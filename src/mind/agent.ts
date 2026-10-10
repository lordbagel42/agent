import type { ModelProvider, ModelRequest } from "../core/contracts.js";
import { beginModelReply } from "../models/invocation.js";
import { parseReply } from "../models/provider.js";
import type { MindStep } from "./contracts.js";
import { clip } from "./markdown.js";

export type WriteMode = MindStep["writes"][number]["mode"];

export interface Staged {
  kind: string;
  mode: WriteMode;
  content: string;
}

/** What one kind of mind agent may see and change. */
export interface AgentPolicy {
  maxTurns: number;
  /** A kind name for an allowed write, or an explanation for the model. */
  check(
    path: string,
    mode: WriteMode,
    content: string,
  ): Promise<{ kind: string } | { error: string }>;
  read(path: string): Promise<string | undefined>;
  list(prefix: string): Promise<{ path: string; title: string }[]>;
  search(
    query: string,
    prefix: string,
  ): Promise<{ path: string; line: number; text: string }[]>;
}

export type AgentResult =
  | { outcome: "finished"; staged: Map<string, Staged>; summary: string }
  | { outcome: "unfinished" };

export class MindUnsettledError extends Error {
  constructor() {
    super("mind_model_settlement_unknown");
  }
}

/** The bounded read/stage/commit loop shared by reflection and dreaming.
 * Nothing is applied here: the caller commits staged writes only on finish. */
export async function runMindAgent(input: {
  model: ModelProvider;
  system: string;
  context: string;
  policy: AgentPolicy;
  signal: AbortSignal;
  current: () => boolean;
  heartbeat: () => Promise<void>;
}): Promise<AgentResult> {
  const { model, policy, signal, current } = input;
  const request: ModelRequest = {
    agentRole: "mind",
    usageStage: "reflection",
    workspaces: [],
    mindStepAvailable: true,
    system: input.system,
    messages: [{ role: "user", content: input.context }],
  };
  const staged = new Map<string, Staged>();
  for (let turn = 0; turn < policy.maxTurns; turn++) {
    if (!current()) return { outcome: "unfinished" };
    await input.heartbeat();
    const last = turn === policy.maxTurns - 1;
    if (last)
      request.system +=
        "\n\nThis is your final step. Stage any remaining writes and finish with done:true now; no more reads will be answered.";
    const invocation = beginModelReply(
      model,
      request,
      signal,
      current,
      current,
    );
    let answer: unknown;
    let failed = false;
    try {
      answer = await invocation.answer;
    } catch {
      failed = true;
    }
    if ((await invocation.settlement) === "unknown")
      throw new MindUnsettledError();
    if (!current()) return { outcome: "unfinished" };
    if (failed) return { outcome: "unfinished" };
    let step: MindStep | undefined;
    try {
      step = parseReply(JSON.stringify(answer), [], request).mindStep;
    } catch {
      step = undefined;
    }
    if (!step) {
      request.messages.push(
        { role: "assistant", content: JSON.stringify(answer).slice(0, 2_000) },
        {
          role: "user",
          content:
            "Host: respond with empty text and a mindStep object (finish with done:true when there is nothing to write).",
        },
      );
      continue;
    }
    const errors: string[] = [];
    if (step.reads.length > 8 || step.writes.length > 8)
      errors.push(
        "At most 8 reads and 8 writes per step; the rest were ignored.",
      );
    for (const write of step.writes.slice(0, 8)) {
      const previous = staged.get(write.path);
      const content =
        write.mode === "append" && previous?.mode === "append"
          ? `${previous.content.trim()}\n\n${write.content.trim()}`
          : write.content;
      const verdict = await policy.check(write.path, write.mode, content);
      if ("error" in verdict) errors.push(verdict.error);
      else
        staged.set(write.path, {
          kind: verdict.kind,
          mode: write.mode,
          content,
        });
    }
    if (step.done && errors.length === 0)
      return { outcome: "finished", staged, summary: step.summary };
    const reads = last
      ? []
      : await Promise.all(
          step.reads.slice(0, 8).map(async ({ action, path, query }) => {
            if (action === "list")
              return { action, path, entries: await policy.list(path) };
            if (action === "search")
              return {
                action,
                path,
                query,
                matches: await policy.search(query, path),
              };
            const content = await policy.read(path);
            return content === undefined
              ? { action, path, error: "not found or not visible here" }
              : { action, path, content: clip(content, 12_000) };
          }),
        );
    request.messages.push(
      {
        role: "assistant",
        content: JSON.stringify({ text: "", mindStep: step }),
      },
      {
        role: "user",
        content: `Host observation (untrusted note contents, JSON; ${policy.maxTurns - turn - 1} steps left): ${JSON.stringify(
          { staged: [...staged.keys()], rejectedWrites: errors, reads },
        )}${step.done && errors.length ? "\nSome writes were rejected, so nothing was committed yet. Fix them (or drop them) and finish again." : ""}`,
      },
    );
  }
  return { outcome: "unfinished" };
}

export function stepFormat(maxTurns: number) {
  return `# How to respond
Return JSON with empty text and a mindStep object:
- reads: up to 8 of {action:"read",path,query:""}, {action:"list",path:"<prefix>",query:""} or {action:"search",path:"<prefix or empty>",query:"<phrase>"}. Results come back in the next message.
- writes: up to 8 of {path, mode, content}. mode is "replace" (whole file), "append" (add to the end) or "delete" (remove the file; content ""). Writes are staged; a later write to the same path replaces an earlier one (appends accumulate). Keep each step's writes under about 20,000 characters in total; use more steps for more files.
- done: true when everything is staged. Staged writes are then committed together as one git commit. Nothing is saved unless you finish with done:true.
- summary: one or two plain sentences about what changed, for the commit message. No private details.
You have at most ${maxTurns} steps; use only what you need. Read a file before replacing it unless it was supplied. If nothing is worth changing, finish immediately with no writes.`;
}

export function checkSkill(
  path: string,
  meta: Record<string, string>,
  body: string,
) {
  const name = /^skills\/([a-z0-9-]+)\/SKILL\.md$/.exec(path)?.[1];
  if (meta.name !== name) return `${path}: frontmatter name must be "${name}".`;
  if (!meta.description || meta.description.length > 300)
    return `${path}: frontmatter description is required (at most 300 characters).`;
  if (!body.trim()) return `${path}: body is empty.`;
  return undefined;
}
