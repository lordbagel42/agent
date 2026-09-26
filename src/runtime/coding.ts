import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import type { CodingRequest, MessageEvent } from "../core/contracts.js";
import type { Dependencies, JuneRegistry } from "./registry.js";

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
  threadId?: string;
  report?: string;
}
type Command =
  | { type: "propose"; proposal: JobProposal }
  | { type: "approve"; commandId: string }
  | { type: "resume"; commandId: string; confirmedStopped: boolean };

export function createCodingActor(coding: Dependencies["coding"]) {
  return actor({
    state: {
      proposal: null,
      status: "empty",
      attempts: 0,
      commandApprovals: {},
    } as CodingState,
    createVars: (c): { persist: () => Promise<void> } => ({
      persist: () => c.saveState({ immediate: true }),
    }),
    queues: { commands: queue<Command>() },
    actions: { snapshot: (c): CodingState => c.state },
    run: workflow(async (ctx) => {
      await ctx.loop("coding-v1", async (loop) => {
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
              !command.proposal.source.direct ||
              command.proposal.id !== step.key[1] ||
              !Object.hasOwn(coding.workspaces, command.proposal.workspace)
            )
              return;
            step.state.proposal = command.proposal;
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
            (command.type === "approve"
              ? step.state.status === "awaiting_approval"
              : command.confirmedStopped &&
                step.state.status === "needs_review" &&
                !!step.state.threadId);
          const attempt = allowed ? step.state.attempts + 1 : null;
          step.state.commandApprovals[command.commandId] = attempt;
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
            const cwd = coding.workspaces[proposal.workspace];
            if (!cwd) return;
            step.state.status = "running";
            step.state.attempts = approved;
            await step.vars.persist();
            try {
              const result = await coding.runtime.run({
                cwd,
                prompt: `You are June's coding worker, not her conversational persona. Work only on this approved local task. Follow repository guidance, preserve others' changes, and run relevant checks. Do not push, deploy, publish, modify shared infrastructure, or access credentials. Report what changed, verification evidence, limitations, and delivery state. Native execution is not a sandbox.\n\nTask:\n${proposal.goal}`,
                threadId: step.state.threadId,
                signal: AbortSignal.any([
                  step.abortSignal,
                  AbortSignal.timeout(coding.timeoutMs),
                ]),
                onThread: async (threadId) => {
                  step.state.threadId = threadId;
                  await step.vars.persist();
                },
              });
              step.state.threadId = result.threadId;
              step.state.report = result.report;
              step.state.status = "completed";
            } catch {
              step.state.status = "needs_review";
              step.state.report =
                "The worker did not return a confirmed final result. Its changes may still exist; inspect the workspace and saved thread before continuing.";
            }
            await step.vars.persist();
          },
        });
        await loop.step("notify-companion", async (step): Promise<void> => {
          const { proposal, status, report, attempts } = step.state;
          if (!proposal) return;
          const text =
            status === "completed"
              ? `Amp reports (not independently verified):\n${report ?? "No report supplied."}`
              : `Coding job ${proposal.id.slice(0, 12)} needs review. ${report ?? ""}`;
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
