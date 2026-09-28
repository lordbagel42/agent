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
  type SocialAction,
  socialActionSchema,
} from "../core/social.js";
import { type Delivery, deliver } from "./delivery.js";
import {
  type ReflectionCandidate,
  reflectionCandidateId,
} from "./reflection.js";

const DAY = 86_400_000;
export interface InterruptionReference {
  candidateId: string;
  scope: string;
  requestId: string;
  epoch: number;
  evidenceIds: string[];
  publication: { version: 1; expiresAt: number };
}

interface Proposal {
  id: string;
  accountId: string;
  requester: string;
  action: Extract<SocialAction, { kind: "request_access" | "outreach" }>;
  status: "pending" | "approved" | "denied" | "revoked";
  created: number;
  expires: number;
  /** Private source binding, not permission. Generic outreach must not send it. */
  reflection?: InterruptionReference;
  /** Caller admission and receiver dispatch are separate durable boundaries. */
  interruptionCommands?: Record<
    string,
    SendResult | { status: "started" } | { status: "dispatching" }
  >;
}

/** Permissions are explicit owner decisions, never inferred relationship scores.
 * This private host ledger must not be exposed through a guest/operator proxy. */
export class SocialPermissions {
  private db: DatabaseSync;
  private ownerSlackId: string;
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
    const identities = options.owner.identities.filter(
      (identity) => identity.channel === "slack",
    );
    const identity = identities[0];
    if (identities.length !== 1 || identity?.accountId !== options.teamId)
      throw new Error(
        "Configure exactly one Slack owner in the configured workspace",
      );
    this.ownerSlackId = identity.senderId;
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(options.file);
    chmodSync(options.file, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS social_proposals (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS social_deliveries (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS social_privacy (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS social_reflection_rejections (
        account_id TEXT NOT NULL, scope TEXT NOT NULL, candidate_id TEXT NOT NULL,
        PRIMARY KEY (account_id, scope, candidate_id));`);
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
      event.senderId === this.ownerSlackId &&
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
    canStartAction?: () => boolean,
    check?: () => Extract<SendResult, { status: "rejected" }> | undefined,
    isCurrent: () => boolean = () => true,
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
      (message) => this.options.slack.send(message),
      () => {
        // Privacy reads may take time. Run them before the interruption gate's
        // final clock sample, leaving only adapter dispatch after that gate.
        this.forget();
        if (
          !isCurrent() ||
          revision !== (this.options.deletionRevision?.() ?? 0)
        )
          return { status: "rejected", code: "forgotten", retryable: false };
        if (canStartAction?.() === false)
          return {
            status: "rejected",
            code: "superseded_input",
            retryable: false,
          };
        return check?.();
      },
    );
  }
  /** Recognized private approval commands must not run inference/extraction,
   * which would invalidate the candidate before its explicit send decision. */
  interruptionCommand(event: MessageEvent): boolean {
    const command =
      event.direct &&
      event.reflectionReviewEligible === true &&
      this.command(event);
    return !!(command && this.get(command[2] ?? "")?.reflection);
  }
  async deliverInterruption(
    proposalId: string,
    reference: InterruptionReference,
    commandId: string,
    check: () => Extract<SendResult, { status: "rejected" }> | undefined,
  ): Promise<SendResult> {
    const proposal = this.get(proposalId);
    const approved = (current: Proposal | undefined) =>
      current?.status === "approved" &&
      current.expires > this.now() &&
      current.accountId === this.options.teamId &&
      JSON.stringify(current.reflection) === JSON.stringify(reference);
    const command = proposal?.interruptionCommands?.[commandId];
    if (!approved(proposal) || proposal?.action.kind !== "outreach" || !command)
      return {
        status: "rejected",
        code: "approval_required",
        retryable: false,
      };
    if (command.status === "dispatching")
      return { status: "unknown", code: "interrupted_approval" };
    if (command.status !== "started") return command;
    // The actor client may retry a dropped response without re-entering decide.
    // Claim this exact owner command before any await or outbox admission.
    proposal.interruptionCommands ??= {};
    proposal.interruptionCommands[commandId] = { status: "dispatching" };
    this.save(proposal);
    const result = await this.send(
      // The proposal ID binds account + candidate, not the approval message.
      `${proposal.id}:interruption`,
      {
        channel: "slack",
        accountId: proposal.accountId,
        conversationId: proposal.action.userId,
      },
      proposal.action.text,
      undefined,
      () => {
        // get() reconciles deletion tombstones even if host cleanup crashed.
        if (!approved(this.get(proposalId)))
          return {
            status: "rejected",
            code: "approval_invalidated",
            retryable: false,
          };
        return check();
      },
    );
    const current = this.get(proposalId);
    if (current) {
      if (
        result.status === "rejected" &&
        !result.retryable &&
        current.status === "approved"
      )
        current.status = "revoked";
      current.interruptionCommands ??= {};
      current.interruptionCommands[commandId] = result;
      this.save(current);
    }
    return result;
  }
  async decide(
    event: MessageEvent,
    interrupt?: (
      proposalId: string,
      reference: InterruptionReference,
      commandId: string,
    ) => Promise<SendResult>,
    observeDelivery?: (
      result: SendResult | { status: "started" | "dispatching" },
    ) => void,
  ): Promise<string> {
    const command = this.command(event);
    if (!command) return "Only Raygen can decide permissions.";
    const proposal = this.get(command[2] ?? "");
    if (
      !proposal ||
      proposal.accountId !== event.address.accountId ||
      proposal.expires <= this.now()
    )
      return "That request is missing or expired.";
    if (
      proposal.reflection &&
      !(event.direct && event.reflectionReviewEligible === true)
    )
      return "Interruption decisions require a fresh plain command in Raygen's private conversation. Approval is unchanged.";
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
    const denyInterruption =
      decision === "deny" &&
      proposal.status === "approved" &&
      !!proposal.reflection;
    if (proposal.status !== "pending" && !resumeOutreach && !denyInterruption)
      return `That request is already ${proposal.status}; it was not executed again.`;
    if (decision === "deny") {
      proposal.status = "denied";
      this.save(proposal);
      return "Denied. No additional access was granted.";
    }
    if (proposal.reflection && (!event.direct || !interrupt))
      return "Interruption delivery is unavailable without the private reflection delivery path. Approval is unchanged; nothing was sent.";
    if (!resumeOutreach) {
      proposal.status = "approved";
      proposal.expires = this.now() + 30 * DAY;
      this.save(proposal);
    }
    if (proposal.reflection && interrupt) {
      const commandId = JSON.stringify([
        event.address.accountId,
        event.address.conversationId,
        event.messageId,
      ]);
      let result = proposal.interruptionCommands?.[commandId];
      if (!result) {
        proposal.interruptionCommands ??= {};
        proposal.interruptionCommands[commandId] = { status: "started" };
        this.save(proposal);
        result = await interrupt(proposal.id, proposal.reflection, commandId);
        // A concurrent rejection/deletion must not be undone by saving the
        // pre-await approval snapshot with its completed command receipt.
        const current = this.get(proposal.id);
        if (current) {
          current.interruptionCommands ??= {};
          current.interruptionCommands[commandId] = result;
          this.save(current);
        }
      }
      observeDelivery?.(result);
      if (result.status === "started" || result.status === "dispatching")
        return `That approval command started previously and its outcome is unresolved. It was not replayed. Send a new !allow ${proposal.id} to recheck the existing outbox, or !revoke ${proposal.id}. Uncertain delivery is never resent.`;
      if (
        result.status === "rejected" &&
        ["quiet_hours", "live_activity"].includes(result.code)
      )
        return `Approved interruption queued (${result.code}); no message was sent. Repeat !allow ${proposal.id} when eligible, or !revoke ${proposal.id}. No automatic retry is scheduled.`;
      return `Approved interruption: delivery ${result.status}. ${result.status === "sent" ? "Slack accepted the message." : "Do not assume it arrived; uncertain delivery is never retried."}`;
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
      observeDelivery?.(result);
      return `Approved outreach: delivery ${result.status}. ${result.status === "sent" ? "Slack accepted the message." : "Do not assume it arrived; I will not automatically resend an uncertain delivery."}`;
    }
    return `Approved access ${proposal.id} for 30 days, only for the named person in the named conversation. Revoke with !revoke ${proposal.id}.`;
  }
  /** Commit before the actor acknowledges rejection. The content-free marker
   * also prevents restaging after recovery, even when no draft existed yet. */
  rejectInterruption(scope: string, candidateId: string): undefined {
    this.forget();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO social_reflection_rejections VALUES (?, ?, ?)",
        )
        .run(this.options.teamId, scope, candidateId);
      for (const row of this.db
        .prepare("SELECT value FROM social_proposals")
        .all()) {
        const proposal = JSON.parse(String(row.value)) as Proposal;
        if (
          proposal.accountId === this.options.teamId &&
          proposal.reflection?.scope === scope &&
          proposal.reflection.candidateId === candidateId &&
          (proposal.status === "pending" || proposal.status === "approved")
        ) {
          proposal.status = "revoked";
          this.save(proposal);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return undefined;
  }
  /** Trusted actor callback, called synchronously after current provenance and
   * operation fences are checked. Never accepts a model-provided candidate,
   * notifies a recipient, or creates an access grant. */
  stageInterruption(
    event: MessageEvent,
    input: { candidateId: string; userId: string; text: string },
    candidate: (ReflectionCandidate & { evidenceIds: string[] }) | null,
    sendEligible: boolean,
  ): string {
    if (!(this.owner(event) && event.direct))
      return "Interruption proposals require Raygen's private conversation.";
    const parsed = socialActionSchema.safeParse({
      kind: "outreach",
      userId: input.userId,
      text: input.text,
    });
    if (
      !/^[a-f0-9]{64}$/.test(input.candidateId) ||
      !parsed.success ||
      parsed.data.kind !== "outreach" ||
      parsed.data.userId === this.ownerSlackId ||
      parsed.data.userId === this.options.botUserId
    )
      return "Choose a valid candidate, human recipient other than Raygen or June, and a message of 1–3000 characters.";
    this.forget();
    if (
      !candidate ||
      reflectionCandidateId(candidate.id) !== input.candidateId ||
      candidate.scope !== JSON.stringify(["private", this.options.owner.id]) ||
      candidate.kind !== "interruption-candidate" ||
      candidate.hypothesisOnly ||
      candidate.decision.answer !== "yes" ||
      !candidate.publication ||
      !candidate.decision.evidenceIds.length
    )
      return "That interruption candidate is unavailable or no longer eligible. Nothing was staged or sent.";
    if (
      this.db
        .prepare(
          "SELECT 1 FROM social_reflection_rejections WHERE account_id = ? AND scope = ? AND candidate_id = ?",
        )
        .get(this.options.teamId, candidate.scope, input.candidateId)
    )
      return "That interruption candidate was rejected. Nothing was staged or sent.";
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          event.address.accountId,
          input.candidateId,
          "reflection-outreach",
        ]),
      )
      .digest("hex")
      .slice(0, 24);
    let proposal = this.get(id);
    if (!proposal) {
      proposal = {
        id,
        accountId: event.address.accountId,
        requester: event.senderId,
        action: parsed.data,
        status: "pending",
        created: this.now(),
        expires: this.now() + DAY,
        reflection: {
          candidateId: input.candidateId,
          scope: candidate.scope,
          requestId: candidate.requestId,
          epoch: candidate.epoch,
          evidenceIds: [...candidate.evidenceIds],
          publication: { ...candidate.publication },
        },
      };
      this.save(proposal);
    }
    if (proposal.status !== "pending" || proposal.expires <= this.now())
      return `Request ${id} is no longer pending. Nothing was staged or sent.`;
    if (proposal.action.kind !== "outreach")
      return "That interruption proposal is unavailable.";
    const quoted = JSON.stringify(proposal.action.text);
    return `Interruption proposal ${id}. Exact recipient: ${proposal.action.userId}. Exact message (JSON quoted):\n${quoted}\nCandidate ${input.candidateId} is a generated hypothesis, not permission. ${sendEligible ? `Authorize one guarded delivery with a fresh plain !allow ${id} in this private conversation. Eligibility is checked again immediately before sending.` : "The original candidate is not currently send-eligible; approving this draft alone cannot send it."} No outreach or separate notification was sent, and no access was granted. Deny with !deny ${id} or revoke with !revoke ${id}. Expires at ${new Date(proposal.expires).toISOString()}; repeated staging keeps the original recipient and message.`;
  }
  async propose(
    event: MessageEvent,
    input: SocialAction,
    canStartAction?: () => boolean,
    operationId = event.id,
    isCurrent: () => boolean = () => true,
  ): Promise<string> {
    if (!isCurrent() || !this.authorized(event))
      return "This conversation is not authorized.";
    const action = socialActionSchema.parse(input);
    if (action.kind === "interruption_proposal")
      return "Interruption staging requires the current private reflection gate. Nothing was staged or sent.";
    const owner = this.owner(event);
    if (action.kind === "post") {
      if (!owner) return "Only Raygen's turns can post to other destinations.";
      const result = await this.send(
        JSON.stringify([event.address.accountId, operationId, "post"]),
        {
          channel: "slack",
          accountId: this.options.teamId,
          conversationId: action.conversationId,
          ...(action.threadId ? { threadId: action.threadId } : {}),
        },
        action.text,
        canStartAction,
        undefined,
        isCurrent,
      );
      return `Post delivery ${result.status}. ${result.status === "sent" ? "Slack accepted the message." : "Do not assume it arrived or repeat an uncertain send."}`;
    }
    if (
      action.userId === this.ownerSlackId ||
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
      .update(JSON.stringify([event.address.accountId, operationId, "social"]))
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
          recent.filter((row) => row.requester !== this.ownerSlackId).length >=
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
          conversationId: this.ownerSlackId,
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
      `<@${this.ownerSlackId}> May I? Request ${id}, requested by <@${proposal.requester}>.\n${summary}\nNothing is authorized yet. Reply with exactly !allow ${id} or !deny ${id} (mention me too if replying in a channel). Request expires in 24 hours.`,
      canStartAction,
      undefined,
      isCurrent,
    );
    return `Approval request ${id}: notification ${result.status}. No extra permission is active. ${result.status === "sent" ? "Waiting for Raygen." : "I cannot confirm Raygen received it; ask him directly."}`;
  }
}
