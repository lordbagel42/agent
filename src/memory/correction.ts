import type { MessageEvent, Owner } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { isOwner } from "../core/social.js";
import { slackSourceId } from "../imports/identity.js";
import type { EvidenceStore, Source } from "./store.js";

export const MEMORY_CORRECTION_HELP =
  "The optional owner-attributed correction command is !memory-correct <verbosity|tone|humor|interests> as a standalone plain text message in the owner's Slack DM, followed by a value of 1–2000 UTF-16 code units (no quotes, code, lists, attachments or rich embeds). This records private correction evidence only; it does not change June's global profile, permissions, or other memories. Ordinary personality requests from any admitted conversation use the exposed personality tools and June's runtime judgment, without a compulsory owner command.";

export function isMemoryCorrectionCommand(text: string): boolean {
  return /^!memory-correct(?:\s|$)/u.test(text);
}

/** Only call for a live inbox event, never model output or retrieved history.
 * The Slack adapter verifies the signature before this event reaches the inbox.
 * Recheck exact owner identity and DM classification here, not in the model. */
export function handleMemoryCorrection(
  event: MessageEvent,
  owner: Owner,
  store?: EvidenceStore,
): string {
  const scope = routeEvent(event, owner);
  if (
    !isOwner(event, owner) ||
    !scope?.private ||
    event.address.channel !== "slack" ||
    !event.direct ||
    event.metadata?.channelType !== "im" ||
    !/^D[A-Z0-9]+$/.test(event.address.conversationId)
  )
    return "Memory corrections require the configured owner's Slack DM.";
  if (!store)
    return "Retained memory is unavailable; no correction was recorded. An operator must configure and authorize memory first.";
  if (event.ownerCorrectionEligible !== true) return MEMORY_CORRECTION_HELP;
  const match =
    /^!memory-correct (verbosity|tone|humor|interests) ([^\r\n]{1,2000})$/u.exec(
      event.text,
    );
  if (
    !match ||
    match[0] !== event.text ||
    !match[2]?.trim() ||
    match[2].length > 2000
  )
    return MEMORY_CORRECTION_HELP;
  const audience = JSON.stringify(scope.key);
  const sourceId = slackSourceId(
    event.address.accountId,
    event.address.conversationId,
    event.messageId,
  );
  const source = store.source(audience, sourceId);
  if (!source || source.author !== event.senderId || source.text !== event.text)
    return "The original correction message is unavailable or changed; no correction was recorded.";
  store.recordOwnerCorrection(audience, sourceId, {
    trait: match[1] as NonNullable<Source["correction"]>["trait"],
    value: match[2],
  });
  return `Recorded private owner-correction evidence: ${sourceId}. No personality revision or memory replacement was applied. A separately reviewed curated revision may cite this ID with the exact trait/value; existing freshness checks still apply.`;
}
