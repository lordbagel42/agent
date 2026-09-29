import { z } from "zod";

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
When repositoryAvailable is granted, an execution worker asks with {text:"",repository:"self-contained repo question, up to 2000 characters"}, with no other action. Send only the question and necessary code identifiers, not private history, credentials, logs, or unrelated user data. Read the returned report and preserve its revision, citations, coverage limits and uncertainty. The specialist receives the entire published source archive before reasoning: a complete file inventory is in its prompt and all text files can be searched/read in bounded pages, including docs, tests and scripts. This is not every file stuffed into one context window, Git history, untracked host files, submodule contents, or Git LFS payloads. It cannot edit, execute code, access local files, consult other tools, publish or deploy.
Cancellation detaches that question from a shared source download. The already-started public download may finish within its 30-second limit for other callers; it never starts inference for a cancelled question.
The snapshot is pinned to the running release revision, or public main at first consultation when no release revision exists; it is cached in memory until process restart, not silently updated during a conversation. The first call downloads the public archive without credentials; failures stop consultation, not a fallback to partial local files or guessed answers. Each question gets isolated model context with bounded read/search steps; no private conversation memory is shared or retained by the specialist. Source evidence does not prove enabled configuration, current infrastructure health, deployment, or a fix's live effect. Use separately authorized inspection for that. If this capability is unavailable, say so rather than pretending to consult it. Completion/automated turns without dispatch authority must only synthesize supplied evidence, never start a consultation or duplicate an investigation.`;
