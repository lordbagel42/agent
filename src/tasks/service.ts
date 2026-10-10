import {
  type CapabilityInvocationContext,
  type TaskView,
  type TaskViewPort,
  taskViewSchema,
} from "../capabilities/contracts.js";
import { currentObservation } from "../operations/capability-readiness.js";
import type {
  WorkflowDependencies,
  WorkflowPresentationSnapshot,
} from "../workflows/contracts.js";
import { workflowTaskIdSchema } from "./contracts.js";

const FRESHNESS_MS = 60_000;
const MAX_ENTRIES = 128;
const receiptStatuses = [
  "started",
  "completed",
  "unknown",
  "not_started",
  "failed",
] as const;

type ObservePresentation = NonNullable<
  WorkflowDependencies["observePresentation"]
>;
type Readable = Parameters<ObservePresentation>[1];
type Entry = { view: TaskView; deletionRevision: number; readable: Readable };

function current(context: CapabilityInvocationContext): boolean {
  return (
    context.turn === "execution" &&
    !!context.event &&
    context.audience === JSON.stringify(context.scope.key) &&
    !context.signal.aborted &&
    context.valid() &&
    context.canStartAction()
  );
}

function project(view: WorkflowPresentationSnapshot): Pick<
  TaskView,
  "state"
> & {
  reason: string;
} {
  const counts = {
    started: 0,
    completed: 0,
    unknown: 0,
    not_started: 0,
    failed: 0,
    unrecognized: 0,
  };
  for (const status of view.operationStatuses) {
    const known = receiptStatuses.find((candidate) => candidate === status);
    counts[known ?? "unrecognized"]++;
  }
  const uncertain = counts.unknown > 0 || counts.unrecognized > 0;
  let state: TaskView["state"];
  switch (view.status) {
    case "cancelled":
    case "failed":
      state = view.status;
      break;
    case "queued":
    case "running":
    case "waiting":
      state = uncertain ? "unknown" : view.status;
      break;
    case "completed":
      state = view.operationStatuses.every((status) => status === "completed")
        ? "complete"
        : "unknown";
      break;
    case "needs_review":
      state =
        uncertain || counts.started > 0 || view.operationStatuses.length === 0
          ? "unknown"
          : "blocked";
      break;
    default:
      state = "unknown";
  }
  const sourceState = [
    "queued",
    "running",
    "waiting",
    "completed",
    "failed",
    "needs_review",
    "cancelled",
  ].includes(view.status)
    ? view.status
    : "unrecognized";
  return {
    state,
    reason: `Source run state: ${sourceState}. Journal receipt counts (not distinct effects): ${JSON.stringify(counts)}. No linked external operation IDs or delivery receipts. Run status and absent history do not prove fencing, settlement or reversal of effects.`,
  };
}

/** Last-published metadata only. Source lookup never creates/wakes a workflow actor
 * or refreshes evidence. Existing worker authorization/delivery fences still run. */
export function createTaskViewProjection(): {
  tasks: TaskViewPort;
  observePresentation: ObservePresentation;
} {
  const entries = new Map<string, Entry>();
  const prune = (now: number) => {
    for (const [id, entry] of entries) {
      if (currentObservation(entry.view.observation, now).freshness !== "fresh")
        entries.delete(id);
    }
  };
  const tasks: TaskViewPort = {
    async inspect(context, id) {
      if (!workflowTaskIdSchema.safeParse(id).success || !current(context))
        return null;
      if (!(await context.canDeliver()) || !current(context)) return null;
      prune(Date.now());
      const entry = entries.get(id);
      if (!entry) return null;
      const readable = () => {
        try {
          return (
            entries.get(id) === entry &&
            entry.deletionRevision === context.deletionRevision &&
            entry.readable(context.event)
          );
        } catch {
          // Source-reader failure reveals neither private errors nor existence.
          return false;
        }
      };
      if (
        !readable() ||
        !(await context.canDeliver()) ||
        !current(context) ||
        !readable()
      )
        return null;
      const observation = currentObservation(
        entry.view.observation,
        Date.now(),
      );
      if (observation.freshness !== "fresh") {
        entries.delete(id);
        return null;
      }
      const result = taskViewSchema.parse({ ...entry.view, observation });
      try {
        if (!context.outputGuards) return null;
        context.outputGuards.register(result, () => {
          try {
            return (
              current(context) &&
              readable() &&
              currentObservation(entry.view.observation, Date.now())
                .freshness === "fresh"
            );
          } catch {
            return false;
          }
        });
      } catch {
        return null;
      }
      return result;
    },
  };
  return {
    tasks,
    observePresentation(snapshot, readable) {
      const now = Date.now();
      prune(now);
      const id = `workflow:${snapshot.runId}`;
      if (
        !workflowTaskIdSchema.safeParse(id).success ||
        !/^[a-f0-9]{64}$/.test(snapshot.revision) ||
        !/^[a-f0-9]{64}$/.test(snapshot.sourceScope) ||
        !Number.isSafeInteger(snapshot.deletionRevision) ||
        snapshot.deletionRevision < 0 ||
        !Number.isSafeInteger(snapshot.capturedAt) ||
        snapshot.capturedAt < 0 ||
        snapshot.status === "empty" ||
        snapshot.status === "revoked"
      )
        return;
      const { state, reason } = project(snapshot);
      const scope = `workflow-source:${snapshot.sourceScope}`;
      const observation = currentObservation(
        {
          value: "yes",
          observedAt: snapshot.capturedAt,
          expiresAt: snapshot.capturedAt + FRESHNESS_MS,
          revision: null,
          freshness: "unknown",
          scope,
          source: `workflow owner saved-state publication; definition revision ${snapshot.revision}`,
          reason,
        },
        now,
      );
      if (observation.freshness !== "fresh") return;
      const view = taskViewSchema.safeParse({
        id,
        owner: "workflowRun",
        scope,
        state,
        delivery: "unknown",
        operationIds: [],
        observation,
      });
      if (!view.success) return;
      const previous = entries.get(id);
      if ((previous?.view.observation.observedAt ?? 0) > snapshot.capturedAt)
        return;
      entries.delete(id);
      entries.set(id, {
        view: view.data,
        deletionRevision: snapshot.deletionRevision,
        readable,
      });
      if (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
  };
}
