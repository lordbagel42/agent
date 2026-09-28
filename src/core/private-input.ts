/** Apply before truncation/escaping, including history and tool reads. A raw
 * PIN reply can still exist on Slack even after live ingress consumed it. */
export function redactBrowserPin(text: string): string {
  return /!browser-pin\b/i.test(text)
    ? "[Browser PIN command removed; never replay historical input.]"
    : text;
}
