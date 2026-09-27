import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import type {
  createWorktreeManager,
  VerificationResult,
  WorktreeManifest,
} from "../coding/worktree.js";
import type {
  CodingRequest,
  CodingRuntime,
  MessageEvent,
} from "../core/contracts.js";
import type { JuneRegistry } from "./registry.js";

export interface CodingDependencies {
  runtime: CodingRuntime;
  /** Stable binding to the operator's runtime selection and execution policy. */
  runtimeId: string;
  workspaces: Record<string, string>;
  timeoutMs: number;
  /** Missing managers fail closed, never fall back to the shared checkout. */
  isolation?: Record<string, ReturnType<typeof createWorktreeManager>>;
}

export interface JobProposal extends CodingRequest {
  id: string;
  source: MessageEvent;
}
export interface CodingState {
  proposal: JobProposal | null;
  status:
    | "empty"
    | "awaiting_approval"
    | "running"
    | "needs_review"
    | "completed";
  attempts: number;
  commandApprovals: Record<string, number | null>;
  runtimeId?: string;
  threadId?: string;
  report?: string;
  worktree?: WorktreeManifest;
  workerClaim?: string;
  verification?: VerificationResult;
  cancelRequested?: boolean;
  revoked?: boolean;
}
type Command =
  | { type: "propose"; proposal: JobProposal }
  | { type: "approve"; commandId: string }
  | { type: "resume"; commandId: string; confirmedStopped: boolean };

/** Explicit projection: never return goals, source messages, paths or raw reports. */
export function codingJobMetadata(id: string, state: CodingState) {
  return {
    id,
    workspace: state.proposal?.workspace.slice(0, 80) ?? null,
    status: state.status === "empty" ? "proposal_pending" : state.status,
    attempts: state.attempts,
    cancelRequested: state.cancelRequested === true,
    threadId: state.threadId?.slice(0, 256) ?? null,
    worktreePrepared: !!state.worktree,
    workerResultRecorded: state.workerClaim !== undefined,
    verification: state.verification
      ? {
          status: state.verification.status,
          exitCode: state.verification.exitCode,
          finishedAt: state.verification.finishedAt,
          historical: state.verification.replayed,
        }
      : null,
    // A missing saved ID is not proof that a worker never started.
    manualReconciliationRequired:
      state.status === "needs_review" && !!state.worktree && !state.threadId,
  };
}

export function createCodingActor(coding: CodingDependencies | undefined) {
  return actor({
    state: {
      proposal: null,
      status: "empty",
      attempts: 0,
      commandApprovals: {},
    } as CodingState,
    createVars: (
      c,
    ): { persist: () => Promise<void>; controller?: AbortController } => ({
      persist: () => c.saveState({ immediate: true }),
    }),
    queues: { commands: queue<Command>() },
    actions: {
      snapshot: (c): CodingState => c.state,
      // Host must expose this only through authenticated owner/operator ingress.
      cancel: async (c, revoke = false) => {
        // Forgetting is permanent, including when it overtakes a queued proposal
        // or resume. A normal cancellation may later be reconciled by the owner.
        if (revoke) c.state.revoked = true;
        c.state.cancelRequested = true;
        await c.vars.persist();
        c.vars.controller?.abort();
      },
    },
    run: workflow(async (ctx) => {
      await ctx.loop("coding-v1", async (loop) => {
        // Keep this first: an old in-flight iteration resolves to v1. Existing
        // step identities still replay, but cannot acquire new v2 effects.
        const version = await loop.getVersion("isolated-worktrees", 2);
        const [message] = await loop.queue.nextBatch("command", {
          names: ["commands"],
          count: 1,
        });
        if (!message || !coding) return;
        const command = message.body;
        if (command.type === "propose") {
          await loop.step("propose", async (step) => {
            if (
              step.state.proposal ||
              step.state.revoked ||
              !command.proposal.source.direct ||
              command.proposal.id !== step.key[1] ||
              !Object.hasOwn(coding.workspaces, command.proposal.workspace)
            )
              return;
            step.state.proposal = command.proposal;
            step.state.runtimeId = coding.runtimeId;
            step.state.status = "awaiting_approval";
            await step.vars.persist();
          });
          return;
        }
        const approved = await loop.step("check-approval", async (step) => {
          // Replaying this step returns the same grant; a duplicate queue entry
          // cannot grant another attempt after an uncertain worker has stopped.
          if (Object.hasOwn(step.state.commandApprovals, command.commandId)) {
            return step.state.commandApprovals[command.commandId] ?? null;
          }
          const allowed =
            step.state.proposal &&
            !step.state.revoked &&
            step.state.runtimeId === coding.runtimeId &&
            (command.type === "approve"
              ? step.state.status === "awaiting_approval"
              : command.confirmedStopped &&
                step.state.status === "needs_review" &&
                (!!step.state.threadId ||
                  (version >= 2 && !step.state.worktree)));
          const attempt = allowed ? step.state.attempts + 1 : null;
          step.state.commandApprovals[command.commandId] = attempt;
          if (attempt && command.type === "resume")
            step.state.cancelRequested = false;
          await step.vars.persist();
          return attempt;
        });
        if (!approved) return;
        await loop.step({
          name: "run-worker",
          timeout: 0,
          run: async (step) => {
            // A replay after a lost connection must not launch a second worker.
            // Resume is a separate, explicitly confirmed command, not a retry.
            if (step.state.attempts >= approved) {
              if (step.state.status === "running") {
                step.state.status = "needs_review";
                step.state.report =
                  "The coding run was interrupted. Check its saved thread and process before resuming.";
                await step.vars.persist();
              }
              return;
            }
            const proposal = step.state.proposal;
            if (!proposal) return;
            const manager = coding.isolation?.[proposal.workspace];
            step.state.status = "running";
            step.state.attempts = approved;
            delete step.state.verification;
            delete step.state.workerClaim;
            await step.vars.persist();
            const controller = new AbortController();
            step.vars.controller = controller;
            const signal = AbortSignal.any([
              controller.signal,
              step.abortSignal,
              AbortSignal.timeout(coding.timeoutMs),
            ]);
            let admitted = false;
            let launched = false;
            let settled = false;
            let acceptingThread = true;
            let onAbort: () => void = () => {};
            try {
              // Do not launch an old approval in a shared checkout, nor silently
              // upgrade that approval to new isolation/verification effects.
              if (version < 2)
                throw new Error("Legacy approval needs reconciliation");
              if (
                step.state.revoked ||
                step.state.runtimeId !== coding.runtimeId
              )
                throw new Error("Execution binding needs reconciliation");
              if (!manager) throw new Error("Isolation is not configured");
              if (step.state.cancelRequested) controller.abort();
              signal.throwIfAborted();
              // A legacy saved thread belongs to the shared checkout. Never
              // silently continue it in a new worktree after a code upgrade.
              if (step.state.threadId && !step.state.worktree)
                throw new Error(
                  "Legacy execution requires manual reconciliation",
                );
              await manager.admit(
                proposal.id,
                approved,
                command.type === "resume" && command.confirmedStopped,
              );
              admitted = true;
              signal.throwIfAborted();
              const { manifest } = await manager.prepare(proposal.id);
              if (
                manifest.repositoryRoot !==
                  coding.workspaces[proposal.workspace] ||
                (step.state.worktree &&
                  JSON.stringify(step.state.worktree) !==
                    JSON.stringify(manifest))
              )
                throw new Error(
                  "Worktree configuration changed; manual reconciliation required",
                );
              step.state.worktree = manifest;
              await step.vars.persist();
              signal.throwIfAborted();
              launched = true;
              const execution = coding.runtime.run({
                cwd: manifest.cwd,
                prompt: `You are June's coding worker, not her conversational persona. Work only on this approved local task. Follow repository guidance, preserve others' changes, and run relevant checks. Do not push, deploy, publish, modify shared infrastructure, or access credentials. Report what changed, verification evidence, limitations, and delivery state. Native execution is not a sandbox.\n\nTask:\n${proposal.goal}`,
                threadId: step.state.threadId,
                signal,
                onThread: async (threadId) => {
                  if (signal.aborted || !acceptingThread) return;
                  if (step.state.threadId && step.state.threadId !== threadId)
                    throw new Error("Worker changed its saved thread");
                  step.state.threadId = threadId;
                  await step.vars.persist();
                },
              });
              // Neither worker nor verifier settlement may block cancellation.
              // An abort is NOT proof either process exited; retain its lease.
              const interrupted = new Promise<never>((_, reject) => {
                onAbort = () => reject(new Error("Execution interrupted"));
                signal.addEventListener("abort", onAbort, { once: true });
                if (signal.aborted) onAbort();
              });
              const result = await Promise.race([
                execution,
                interrupted,
              ]).finally(() => {
                acceptingThread = false;
              });
              signal.throwIfAborted();
              settled = true;
              if (
                step.state.threadId &&
                step.state.threadId !== result.threadId
              )
                throw new Error("Worker result changed its saved thread");
              step.state.threadId = result.threadId;
              step.state.workerClaim = result.report;
              await step.vars.persist();
              settled = false;
              const verification = await Promise.race([
                manager.verify(proposal.id, signal, approved),
                interrupted,
              ]);
              settled = verification.status !== "needs_review";
              step.state.verification = verification;
              step.state.report = verification.replayed
                ? "Only a historical verifier receipt is available; current workspace changes are not verified."
                : `Separate operator verifier: ${verification.status}. This is evidence only for that command at ${verification.finishedAt}, not approval to push or deploy.`;
              step.state.status =
                verification.status === "passed" &&
                !verification.replayed &&
                !signal.aborted
                  ? "completed"
                  : "needs_review";
            } catch {
              step.state.status = "needs_review";
              step.state.report =
                "No confirmed completion. Admission, cancellation, worker execution, or verification needs review. Inspect the isolated workspace and saved thread; unknown execution must be confirmed stopped before resuming.";
            } finally {
              acceptingThread = false;
              signal.removeEventListener("abort", onAbort);
              // Unknown worker or verifier execution retains durable capacity
              // until explicit reconciliation, even if it later reports success.
              if (manager && admitted && (!launched || settled)) {
                try {
                  await manager.release(proposal.id, approved);
                } catch {
                  step.state.status = "needs_review";
                }
              }
              delete step.vars.controller;
            }
            await step.vars.persist();
          },
        });
        await loop.step("notify-companion", async (step): Promise<void> => {
          const { proposal, status, report, attempts, workerClaim } =
            step.state;
          if (!proposal) return;
          const text =
            version < 2
              ? status === "completed"
                ? `Amp reports (not independently verified):\n${report ?? "No report supplied."}`
                : `Coding job ${proposal.id.slice(0, 12)} needs review. ${report ?? ""}`
              : `Coding job ${proposal.id.slice(0, 12)}: ${status}.\n${report ?? "No verification evidence."}\n\nWorker claims (not independently verified):\n${workerClaim?.slice(0, 2200) ?? "No confirmed worker result."}`;
          await step
            .client<JuneRegistry>()
            .conversation.getOrCreate(["private", step.key[0] ?? ""])
            .send("inbox", {
              type: "job_result",
              jobId: proposal.id,
              attempt: attempts,
              source: proposal.source,
              text: [...text].slice(0, 3500).join(""),
            });
        });
      });
    }),
  });
}
