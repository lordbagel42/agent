import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import type { MessageEvent, Owner } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import type { DeploymentFeed } from "../deployment/feed.js";
import type { Dependencies, JuneClientRegistry } from "../runtime/registry.js";
import {
  acceptEvent,
  applyAction,
  initialState,
  pending,
  tick,
  type WakeupAction,
  type WakeupEvent,
  type WakeupRun,
  type WakeupState,
} from "./state.js";

export interface WakeupDependencies {
  sources: string[];
  pollMs?: number;
  readDeployment?: () => Promise<DeploymentFeed>;
}

export function createWakeupActor(
  deps: WakeupDependencies & {
    owner: Owner;
    lifecycle?: Dependencies["lifecycle"];
    memory?: Dependencies["memory"];
  },
) {
  const guard = (key: string[]) => {
    if (key.length !== 1 || key[0] !== deps.owner.id)
      throw new Error("wakeup_owner_mismatch");
  };
  const authorized = (source: MessageEvent, evidenceIds: string[] = []) => {
    const scope = routeEvent(source, deps.owner);
    if (source.address.channel !== "slack" || !scope?.private) return false;
    const evidence = deps.memory?.source(source, JSON.stringify(scope.key));
    return (
      (!evidence || !deps.memory?.store.isDeleted(evidence.id)) &&
      evidenceIds.every(
        (id) => !!deps.memory && !deps.memory.store.isDeleted(id),
      )
    );
  };
  const revoke = (state: WakeupState, ids: string[]) => {
    for (const id of ids) {
      const job = state.jobs[id];
      if (!job?.instruction) continue;
      job.status = "cancelled";
      job.updatedAt = Date.now();
      job.name = "Forgotten wakeup";
      job.instruction = "";
      job.source.text = "";
      delete job.source.metadata;
      if (job.trigger.kind === "event") job.trigger.filters = [];
      for (const run of Object.values(state.runs)) {
        if (run.jobId !== id) continue;
        if (pending(run)) run.status = "cancelled";
        run.event.data = {};
      }
    }
  };
  const invalidate = (state: WakeupState) => {
    revoke(
      state,
      Object.values(state.jobs)
        .filter((job) => !authorized(job.source, job.evidenceIds))
        .map((job) => job.id),
    );
  };
  return actor({
    state: initialState(),
    createVars: (c): { persist: () => Promise<void> } => ({
      persist: () => c.saveState({ immediate: true }),
    }),
    queues: { wake: queue<{ wake: true }>() },
    actions: {
      async snapshot(c) {
        guard(c.key);
        invalidate(c.state);
        await c.vars.persist();
        return c.state;
      },
      /** Metadata only. Bind these tombstone dependencies before retaining reads. */
      async dependencies(c, action: WakeupAction) {
        guard(c.key);
        invalidate(c.state);
        await c.vars.persist();
        const jobs = Object.values(c.state.jobs).filter(
          (job) =>
            job.instruction &&
            (action.action === "list" ||
              ("id" in action && action.id === job.id)),
        );
        return [
          ...new Set(
            jobs.flatMap((job) => {
              const source = deps.memory?.source(
                job.source,
                JSON.stringify(["private", deps.owner.id]),
              );
              return [...job.evidenceIds, ...(source ? [source.id] : [])];
            }),
          ),
        ];
      },
      async manage(
        c,
        action: WakeupAction,
        source: MessageEvent,
        commandId: string,
        evidenceIds: string[] = [],
        originEventId?: string,
      ) {
        guard(c.key);
        if (!authorized(source, evidenceIds))
          throw new Error("wakeup_requires_owner_dm");
        invalidate(c.state);
        const result = applyAction(
          c.state,
          action,
          source,
          commandId,
          Date.now(),
          deps.sources,
          evidenceIds,
          originEventId,
        );
        await c.vars.persist();
        await c.queue.send("wake", { wake: true });
        return result;
      },
      async forget(c, originEventIds: string[]) {
        guard(c.key);
        revoke(
          c.state,
          Object.values(c.state.jobs)
            .filter((job) =>
              originEventIds.includes(job.originEventId ?? job.id),
            )
            .map((job) => job.id),
        );
        await c.vars.persist();
      },
      async publish(c, event: WakeupEvent) {
        guard(c.key);
        if (!deps.sources.includes(event.source))
          throw new Error("unknown_event_source");
        invalidate(c.state);
        const result = acceptEvent(c.state, event, Date.now());
        await c.vars.persist();
        await c.queue.send("wake", { wake: true });
        return result;
      },
      async claim(c, id: string) {
        guard(c.key);
        invalidate(c.state);
        await c.vars.persist();
        const run = c.state.runs[id];
        const job = run && c.state.jobs[run.jobId];
        if (
          !run ||
          !job ||
          !pending(run) ||
          ["paused", "cancelled"].includes(job.status)
        )
          return false;
        run.status = "running";
        await c.vars.persist();
        return true;
      },
      async complete(
        c,
        id: string,
        status: Extract<
          WakeupRun["status"],
          "completed" | "failed" | "unknown"
        >,
      ) {
        guard(c.key);
        const run = c.state.runs[id];
        if (run && pending(run)) run.status = status;
        await c.vars.persist();
      },
    },
    run: workflow(
      async (ctx) => {
        await ctx.loop("wakeups-v1", async (loop) => {
          await loop.queue.nextBatch("wake-or-timer", {
            names: ["wake"],
            count: 100,
            timeout: deps.pollMs ?? 5000,
          });
          // The fence encloses all state transitions and cross-actor dispatch.
          const release = await deps.lifecycle?.enter(ctx.abortSignal);
          try {
            await loop.step({
              name: "poll-and-dispatch",
              timeout: 0,
              run: async (step) => {
                guard(step.key);
                invalidate(step.state);
                if (deps.readDeployment) {
                  const feed = await deps
                    .readDeployment()
                    .catch(() => undefined);
                  if (!feed) step.state.deploymentIssue = "feed_unavailable";
                  else {
                    const cursor = step.state.deploymentCursor;
                    const first = feed.events[0]?.sequence;
                    if (
                      cursor !== undefined &&
                      first !== undefined &&
                      first > cursor + 1
                    )
                      step.state.deploymentIssue = "feed_gap";
                    else if (step.state.deploymentIssue === "feed_unavailable")
                      delete step.state.deploymentIssue;
                    for (const event of feed.events) {
                      if (event.sequence <= (step.state.deploymentCursor ?? -1))
                        continue;
                      acceptEvent(
                        step.state,
                        {
                          id: String(event.sequence),
                          source: "deployment",
                          type: event.status,
                          occurredAt: event.at,
                          data: {
                            ...event,
                            repository: feed.repository,
                            branch: feed.branch,
                          },
                        },
                        Date.now(),
                      );
                      step.state.deploymentCursor = event.sequence;
                    }
                  }
                }
                tick(step.state, Date.now());
                await step.vars.persist();
                if (
                  Object.values(step.state.runs).some(
                    (run) =>
                      run.status === "queued" || run.status === "running",
                  )
                ) {
                  // A queue ACK is durable, but a host crash can leave its
                  // consumer asleep. Reactivate it without re-enqueuing work.
                  await step
                    .client<JuneClientRegistry>()
                    .conversation.getOrCreate(["private", deps.owner.id])
                    .wake()
                    .catch(() => {
                      if (step.abortSignal.aborted)
                        throw step.abortSignal.reason;
                    });
                }
                for (const run of Object.values(step.state.runs)) {
                  if (run.status !== "pending") continue;
                  const job = step.state.jobs[run.jobId];
                  if (!job || ["paused", "cancelled"].includes(job.status))
                    continue;
                  if (!authorized(job.source, job.evidenceIds)) {
                    revoke(step.state, [job.id]);
                    await step.vars.persist();
                    continue;
                  }
                  try {
                    await step
                      .client<JuneClientRegistry>()
                      .conversation.getOrCreate(["private", deps.owner.id])
                      .notify({
                        type: "wakeup",
                        source: job.source,
                        wakeup: {
                          runId: run.id,
                          jobId: job.id,
                          ...(job.originEventId
                            ? { originEventId: job.originEventId }
                            : {}),
                          instruction: job.instruction,
                          event: run.event,
                        },
                      });
                    // Conversation admission can race this receipt; never regress running/completed.
                    const current = step.state.runs[run.id];
                    if (current?.status === "pending")
                      current.status = "queued";
                    await step.vars.persist();
                  } catch {
                    // Stable occurrence IDs make an uncertain queue ACK safe to retry.
                    // External model/send effects remain the conversation's responsibility.
                    if (step.abortSignal.aborted) throw step.abortSignal.reason;
                    break;
                  }
                }
              },
            });
          } finally {
            release?.();
          }
        });
      },
      {
        onError(ctx) {
          if (!ctx.abortSignal.aborted) deps.lifecycle?.fail();
        },
      },
    ),
  });
}
