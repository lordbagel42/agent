import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import type { BrokerOptions, ToolAction } from "../tools/broker.js";

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
  session(): Promise<BitwardenSession>;
  now?: () => number;
}
export type BitwardenCommand = (
  executable: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<string>;

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

/** Supported Password Manager `bw get item`, NOT private vault APIs or bws.
 * No cache: one exact item read per authorized use. Session is only in child env.
 * Neither this process nor JavaScript strings provide secure erasure/host isolation.
 */
export function createBitwardenCredentialResolver(
  options: BitwardenOptions,
  command: BitwardenCommand = runCommand,
): BrokerOptions["resolveCredential"] {
  const { executable, appDataDir, session, now = Date.now } = options;
  if (!isAbsolute(executable) || !isAbsolute(appDataDir))
    throw new Error("invalid_credential_configuration");
  const bindings = options.bindings.map((binding) => ({ ...binding }));
  const seen = new Set<string>();
  const scopeKey = (scope: Pick<ToolAction, "account" | "item" | "origin">) =>
    JSON.stringify([scope.account, scope.item, scope.origin]);
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
  return async (scope) => {
    try {
      const binding = bindings.find(
        (candidate) => scopeKey(candidate) === scopeKey(scope),
      );
      if (!binding) throw new Error();
      const lease = await session();
      // Session provider must issue short local leases. This does NOT change the
      // vault session's validity: owner lock/logout is required to invalidate it.
      const remaining = lease.expiresAt - now();
      if (
        !lease.key ||
        !Number.isSafeInteger(lease.expiresAt) ||
        remaining <= 0 ||
        remaining > 60_000
      )
        throw new Error();
      const result = await command(
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
        },
      );
      if (now() >= lease.expiresAt) throw new Error();
      const item = JSON.parse(result);
      if (
        !item ||
        item.id !== binding.vaultItemId ||
        item.type !== 1 ||
        item.deletedDate ||
        typeof item.login?.password !== "string" ||
        !item.login.password
      )
        throw new Error();
      if (binding.field === "bearer")
        return Object.freeze({
          bearerToken: item.login.password,
        }) satisfies Credential;
      if (typeof item.login.username !== "string") throw new Error();
      // Only requested login fields, never notes, URIs, TOTP seeds or custom fields.
      return Object.freeze({
        kind: "login",
        username: item.login.username,
        password: item.login.password,
      }) satisfies Credential;
    } catch {
      throw new Error("credential_unavailable");
    }
  };
}
