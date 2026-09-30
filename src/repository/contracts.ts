import { z } from "zod";
import type { ModelSettlement } from "../core/contracts.js";

export const REPOSITORY_REPORT_LIMIT = 12_000;

/** Fixed host wording only; never forward a provider error body to June. */
export class RepositoryTimeoutError extends Error {
  constructor(finalReport: boolean, settlement: ModelSettlement) {
    super(
      `Repository specialist ${finalReport ? "final report" : "model call"} timed out. No confirmed report was produced; this does not establish that the requested capability is absent. Inference settlement: ${settlement}. No automatic retry was made; another consultation requires a fresh owner request.`,
    );
    this.name = "RepositoryTimeoutError";
  }
}

export const repositoryQuestionSchema = z.string().trim().min(1).max(2000);

export const repositoryReadSchema = z.strictObject({
  action: z.enum(["read", "search"]),
  path: z.string().max(500),
  query: z.string().max(200),
  offset: z
    .number()
    .int()
    .min(0)
    .max(64 * 1024 * 1024),
});

export type RepositoryRead = z.infer<typeof repositoryReadSchema>;

export const REPOSITORY_HELP = `June has a dedicated read-only repository specialist for https://github.com/lordbagel42/agent. For any task requiring understanding June's source, architecture, implementation, tests, or deployment code, consult this specialist before drawing repo-specific conclusions or preparing a coding proposal. Interaction agents delegate to the stable execution worker "june-repo" (reuse it for related follow-ups), instructing it to call repository. Other execution workers with a repo-dependent task call repository themselves; this is a read-only specialist capability, not dispatching a child execution worker.
When repositoryAvailable is granted, an execution worker asks with {text:"",repository:"self-contained repo question, up to 2000 characters"}, with no other action. Send only the question and necessary code identifiers, not private history, credentials, logs, or unrelated user data. Internal specialist reports may contain up to ${REPOSITORY_REPORT_LIMIT} Unicode characters; summarize them for June rather than copying them into a chat-sized reply. Preserve the report's revision, citations, coverage limits and uncertainty. The specialist receives the entire published source archive before reasoning: a complete file inventory is in its prompt and all text files can be searched/read in bounded pages, including docs, tests and scripts. This is not every file stuffed into one context window, Git history, untracked host files, submodule contents, or Git LFS payloads. It cannot edit, execute code, access local files, consult other tools, publish or deploy.
The specialist uses the configured deep model, or the normal model when none is configured, including its configured model timeout. The enclosing worker also has a five-minute deadline; twelve model turns is a ceiling, not a promise that every turn fits. A model timeout is distinct from a source-download failure and does not prove that a feature is unavailable or unsupported. Preserve a reported timeout and its inference-settlement status when explaining the failure. The host waits for settlement before reporting the timeout, retains the started operation as needs_review, and does not retry or continue the worker's tool/model loop. Unknown settlement is not confirmed stoppage. Another consultation requires a fresh owner request; do not silently repeat it from a completion or automated turn. Timeout configuration changes require operator authorization and can affect other users of that model.
Cancellation detaches that question from a shared source download. The already-started public download may finish within its 30-second limit for other callers; it never starts inference for a cancelled question.
The snapshot is pinned to the running release revision, or public main at first consultation when no release revision exists; it is cached in memory until process restart, not silently updated during a conversation. The first call downloads the public archive without credentials; failures stop consultation, not a fallback to partial local files or guessed answers. Each question gets isolated model context with bounded read/search steps; no private conversation memory is shared or retained by the specialist. Source evidence does not prove enabled configuration, current infrastructure health, deployment, or a fix's live effect. Use separately authorized inspection for that. If this capability is unavailable, say so rather than pretending to consult it. Completion/automated turns without dispatch authority must only synthesize supplied evidence, never start a consultation or duplicate an investigation.`;
