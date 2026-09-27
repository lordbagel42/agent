import { createHash } from "node:crypto";
import type { CodingRequest } from "../core/contracts.js";
import type { Json } from "./broker.js";
import { type McpReadResult, McpToolAdapter } from "./mcp.js";

export const PUCK_MCP_URL = "https://ampcode.com/mcp";
export const PUCK_RESOURCE_METADATA_URL =
  "https://ampcode.com/.well-known/oauth-protected-resource/mcp";

export type PuckReadOperation = "read_thread" | "search_threads";

/** Host-authenticated routing context, NEVER fields selected by the model. */
export interface PuckContext {
  principal: string;
  audience: readonly string[];
  turnId: string;
}

/** A dedicated, currently consented OAuth grant. Parent credential code verifies
 * account/owner identity and resource when saving it; a token string alone is
 * not identity verification. Return undefined immediately when consent ends. */
export interface PuckAuthorization {
  ownerId: string;
  account: string;
  resource: typeof PUCK_MCP_URL;
  bearerToken: string;
  expiresAt: number;
}

export interface PuckReadRegistration {
  /** Actual tools/list name and mcpToolContractDigest from explicit review.
   * Local operation names above do NOT assert Amp's external tool names. */
  remoteTool: string;
  contractDigest: string;
  /** Trusted schema-specific policy: constrain queries/IDs to June's own saved
   * coding threads in the configured workspace. Do not accept an arbitrary
   * author/workspace filter or use MCP annotations as authorization. */
  allowsArguments(args: Readonly<Record<string, Json>>): boolean;
}

export interface PuckConfig {
  ownerId: string;
  /** Operator-verified Amp account identity, not a display name. */
  account: string;
  reads?: Partial<Record<PuckReadOperation, PuckReadRegistration>>;
  codingWorkspaces: readonly string[];
}

type UnavailableCode =
  | "private_context_required"
  | "authorization_required"
  | "tool_not_configured"
  | "scope_denied"
  | "request_failed"
  | "closed";

export type PuckReadResult =
  | { status: "unavailable"; code: UnavailableCode }
  | {
      status: "private_ready";
      /** Untrusted evidence for this private turn only. Consume immediately
       * before private model/delivery use; never persist or journal the text. */
      consume(context: PuckContext): McpReadResult | undefined;
    };

function identifier(value: string): boolean {
  return typeof value === "string" && /^[\x21-\x7e]{1,256}$/u.test(value);
}

/** No OAuth side effects at construction, no automatic tool registration, and
 * no mutating MCP tools. CodingRequest still needs the existing supervisor's
 * exact owner approval. This connector cannot push, publish or deploy.
 *
 * Reviewed 2026-09-27: endpoint returns a Bearer resource_metadata challenge;
 * public OAuth metadata advertises authorization-code/S256/CIMD. Authenticated
 * tools/list requires dedicated owner consent; no live names are presumed here.
 */
export function createPuckConnection(
  config: PuckConfig,
  dependencies: {
    getAuthorization(): PuckAuthorization | undefined;
    fetch?: typeof fetch;
    now?: () => number;
  },
) {
  if (
    !identifier(config.ownerId) ||
    !identifier(config.account) ||
    !config.codingWorkspaces.every(identifier)
  )
    throw new Error("invalid_puck_configuration");
  const { ownerId, account } = config;
  const workspaces = new Set(config.codingWorkspaces);
  const { getAuthorization } = dependencies;
  const now = dependencies.now ?? Date.now;
  const reads = new Map<
    PuckReadOperation,
    {
      adapter: McpToolAdapter;
      allowsArguments: PuckReadRegistration["allowsArguments"];
    }
  >();
  for (const [operation, registration] of Object.entries(config.reads ?? {})) {
    if (
      !["read_thread", "search_threads"].includes(operation) ||
      !registration ||
      typeof registration.allowsArguments !== "function" ||
      !/^[a-f0-9]{64}$/u.test(registration.contractDigest)
    )
      throw new Error("invalid_puck_configuration");
    reads.set(operation as PuckReadOperation, {
      adapter: new McpToolAdapter(
        {
          id: "puck",
          tool: `puck.${operation}`,
          remoteTool: registration.remoteTool,
          account,
          item: "puck-oauth",
          origin: "https://ampcode.com",
          url: PUCK_MCP_URL,
          allowedOrigins: ["https://ampcode.com"],
          readContractDigest: registration.contractDigest,
        },
        { fetch: dependencies.fetch },
      ),
      allowsArguments: registration.allowsArguments,
    });
  }
  let closed = false;
  let lastVerifiedAt: number | undefined;
  const pendingResults = new Set<() => void>();

  function privateContext(context: PuckContext): boolean {
    return (
      context.principal === ownerId &&
      context.audience.length === 2 &&
      context.audience[0] === "private" &&
      context.audience[1] === ownerId &&
      identifier(context.turnId)
    );
  }
  function authorization(): PuckAuthorization | undefined {
    try {
      const grant = getAuthorization();
      if (
        !grant ||
        grant.ownerId !== ownerId ||
        grant.account !== account ||
        grant.resource !== PUCK_MCP_URL ||
        !Number.isSafeInteger(grant.expiresAt) ||
        grant.expiresAt <= now() ||
        typeof grant.bearerToken !== "string" ||
        grant.bearerToken.length > 8192 ||
        !/^[A-Za-z0-9._~+/-]+=*$/u.test(grant.bearerToken)
      )
        return undefined;
      return { ...grant };
    } catch {
      return undefined;
    }
  }
  function binding(grant: PuckAuthorization | undefined): string | undefined {
    return (
      grant &&
      createHash("sha256")
        .update(
          JSON.stringify([
            grant.ownerId,
            grant.account,
            grant.resource,
            grant.bearerToken,
            grant.expiresAt,
          ]),
        )
        .digest("hex")
    );
  }
  function unavailable(code: UnavailableCode): PuckReadResult {
    return { status: "unavailable", code };
  }

  return {
    /** Configuration/consent are not a live connection check. A successful read
     * records a timestamp, never a permanent connected/healthy assertion. */
    capabilities(context: PuckContext) {
      const readStatus = (operation: PuckReadOperation) => {
        if (closed) return "closed" as const;
        if (!privateContext(context))
          return "private_context_required" as const;
        if (!reads.has(operation)) return "tool_not_configured" as const;
        if (!authorization()) return "authorization_required" as const;
        return "configured" as const;
      };
      return {
        endpoint: PUCK_MCP_URL,
        readThread: readStatus("read_thread"),
        searchThreads: readStatus("search_threads"),
        lastVerifiedAt,
        taskProposal: !closed && privateContext(context) && workspaces.size > 0,
        taskExecution: false as const,
        deployment: false as const,
      };
    },

    async read(
      context: PuckContext,
      operation: PuckReadOperation,
      input: unknown,
    ): Promise<PuckReadResult> {
      if (closed) return unavailable("closed");
      if (!privateContext(context))
        return unavailable("private_context_required");
      const registration = reads.get(operation);
      if (!registration) return unavailable("tool_not_configured");
      const grant = authorization();
      if (!grant) return unavailable("authorization_required");
      const turnId = context.turnId;
      const grantBinding = binding(grant);
      const expiresAt = Math.min(grant.expiresAt, now() + 30_000);
      let args: Record<string, Json>;
      try {
        const encoded = JSON.stringify(input);
        if (Buffer.byteLength(encoded) > 16_384) throw new Error();
        args = JSON.parse(encoded);
        if (
          !args ||
          typeof args !== "object" ||
          Array.isArray(args) ||
          registration.allowsArguments(args) !== true
        )
          throw new Error();
      } catch {
        return unavailable("scope_denied");
      }
      const authorized = (candidate: PuckContext) =>
        !closed &&
        now() < expiresAt &&
        privateContext(candidate) &&
        candidate.turnId === turnId &&
        binding(authorization()) === grantBinding &&
        registration.allowsArguments(args) === true;
      try {
        if (!authorized(context)) return unavailable("authorization_required");
        let value: McpReadResult | undefined = await registration.adapter.read(
          {
            tool: `puck.${operation}`,
            account,
            item: "puck-oauth",
            origin: "https://ampcode.com",
            arguments: args,
          },
          { bearerToken: grant.bearerToken },
          () => authorized(context),
        );
        if (!authorized(context)) return unavailable("authorization_required");
        lastVerifiedAt = now();
        const clear = () => {
          value = undefined;
          clearTimeout(timer);
          pendingResults.delete(clear);
        };
        const timer = setTimeout(clear, expiresAt - now());
        timer.unref();
        pendingResults.add(clear);
        return {
          status: "private_ready",
          consume(candidate) {
            const result = value;
            clear();
            try {
              return authorized(candidate) ? result : undefined;
            } catch {
              return undefined;
            }
          },
        };
      } catch {
        return unavailable("request_failed");
      }
    },

    /** Proposal only. Parent submits this to the existing coding supervisor,
     * which binds configuration and awaits owner approval before execution. */
    proposeTask(context: PuckContext, input: unknown): CodingRequest {
      if (
        closed ||
        !privateContext(context) ||
        !input ||
        typeof input !== "object"
      )
        throw new Error("puck_proposal_denied");
      const value = input as Record<string, unknown>;
      if (
        Object.keys(value).sort().join(",") !== "goal,workspace" ||
        typeof value.workspace !== "string" ||
        !workspaces.has(value.workspace) ||
        typeof value.goal !== "string" ||
        !value.goal.trim() ||
        value.goal.length > 8000
      )
        throw new Error("puck_proposal_denied");
      return { workspace: value.workspace, goal: value.goal };
    },

    async close(): Promise<void> {
      closed = true;
      for (const clear of pendingResults) clear();
      await Promise.all(
        [...reads.values()].map(({ adapter }) => adapter.close()),
      );
    },
  };
}
