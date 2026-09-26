import type { Source } from "../memory/store.js";

/** Shared by retained history and live ingress; never include job/thread IDs. */
export function slackSourceId(
  workspace: string,
  channel: string,
  ts: string,
): string {
  if (
    !/^T[A-Z0-9]+$/.test(workspace) ||
    !/^[CGD][A-Z0-9]+$/.test(channel) ||
    !/^\d+\.\d{6}$/.test(ts)
  )
    throw new Error("Invalid Slack source identity");
  return `slack:${workspace}:${channel}:${ts}`;
}

/** Original message fields plus authenticated workspace/routing, never model input.
 * Live ingress and retained history must use this same immutable representation.
 */
export function slackSource(input: {
  workspace: string;
  channel: string;
  ts: string;
  threadTs?: string;
  author: string;
  text: string;
  workspaceUrl: string;
  audiences: string[];
}): Source {
  const id = slackSourceId(input.workspace, input.channel, input.ts);
  if (
    (input.threadTs !== undefined && !/^\d+\.\d{6}$/.test(input.threadTs)) ||
    !/^https:\/\/[a-z0-9-]+\.slack\.com\/$/.test(input.workspaceUrl)
  )
    throw new Error("Invalid Slack source provenance");
  const observedAt = Number(BigInt(input.ts.replace(".", "")) / 1000n);
  if (!Number.isSafeInteger(observedAt))
    throw new Error("Invalid Slack source timestamp");
  return {
    id,
    platform: "slack",
    account: input.workspace,
    conversation: `${input.channel}/${input.threadTs ?? input.ts}`,
    audiences: [...input.audiences],
    author: input.author,
    observedAt,
    sourceUrl: `${input.workspaceUrl}archives/${input.channel}/p${input.ts.replace(".", "")}`,
    text: input.text,
  };
}

export function gmailSourceId(account: string, messageId: string): string {
  if (!/^[^\s@/]+@[^\s@/]+$/.test(account) || !/^[a-f0-9]+$/i.test(messageId))
    throw new Error("Invalid Gmail source identity");
  return `gmail:${account}:${messageId}`;
}
