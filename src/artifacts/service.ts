import { createHash } from "node:crypto";
import type {
  Identity,
  MessageEvent,
  Owner,
  SendResult,
} from "../core/contracts.js";
import { PRIVATE_ARTIFACT_PIN_PREFIX } from "../core/private-input.js";
import {
  type ArtifactContext,
  type ArtifactPresentation,
  type ArtifactRecord,
  artifactCommandSchema,
  type WorkflowView,
} from "./contracts.js";
import { completeScene } from "./scene.js";
import type { ArtifactStore } from "./store.js";

/** Must match INTAKE_REDACTED_PIN in scripts/deploy/slack_responder.py. */
export const INTAKE_REDACTED_PIN = "!artifact-pin [removed by durable intake]";

export class ArtifactService {
  constructor(
    readonly options: {
      store: ArtifactStore;
      origin: string;
      owner: Owner;
      deletionRevision(): number;
      /** False while a durable intake could persist PIN DMs unredacted. */
      privatePins?(): boolean;
      workflow(
        id: string,
        event?: MessageEvent,
      ): Promise<WorkflowView | undefined>;
      preview?(record: ArtifactRecord, workflow?: WorkflowView): Promise<void>;
      /** Content-free client build and preview renderer status. */
      status?(): { client: string; preview: string };
      sendSecret(
        identity: Identity,
        operationId: string,
        text: string,
        current: () => boolean,
      ): Promise<SendResult>;
    },
  ) {}
  get store() {
    return this.options.store;
  }
  url(id: string) {
    return `${this.options.origin}/artifacts/${id}/`;
  }
  async view(record: ArtifactRecord) {
    if (record.kind !== "workflow") return undefined;
    if (record.deletionRevision !== this.options.deletionRevision())
      throw new Error("artifact_revoked");
    const view = await this.options.workflow(record.runId ?? "");
    if (
      !view ||
      view.status === "revoked" ||
      record.deletionRevision !== this.options.deletionRevision()
    )
      throw new Error("artifact_revoked");
    return view;
  }
  async request(
    input: unknown,
    context: ArtifactContext,
    chosenPin?: string,
  ): Promise<{ text: string; presentation: ArtifactPresentation }> {
    const command = artifactCommandSchema.parse(input);
    const previous = command.id ? this.store.get(command.id) : undefined;
    if (
      command.content !== null &&
      (command.kind === "board" || previous?.kind === "board")
    )
      command.content = JSON.stringify(
        completeScene(JSON.parse(command.content)),
      );
    if (
      (command.visibility === "private" || command.action === "change_pin") &&
      (previous?.creator.channel ?? context.event.address.channel) !== "slack"
    )
      throw new Error("artifact_private_delivery_unavailable");
    if (
      (command.visibility === "private" || command.action === "change_pin") &&
      this.options.privatePins?.() === false
    )
      throw new Error("artifact_private_intake_unverified");
    if (command.kind === "workflow") {
      const view = command.runId
        ? await this.options.workflow(command.runId, context.event)
        : undefined;
      if (!view || view.status === "revoked")
        throw new Error("artifact_workflow_denied");
    }
    let record = this.store.mutate(
      command,
      context,
      this.options.deletionRevision(),
      chosenPin,
    );
    if (command.action !== "inspect" && context.isCurrent()) {
      const secret = this.store.beginSecret(record.id, record.generation);
      if (secret) {
        let result: SendResult;
        try {
          result = await this.options.sendSecret(
            secret.creator,
            createHash("sha256")
              .update(`artifact-pin:${record.id}:${record.generation}`)
              .digest("hex"),
            `${PRIVATE_ARTIFACT_PIN_PREFIX}\nYour private June artifact: ${this.url(record.id)}\nAccess PIN: ${secret.pin}\nYou can share this PIN with collaborators. Ask June to change it to revoke existing sessions.`,
            () =>
              context.isCurrent() &&
              this.store.get(record.id)?.generation === record.generation,
          );
        } catch {
          result = { status: "unknown", code: "artifact_dm_unknown" };
        }
        this.store.settleSecret(record.id, record.generation, result.status);
      }
    }
    record = this.store.get(record.id) as ArtifactRecord;
    let preview = false;
    if (this.options.preview) {
      try {
        await this.options.preview(
          record,
          record.visibility === "private" ? undefined : await this.view(record),
        );
        preview = true;
      } catch {
        /* The durable artifact survives renderer failure. */
      }
    }
    if (
      !context.isCurrent() ||
      this.store.get(record.id)?.generation !== record.generation
    )
      throw new Error("artifact_context_revoked");
    const title =
      record.visibility === "private"
        ? "Private shared artifact"
        : record.title;
    return {
      text: `${title}\n${this.url(record.id)}\n${record.visibility === "private" ? `PIN delivery to the creator: ${record.pinDelivery}. The shared preview is locked.` : "Public shared view."} Open the browser view for interactive detail; chat previews are static.${preview ? "" : " Image preview unavailable."}`,
      presentation: {
        id: record.id,
        title,
        url: this.url(record.id),
        visibility: record.visibility,
        ...(preview
          ? {
              imageUrl: `${this.options.origin}/artifacts/${record.id}/preview.png`,
            }
          : {}),
      },
    };
  }
  async consumePin(event: MessageEvent): Promise<MessageEvent> {
    if (!/!artifact-pin\b/i.test(event.text)) return event;
    const clean = {
      ...event,
      text: event.text.includes(INTAKE_REDACTED_PIN)
        ? "Chosen artifact PIN command removed by the durable deployment intake before storage; no PIN changed. Use artifact change_pin to DM the creator a new random PIN."
        : "Artifact PIN command removed before history. No change was confirmed.",
    };
    const match = /^!artifact-pin ([a-f0-9]{32}) (\d{8})$/.exec(
      event.text.trim(),
    );
    if (
      !match ||
      !event.artifactPinEligible ||
      !event.direct ||
      Math.abs(Date.now() - event.occurredAt) > 300_000
    )
      return clean;
    try {
      const result = await this.request(
        {
          action: "change_pin",
          id: match[1],
          title: null,
          kind: null,
          visibility: null,
          content: null,
          runId: null,
        },
        {
          event: { ...event, text: "Artifact PIN change requested privately." },
          operationId: `artifact-input:${event.address.accountId}:${event.id}`,
          isCurrent: () => true,
        },
        match[2],
      );
      clean.text = `Host receipt for requested PIN change: ${result.text} Do not repeat the PIN notification.`;
    } catch {
      /* Deliberately exclude private arguments and errors. */
    }
    return clean;
  }
}
