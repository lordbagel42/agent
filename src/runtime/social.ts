import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Address,
  ChannelAdapter,
  MessageEvent,
  Owner,
  SendResult,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import {
  isOwner,
  RAYGEN_SLACK_ID,
  type SocialAction,
  socialActionSchema,
} from "../core/social.js";
import { type Delivery, deliver } from "./delivery.js";

const DAY = 86_400_000;
interface Proposal {
  id: string;
  accountId: string;
  requester: string;
  action: Exclude<SocialAction, { kind: "post" }>;
  status: "pending" | "approved" | "denied" | "revoked";
  created: number;
  expires: number;
}

/** Permissions are explicit owner decisions, never inferred relationship scores.
 * This private host ledger must not be exposed through a guest/operator proxy. */
export class SocialPermissions {
  private db: DatabaseSync;
  constructor(
    private options: {
      file: string;
      owner: Owner;
      teamId: string;
      botUserId: string;
      slack: ChannelAdapter;
      now?: () => number;
      deletionRevision?: () => number;
    },
  ) {
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(options.file);
    chmodSync(options.file, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS social_proposals (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS social_deliveries (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS social_privacy (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);`);
    this.forget();
  }
  close() {
    this.db.close();
  }
  /** Frozen prose has no complete provenance (including legacy rows). Revoke
   * and redact it conservatively, retaining IDs so replay cannot recreate it.
   * Reconcile against the evidence ledger on reads as well as the host callback:
   * a crash between tombstoning evidence and cleanup must still fail closed. */
  forget() {
    const revision = this.options.deletionRevision?.() ?? 0;
    const saved = this.db
      .prepare("SELECT revision FROM social_privacy WHERE id = 1")
      .get();
    if (revision <= Number(saved?.revision ?? 0)) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.db
        .prepare("SELECT value FROM social_proposals")
        .all()) {
        const proposal = JSON.parse(String(row.value)) as Proposal;
        proposal.status = "revoked";
        if (proposal.action.kind === "outreach") proposal.action.text = "";
        else {
          proposal.action.topic = "";
          proposal.action.sharedContext = "";
        }
        this.save(proposal);
      }
      for (const row of this.db
        .prepare("SELECT id, value FROM social_deliveries")
        .all()) {
        const delivery = JSON.parse(String(row.value)) as Delivery;
        this.redact(delivery);
        this.db
          .prepare("UPDATE social_deliveries SET value = ? WHERE id = ?")
          .run(JSON.stringify(delivery), String(row.id));
      }
      this.db
        .prepare("INSERT OR REPLACE INTO social_privacy VALUES (1, ?)")
        .run(revision);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private redact(delivery: Delivery) {
    delivery.message.content = { type: "text", text: "" };
    delivery.phase = "settled";
    delivery.result = {
      status: "rejected",
      code: "forgotten",
      retryable: false,
    };
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private authorized(event: MessageEvent) {
    return (
      event.address.channel === "slack" &&
      event.address.accountId === this.options.teamId &&
      !!routeEvent(event, this.options.owner)
    );
  }
  private owner(event: MessageEvent) {
    return (
      this.authorized(event) &&
      event.senderId === RAYGEN_SLACK_ID &&
      isOwner(event, this.options.owner)
    );
  }
  private rows(): Proposal[] {
    this.forget();
    return this.db
      .prepare("SELECT value FROM social_proposals")
      .all()
      .map((row) => JSON.parse(String(row.value)) as Proposal);
  }
  private get(id: string): Proposal | undefined {
    this.forget();
    const row = this.db
      .prepare("SELECT value FROM social_proposals WHERE id = ?")
      .get(id);
    return row ? (JSON.parse(String(row.value)) as Proposal) : undefined;
  }
  private save(proposal: Proposal) {
    this.db
      .prepare("INSERT OR REPLACE INTO social_proposals VALUES (?, ?)")
      .run(proposal.id, JSON.stringify(proposal));
  }
  grants(event: MessageEvent): Proposal[] {
    if (!this.authorized(event)) return [];
    return this.rows().filter(
      (row) =>
        row.accountId === event.address.accountId &&
        row.status === "approved" &&
        row.expires > this.now() &&
        row.action.kind === "request_access" &&
        row.action.userId === event.senderId &&
        row.action.conversationId === event.address.conversationId,
    );
  }
  /** Used before effects/delivery as well as prompt construction. */
  fingerprint(event: MessageEvent) {
    return JSON.stringify(this.grants(event));
  }
  view(event: MessageEvent): string {
    const owner = this.owner(event) && event.direct;
    const rows = owner
      ? this.rows()
          .filter(
            (row) =>
              row.accountId === event.address.accountId &&
              row.expires > this.now(),
          )
          .slice(-20)
      : this.grants(event);
    return JSON.stringify(rows);
  }
  permits(event: MessageEvent, tool: "deep" | "webSearch") {
    return this.grants(event).some(
      (row) =>
        row.action.kind === "request_access" && row.action.tools.includes(tool),
    );
  }
  command(event: MessageEvent): RegExpMatchArray | null {
    if (!this.owner(event)) return null;
    const text = event.text
      .trim()
      .replace(new RegExp(`^<@${this.options.botUserId}>\\s*`), "");
    return text.match(/^!(allow|deny|revoke) ([a-f0-9]{24})$/);
  }
  private async send(
    id: string,
    address: Address,
    text: string,
  ): Promise<SendResult> {
    this.forget();
    const revision = this.options.deletionRevision?.() ?? 0;
    const row = this.db
      .prepare("SELECT value FROM social_deliveries WHERE id = ?")
      .get(id);
    const delivery: Delivery = row
      ? (JSON.parse(String(row.value)) as Delivery)
      : {
          phase: "ready",
          attempts: 0,
          message: {
            id: randomUUID(),
            address,
            lastInboundAt: this.now(),
            content: { type: "text", text },
          },
        };
    return deliver(
      delivery,
      async () => {
        this.forget();
        if (revision !== (this.options.deletionRevision?.() ?? 0))
          this.redact(delivery);
        this.db
          .prepare("INSERT OR REPLACE INTO social_deliveries VALUES (?, ?)")
          .run(id, JSON.stringify(delivery));
      },
      async (message) => {
        this.forget();
        if (revision !== (this.options.deletionRevision?.() ?? 0))
          return { status: "rejected", code: "forgotten", retryable: false };
        return this.options.slack.send(message);
      },
    );
  }
  async decide(event: MessageEvent): Promise<string> {
    const command = this.command(event);
    if (!command) return "Only Raygen can decide permissions.";
    const proposal = this.get(command[2] ?? "");
    if (
      !proposal ||
      proposal.accountId !== event.address.accountId ||
      proposal.expires <= this.now()
    )
      return "That request is missing or expired.";
    const decision = command[1];
    if (decision === "revoke") {
      proposal.status = "revoked";
      this.save(proposal);
      return "Revoked. Previously delivered messages cannot be unsent.";
    }
    // Approval can survive a crash before delivery is journaled. Re-enter the
    // durable send on repeated approval, not a fresh send: its ledger prevents
    // replay of accepted or uncertain deliveries. Other decisions stay final.
    const resumeOutreach =
      decision === "allow" &&
      proposal.status === "approved" &&
      proposal.action.kind === "outreach";
    if (proposal.status !== "pending" && !resumeOutreach)
      return `That request is already ${proposal.status}; it was not executed again.`;
    if (decision === "deny") {
      proposal.status = "denied";
      this.save(proposal);
      return "Denied. No additional access was granted.";
    }
    if (!resumeOutreach) {
      proposal.status = "approved";
      proposal.expires = this.now() + 30 * DAY;
      this.save(proposal);
    }
    if (proposal.action.kind === "outreach") {
      const result = await this.send(
        `${proposal.id}:outreach`,
        {
          channel: "slack",
          accountId: proposal.accountId,
          conversationId: proposal.action.userId,
        },
        proposal.action.text,
      );
      return `Approved outreach: delivery ${result.status}. ${result.status === "sent" ? "Slack accepted the message." : "Do not assume it arrived; I will not automatically resend an uncertain delivery."}`;
    }
    return `Approved access ${proposal.id} for 30 days, only for the named person in the named conversation. Revoke with !revoke ${proposal.id}.`;
  }
  async propose(event: MessageEvent, input: SocialAction): Promise<string> {
    if (!this.authorized(event)) return "This conversation is not authorized.";
    const action = socialActionSchema.parse(input);
    const owner = this.owner(event);
    if (action.kind === "post") {
      if (!owner) return "Only Raygen's turns can post to other destinations.";
      const result = await this.send(
        JSON.stringify([event.address.accountId, event.id, "post"]),
        {
          channel: "slack",
          accountId: this.options.teamId,
          conversationId: action.conversationId,
          ...(action.threadId ? { threadId: action.threadId } : {}),
        },
        action.text,
      );
      return `Post delivery ${result.status}. ${result.status === "sent" ? "Slack accepted the message." : "Do not assume it arrived or repeat an uncertain send."}`;
    }
    if (
      action.userId === RAYGEN_SLACK_ID ||
      action.userId === this.options.botUserId
    )
      return "Choose a human recipient other than Raygen or June.";
    // Private material may only originate in an owner-private turn, and only
    // the frozen, explicitly reviewed excerpt will be shared after approval.
    if (action.kind === "outreach" && !(owner && event.direct))
      return "Outreach requires Raygen's private request and approval.";
    if (action.kind === "request_access") {
      if (
        !owner &&
        (action.userId !== event.senderId ||
          action.conversationId !== event.address.conversationId ||
          action.sharedContext !== "")
      )
        return "I can request tools for this conversation, but only Raygen can propose private context to share.";
      if (action.sharedContext && !(owner && event.direct))
        return "Propose shareable context privately with Raygen.";
    }
    const id = createHash("sha256")
      .update(JSON.stringify([event.address.accountId, event.id, "social"]))
      .digest("hex")
      .slice(0, 24);
    let proposal = this.get(id);
    if (!proposal) {
      // A guest cannot turn a mention flood into an owner-notification flood.
      const recent = this.rows().filter(
        (row) =>
          row.created > this.now() - DAY &&
          row.accountId === event.address.accountId,
      );
      if (
        !owner &&
        (recent.filter((row) => row.requester === event.senderId).length >= 2 ||
          recent.filter((row) => row.requester !== RAYGEN_SLACK_ID).length >=
            20)
      )
        return "I've reached the approval-request limit. Please ask Raygen directly; no extra access was granted.";
      proposal = {
        id,
        accountId: event.address.accountId,
        requester: event.senderId,
        action,
        status: "pending",
        created: this.now(),
        expires: this.now() + DAY,
      };
      this.save(proposal);
    }
    if (proposal.status !== "pending" || proposal.expires <= this.now())
      return `Request ${id} is no longer pending.`;
    // Never reconstruct a replayed proposal from fresh model output.
    const frozen = proposal.action;
    const dm =
      owner ||
      event.direct ||
      frozen.kind === "outreach" ||
      frozen.via === "dm";
    const address: Address = dm
      ? {
          channel: "slack",
          accountId: proposal.accountId,
          conversationId: RAYGEN_SLACK_ID,
        }
      : {
          ...event.address,
          threadId: event.address.threadId ?? event.messageId,
        };
    // Model/user prose must not create Slack broadcasts, links or extra pings
    // in the approval preview. The approved outreach retains its exact bytes.
    const quoted = (text: string) =>
      JSON.stringify(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    const summary =
      frozen.kind === "outreach"
        ? `Send one DM to <@${frozen.userId}>. Exact message (JSON quoted):\n${quoted(frozen.text)}`
        : `Allow <@${frozen.userId}> in conversation ${frozen.conversationId} for 30 days. Topic (purpose, not an access classifier): ${quoted(frozen.topic)}\nTools: ${frozen.tools.join(", ") || "none"}. This permits those tools throughout that conversation, not just one thread.\nExact shareable context (visible to that conversation): ${quoted(frozen.sharedContext)}\nNo access to private memory, private search, coding, or administrative tools.`;
    const result = await this.send(
      `${id}:notice`,
      address,
      `<@${RAYGEN_SLACK_ID}> May I? Request ${id}, requested by <@${proposal.requester}>.\n${summary}\nNothing is authorized yet. Reply with exactly !allow ${id} or !deny ${id} (mention me too if replying in a channel). Request expires in 24 hours.`,
    );
    return `Approval request ${id}: notification ${result.status}. No extra permission is active. ${result.status === "sent" ? "Waiting for Raygen." : "I cannot confirm Raygen received it; ask him directly."}`;
  }
}
