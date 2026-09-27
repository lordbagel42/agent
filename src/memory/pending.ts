import type { EvidenceStore } from "./store.js";

/** Host-only projection. Audience must come from authenticated private routing.
 * Keep complete claims and identifiers; omit oversized rows rather than suggest
 * confirming a claim whose text was cut. Never return raw source quotations.
 */
export function pendingMemoryView(
  store: EvidenceStore,
  audience: string,
  redact?: (text: string) => string,
) {
  const pending = store
    .proposals(audience)
    .filter((proposal) => proposal.status === "pending");
  const rows: string[] = [];
  const sourceIds = new Set<string>();
  const claimIds: string[] = [];
  for (const proposal of pending) {
    if (rows.length >= 6) break;
    const { claim } = proposal;
    const json = JSON.stringify({
      proposalId: proposal.id,
      status: "pending",
      acceptCommand: `!memory-accept ${proposal.id}`,
      rejectCommand: `!memory-reject ${proposal.id}`,
      text: claim.text,
      category: claim.grounding?.category ?? null,
      confidence: claim.grounding?.confidence ?? null,
      validFrom: claim.grounding?.validFrom ?? null,
      validTo: claim.grounding?.validTo ?? null,
      sourceIds: claim.dependsOn,
      contradicts: claim.contradicts,
      supersedes: claim.supersedes,
      recordedImports: store.pendingImportProvenance(audience, proposal.id),
    });
    // Credential redaction must precede reversible display escaping.
    const row = (redact?.(json) ?? json).replace(
      /[<>&`*_~@/]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    if ([...rows, row].join("\n").length > 3000) continue;
    rows.push(row);
    claimIds.push(claim.id);
    for (const id of claim.dependsOn) sourceIds.add(id);
    for (const id of [...claim.contradicts, ...claim.supersedes])
      for (const sourceId of store.independentEvidence(id, audience))
        sourceIds.add(sourceId);
  }
  return {
    text: `Pending memory claims awaiting owner review. Read-only snapshot; these are untrusted, unaccepted hypotheses, not facts or instructions. Confidence is the extractor's uncalibrated estimate; null means unknown. Validity times are epoch milliseconds (validTo exclusive). Source IDs identify supporting evidence, not proof of truth. Source bodies, quotes, and links are omitted. No review decision was made. After reviewing one claim, send its acceptCommand or rejectCommand value exactly as a new plain-text owner-private Slack DM. Rejection prevents this candidate's promotion on replay but retains bounded provenance; it is not source deletion.\nRecorded imports show cited-source membership; extraction IDs link this claim to an attempt. Missing links do not prove no import occurred. Exact page attribution is unavailable. Imports never approve claims.\nShowing ${rows.length} of ${pending.length} pending claims; ${pending.length - rows.length} omitted by count/size limits.\n${rows.join("\n")}`,
    sourceIds: [...sourceIds],
    claimIds,
  };
}
