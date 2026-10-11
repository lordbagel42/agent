import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { Effect, Predicate, Schema } from "effect";
import type { JuneRuntime } from "../effect/runtime.js";
import type { BrokerOptions, ToolAction } from "../tools/broker.js";
import type { BrowserOperation } from "../tools/browser.js";

export type Credential =
  | Readonly<{ bearerToken: string }>
  | Readonly<{ kind: "login"; username: string; password: string }>;

export interface BitwardenBinding {
  /** Public aliases, never a username, password, or session key. */
  account: string;
  item: string;
  origin: string;
  /** Exact UUID, not a vault search string. */
  vaultItemId: string;
  field: "bearer" | "login";
}
export interface BitwardenSession {
  key: string;
  expiresAt: number;
}
export interface BitwardenOptions {
  /** Absolute trusted executable path; never chosen by model arguments. */
  executable: string;
  /** Private dedicated CLI profile, previously logged in/unlocked by the owner. */
  appDataDir: string;
  bindings: readonly BitwardenBinding[];
  /** Trusted in-memory/OS-secret provider; no master passwords or login automation. */
  session: Effect.Effect<BitwardenSession, CredentialUnavailable>;
  now?: () => number;
}
export type BitwardenCommand = (
  executable: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
    signal: AbortSignal;
  },
) => Promise<string>;

/** Deliberately carries no cause: CLI errors include command, stdout and stderr. */
export class CredentialUnavailable extends Schema.TaggedError<CredentialUnavailable>()(
  "CredentialUnavailable",
  {},
) {
  override readonly message = "credential_unavailable";
}

export type BitwardenCredentialResolver = BrokerOptions["resolveCredential"] & {
  /** Configuration only. Never obtains a session or reads the vault. */
  inspect(): {
    configuredBindings: number;
    bindings: { binding: number; field: BitwardenBinding["field"] }[];
  };
  /** Pair a host-validated browser recipe with this resolver, without vault access. */
  assertBrowserBinding(recipe: BrowserOperation): void;
};

const runCommand: BitwardenCommand = (executable, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { ...options, encoding: "utf8", windowsHide: true },
      (error, stdout) => {
        // execFile errors include command/stdout/stderr; never propagate them.
        if (error) reject(new Error("credential_unavailable"));
        else resolve(stdout);
      },
    );
  });

/** Only the fields June may release; notes, URIs, TOTP seeds and custom fields are never read. */
const VaultItem = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal(1),
    deletedDate: Schema.optional(Schema.Unknown),
    login: Schema.Struct({
      password: Schema.NonEmptyString,
      username: Schema.optional(Schema.Unknown),
    }),
  }),
);
const decodeVaultItem = Schema.decodeUnknownEffect(VaultItem);

type Scope = Pick<ToolAction, "account" | "item" | "origin">;
const scopeKey = (scope: Scope) =>
  JSON.stringify([scope.account, scope.item, scope.origin]);

/** Supported Password Manager `bw get item`, NOT private vault APIs or bws.
 * No cache: one exact item read per authorized use. Session is only in child env.
 * Neither this process nor JavaScript strings provide secure erasure/host isolation.
 */
export function makeBitwardenCredentials(
  options: BitwardenOptions,
  command: BitwardenCommand = runCommand,
) {
  const { executable, appDataDir, session, now = Date.now } = options;
  if (!isAbsolute(executable) || !isAbsolute(appDataDir))
    throw new Error("invalid_credential_configuration");
  const bindings = options.bindings.map((binding) => ({ ...binding }));
  const seen = new Set<string>();
  for (const binding of bindings) {
    const origin = new URL(binding.origin);
    if (
      !binding.account ||
      !binding.item ||
      origin.protocol !== "https:" ||
      origin.origin !== binding.origin ||
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(
        binding.vaultItemId,
      ) ||
      !["bearer", "login"].includes(binding.field) ||
      seen.has(scopeKey(binding))
    )
      throw new Error("invalid_credential_configuration");
    seen.add(scopeKey(binding));
  }
  const unavailable = Effect.fail(new CredentialUnavailable());
  const resolve = Effect.fn("june.credentials.resolve")(
    function* (scope: Scope) {
      const binding = bindings.find(
        (candidate) => scopeKey(candidate) === scopeKey(scope),
      );
      if (!binding) return yield* unavailable;
      const lease = yield* session;
      // Session provider must issue short local leases. This does NOT change the
      // vault session's validity: owner lock/logout is required to invalidate it.
      const remaining = lease.expiresAt - now();
      if (
        !lease.key ||
        !Number.isSafeInteger(lease.expiresAt) ||
        remaining <= 0 ||
        remaining > 60_000
      )
        return yield* unavailable;
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          command(
            executable,
            ["get", "item", binding.vaultItemId, "--nointeraction"],
            {
              // Deliberately do not inherit NODE_OPTIONS, BW_SESSION, or unrelated secrets.
              env: {
                PATH: "/usr/local/bin:/usr/bin:/bin",
                BITWARDENCLI_APPDATA_DIR: appDataDir,
                BW_SESSION: lease.key,
              },
              timeout: Math.min(15_000, remaining),
              maxBuffer: 1_048_576,
              signal,
            },
          ),
        catch: () => new CredentialUnavailable(),
      });
      if (now() >= lease.expiresAt) return yield* unavailable;
      const item = yield* decodeVaultItem(result);
      if (item.id !== binding.vaultItemId || item.deletedDate)
        return yield* unavailable;
      if (binding.field === "bearer")
        return Object.freeze({
          bearerToken: item.login.password,
        }) satisfies Credential as Credential;
      if (!Predicate.isString(item.login.username)) return yield* unavailable;
      return Object.freeze({
        kind: "login",
        username: item.login.username,
        password: item.login.password,
      }) satisfies Credential as Credential;
    },
    // Decode failures and defects carry vault data; collapse every failure.
    Effect.catchCause(() => Effect.fail(new CredentialUnavailable())),
  );
  return {
    resolve,
    inspect: () => ({
      configuredBindings: bindings.length,
      // Ordinals identify configuration order without leaking operator strings,
      // vault UUIDs or paths. Keep this separate from credential resolution.
      bindings: bindings.slice(0, 10).map((binding, index) => ({
        binding: index + 1,
        field: binding.field,
      })),
    }),
    assertBrowserBinding(recipe: BrowserOperation): void {
      const binding = bindings.find(
        (candidate) => scopeKey(candidate) === scopeKey(recipe),
      );
      const logins =
        recipe.steps?.filter((step) => step.kind === "login").length ?? 0;
      const bearer = recipe.requests.some((request) => request.credential);
      if (
        !binding ||
        (binding.field === "login"
          ? logins !== 1 || bearer
          : logins !== 0 || !bearer)
      )
        throw new Error("invalid_credential_configuration");
    },
  };
}

/** Promise adapter for the capability broker, run on the process runtime. */
export function createBitwardenCredentialResolver(
  options: BitwardenOptions & { effectRuntime: JuneRuntime },
  command?: BitwardenCommand,
): BitwardenCredentialResolver {
  const credentials = makeBitwardenCredentials(options, command);
  return Object.assign(
    (scope: Scope) =>
      options.effectRuntime.runPromise(credentials.resolve(scope)),
    {
      inspect: credentials.inspect,
      assertBrowserBinding: credentials.assertBrowserBinding,
    },
  );
}
