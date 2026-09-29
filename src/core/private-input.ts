export const PRIVATE_ARTIFACT_PIN_PREFIX = "[June private artifact access]";

export function containsArtifactSecret(text: string): boolean {
  return (
    text.includes(PRIVATE_ARTIFACT_PIN_PREFIX) ||
    /(?:!artifact-pin\b|Access PIN:\s*\d{8}\b)/i.test(text)
  );
}

/** Apply before truncation/escaping, including history and tool reads. A raw
 * PIN reply can still exist on Slack even after live ingress consumed it. */
export function redactBrowserPin(text: string): string {
  if (containsArtifactSecret(text))
    return "[Private artifact PIN input or notification removed; never replay historical input.]";
  return /!browser-pin\b/i.test(text)
    ? "[Browser PIN command removed; never replay historical input.]"
    : text;
}
