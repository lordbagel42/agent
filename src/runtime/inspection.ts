import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Config } from "../config.js";
import type { CompanionReply, MessageEvent } from "../core/contracts.js";
import type { BitwardenCredentialResolver } from "../credentials/bitwarden.js";
import type { ImportedMemoryExtraction } from "../imports/extraction.js";
import { type HistoryImports, importCoverageDigest } from "../imports/index.js";
import { MEMORY_CORRECTION_HELP } from "../memory/correction.js";
import type { CuratedPersonalityStore } from "../memory/curated.js";
import {
  type EvidenceStore,
  type ImportCoverage,
  tombstoneExportLimits,
} from "../memory/store.js";
import {
  reflectionDriveHalfLifeMs,
  reflectionPriority,
} from "../reflection/domain.js";
import type { McpConnections } from "../tools/connections.js";
import type { Delivery } from "./delivery.js";
import { proposeImportApproval } from "./import-approval.js";
import type {
  CuriosityProgress,
  ReflectionRuntimeState,
} from "./reflection.js";
import type { Dependencies } from "./registry.js";

/** Fixed allowlist: never serialize config, dependency objects or remote data.
 * Callability is a route, not provider health, approval or admission capacity.
 */
export function capabilitySnapshot(
  config: Config,
  runtime: Pick<
    Dependencies,
    | "coding"
    | "memory"
    | "reflection"
    | "mcpAvailable"
    | "webSearch"
    | "execution"
    | "release"
    | "inspection"
  >,
  importsMounted: boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  const turn = !config.setupMode;
  const memoryEnabled = !!config.memory && env.JUNE_ALLOW_MEMORY === "1";
  const state = (value: boolean | null) =>
    value === null ? "unknown" : value ? "yes" : "no";
  const row = (
    capability: string,
    integrated: boolean,
    callable: boolean | null,
    enabled: boolean | null,
    detail: string,
  ) => ({
    capability,
    implemented: "yes",
    hostIntegrated: state(integrated),
    juneCallable: state(callable),
    enabled: state(enabled),
    liveVerified: "unknown",
    detail,
  });
  return {
    scope:
      "Selected capabilities of this process; not an exhaustive tool inventory. Fresh owner-private non-synthesis turns only. Setup mode disables model invocation.",
    definitions: {
      implemented: "Source implementation exists in this build.",
      hostIntegrated: "Dependency is mounted in this process.",
      juneCallable:
        "A direct model action route is available; automatic work and operator-only APIs do not count. Per-turn guards still apply.",
      enabled:
        "Configuration and required host activation gates permit the feature; not action approval, provider authorization or health.",
      liveVerified:
        "Independent live capability attestation. No such attestation is wired into this view; absence is unknown, not failure or success.",
    },
    capabilities: [
      row(
        "native-coding",
        !!runtime.coding,
        turn && !!Object.keys(runtime.coding?.workspaces ?? {}).length,
        config.coding.enabled && env.JUNE_ALLOW_NATIVE_CODING === "1",
        "coding proposes a job; owner approval and isolation remain required. inspection: native-coding checks prerequisites without launching work.",
      ),
      row(
        "retained-memory",
        !!runtime.memory,
        turn && !!runtime.memory,
        memoryEnabled,
        "recall queries retained owner-private evidence with deletion rechecks; it is not a live account search or complete history. inspection: memory returns metadata only.",
      ),
      row(
        "history-imports",
        importsMounted,
        false,
        memoryEnabled &&
          Object.keys(config.imports).length > 0 &&
          env.JUNE_ALLOW_HISTORY_IMPORTS === "1",
        "Operator-controlled import execution. inspection: imports only reads progress; selections do not prove imported history or authorization.",
      ),
      row(
        "reflection",
        !!runtime.reflection,
        turn && !!runtime.memory && !!runtime.reflection,
        memoryEnabled &&
          !!config.reflection &&
          env.JUNE_ALLOW_MEMORY_MODELS === "1",
        "reflectionRequest queues bounded retained evidence through the scheduler; it does not confirm evaluation, delivery or approval. inspection: reflection returns metadata only.",
      ),
      row(
        "mcp-tools",
        runtime.mcpAvailable === true,
        turn && runtime.mcpAvailable ? null : false,
        config.mcp ? null : false,
        "Broker mounting does not establish enabled tools. Per-tool permissions, catalog and credential expiry are not inspected here; use MCP discovery. Mutations still need approval.",
      ),
      row(
        "public-web-search",
        !!runtime.webSearch,
        turn && !runtime.execution && runtime.webSearch?.available === true,
        !!config.webSearch && runtime.webSearch?.available === true,
        "webSearch accepts an explicit public query when configured with a credential. Execution-enabled turns delegate search through workers, not a direct conversational webSearch action. Credential validity and quota are not probed.",
      ),
      row(
        "execution-agents",
        !!runtime.execution,
        turn && !!runtime.execution,
        config.executionEnabled && turn,
        "execution dispatches bounded reasoning workers; it does not authorize native execution or external effects.",
      ),
      row(
        "release-inspection",
        !!runtime.release,
        turn && !!runtime.release,
        !!config.deployment,
        "release reads deployment evidence. No feed read, deployment, running-revision attestation or health probe is performed by this matrix.",
      ),
      row(
        "subsystem-inspection",
        !!runtime.inspection,
        turn && !!runtime.inspection,
        true,
        "inspection: capability-matrix reads this fixed metadata view, including disabled subsystems. No secrets, evidence bodies, configuration values or mutations.",
      ),
    ],
  };
}

/** Project existing recovery receipts only; absence is not an outcome. */
export function inspectInterruptedInference(
  events: Record<
    string,
    {
      event: { occurredAt: number };
      inference?: {
        status: "unknown";
        code: "interrupted_inference";
        invocation: string;
      };
    }
  >,
  forgottenEvents: readonly string[] = [],
): string {
  const forgotten = new Set(forgottenEvents);
  const receipts = Object.entries(events)
    .flatMap(([id, { event, inference }]) =>
      inference && !forgotten.has(id)
        ? [{ inference, occurredAt: event.occurredAt }]
        : [],
    )
    .sort((a, b) => b.occurredAt - a.occurredAt);
  const rows = receipts.slice(0, 10).map(({ inference, occurredAt }) => ({
    id: createHash("sha256").update(inference.invocation).digest("hex"),
    inboundOccurredAt: occurredAt,
    status: inference.status,
    code: inference.code,
  }));
  return `Interrupted inference snapshot at ${new Date().toISOString()}. Read-only; this owner-private conversation only. Recorded recovery receipts: ${receipts.length}; showing latest ${rows.length} by inbound event time. ${JSON.stringify(rows)}\nIDs are opaque receipt fingerprints, not provider request IDs. inboundOccurredAt is the inbound event time (epoch milliseconds), not an inference or interruption timestamp; those times were not recorded. Legacy or uninterrupted events may have no receipt; absence does not prove success or intentional silence. Outcomes remain unknown, not intentional silence; actions may have occurred. Inspect recorded delivery/tool receipts before any new action. No retry, reconciliation, reclassification or release of held work was performed. No message bodies or raw invocation keys returned.`;
}

// Legacy persisted gaps are free text, sometimes containing private identifiers.
// Recognize only exact connector notes after the identifier; never echo a note.
// New/changed connector wording remains visible as an unclassified count.
const importGapKinds = new Map([
  [
    "available retained messages only; deleted, expired and inaccessible history cannot be recovered; files are not downloaded.",
    "retained-history/files limitation",
  ],
  [
    "channel timeline only; replies require separately authorized channel/thread selections, including threads with older roots.",
    "thread replies not covered by timeline",
  ],
  ["Slack reports retention-limited history.", "retention-limited history"],
  ["no plain text; non-text content omitted.", "plain-text body unavailable"],
  [
    "Gmail API search interval; exact lower-bound messages may be excluded by after. Deleted mail and unavailable content are not imported. Attachments, attached messages and non-plain-text MIME content returned by full reads are discarded; separate attachment bodies are never fetched. Labels and search results can change during pagination; this is not a snapshot.",
    "Gmail date/search/content limitations",
  ],
  [
    "no longer inside selected label/date coverage.",
    "message left selected label/date window",
  ],
  ["no inline plain-text body.", "plain-text body unavailable"],
  ["message disappeared or is unavailable.", "message unavailable"],
  ["Previously deleted source omitted.", "previously deleted source omitted"],
  ["Tombstoned evidence omitted", "previously deleted source omitted"],
]);

function summarizeImportGaps(gaps: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const gap of gaps) {
    const separator = gap.indexOf(": ");
    const note = separator < 0 ? gap : gap.slice(separator + 2);
    const kind = importGapKinds.get(note) ?? "unclassified (details withheld)";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

type InvocationMarkers = Record<string, "started" | "settled" | "uncertain">;

/** Project durable markers only; never prune, settle, release or replay work. */
export function outstandingOperationMetadata(state: {
  modelInvocations?: InvocationMarkers;
  webInvocations?: InvocationMarkers;
  deliveries: Record<string, Delivery>;
}) {
  const counts = {
    model: { started: 0, uncertain: 0 },
    web: { started: 0, uncertain: 0 },
    delivery: { sending: 0, unknown: 0 },
  };
  const operations: {
    id: string;
    kind: "model" | "web" | "delivery";
    marker: "started" | "uncertain" | "sending" | "unknown";
    status: "unresolved";
  }[] = [];
  let total = 0;
  const include = (
    key: string,
    kind: (typeof operations)[number]["kind"],
    marker: (typeof operations)[number]["marker"],
  ) => {
    total++;
    if (operations.length < 10)
      operations.push({
        id: createHash("sha256")
          .update(JSON.stringify([kind, key]))
          .digest("hex"),
        kind,
        marker,
        status: "unresolved",
      });
  };
  for (const [kind, markers] of [
    ["model", state.modelInvocations],
    ["web", state.webInvocations],
  ] as const)
    for (const [key, marker] of Object.entries(markers ?? {})) {
      if (marker === "settled") continue;
      counts[kind][marker]++;
      include(key, kind, marker);
    }
  for (const [key, delivery] of Object.entries(state.deliveries)) {
    // A previous known rejection may remain while a new send is in progress.
    const marker =
      delivery.phase === "sending"
        ? "sending"
        : delivery.result?.status === "unknown"
          ? "unknown"
          : undefined;
    if (!marker) continue;
    counts.delivery[marker]++;
    include(key, "delivery", marker);
  }
  return {
    counts,
    operations,
    omitted: total - operations.length,
    recorded: {
      model: state.modelInvocations !== undefined,
      web: state.webInvocations !== undefined,
    },
  };
}

export type OutstandingOperationSnapshot = ReturnType<
  typeof outstandingOperationMetadata
>;

function jsonPage(json: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > json.length)
    throw new Error("Invalid metadata offset");
  // JSON text has no raw control characters. Even escaped a second time, a
  // 1000-code-unit chunk leaves room for the receipt and limitations below.
  const end = Math.min(offset + 1000, json.length);
  return {
    offset,
    nextOffset: end < json.length ? end : null,
    totalCharacters: json.length,
    json: json.slice(offset, end),
  };
}

/** Host-bound audience and selections, never model-supplied scope or query.
 * Reports contain metadata only, so retained receipts cannot resurrect evidence.
 * No mutating service methods or remote history fetches are called here.
 */
export function createInspectionReader(deps: {
  audience: string;
  memory?: { store: EvidenceStore; personality?: CuratedPersonalityStore };
  imports?: HistoryImports;
  importExtraction?: ImportedMemoryExtraction;
  selections: Record<string, ImportCoverage>;
  mcp?: Pick<McpConnections, "inventory">;
  /** The host's HTTP readiness predicate, not a workflow progress check. */
  processHealth?: () => Promise<boolean>;
  capabilityMatrix?: () => ReturnType<typeof capabilitySnapshot>;
  slackMcpConfigured?: boolean;
  nativeCoding?: () => Promise<string>;
  capabilities?: () => string;
  credentials?: Pick<BitwardenCredentialResolver, "inspect">;
  slackSearch?: {
    enabled: boolean;
    hasActionToken?: (event: MessageEvent) => boolean;
  };
  operations?: () => Promise<OutstandingOperationSnapshot>;
  curiosity?: (audience: string) => Promise<CuriosityProgress>;
  reflection?: () => Promise<
    Pick<
      ReflectionRuntimeState,
      "reflection" | "liveActive" | "invocations"
    > & {
      candidateIds: string[];
      activeTurnIds: string[];
    }
  >;
}): (
  target: Exclude<
    NonNullable<CompanionReply["inspection"]>,
    "inference" | "personality"
  >,
  event?: MessageEvent,
) => Promise<string> {
  return async (query, event) => {
    if (typeof query === "object" && query.target === "import-approval") {
      const selected = Object.entries(deps.selections).find(
        ([id, coverage]) =>
          id === query.selection && coverage.audiences.includes(deps.audience),
      );
      if (!deps.imports || !selected)
        return "Import approval is unavailable for this selection. No import was started.";
      const [id, coverage] = selected;
      return proposeImportApproval(
        id,
        coverage,
        importCoverageDigest(id, coverage),
        deps.imports.status(id),
      );
    }
    const target = typeof query === "string" ? query : query.target;
    const heading = `${target} metadata snapshot at ${new Date().toISOString()}. Read-only; not recall or proof of complete coverage.`;
    switch (target) {
      case "capability-matrix":
        return deps.capabilityMatrix
          ? `${heading}\n${JSON.stringify(deps.capabilityMatrix())}`
          : `${heading}\nCapability matrix is unavailable; implementation, integration, callability, activation and live verification are unknown.`;
      case "capabilities":
        return `${heading}\n${deps.capabilities?.() ?? "Generic capabilities are disabled; no generic capability routes or tools are mounted. Opaque action links are also disabled. Inspection grants nothing and does not enable them."}`;
      case "credentials": {
        const caution =
          "Vault authentication and item availability: unverified. No session or vault read was attempted. Configuration is not authorization or proof of usable credentials. No account aliases, origins, vault IDs, paths, credential values, tokens or item bodies returned.";
        if (!deps.credentials)
          return `${heading}\nCredential resolver: absent. No bindings are available to inspect. ${caution}`;
        const metadata = deps.credentials.inspect();
        return `${heading}\nCredential resolver: configured. Configured bindings: ${metadata.configuredBindings}; showing ${metadata.bindings.length}. Bindings are numbered in configuration order: ${JSON.stringify(metadata.bindings)}\n${caution}`;
      }
      case "slack-search": {
        const search = deps.slackSearch;
        const token =
          event?.address.channel !== "slack"
            ? "not applicable: no current Slack message"
            : !search?.enabled
              ? "not checked: public search is disabled"
              : !search.hasActionToken
                ? "unknown: token inspection is unavailable"
                : search.hasActionToken(event)
                  ? "present and unconsumed in the local cache; Slack validity is unverified"
                  : "unavailable: missing, expired, consumed, or lost on restart; a fresh owner Slack message is required";
        return `${heading}\nPublic Slack RTS (assistant.search.context). Runtime slack.searchEnabled: ${search ? String(search.enabled) : "unavailable: Slack is not configured"}. Required bot scope: search:read.public; actual installed bot grant is unverified by this inspection. Saved permissions, requested manifest scopes, and separate MCP/user OAuth grants do not establish this bot grant or live search availability.\nCurrent-message action token: ${token}.\nLive search access is unverified, even with the runtime enabled and a local token present. This snapshot is not reusable authorization for another message. No Slack request was made, no token was consumed or returned, and no search or OAuth scope was enabled. Private/DM search and MCP tool permissions are separate.`;
      }
      case "snapshot-retention": {
        const personality = deps.memory?.personality;
        if (!personality)
          return `${heading}\nCurated snapshot retention dry run is unavailable.`;
        return `${heading}\nCurated snapshot retention dry run: ${JSON.stringify(personality.retentionReport())}\nPreserve all snapshots referenced by curated history for historical reads and rollback, even after logical source deletion. Counts/bytes cover observed files only; incomplete scans are lower bounds and null means unknown, not zero. File presence is not authentication or proof of restore readiness. Unreferenced files are operator-review candidates only: they may belong to an in-flight write, another ref or backup. No deletion is authorized or performed; no age policy or backup dependency check was applied. Preserve Git metadata, encrypted snapshots, separately managed keys and independent tombstones throughout backup retention; replay later tombstones before serving restored data. Other retained copies remain unknown. No private contents, paths or identifiers returned.`;
      }
      case "operations": {
        // Probe and marker reads fail independently; neither implies the other.
        const ready = await Promise.resolve()
          .then(() => deps.processHealth?.())
          .catch(() => undefined);
        const health = `${heading}\nProcess/engine readiness: ${ready === undefined ? "unavailable" : ready ? "ready" : "not ready"}. This checks process admission and Rivet runtime readiness, as /health does, not workflow advancement. Dormant actors are not surveyed; their replay and progress remain unverified even when ready.`;
        const snapshot = await Promise.resolve()
          .then(() => deps.operations?.())
          .catch(() => undefined);
        if (!snapshot)
          return `${health}\nDurable operation diagnostics are unavailable; unresolved counts are unknown, not zero. Settlement cannot be inferred.`;
        return `${health}\nOwner-private conversation markers only, not all actors or external operations. ${JSON.stringify(snapshot)}\nListed operations are unresolved, not failed or successful. Started/sending may still be active, including this inspection's model turn. Uncertain/unknown has no confirmed outcome. Settled invocations are omitted, not proof of success. Missing marker maps and zero counts do not establish complete coverage; older operations may be unrecorded. Process health, idle state and restart do not prove settlement or stoppage. IDs are hashed; no message bodies, queries, destinations, errors or credentials are returned. No retry, cancellation, reconciliation or admission release was performed.`;
      }
      case "mcp-connections":
        return deps.mcp
          ? `${heading}\n${JSON.stringify(deps.mcp.inventory())}\nAt most 20 connections. Configuration, saved credentials and past discovery are not live health or verified authorization. Refs are opaque display labels, not catalog IDs. Names, endpoints, credentials and tool contracts are omitted. No server was contacted or permission changed.`
          : `${heading}\nMCP is disconnected: integration disabled; no active connection inventory. No server was contacted and no health or authorization is inferred.`;
      case "mcp-enrollment": {
        const caution =
          "No enrollment, authentication, discovery or permission change was performed. Saved credentials and past discovery do not prove current authorization or server availability. Never send credentials in chat.";
        if (!deps.mcp)
          return `${heading}\nHost configuration required: MCP integration is disabled. The owner/operator must review and configure the private console and encrypted MCP store before enrollment. This is not a server outage; owner consent is not established. ${caution}`;
        const inventory = deps.mcp.inventory();
        const steps = {
          renew_authentication:
            "Saved credential expired. The owner must renew authentication in Connections; Slack reconnect resets tool permissions.",
          owner_authentication_required:
            "No Slack authorization is saved. The owner must review Slack consent and save authorization in Connections; bot login is not user consent.",
          owner_discovery_required:
            "Not tested. The owner can review the destination and choose Test & discover tools; discovery sends any saved credential but runs no tools.",
          review_discovery_failure:
            "Discovery failed; cause unknown. The owner must check the endpoint, authentication/account permissions and server availability before deliberately testing again. This does not prove a server outage.",
          no_tools_discovered:
            "Past discovery returned no tools. The owner must check the intended account/server configuration; granting permission cannot create tools.",
          owner_tool_consent_required:
            "Discovered tools are disabled. The owner must review contracts and grant the intended permissions in Connections; do not enable tools automatically.",
          no_enrollment_step_known:
            "Saved tool permissions exist. No further enrollment step is known locally; approval-required tools still need exact single-use owner approval.",
        };
        const rows = inventory.connections.map((connection) => {
          const { tools } = connection;
          const next =
            connection.credential === "expired"
              ? "renew_authentication"
              : connection.kind === "slack" &&
                  connection.credential === "absent"
                ? "owner_authentication_required"
                : connection.lastDiscovery === "not_tested"
                  ? "owner_discovery_required"
                  : connection.lastDiscovery === "failed"
                    ? "review_discovery_failure"
                    : tools.disabled + tools.read + tools.approval === 0
                      ? "no_tools_discovered"
                      : tools.read + tools.approval === 0
                        ? "owner_tool_consent_required"
                        : "no_enrollment_step_known";
          return {
            ref: connection.ref,
            kind: connection.kind,
            credential: connection.credential,
            next,
          } as const;
        });
        const slack = inventory.connections.find((row) => row.kind === "slack");
        const slackEnrollment = slack
          ? ""
          : inventory.truncated
            ? "Slack enrollment status is unknown because inventory is truncated. Check the existing connection in Connections before any sign-in."
            : "No saved Slack authorization is visible. To use Slack, the owner must review user consent and save authorization after host setup.";
        const report = () => {
          const guidance = [...new Set(rows.map((row) => row.next))]
            .map((step) => `${step}: ${steps[step]}`)
            .join("\n");
          return `${heading}\nHost configuration loaded. Saved connections: ${inventory.configuredConnections}; showing ${rows.length}; omitted: ${inventory.configuredConnections - rows.length}. Check Connections for omitted rows.\n${inventory.configuredConnections === 0 ? "Owner enrollment required: no connections saved. The owner can add a trusted server in Connections; no consent or server health is established.\n" : ""}Slack OAuth setup (optional for other servers): ${deps.slackMcpConfigured ? "configured locally; provider app setup is not verified" : "configuration required for Slack enrollment/reconnect; the owner/operator must configure the Slack app and dashboard callback"}. ${slackEnrollment}\nBrowser consent/save progress is unknown here. The owner should check Connections for Resume Slack setup before starting another sign-in. Saving authorization does not enable tools.\n${JSON.stringify(rows)}\n${guidance}\nFor remote servers, an absent credential is not automatically a blocker: public servers may need none; the server's requirement is unknown here. ${caution}`;
        };
        let text = report();
        // Preserve the checklist and caveats within the smallest chat limit.
        while (text.length > 3500 && rows.length) {
          rows.pop();
          text = report();
        }
        return text;
      }
      case "native-coding":
        return deps.nativeCoding
          ? deps.nativeCoding()
          : `${heading}\nNative coding preflight is unavailable; readiness cannot be inferred.`;
      case "retention":
        // Wiring only: even apparently read-only store/actor getters can
        // decrypt evidence or prune state. Do not enumerate retained data.
        return [
          heading,
          "Retained-copy category inventory, not a census of files or messages. Basis: current runtime wiring and implementation behavior only; no storage or provider scan.",
          `Ledger: ${deps.memory ? "configured" : "not configured in this runtime"}. Source deletion removes affected sources and dependent claims/proposals from the active evidence ledger and retains tombstones. Per-source deletion status is unknown here; no source was checked. Encryption and SQLite secure deletion are not proof of physical erasure across copies.`,
          "Rivet journals: runtime persistence can retain historical conversation, workflow and delivery payloads. Clearing current actor state does not purge old journals. The optional evidence-ledger encryption does not encrypt Rivet data. Retained contents and copy counts are unknown.",
          `Snapshots: curated encrypted snapshot storage is ${deps.memory?.personality ? "configured" : "not configured in this runtime"}. Logical deletion filters evidence-derived projections, not old encrypted revisions. Git rollback is not erasure. Historical curated copies and filesystem snapshots may remain; their inventory is unknown.`,
          "Backups: existence, locations, ages, retention deadlines and purge status are unknown; no backup inventory was supplied or scanned. An older ledger must not serve traffic until later tombstones are replayed. Retain tombstones through the backup retention window; physical purge and retention policy require operator verification.",
          "Delivered messages: platform and recipient copies may remain after local history or delivery text is cleared. Logical forgetting does not retract already delivered messages or already submitted model requests. Platform, recipient and provider retention is unknown; no remote lookup or deletion was attempted.",
          "Physical erasure is unverified for every category. Logical deletion means removal from active use, not proof that all bytes or external copies are gone. Unknown does not mean absent; an unconfigured subsystem does not prove older copies are absent. This report contains no content, IDs, paths or keys, performs no deletion, and certifies no individual deletion request.",
        ].join("\n");
      case "backup": {
        if (!deps.memory) return `${heading}\nMemory backup is unavailable.`;
        return `${heading}\n${JSON.stringify(deps.memory.store.backupStatus())}\nLocal evidence-ledger copy only; personality, journals and external retention are not included. A watermark counts tombstone IDs in this ledger history, not global identity or retention proof. Retain later tombstones independently before restoring. This inspection created no backup. In chat, only the owner's exact private !memory-backup command creates one.`;
      }
      case "memory": {
        if (!deps.memory)
          return `${heading}\nMemory is disabled or unavailable. Counts, size and operation history are unknown, not zero.`;
        const { store, personality } = deps.memory;
        let snapshot: string;
        try {
          const capacity = store.capacity(deps.audience);
          const proposals = store.proposals(deps.audience);
          const counts = { pending: 0, accepted: 0, rejected: 0 };
          for (const proposal of proposals) counts[proposal.status]++;
          const restore = store.restoreStatus();
          snapshot = `Scoped source/claim projection: ${capacity.sources === 0 && capacity.claims === 0 ? "empty" : "nonempty"}. Authorized memory capacity: ${JSON.stringify(capacity)}. Counts cover this audience's retained sources/stored claims, not pending/rejected proposals. serializedBytes is UTF-8 JSON of {sources,claims}, with record metadata and the empty container; excludes other audiences, proposals, imports, tombstones, curated history, encryption and database overhead. This is not total ledger/disk size or model context usage. Null limits mean no audience-specific quota, not unlimited capacity; remaining capacity is unknown. Imports separately enforce ledger-wide source/claim/full-snapshot byte ceilings.\nProposal counts: ${JSON.stringify(counts)}.`;
          snapshot += `\nMemory readiness: ready. Tombstone replay: ${restore.replayedThrough === null ? "no restore receipt" : `complete through watermark ${restore.replayedThrough}`}; current deletion watermark: ${restore.deletionWatermark}. This is not proof of current independent retention. No tombstone IDs returned.`;
          const validation = store.restoreValidationStatus();
          snapshot += `\nOffline restore validation: ${validation ? JSON.stringify(validation) : "not run in this process"}. Preflight only, not independent retention proof or permission to replace any store; no automatic restore.`;
        } catch {
          snapshot =
            "Ledger snapshot failed; current counts and size are unknown. No cached or zero values substituted.";
        }
        let revisions: number | "unavailable" = "unavailable";
        try {
          revisions =
            personality?.ownerHistory().revisions.length ?? "unavailable";
        } catch {
          // A separate curated-store failure must not conceal ledger status.
        }
        return `${heading}\n${snapshot}\nLedger operations: ${JSON.stringify(store.operationStatus())}. Ledger-wide, this opening only; earlier history unknown. Timestamps: epoch ms. Retrieval counters cover retrieve() attempts, including failures; duration totals/max are elapsed ms, null max is unobserved. Read success means authenticated snapshot read; transaction success means COMMIT completed (including initial creation, excluding pre-transaction validation). Persistence counters count settled transaction attempts, not records; completed requires COMMIT. Durations are elapsed ms for the entire attempt, including failures and rollback, not disk I/O alone. No-op commits count; initial creation, pre-transaction validation, curated Git saves and historical writes are excluded. Counters reset on reopening and stop at the safe integer limit; total duration saturates there. Open is not a health check; read success does not prove writability.\nCurated revision count: ${revisions}. No evidence, proposal text, keys, error details or personality values returned.\n${MEMORY_CORRECTION_HELP}`;
      }
      case "tombstones": {
        if (!deps.memory) return `${heading}\nMemory is unavailable.`;
        return `${heading}\nTombstone export available via the owner-bearer-only GET /operator/memory/tombstones endpoint. ${JSON.stringify({ watermark: deps.memory.store.deletionRevision(), ...tombstoneExportLimits })}\nWatermark counts deleted IDs in this ledger's append history, not deletion operations. Export pages contain IDs only; this inspection returns no IDs, bodies or keys and performs no export or backup mutation. Independent retention and physical purge are not verified.`;
      }
      case "imports": {
        const imports = deps.imports;
        if (!imports) return `${heading}\nImports are unavailable.`;
        const selections = Object.entries(deps.selections).filter(
          ([, coverage]) => coverage.audiences.includes(deps.audience),
        );
        if (typeof query === "object") {
          if (query.selection === null) {
            const { json, ...page } = jsonPage(
              JSON.stringify(selections.map(([id]) => id)),
              query.offset,
            );
            return `${heading}\n${JSON.stringify({ configuredSelections: selections.length, ...page, selectionsJson: json })}\nConcatenate selectionsJson chunks using nextOffset until null. These are exact configured IDs, not proof of access or imported history. Inspect an exact ID with inspection {target:"imports",selection:ID,offset:0}. No account data was read.`;
          }
          const selected = selections.find(([id]) => id === query.selection);
          if (!selected) throw new Error("Import selection is unavailable");
          const [id, coverage] = selected;
          const { running, progress, notBefore, cooldownReason, coolingDown } =
            imports.status(id);
          if (progress && !isDeepStrictEqual(progress.coverage, coverage))
            throw new Error("Import coverage changed");
          const { platform, account, conversations, from, to } = coverage;
          const { json, ...page } = jsonPage(
            JSON.stringify({
              selection: id,
              platform,
              account,
              conversations,
              from,
              to,
            }),
            query.offset,
          );
          const scope =
            platform === "slack"
              ? "Slack account is a workspace ID. conversations are channel IDs (timeline only, not all replies) or channel/thread_ts for explicitly selected threads."
              : platform === "gmail"
                ? "Gmail account is the configured email address. conversations are label IDs, not threads or the whole mailbox. Gmail's strict after search may omit the exact lower boundary; labels can change during pagination."
                : "Provider-specific coverage semantics are unavailable.";
          return `${heading}\n${JSON.stringify({ digest: importCoverageDigest(id, coverage), ...page, coverageJson: json, running, started: progress !== undefined, pages: progress?.pages ?? 0, complete: progress?.complete ?? false, notBefore, cooldownReason, coolingDown, gapCount: progress?.gaps.length ?? 0 })}\nConcatenate coverageJson chunks using nextOffset until null; do not mix digests. from/to are configured epoch milliseconds [from,to). ${scope} Complete means selected traversal exhausted, not gap-free account history. Configuration is not verified access. notBefore is the persisted account cooldown deadline, not provider readiness; no polling or automatic retry. Cursors, gap contents, credentials and message bodies are omitted. No import was started or cancelled; no account data was read.`;
        }
        const rows = selections
          .slice(0, deps.importExtraction ? 5 : 10)
          .map(([id, coverage]) => {
            const {
              running,
              progress,
              notBefore,
              cooldownReason,
              coolingDown,
              budget,
              lastConflict,
            } = imports.status(id);
            if (progress && !isDeepStrictEqual(progress.coverage, coverage))
              throw new Error("Import coverage changed");
            const extraction = deps.importExtraction?.review(id);
            return {
              selection: id.slice(0, 80),
              conversations: coverage.conversations.length,
              from: coverage.from,
              to: coverage.to,
              running,
              started: progress !== undefined,
              pages: progress?.pages ?? 0,
              complete: progress?.complete ?? false,
              notBefore,
              cooldownReason,
              coolingDown,
              gapCount: progress?.gaps.length ?? 0,
              budgetRejected: budget.lastRejection,
              lastConflict,
              gapKinds: summarizeImportGaps(progress?.gaps ?? []),
              extraction: extraction
                ? {
                    batch: extraction.sourceIds.length,
                    eligible: extraction.eligible,
                    oversized: extraction.oversized,
                    overflow: extraction.overflow,
                    untrackedPages: extraction.untrackedPages,
                    blocked: extraction.blocked,
                    admission: extraction.admission,
                    staged: extraction.attempts.filter(
                      (e) => e.status === "staged",
                    ).length,
                    uncertain: extraction.attempts.filter(
                      (e) => e.status === "uncertain",
                    ).length,
                    cancelled: extraction.attempts.filter(
                      (e) => e.status === "cancelled",
                    ).length,
                    // Exact actionable request, never a bearer credential or a
                    // grant. Bound configured IDs keep the metadata reply small.
                    request:
                      extraction.digest && id.length <= 80
                        ? {
                            review: `/operator/imports/${encodeURIComponent(id)}/extraction`,
                            digest: extraction.digest,
                          }
                        : null,
                  }
                : undefined,
            };
          });
        const reconciliation = rows.some(
          (row) => row.lastConflict === "immutable_source",
        )
          ? "\nImmutable-source conflict: a page reused a source ID with changed fields. Rejected page: stored evidence and cursor unchanged. Saved evidence is not proof of current content. Please arrange explicit reconciliation through the authenticated operator before retrying. I cannot overwrite evidence, skip conflicts, invent replacement IDs, or authorize reconciliation. This is operator review, not a queued or completed repair."
          : "";
        const budget = deps.memory?.store.importBudget;
        const guidance = `Effective import limits: ${budget ? JSON.stringify(budget) : "unavailable"} (ledger-global import pages; full UTF-8 JSON, not disk/RAM). Small-import guidance: 1,000 sources / 4 MiB. Disposable LEGION/Node24, 2026-09-27, no claims: page max 237 ms; retrieval max 32 ms. Small samples, not a latency guarantee; claim-heavy/larger overrides unmeasured. Method: src/imports/README.md; current counters: memory inspection. No automatic cap increase.`;
        const report = () =>
          `${heading}\nConfigured selections: ${selections.length}; showing ${rows.length}. ${JSON.stringify(rows)}\n${guidance}\nnotBefore: persisted account cooldown deadline (epoch ms). cooldownReason: rate_limit, provider_backoff, pacing, unknown (legacy), or null. coolingDown is a time gate, not provider readiness. Wait until notBefore; no polling or automatic retry. Explicit operator confirmation is needed to resume, even after expiry/restart.\nbudgetRejected and lastConflict are last observed this process; page-count advancement or restart clears them, but cooldown-only updates do not. Null proves neither capacity nor absence of conflicts. Budget rejection: whole page exceeds ledger-wide source/claim/full-snapshot UTF-8 byte ceilings; no page evidence or progress committed. Reduce import or request operator capacity review.\nWindows are requested [from,to) epoch milliseconds, not verified coverage. Pages count persisted pages; a finished page does not mean pagination is exhausted. Complete means only that pagination exhausted the selected window, not gap-free coverage or complete account history. Gap counts are persisted limitation/omission notes, may repeat, and are not counts of missing messages. Zero recorded gaps is not proof of completeness; unstarted selections have not been assessed. Gap kinds are content-free summaries of recognized notes; unclassified details are withheld. Only shown selections are summarized. Raw gap contents, account/conversation IDs, cursors, provider errors, credentials and message bodies are omitted. No import was started or cancelled.${reconciliation}${deps.importExtraction ? "\nGET the request review path with owner bearer auth to check source/context IDs, coverage and model; POST that path + /start with {confirmed:true,digest}. Approval permits one batch (20 sources / 64,000 serialized characters + 20 scoped claims / 16,000 characters), one paid call, pending claims only; acceptance is separate. One slot across selections; no queue/backfill/retry. Overflow is unattempted input outside the review batch. Paused needs its blocker cleared and explicit approval. Unknown holds require operator investigation; cancellation holds capacity until settlement. Idle is not success. Oversized sources and untracked pages remain unextracted. Inspection grants nothing and runs no extraction." : "\nExtraction unavailable."}`;
        // Preserve guidance and accurate omission counts within channel limits.
        while (rows.length && report().length > 4000) rows.pop();
        return report();
      }
      case "reflection": {
        if (!deps.reflection) return `${heading}\nReflection is unavailable.`;
        const status = await deps.reflection();
        const requests = status.reflection.requests.filter(
          (request) => request.scope === deps.audience,
        );
        const counts = {
          pending: 0,
          running: 0,
          cancelling: 0,
          cancelled: 0,
          stopped: 0,
        };
        for (const request of requests) counts[request.status]++;
        const invocations = { started: 0, settled: 0, uncertain: 0 };
        const requestIds = new Set(requests.map((request) => request.id));
        for (const [key, state] of Object.entries(status.invocations))
          if (requestIds.has(JSON.parse(key)[0])) invocations[state]++;
        const now = Date.now();
        const priorities = requests
          .filter((r) => r.status === "pending")
          .map((r) => reflectionPriority(r, now))
          .sort((a, b) => b - a)
          .slice(0, 10);
        // Request/turn IDs can embed scope and evidence IDs. Only expose bounded
        // fingerprints; the authenticated operator retrieves the exact IDs.
        const reference = (id: string) =>
          createHash("sha256").update(id).digest("hex");
        const held = requests.filter(
          (request) =>
            request.status === "running" || request.status === "cancelling",
        );
        const rows = held.slice(0, 5).map((request) => ({
          reference: reference(request.id),
          status: request.status,
          attempt: request.attempts,
          invocation:
            status.invocations[
              JSON.stringify([request.id, request.attempts])
            ] ?? "not_recorded",
        }));
        const turns = status.activeTurnIds.slice(0, 5).map(reference);
        const curiosity = await deps.curiosity?.(deps.audience);
        const render =
          () => `${heading}\nScoped request counts: ${JSON.stringify(counts)}. Scoped invocation counts: ${JSON.stringify(invocations)}. Owner-wide live turns: ${status.liveActive}. Owner-wide candidate count: ${status.candidateIds.length}. Candidates are provisional, not approved messages; a live turn may invalidate them. No evidence IDs, rationale or candidate contents returned.
Pending effective priorities (highest first, up to 10): ${JSON.stringify(priorities)}. Reason: enqueue-age decay (half-life ${reflectionDriveHalfLifeMs}ms); duplicates/retries do not refresh. Ties keep enqueue order. Scores only rank eligible work: idle/deep, quiet, live reserve, cooldown, evidence and attempt gates remain; no tools or actions granted.
Held scoped requests: ${held.length}; showing ${rows.length}. ${JSON.stringify(rows)}
Owner-wide live turn references: ${status.activeTurnIds.length}; showing ${turns.length}. ${JSON.stringify(turns)}
An uncertain invocation was interrupted; its outcome is unknown, not success or confirmed failure. Running/started may still be active; cancelling is not stopped. Live occupancy may include this inspection turn and does not by itself prove interruption. Unidentified legacy live holds may also remain. Cancellation, timeout, restart, elapsed time or a model assertion cannot prove provider settlement. Do not retry unknown work or release its capacity automatically.
Reconciliation is operator-only: use the existing owner bearer authentication on the private GET /operator/reflection endpoint. References are SHA-256 of the exact UTF-8 request id or activeTurnIds entry; match locally, never paste raw IDs or credentials into chat. Inspect the old worker/provider and confirm it actually stopped. If stoppage cannot be verified, leave the hold and outcome unknown. Only after that confirmation, POST /operator/reflection/reconcile with {"id":"<exact request id>","confirmedStopped":true,"live":false}, or {"id":"<exact active turn id>","confirmedStopped":true,"live":true} for live occupancy. Never substitute a reference for an id or guess an id for a legacy hold. Require reconciled:true and read status again before reporting the hold released. Reconciliation is not successful reflection, candidate approval or permission to retry; dedupe remains. This inspection changed nothing and cannot reconcile, cancel, enqueue or send.
${curiosity ? `Curiosity (up to 10 newest; owner-private retained inputs): ${JSON.stringify(curiosity)}\nPublic search: not performed by this workflow. Current inputs are observations/corrections or dream hypotheses, not new findings. Recorded outcomes are historical judgments/hypotheses, never observations or approval; abstain may be host-generated, not proof of model evaluation. Settled means ended, not success; not-recorded is unknown. Null inputs/withheld means provenance could not be revalidated.` : "Curiosity provenance inspection is unavailable."}`;
        // Keep complete rows and all safety guidance within the smallest channel
        // text limit. Retain at least one row of each available metadata category.
        while (render().length > 4000) {
          if (curiosity && curiosity.rows.length > 1) {
            curiosity.rows.pop();
            curiosity.truncated = true;
          } else if (rows.length > 1) rows.pop();
          else if (turns.length > 1) turns.pop();
          else break;
        }
        return render();
      }
    }
  };
}
