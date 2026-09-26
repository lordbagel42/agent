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

export function gmailSourceId(account: string, messageId: string): string {
  if (!/^[^\s@/]+@[^\s@/]+$/.test(account) || !/^[a-f0-9]+$/i.test(messageId))
    throw new Error("Invalid Gmail source identity");
  return `gmail:${account}:${messageId}`;
}
