import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { EffectGuard } from "../sentinel/contracts.js";
import {
  type CapabilityBroker,
  MAX_GRANT_TTL_MS,
  type Receipt,
} from "./broker.js";
import {
  type BrowserAdapter,
  type BrowserOperation,
  browserCredentialOperationSchema,
  browserOperationDigest,
  browserOperationSchema,
} from "./browser.js";

/** Separate opt-in from reads: one literal fill OR one click, never a sequence. */
export const browserMutationSchema = browserOperationSchema.refine((recipe) => {
  const step = recipe.steps[0];
  const writes = recipe.requests.filter((request) => request.method !== "GET");
  return (
    /^[a-z][a-z0-9_-]{0,63}$/u.test(recipe.name) &&
    recipe.steps.length === 1 &&
    (step?.kind === "fill" || step?.kind === "click") &&
    !recipe.requests.some((request) => request.credential) &&
    recipe.outputSelector === undefined &&
    writes.length <= (step.kind === "click" ? 1 : 0) &&
    writes.every((request) => request.maxUses === 1) &&
    // Retain the configured recipe-size bound independently of receipt output.
    JSON.stringify(recipe).length <= 1400
  );
}, "Mutation requires a short lowercase name, one anonymous fill or click, no implicit submit, at most one one-use write endpoint, and a recipe of at most 1400 JSON characters");

// Reversible JSON escapes prevent platform mentions, formatting and link unfurls.
function reviewJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&`*_~@/.]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** The host supplies identity and liveness, never the model or page content. */
export type BrowserProposal = (
  operation: string | null,
  operationId: string,
  isCurrent: () => boolean,
  signal?: AbortSignal,
  guard?: EffectGuard,
) => Promise<string>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Exact configured effects only. The broker owns all receipts and credentials;
 * this store only binds host invocation IDs to grants, like MCP proposals do.
 * Existing proposals are never migrated, swept, or executed on replay. */
export function createBrowserProposal(options: {
  owner: string;
  /** Durable private SQLite path; retain alongside the broker database. */
  path: string;
  operations: BrowserOperation[];
  credentialOperations?: BrowserOperation[];
  browser: Pick<BrowserAdapter, "action">;
  broker: Pick<
    CapabilityBroker,
    "propose" | "grant" | "execute" | "audit" | "cancel"
  >;
}): BrowserProposal {
  if (!options.path || options.path === ":memory:")
    throw new Error("browser_proposal_storage_required");
  const { owner, path, broker, browser } = options;
  const recipes = [
    ...options.operations.map((input) => ({
      recipe: browserMutationSchema.parse(input),
      credentialed: false,
    })),
    ...(options.credentialOperations ?? []).map((input) => ({
      recipe: browserCredentialOperationSchema.parse(input),
      credentialed: true,
    })),
  ];
  const names = new Set<string>();
  const proposals = recipes.map(({ recipe, credentialed }) => {
    if (names.has(recipe.name))
      throw new Error("browser_proposal_recipe_mismatch");
    names.add(recipe.name);
    const expected = {
      tool: "browser",
      account: recipe.account,
      item: recipe.item,
      origin: recipe.origin,
      arguments: {
        operation: recipe.name,
        recipeDigest: browserOperationDigest(recipe),
      },
    };
    const action = () => {
      const value = broker.propose(browser.action(recipe.name));
      if (JSON.stringify(value) !== JSON.stringify(expected))
        throw new Error("browser_proposal_recipe_mismatch");
      return value;
    };
    action();
    const credential = credentialed
      ? {
          credential: {
            kind: recipe.steps.some((step) => step.kind === "login")
              ? "login"
              : "bearer",
            values: "not_exposed",
          },
        }
      : {};
    const report = (grantId: string | null, receipt?: Receipt) => {
      const metadata = {
        operation: recipe.name,
        grantId,
        // Explicit projection: no adapter result, errors, page text, or secrets.
        receipt: receipt
          ? {
              id: receipt.id,
              grantId: receipt.grantId,
              status: receipt.status,
              startedAt: receipt.startedAt,
            }
          : null,
        ...credential,
      };
      const outcome =
        !receipt || receipt.status === "unknown"
          ? "Unknown result: not proof of failure, success, rejection or stoppage. Do not retry, including with a new operation ID or another provider. A missing receipt is not evidence of an external outcome. Use authenticated grant inspection/reconciliation only after independently verifying worker stoppage and the external result."
          : "This is a recorded outcome, not fresh site verification. Do not repeat this effect to retrieve its result.";
      const text = `Browser execution receipt (escaped JSON). ${outcome} Credentials remain host-resolved; fresh credentials and account enrollment require separate authenticated controls, not this operation.\n${reviewJson(metadata)}`;
      if (text.length > 3500) throw new Error("browser_proposal_too_large");
      return text;
    };
    return { name: recipe.name, recipe, action, report };
  });
  const catalog = `Configured browser mutation and credential-operation names (escaped JSON): ${reviewJson(proposals.map(({ name }) => name))}. Select one exact name to execute its bounded configured recipe through a durable one-use grant; decide safety for the current task without mandatory per-action human approval. This discovery ran nothing, resolved no credentials and granted no permission. Configuration is not live availability. Fresh credentials and account enrollment remain separate authenticated controls.`;
  if (catalog.length > 3500) throw new Error("browser_proposal_too_large");
  return async (operation, operationId, isCurrent, signal, guard) => {
    if (operation === null) return catalog;
    const proposal = proposals.find(({ name }) => name === operation);
    if (!proposal) throw new Error("browser_proposal_unavailable");
    if (
      typeof operationId !== "string" ||
      !operationId.length ||
      operationId.length > 512 ||
      [...operationId].some((character) => character.charCodeAt(0) < 32) ||
      typeof isCurrent !== "function"
    )
      throw new Error("browser_proposal_context_required");
    const current = () => !signal?.aborted && isCurrent();
    const action = proposal.action();
    const check = guard?.("browser-recipe", {
      action,
      recipe: proposal.recipe,
    });
    const key = digest(JSON.stringify([owner, operationId]));
    const fingerprint = digest(JSON.stringify(action));
    let grantId: string | null = null;
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS browser_proposal_invocations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, grant_id TEXT);`);
      const existing = () =>
        db
          .prepare(
            "SELECT fingerprint,grant_id FROM browser_proposal_invocations WHERE id=?",
          )
          .get(key);
      const replay = (row: NonNullable<ReturnType<typeof existing>>) => {
        if (row.fingerprint !== fingerprint)
          throw new Error("browser_proposal_operation_mismatch");
        const grant = row.grant_id === null ? null : String(row.grant_id);
        // Even a grant without a receipt is inspection-only on replay. A crash
        // between reservation, grant creation and dispatch never authorizes retry.
        return proposal.report(
          grant,
          grant ? broker.audit(owner, grant) : undefined,
        );
      };
      const saved = existing();
      if (saved) return replay(saved);
      const withheld = await check?.commit();
      if (withheld) return withheld;
      if (!current())
        return "Browser operation is no longer current. Nothing ran and no permission was granted.";
      // Commit the ID reservation before creating a grant in the broker's store.
      // Persist only digests and a grant reference, never a second receipt ledger.
      const claimed = db
        .prepare(
          "INSERT OR IGNORE INTO browser_proposal_invocations(id,fingerprint) VALUES(?,?)",
        )
        .run(key, fingerprint).changes;
      if (!claimed) {
        const row = existing();
        if (!row) throw new Error("browser_proposal_unavailable");
        return replay(row);
      }
      grantId = broker.grant(owner, {
        audience: owner,
        action,
        expiresAt: Date.now() + MAX_GRANT_TTL_MS,
      });
      db.prepare(
        "UPDATE browser_proposal_invocations SET grant_id=? WHERE id=?",
      ).run(grantId, key);
    } finally {
      db.close();
    }
    const grant = grantId;
    const abort = () => {
      // Cancellation requests cleanup; it cannot prove the effect stopped.
      try {
        broker.cancel(owner, grant);
      } catch {
        /* Keep the consumed invocation; never fall back or expose errors. */
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (!current()) {
        abort();
        return proposal.report(grant, broker.audit(owner, grant));
      }
      const receipt = await broker.execute(
        owner,
        grant,
        action,
        undefined,
        undefined,
        current,
      );
      return proposal.report(grant, receipt);
    } catch {
      return proposal.report(grant, broker.audit(owner, grant));
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  };
}
