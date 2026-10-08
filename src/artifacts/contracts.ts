import { z } from "zod";
import type { Identity, MessageEvent } from "../core/contracts.js";

export const artifactId = z.string().regex(/^[a-f0-9]{32}$/);
export const artifactCommandSchema = z.strictObject({
  action: z.enum(["create", "inspect", "update", "change_pin"]),
  id: artifactId.nullable(),
  title: z.string().trim().min(1).max(100).nullable(),
  kind: z.enum(["html", "board", "workflow"]).nullable(),
  visibility: z.enum(["public", "private"]).nullable(),
  content: z.string().max(64_000).nullable(),
  runId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type ArtifactCommand = z.infer<typeof artifactCommandSchema>;
export interface ArtifactContext {
  event: MessageEvent;
  operationId: string;
  isCurrent(): boolean;
}
export interface WorkflowView {
  runId: string;
  name: string;
  revision: string;
  status: string;
  operations: { name: string; status: string }[];
}
export interface ArtifactRecord {
  id: string;
  title: string;
  kind: "html" | "board" | "workflow";
  visibility: "public" | "private";
  creator: Identity;
  revision: number;
  generation: number;
  content: string;
  runId: string | null;
  deletionRevision: number;
  pinDelivery:
    | "not_required"
    | "pending"
    | "sending"
    | "sent"
    | "rejected"
    | "unknown";
}
export interface ArtifactPresentation {
  id: string;
  title: string;
  url: string;
  imageUrl?: string;
  visibility: "public" | "private";
}
export const ARTIFACT_HELP = `Shared artifacts are hosted HTML pages, collaborative Excalidraw boards, or read-only live workflow views. Use artifact with action create/inspect/update/change_pin and id,title,kind,visibility,content,runId (unused fields null). Create requires title, kind and explicit visibility public/private. HTML content is a complete self-contained document with inline CSS and native details/summary interactivity; arbitrary scripts, forms and external resources are BLOCKED. Use the host-authored board/workflow client for live behavior. Board content is an Excalidraw elements JSON array (or []); vector/text only, no external links or images. Existing elements require valid fractional index strings (a0, a1, etc.), versions and nonces. Workflow requires a runId belonging to the authenticated original requester in the same conversation/thread and audience, not content; owner-private conversation is not required. Only status is shared, never raw inputs/source/results. Existing artifact viewers use its public-link or private-PIN access controls. June chooses visibility from the request and sensitivity; never bypass existing source permissions. Private creation currently requires a Slack creator: the host generates eight random digits and DMs them to that creator only. You never receive the PIN and must not repeat its notification. Only the owner or creator may update or change_pin; change_pin generates a new PIN, invalidates viewer sessions and DMs the creator. For a chosen PIN, ask the authorized person to DM !artifact-pin <id> <eight digits>; never put the PIN into model tool arguments or shared chat. Anyone with the public link (or private PIN) can collaborate on a board, not administer it or execute a workflow. The shared private preview is locked to avoid leaking content. Images are static snapshots: always offer the returned browser URL for interactive/live detail. Slack's video-block inline HTML is experimental and client-dependent; image+link is the portable fallback. Do not invent URLs or claim DM/render success beyond recorded receipts; unknown sends are not retried. Configuration support is not proof of live Slack rendering. Automated events cannot create artifacts or rotate PINs.`;
