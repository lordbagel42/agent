# Activity-period conversation actors

Status: approved architectural direction. The session-directory prerequisite is
implemented separately; live session routing, archive/recall integration and
migration are not implemented or activated by that prerequisite.

## Outcome and scope

June should remember an earlier conversation without replaying its transcript
into every later model request. Each period of activity gets a distinct durable
Rivet interaction actor. The platform DM is an address, the privacy scope is an
authorization boundary, and the activity session is neither of those things.

Start with authenticated owner Slack DMs. Preserve the existing linked-owner-DM
scope, public and guest routing, worker capabilities, and delivery permissions.
Do not roll public conversations or guests into private sessions. Reject enabling
this experiment while another linked adapter can feed the same private scope but
does not yet use the coordinator. Do not silently split one owner-private scope
into competing legacy and session lanes. Unaffected scopes retain their behavior.

The initial idle threshold is three hours, configurable independently
of reflection timing. A gap at or above the threshold starts a new session.
Replies to an old Slack thread keep their placement but use a new activity actor
after the gap. These are reversible implementation defaults under the approved
direction, not additional owner requirements or a new design approval gate.

## Ownership

| Component | Durable responsibility |
| --- | --- |
| Scope coordinator | Authenticated scope, current session, durable ingress assignments, worker roster and proposal/task lookup across sessions |
| Interaction session | One period's conversation turns, model invocation receipts, transcript and delivery records |
| Execution/coding/workflow actors | Existing work, task identity, tool authority, cancellation and results; independent of session expiry |
| Retained memory | Searchable episodes, grounded claims, summary derivatives and deletion dependencies |

The coordinator is routing and control state, not another LLM. Session actors
handle conversation, clarification, delegation and synthesis; substantive work
belongs to execution workers. Ending a session does not end June's identity,
personality, outstanding approvals, workers or schedules.

Scope keys remain host-derived from authenticated routing. Session keys use an
opaque host-generated ID, persisted before dispatch, and a stable scope binding.
Never append a session ID to a memory audience or to a reusable worker identity.
Use safe compound key segments rather than raw JSON in Rivet keys.

## Ingress and rotation

The coordinator accepts each authenticated event once. Its persisted receipt
records the event identity and first host-received time. It durably assigns that
receipt to a session before enqueueing it there. Retrying a lost queue
acknowledgment reuses that assignment; the session also deduplicates the event.
Neither duplicate delivery nor queue replay refreshes the activity clock.

Use first receipt time, not provider-controlled timestamps or eventual model
start time, to compare human-message gaps. Retain platform timestamps separately
for citation and ordering. A backward host-clock change cannot prematurely expire
a session. Reactions, worker results, reflection, inspection and delivery receipts
do not refresh human activity.

An idle boundary is a routing boundary, not permission to interrupt a model call.
The coordinator can durably queue incoming events while a previous turn settles.
It cannot start a second conversational turn for the same scope while the first
is live or uncertain. Messages received within one activity period remain grouped
together even if a backlog delays processing. Long-running delegated jobs do not
hold the conversational session open after their dispatch turn settles.

A durable idle wake seals an eligible, quiescent session even if no later message
arrives. Admission of the next message also checks the boundary, so a delayed
idle wake cannot accidentally reuse an expired session. A seal names its final
turn sequence; a stale timer cannot seal a session that received new activity.

Closing follows this order:

1. Finish already-assigned conversational turns and establish no live/uncertain
   conversational invocation or delivery remains.
2. Persist/index every retainable transcript entry through the final sequence.
3. Verify the archive watermark and persist the sealed session record.
4. Open the next session when there is an eligible event to handle.

Archive writes and actor state saves are not one transaction. Stable entry IDs,
an acknowledged watermark and idempotent replay repair the gap. A summary is not
an archive acknowledgment. If archive persistence is unavailable, retain the old
session and queued input, expose the failure, and do not claim rotation succeeded.
Summary/provider failure alone does not block rotation or the next reply.

Sealed actors remain durable records. They do not accept new conversational turns
or resume inference because an operator or recall request reads them. Application
closure is distinct from Rivet process hibernation and actor destruction.

## Archive, summary and recall

Archive incrementally rather than waiting for the idle boundary. Preserve both
sides' ordered entries with session ID, authenticated audience, originating event
ID, author/role, original address, observation time and delivery status. Keep
failed/unknown deliveries distinguishable from text the platform accepted.

Extend the encrypted evidence store with episode records and a rebuildable search
projection. Do not encode assistant output or episode summaries as independent
original human sources. An assistant statement is evidence of what June said,
not corroboration of its factual content or proof an external action succeeded.
Existing claim review and independent-evidence rules remain unchanged.

Apply existing retention exclusions before archival: volatile Slack search,
private Rivet inspection output, login links, credentials and other non-retainable
tool results must not enter a session archive merely because they were delivered.
Represent omitted content with non-sensitive delivery metadata where needed.

On seal, enqueue one background episode-processing request keyed by session and
final sequence. Produce a bounded summary, decisions and unresolved commitments,
with dependencies on original transcript entries and their evidence. Grounded
memory proposals still use the existing review policy. A summary is untrusted
derived context, never instructions, permission or a replacement for originals.

Persist processing status separately from archive readiness. Retry known-not-
started work within existing limits; an interrupted provider invocation becomes
uncertain and follows existing recovery rules, not an automatic paid relaunch.
An unavailable summary leaves a searchable transcript and a visible pending or
uncertain processing record.

Extend June's existing owner-private model-callable recall interface to search
episodes by text/time and expand a selected episode into bounded message ranges.
Filter authorization and deletion before ranking. Return source references,
attribution, original times, delivery status, truncation and continuation metadata.
Use bounded results rather than returning an entire actor snapshot or journal.
Use the delegation thread's shared host-capability runner from the persistent
execution actor's durable callback. Workers perform recall and return scoped
findings; tools do not run on completion inside the conversation inbox. Do not
role-switch a conversation actor into an execution worker.

June can inspect the current session's ID, start/last-activity time and archive
status through a bounded owner-private capability. Exposing a capability only
through an operator dashboard is not completion.

## Fresh-session context

A new session starts with current input, the established identity/personality,
appropriate scoped memory, and at most one compact continuity note. It does not
inherit the previous session's raw history or a stack of historical summaries.

The optional note is at most 1,000 characters and contains only still-open,
provenance-backed commitments. Revalidate dependencies and task status each time
it is used. If absent, stale or unavailable, omit it and allow recall. Carrying a
note does not extend a session, authorize an action or renew an approval.

Bounded same-surface Slack context must obey the session boundary too. It may
enrich the current input and include messages assigned to the current activity
period, but cannot refill a new prompt with earlier history. An explicit reply
reference can retrieve the referenced message and relevant bounded context with
attribution; it does not reopen the old actor. Unsupported legacy timestamps or
missing provenance are not grounds to assume old content belongs in this session.

Within an active session, retain an input budget. Actor-per-session does not make
an arbitrarily long conversation fit into a model request. Existing bounds remain
until a separate budget change is justified; archived entries remain recallable.

## Work that outlives the session

The shared host/worker boundary needs distinct trusted values for:

- unchanged authenticated source MessageEvent;
- stable authenticated scope and privacy audience;
- originating conversation key, with session identity separate after rotation;
- stable worker/task identity, request identity and per-operation identity;
- original source address and separately host-selected reply address;
- frozen, versioned capability ceiling;
- deletion revision, sourceIds/contextSourceIds and revocation provenance;
- existing invocation/delivery receipts.

These are host-controlled context, not new model-supplied authority. A worker
cannot select a broader audience or an arbitrary return session. The scope owner
keeps approvals and the job index; the runner uses narrow metadata actions rather
than copying those indexes into a session or execution actor.

Worker completion records the task result under its original identity. A stable
notification ID then passes through the scope coordinator. If the original
session remains active, it can synthesize the result there. Otherwise route the
permitted notification to the current session; if none exists, create a fresh
notification session without pretending a new human message arrived. Preserve
the original authorized surface and reduced-authority completion-turn behavior.
Notification-only sessions close after settlement/archive when no human input
has joined them; they do not keep themselves alive with background activity.

The session that receives a result is not the source of approval. Proposal/task
lookup and exact approval receipts remain reachable through the stable scope.
Cancellation and deletion suppress stale results before synthesis and again
before delivery. Notification replay cannot synthesize/send twice or change its
assigned destination merely because another session has since opened.

## Forgetting and inspection

Tombstone the evidence first. Episode reads, summaries, continuity notes, prompts,
workers and pending deliveries must recheck the ledger and complete dependencies.
Do not rely on visiting every sleeping actor before the deletion takes effect.
Then perform resumable cleanup of affected active, sealed and legacy sessions.

The archive, its indexes and any new derivatives participate in the existing
authenticated tombstone-replay/restore rules. Restoring an older archive cannot
restore deleted material. Clearing current state still does not physically erase
old Rivet journals, provider requests, platform messages or retained backups.

Owner/operator inspection resolves the scope coordinator, then the selected
session. Task inspection is scope-wide; reading an old session is not routing new
traffic into it. Keep historical sessions discoverable without exposing private
state or raw actor journals to guests/public turns.

## Migration and safe delivery stages

Keep existing actor types/keys and journal step contracts readable. A deployment
must not reinterpret an in-progress conversation journal as a different actor
workflow or replay an uncertain effect under a fresh session ID.

First extract stable scope ownership and add archive/recall behavior without
rotation. Verify the existing conversation behavior before enabling new actors.
Next introduce a coordinator admission path that durably chooses legacy versus
session routing per event. During cutover, stop assigning new events to the legacy
lane, drain its accepted queue and known live turns, and record the last accepted
event boundary. New input waits durably until this handoff completes. Ambiguous
live work requires existing reconciliation; it is not declared drained by age.

Adopt existing event IDs into cross-session deduplication, preserve old proposal
lookup and worker identities, and archive only provably retainable legacy entries.
Legacy history with missing timestamps/dependencies is marked incomplete rather
than fabricated into a precise episode. Old worker/coding callbacks retain a
compatibility route through stable task lookup; do not require replaying their
launch to attach a new origin field.

Start rotation in the owner-DM experiment only when archive and recall are ready.
Do not silently fall back to permanent-history routing after accepting new-format
events. Disabling rotation stops future rotation while preserving current session
routing and historical lookup; it does not restore an older actor snapshot.

Production recovery is a separate workstream. Source work can proceed locally;
activation must respect the existing controller, compatibility checks and drain
locks. Report source publication separately from running-revision/readiness
evidence. No manual service restart or configuration mutation is authorized by
this design.

## Verification and coordination

Use controlled providers and disposable Rivet/evidence state. Keep durable tests
focused on privacy and duplicate effects; use focused runtime fixtures for the
remaining behavior. Verify:

- Active conversation stays in one actor; gaps just below versus at three hours
  select the expected actor, including backlog and host-clock rollback cases.
- Your first message after an idle gap has no earlier raw transcript in the actual
  provider request, including platform-context loading. Model-directed recall
  can recover a specific earlier user statement and June's attributed reply.
- Duplicate events and lost enqueue acknowledgments cannot cross into a second
  session, repeat inference/delivery, or refresh activity.
- A crash between archive write and sealing recovers one archive and one routing
  boundary. Summary failure does not prevent searchable recall or the next turn.
- A worker outlives its session, remains reusable, and delivers one authorized
  completion. A later approval resolves the original exact proposal.
- Public/guest prompts cannot access owner episodes. Deletion during processing,
  recall or delivery suppresses all affected derivatives, including after restore.
- Legacy in-flight/uncertain turns and delayed callbacks survive cutover without
  relaunching work. Notification-only activity does not prevent human idle expiry.

Delegation thread T-01a0e445-d70b-7275-9281-836ec96e1186 owns its dispatcher,
including registry.ts capability extraction/guards, execution.ts, prompt.ts,
provider/contracts capability schemas, main.ts provider wiring and new shared
capability-runner modules. Session thread
T-01a0e42f-e6cd-745e-bea6-6cdb53ea2e25 owns this design and session-specific work.
Session integration into those shared files follows the landed runner boundary.
Agree on any additional shared config/memory edits before writing them; consume
landed changes and reconcile normally, without publication freezes.
The cross-June orchestrator is T-01a0e44c-df6d-7492-a778-831613ce0284.
