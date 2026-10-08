import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { type Config, parseConfig } from "../config.js";
import {
  type SettingKey,
  type SettingsOverrides,
  settingKeys,
  settingsCommandSchema,
  settingsOverridesSchema,
} from "./contracts.js";

const storedSchema = z.strictObject({
  version: z.number().int().nonnegative().safe(),
  contract: z.literal(1),
  baseline: z.string().regex(/^[a-f0-9]{64}$/),
  overrides: settingsOverridesSchema,
  invalidation: z.enum(["operator-baseline-changed"]).nullable(),
});
type Stored = z.infer<typeof storedSchema>;

function at(config: Config, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === "object" && Object.hasOwn(value, key)
          ? Reflect.get(value, key)
          : undefined,
      config,
    );
}

function applicability(config: Config, key: SettingKey) {
  const parts = key.split(".");
  const field = parts.pop();
  const parent = at(config, parts.join("."));
  if (!parent || typeof parent !== "object") return "not-configured";
  const protocol = Reflect.get(parent, "protocol");
  if (
    (field === "serviceTier" && protocol !== "codex") ||
    (field === "maxOutputTokens" && protocol === "codex") ||
    (field === "reasoningEffort" && !["openai", "codex"].includes(protocol))
  )
    return "not-applicable";
  return "adjustable";
}

function constraint(key: SettingKey) {
  if (key.endsWith(".model"))
    return "Provider model identifier, 1–128 characters; availability is not probed.";
  if (key.endsWith(".reasoningEffort")) return "low | medium | high";
  if (key.endsWith(".serviceTier")) return "fast | default";
  if (key.endsWith(".maxOutputTokens")) return "Integer 1–32768 tokens";
  if (["activitySessions.idleMs", "continuity.idleMs"].includes(key))
    return "Integer 1000–604800000 ms";
  if (
    ["reflection.idleMs", "reflection.deepMs", "reflection.pollMs"].includes(
      key,
    )
  )
    return "Integer 1000–86400000 ms; deepMs must be >= idleMs";
  if (key === "browser.timeoutMs") return "Integer 100–60000 ms";
  if (key === "webSearch.timeoutMs") return "Integer 1000–15000 ms";
  if (key === "emojiSearch.timeoutMs") return "Integer 100–5000 ms";
  if (key === "jev.timeoutMs") return "Integer 1000–30000 ms";
  return "Integer 1000–300000 ms";
}

/** Separate application preferences, never edits to the operator's config or
 * conversation journals. Open only after acquiring active-runtime ownership. */
export class SettingsStore {
  private readonly db: DatabaseSync;
  private readonly base: Config;
  private readonly baseline: string;
  readonly effective: Config;
  readonly loadedVersion: number;

  constructor(
    private readonly options: {
      path: string;
      base: Config;
      binding?: string;
      revision?: string;
      isBaselineCurrent?: () => boolean;
    },
  ) {
    this.base = structuredClone(options.base);
    this.baseline = createHash("sha256")
      .update(JSON.stringify(this.base))
      .update(options.binding ?? "")
      .digest("hex");
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(options.path);
    chmodSync(options.path, 0o600);
    try {
      this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL);`);
      this.db.exec("BEGIN IMMEDIATE");
      const row = this.db
        .prepare("SELECT data FROM settings WHERE id = 1")
        .get();
      let stored: Stored = row
        ? this.decode(row.data)
        : {
            version: 0,
            contract: 1,
            baseline: this.baseline,
            overrides: {},
            invalidation: null,
          };
      if (stored.baseline !== this.baseline)
        stored = {
          version: stored.version + 1,
          contract: 1,
          baseline: this.baseline,
          overrides: {},
          invalidation: "operator-baseline-changed",
        };
      this.effective = this.resolve(stored.overrides);
      this.loadedVersion = stored.version;
      this.save(stored);
      this.db.exec("COMMIT");
    } catch {
      this.db.close();
      throw new Error(
        "Settings storage unavailable or invalid; operator reconciliation required",
      );
    }
  }

  private decode(data: unknown): Stored {
    try {
      return storedSchema.parse(JSON.parse(String(data)));
    } catch {
      throw new Error(
        "Settings storage invalid; operator reconciliation required",
      );
    }
  }

  private read(): Stored {
    const stored = this.decode(
      this.db.prepare("SELECT data FROM settings WHERE id = 1").get()?.data,
    );
    if (stored.baseline !== this.baseline)
      throw new Error(
        "Operator configuration changed; inspect after activation",
      );
    return stored;
  }

  private save(stored: Stored) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES (1, ?)")
      .run(JSON.stringify(storedSchema.parse(stored)));
  }

  private resolve(overrides: SettingsOverrides): Config {
    const desired = structuredClone(this.base);
    for (const [path, value] of Object.entries(overrides)) {
      if (applicability(this.base, path as SettingKey) !== "adjustable")
        throw new Error("Setting is not configured or not applicable");
      const parts = path.split(".");
      const field = parts.pop();
      const parent = at(desired, parts.join("."));
      if (!parent || typeof parent !== "object" || !field)
        throw new Error("Invalid setting");
      Reflect.set(parent, field, value);
    }
    return parseConfig(desired);
  }

  private snapshot(stored: Stored, status: "inspected" | "saved") {
    const desired = this.resolve(stored.overrides);
    const settings = settingKeys.map((key) => ({
      key,
      status: applicability(this.base, key),
      constraint: constraint(key),
      baseline: at(this.base, key) ?? null,
      effective: at(this.effective, key) ?? null,
      desired: at(desired, key) ?? null,
      overridden: Object.hasOwn(stored.overrides, key),
    }));
    return {
      status,
      version: stored.version,
      loadedVersion: this.loadedVersion,
      runningRevision: this.options.revision ?? null,
      invalidation: stored.invalidation,
      operatorBaselineCurrent: this.options.isBaselineCurrent?.() ?? true,
      pendingActivation: settings
        .filter((row) => row.effective !== row.desired)
        .map((row) => row.key),
      activation:
        "Saved changes are pending next authorized activation. No hot reload, restart or deployment was requested.",
      settings,
      protected: {
        configurationGroups: Object.keys(this.base),
        rule: "Every configuration field not listed as adjustable is operator-owned. Values are withheld. This includes credentials/references, identities, endpoints, paths, activation gates, permission/allowlists, safety/admission budgets, native execution and deployment/recovery controls. Consult repository source for schema and the authorized operator for changes; this action cannot grant authority or change infrastructure.",
        existingInterfaces:
          "Personality: personalityPreview with apply:true saves an exact version-bound public-safe style; !personality remains an optional manual route. Optional per-conversation typing: typingEnabled. MCP account consent and explicit permission/disconnect controls remain authenticated in Connections; ordinary enabled effects need no separate human approval. Deployment: release.inspect is read-only; the designated operator coordinates changes under deployment ownership rules.",
      },
    };
  }

  run(value: unknown) {
    const parsed = settingsCommandSchema.safeParse(value);
    if (!parsed.success)
      throw new Error(
        "Invalid settings command; inspect adjustable keys first",
      );
    const command = parsed.data;
    if (command.action === "inspect")
      return this.snapshot(this.read(), "inspected");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.options.isBaselineCurrent?.() === false)
        throw new Error(
          "Operator configuration changed; inspect after activation",
        );
      const stored = this.read();
      if (stored.version !== command.expectedVersion)
        throw new Error(
          "Settings version changed; inspect before writing again",
        );
      const overrides = { ...stored.overrides };
      if (command.action === "update") {
        for (const change of command.changes)
          overrides[change.key] = change.value;
      } else {
        for (const key of command.keys) delete overrides[key];
      }
      this.resolve(overrides);
      const next = { ...stored, version: stored.version + 1, overrides };
      const result = this.snapshot(next, "saved");
      this.save(next);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
