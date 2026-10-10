import { createHash } from "node:crypto";
import { actor, queue, type Registry } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import type { MessageEvent, ModelProvider } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import {
  guardWorkflowActor,
  terminalWorkflowError,
} from "../runtime/lifecycle.js";
import type { createPriorityAdmission } from "../runtime/priority.js";
import type { Dependencies } from "../runtime/registry.js";
import {
  ResearchBatchError,
  type ResearchFinding,
  runResearchBatch,
} from "./batch.js";
import { researchCommandSchema } from "./contracts.js";

export interface ResearchDependencies {
  model: ModelProvider;
  pollMs?: number;
  now?: () => number;
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const revision = (deps: Dependencies) =>
  deps.memory?.store.deletionRevision() ?? 0;
const day = 86_400_000;
interface Spec {
  id: string;
  goal: string;
  connections: string[];
  intervalMinutes: number;
  dailyBatches: number;
  createdAt: number;
  origin: MessageEvent;
  scopeKey?: string[];
  deletionRevision: number;
  evidenceIds: string[];
}
type Status =
  | "active"
  | "paused"
  | "stopped"
  | "completed"
  | "needs_review"
  | "revoked";
interface State {
  spec: Spec | null;
  status: Status;
  phase: "idle" | "started";
  reason: string;
  nextAt: number;
  windowStart: number;
  windowUsed: number;
  batches: number;
  emptyBatches: number;
  checkpoint: string;
  findings: ResearchFinding[];
  commands: string[];
}
const sourceScope = (source: MessageEvent, scopeKey: string[]) =>
  hash([
    scopeKey,
    source.senderId,
    source.address.channel,
    source.address.accountId,
    source.address.conversationId,
    source.address.threadId ?? "",
  ]);
const current = (deps: Dependencies, spec: Spec) =>
  deps.channels[spec.origin.address.channel]?.sourceActive?.(spec.origin) !==
    false &&
  hash(routeEvent(spec.origin, deps.owner)?.key ?? null) ===
    hash(spec.scopeKey ?? ["private", deps.owner.id]) &&
  (spec.origin.address.channel !== "agent" ||
    deps.agents?.clientActive(spec.origin.senderId) === true) &&
  spec.deletionRevision === revision(deps) &&
  spec.evidenceIds.every((id) =>
    id.startsWith("volatile-context:continuity:")
      ? deps.continuity?.valid(id) === true
      : !!deps.memory && !deps.memory.store.isDeleted(id),
  );
const revoke = (state: State) => {
  state.status = "revoked";
  state.spec = null;
  state.checkpoint = "";
  state.findings = [];
  state.commands = [];
  state.reason = "forgotten_or_authority_changed";
};
const summary = (state: State) => ({
  id: state.spec?.id,
  goal: state.spec?.goal.slice(0, 240),
  status: state.status,
  inFlight: state.phase === "started",
  reason: state.reason,
  nextAt: state.nextAt,
  batches: state.batches,
  windowStart: state.windowStart,
  windowUsed: state.windowUsed,
  dailyBatches: state.spec?.dailyBatches,
  intervalMinutes: state.spec?.intervalMinutes,
  findingCount: state.findings.length,
});

export function createResearchSessionActor(
  deps: Dependencies,
  priority: ReturnType<typeof createPriorityAdmission>,
) {
  const now = () => deps.research?.now?.() ?? Date.now();
  const definition = actor({
    state: {
      spec: null,
      status: "paused",
      phase: "idle",
      reason: "",
      nextAt: 0,
      windowStart: 0,
      windowUsed: 0,
      batches: 0,
      emptyBatches: 0,
      checkpoint: "",
      findings: [],
      commands: [],
    } as State,
    createVars: (
      c,
    ): {
      persist(): Promise<void>;
      controller?: AbortController;
      tail: Promise<void>;
    } => ({
      persist: () => c.saveState({ immediate: true }),
      tail: Promise.resolve(),
    }),
    queues: { wake: queue<null>() },
    actions: {
      async submit(c, spec: Spec) {
        if (
          c.key.length !== 2 ||
          c.key[0] !== deps.owner.id ||
          c.key[1] !== spec.id ||
          !current(deps, spec)
        )
          throw new Error("research_denied");
        // A terminal revoked receipt is never permission to restore its payload.
        if (c.state.status === "revoked") return;
        if (!c.state.spec) {
          c.state.spec = spec;
          c.state.status = "active";
          c.state.nextAt = spec.createdAt;
          c.state.windowStart = spec.createdAt;
        } else if (hash(c.state.spec) !== hash(spec))
          throw new Error("research_conflict");
        if (!deps.research && c.state.status === "active") {
          c.state.status = "paused";
          c.state.reason = "integration_disabled";
        }
        await c.vars.persist();
        await c.queue.send("wake", null);
      },
      isSettled(c) {
        return c.state.phase === "idle";
      },
      async inspect(c, offset = 0, metadata = false) {
        if (c.key[0] !== deps.owner.id) throw new Error("research_denied");
        if (!c.state.spec || !current(deps, c.state.spec)) {
          revoke(c.state);
          c.vars.controller?.abort();
          await c.vars.persist();
          return { status: "revoked" };
        }
        if (metadata) return summary(c.state);
        const report = {
          ...summary(c.state),
          checkpoint: c.state.checkpoint,
          findings: [] as ResearchFinding[],
          nextOffset: null as number | null,
        };
        for (const finding of c.state.findings.slice(offset, offset + 10)) {
          report.findings.push(finding);
          if (JSON.stringify(report).length > 7980) {
            report.findings.pop();
            break;
          }
        }
        const end = offset + report.findings.length;
        report.nextOffset = end < c.state.findings.length ? end : null;
        return report;
      },
      async control(c, action: "pause" | "resume" | "stop", commandId: string) {
        const previous = c.vars.tail;
        const lock = Promise.withResolvers<void>();
        c.vars.tail = lock.promise;
        await previous;
        try {
          if (
            c.key[0] !== deps.owner.id ||
            !deps.research ||
            !c.state.spec ||
            !current(deps, c.state.spec)
          )
            throw new Error("research_denied");
          if (c.state.commands.includes(commandId)) return summary(c.state);
          if (c.state.commands.length >= 512 && action !== "stop")
            throw new Error("research_command_limit");
          if (action === "resume") {
            if (
              c.state.status !== "paused" ||
              c.state.phase === "started" ||
              c.state.reason === "storage_limit"
            )
              throw new Error("research_not_resumable");
            c.state.status = "active";
          } else {
            if (action === "stop") c.state.status = "stopped";
            else if (c.state.status === "active") c.state.status = "paused";
            c.vars.controller?.abort();
          }
          if (c.state.commands.length < 512) c.state.commands.push(commandId);
          await c.vars.persist();
          await c.queue.send("wake", null);
          return summary(c.state);
        } finally {
          lock.resolve();
        }
      },
      async invalidate(c, cutoff: number) {
        if (c.state.spec && c.state.spec.deletionRevision >= cutoff) return;
        revoke(c.state);
        c.vars.controller?.abort();
        await c.vars.persist();
        await c.queue.send("wake", null);
      },
    },
    run: workflow(
      async (ctx) => {
        await ctx.loop("research-v1", async (loop) => {
          await loop.queue.nextBatch("wake-or-timer", {
            names: ["wake"],
            count: 100,
            timeout: deps.research?.pollMs ?? 30_000,
          });
          await loop.step({
            name: "batch",
            timeout: 0,
            maxRetries: 0,
            run: async (step) => {
              const state = step.state;
              const spec = state.spec;
              if (!spec) return;
              if (!current(deps, spec)) {
                revoke(state);
                await step.vars.persist();
                return;
              }
              // Durable intent survives process death; no replay of an uncertain
              // inference or remote read even if its native step did not commit.
              if (state.phase === "started") {
                if (state.status === "active") {
                  state.status = "needs_review";
                  state.reason = "interrupted_batch";
                  await step.vars.persist();
                }
                return;
              }
              if (!deps.research) {
                if (state.status === "active") {
                  state.status = "paused";
                  state.reason = "integration_disabled";
                  await step.vars.persist();
                }
                return;
              }
              if (state.status !== "active" || state.nextAt > now()) return;
              if (now() >= state.windowStart + day) {
                state.windowStart = now();
                state.windowUsed = 0;
              }
              if (state.windowUsed >= spec.dailyBatches) {
                state.reason = "daily_limit";
                state.nextAt = state.windowStart + day;
                await step.vars.persist();
                return;
              }
              const controller = new AbortController();
              step.vars.controller = controller;
              const sourceWatch = deps.channels[
                spec.origin.address.channel
              ]?.watchSource?.(spec.origin);
              const signal = AbortSignal.any([
                controller.signal,
                step.abortSignal,
                AbortSignal.timeout(180_000),
                ...(sourceWatch ? [sourceWatch.signal] : []),
              ]);
              const usable = () =>
                !signal.aborted &&
                !!deps.research &&
                state.status === "active" &&
                state.spec !== null &&
                current(deps, spec);
              let releasePriority: (() => void) | undefined;
              let releaseLifecycle: (() => void) | undefined;
              let uncertain = false;
              try {
                releasePriority = await priority.enter("background", signal);
                if (!releasePriority || !usable()) return;
                releaseLifecycle = await deps.lifecycle?.enter(
                  step.abortSignal,
                );
                if (!usable()) return;
                state.phase = "started";
                state.reason = "";
                state.windowUsed++;
                await step.vars.persist();
                if (!usable()) return;
                const batch = await runResearchBatch({
                  model: (deps.research as ResearchDependencies).model,
                  webSearch: deps.webSearch,
                  mcpAvailable: deps.mcpAvailable === true,
                  goal: spec.goal,
                  connections: spec.connections,
                  checkpoint: state.checkpoint,
                  findings: JSON.parse(JSON.stringify(state.findings)),
                  now: now(),
                  signal,
                  current: usable,
                });
                if (!usable()) return;
                const keys = new Set(
                  state.findings.map(
                    (f) =>
                      f.email?.toLowerCase() ??
                      `${f.url}\n${f.title.toLowerCase()}`,
                  ),
                );
                let added = 0;
                for (const finding of batch.findings) {
                  const key =
                    finding.email?.toLowerCase() ??
                    `${finding.url}\n${finding.title.toLowerCase()}`;
                  if (keys.has(key)) continue;
                  // Never inflate actor state toward Rivet's transaction ceiling.
                  if (
                    Buffer.byteLength(JSON.stringify(state.findings)) +
                      Buffer.byteLength(JSON.stringify(finding)) >
                    180_000
                  ) {
                    state.status = "paused";
                    state.reason = "storage_limit";
                    break;
                  }
                  keys.add(key);
                  state.findings.push(finding);
                  added++;
                }
                state.checkpoint = batch.checkpoint;
                state.batches++;
                state.emptyBatches = added
                  ? 0
                  : Math.min(8, state.emptyBatches + 1);
                state.nextAt =
                  now() +
                  Math.min(
                    Math.max(360, spec.intervalMinutes),
                    spec.intervalMinutes * 2 ** state.emptyBatches,
                  ) *
                    60_000;
                if (batch.done && state.status === "active")
                  state.status = "completed";
                state.phase = "idle";
              } catch (error) {
                // A deleted payload or a stop request cannot retire unknown IO.
                uncertain =
                  state.phase === "started" &&
                  (!(error instanceof ResearchBatchError) ||
                    error.reason === "unknown");
                if (uncertain) deps.lifecycle?.fail();
                if (state.spec && current(deps, spec)) {
                  if (
                    error instanceof ResearchBatchError &&
                    error.reason === "not_started"
                  ) {
                    state.nextAt =
                      now() + Math.max(5, spec.intervalMinutes) * 60_000;
                    state.reason = "provider_not_started";
                    state.phase = "idle";
                  } else if (state.phase === "started") {
                    // An action can stop the session while provider IO awaits.
                    if ((state.status as Status) !== "stopped")
                      state.status = "needs_review";
                    state.reason =
                      error instanceof ResearchBatchError
                        ? error.reason
                        : "unknown";
                  }
                }
              } finally {
                sourceWatch?.dispose();
                if (!uncertain) state.phase = "idle";
                if (state.spec && !current(deps, spec)) revoke(state);
                await step.vars.persist();
                delete step.vars.controller;
                releaseLifecycle?.();
                // Keep uncertain occupancy until process retirement. Lifecycle
                // failure also prevents a successful drain or new admission.
                if (!uncertain) releasePriority?.();
              }
            },
          });
        });
      },
      {
        onError: async (c, event) => {
          if (c.abortSignal.aborted || !terminalWorkflowError(event)) return;
          deps.lifecycle?.fail();
          if (c.state.status === "active") {
            c.state.status = "needs_review";
            c.state.reason = "storage_or_workflow_failure";
            await c.vars.persist();
          }
        },
      },
    ),
  });
  return guardWorkflowActor(definition, deps.lifecycle);
}

type ResearchRegistry = Registry<{
  researchSession: ReturnType<typeof createResearchSessionActor>;
}>;
export function createResearchLibraryActor(deps: Dependencies) {
  return actor({
    // Null retains a content-free identity for unresolved IO after forgetting.
    state: { sessions: {} as Record<string, Spec | null> },
    createVars: () => ({ tail: Promise.resolve() }),
    actions: {
      async isSettled(c) {
        if (c.key.length !== 1 || c.key[0] !== deps.owner.id)
          throw new Error("research_denied");
        for (const id of Object.keys(c.state.sessions)) {
          if (
            !(await c
              .client<ResearchRegistry>()
              .researchSession.getOrCreate([deps.owner.id, id])
              .isSettled())
          )
            return false;
        }
        return true;
      },
      async recover(c) {
        if (c.key.length !== 1 || c.key[0] !== deps.owner.id)
          throw new Error("research_denied");
        for (const spec of Object.values(c.state.sessions)) {
          if (!spec) continue;
          const session = c
            .client<ResearchRegistry>()
            .researchSession.getOrCreate([deps.owner.id, spec.id]);
          if (current(deps, spec)) await session.submit(spec);
          else {
            await session.invalidate(revision(deps) + 1);
            c.state.sessions[spec.id] = null;
          }
        }
        await c.saveState({ immediate: true });
      },
      async invalidate(c, cutoff: number) {
        for (const [id, spec] of Object.entries(c.state.sessions)) {
          if (!spec || spec.deletionRevision >= cutoff) continue;
          await c
            .client<ResearchRegistry>()
            .researchSession.getOrCreate([deps.owner.id, id])
            .invalidate(cutoff);
          c.state.sessions[id] = null;
        }
        await c.saveState({ immediate: true });
      },
      async manage(
        c,
        source: MessageEvent,
        operationId: string,
        raw: unknown,
        deletionRevision: number,
        evidenceIds: string[] = [],
      ): Promise<string> {
        const previous = c.vars.tail;
        const lock = Promise.withResolvers<void>();
        c.vars.tail = lock.promise;
        await previous;
        try {
          const scope = routeEvent(source, deps.owner);
          if (
            c.key.length !== 1 ||
            c.key[0] !== deps.owner.id ||
            !deps.research ||
            !scope ||
            (source.address.channel === "agent" &&
              deps.agents?.clientActive(source.senderId) !== true) ||
            deletionRevision !== revision(deps)
          )
            throw new Error("research_denied");
          const inScope = (spec: Spec) =>
            sourceScope(source, scope.key) ===
            sourceScope(
              spec.origin,
              spec.scopeKey ?? ["private", deps.owner.id],
            );
          const command = researchCommandSchema.parse(raw);
          const id =
            command.id ?? hash([deps.owner.id, operationId, "research"]);
          const session = (id: string) =>
            c
              .client<ResearchRegistry>()
              .researchSession.getOrCreate([deps.owner.id, id]);
          let report: Record<string, unknown>;
          let resultIds: string[] = [];
          if (command.action === "start") {
            let spec = c.state.sessions[id];
            if (spec === null) throw new Error("research_revoked");
            if (!spec) {
              if (Object.keys(c.state.sessions).length >= 32)
                throw new Error("research_session_limit");
              const ownSource = deps.memory?.source(
                source,
                JSON.stringify(scope.key),
              );
              const ids = [
                ...new Set([
                  ...evidenceIds,
                  ...(ownSource ? [ownSource.id] : []),
                ]),
              ];
              if (ids.length > 128 || ids.some((id) => id.length > 2048))
                throw new Error("research_evidence_limit");
              spec = {
                id,
                goal: command.goal as string,
                connections: command.connections,
                intervalMinutes: command.intervalMinutes ?? 5,
                dailyBatches: command.dailyBatches ?? 48,
                createdAt: deps.research.now?.() ?? Date.now(),
                scopeKey: scope.key,
                deletionRevision,
                evidenceIds: ids,
                origin: {
                  type: "message",
                  id: source.id,
                  messageId: source.messageId,
                  occurredAt: source.occurredAt,
                  senderId: source.senderId,
                  direct: source.direct,
                  address: source.address,
                  botMentioned: source.botMentioned,
                  threadFollowup: source.threadFollowup,
                  questionAnswered: source.questionAnswered,
                  metadata: { channelType: source.metadata?.channelType },
                  text: "",
                },
              };
              if (!current(deps, spec)) throw new Error("research_revoked");
              if (
                Buffer.byteLength(JSON.stringify(spec)) > 12_000 ||
                Buffer.byteLength(JSON.stringify(c.state.sessions)) +
                  Buffer.byteLength(JSON.stringify(spec)) >
                  120_000
              )
                throw new Error("research_session_limit");
              c.state.sessions[id] = spec;
              await c.saveState({ immediate: true });
            } else if (
              !inScope(spec) ||
              spec.goal !== command.goal ||
              hash(spec.connections) !== hash(command.connections) ||
              spec.dailyBatches !== (command.dailyBatches ?? 48) ||
              spec.intervalMinutes !== (command.intervalMinutes ?? 5)
            )
              throw new Error("research_start_conflict");
            resultIds = spec.evidenceIds;
            await session(id).submit(spec);
            report = {
              id,
              status: "accepted",
              intervalMinutes: spec.intervalMinutes,
              dailyBatches: spec.dailyBatches,
            };
          } else if (command.action === "list") {
            const entries = Object.values(c.state.sessions).filter(
              (spec): spec is Spec =>
                !!spec && inScope(spec) && current(deps, spec),
            );
            const page = entries.slice(command.offset, command.offset + 5);
            resultIds = page.flatMap((spec) => spec.evidenceIds);
            report = {
              sessions: await Promise.all(
                page.map((spec) => session(spec.id).inspect(0, true)),
              ),
              nextOffset:
                command.offset + 5 < entries.length ? command.offset + 5 : null,
            };
          } else {
            const spec = c.state.sessions[id];
            if (!spec || !inScope(spec) || !current(deps, spec))
              throw new Error("research_unavailable");
            resultIds = spec.evidenceIds;
            report =
              command.action === "inspect"
                ? await session(id).inspect(command.offset)
                : await session(id).control(
                    command.action,
                    hash([operationId, command]),
                  );
          }
          if (deletionRevision !== revision(deps))
            throw new Error("research_revoked");
          // One snapshot binds the selected report and its deletion ancestry.
          // The host consumes evidenceIds before any model sees the report.
          return JSON.stringify({
            ...report,
            evidenceIds: [...new Set(resultIds)],
          });
        } finally {
          lock.resolve();
        }
      },
    },
  });
}
