# June capability rollout: technical intent

This historical plan records design priorities, not current implementation,
deployment status, operator authorization, or a coordination log. Consult the
[architecture](../../architecture.md), [capability evidence matrix](../../implementation-plan.md)
and [deployment guide](../../deployment.md) for the relevant boundaries.

## Capability families

- **Coding:** one persistent supervisor for proposals, exact approvals, status,
  cancellation, saved reports and verifier results. Cancellation is not proof of
  stopped execution; approval to work is not publication or deployment authority.
- **Personality:** one versioned public-safe profile across audiences, with private
  evidence-backed overlays. Compare-and-set revisions and exact public-payload
  review prevent stale edits and accidental disclosure of supporting evidence.
- **Memory:** bounded explicit recall, authenticated corrections, pending-claim
  review, contradiction/supersession relations and deletion-aware provenance.
  Retrieval filters audience before ranking, counting or relation expansion.
- **Imports:** account-bound coverage, exact page confirmation, durable cooldowns,
  cancellation and truthful gaps. A completed traversal is not complete account
  history, and an import is not approval of extracted claims.
- **Reflection:** bounded background work, current-evidence candidate review,
  explicit abstention and held uncertain provider attempts. Dreams and jury
  agreement are hypotheses, not independent evidence or action authorization.
- **Tools:** discoverable MCP inventory and reviewed contracts; exact proposals,
  durable cancellation and independently evidenced reconciliation. Browser and
  vault operations require isolated execution and exact account/item/origin
  binding; metadata inspection never resolves a credential.
- **Operations:** read-only capability, capacity and deployment evidence. Keep
  installed controller identity separate from the application's running revision.

## Safety requirements for each usable increment

1. Reuse existing inboxes, outboxes, supervisors and capability runners. Include
   the June-callable path, host validation and discoverable instructions where
   appropriate; avoid disconnected helpers and duplicate control planes.
2. Bind approval to authenticated identity and exact persisted scope. Model
   output, retrieved text and remote tool descriptions are untrusted data.
3. Revalidate deletion before reads, evaluation, promotion and delivery. Public
   promotion does not declassify private supporting records.
4. Make forgetting ledger-first and resumable, preserving unrelated later work.
   Authenticate restored snapshots and replay independently retained tombstones
   before exposing restored reads. Logical deletion is not physical erasure.
5. Preserve workflow journal compatibility and held unknown external outcomes.
   Stopped execution plus unknown outcome is still unknown; never invent a
   failed receipt merely to permit another attempt.
6. Check send-time attention, quiet policy, approval, rejection and deletion
   before unsolicited delivery. Review must not invalidate its own candidates.
7. Distinguish **implemented / host-integrated / June-callable / enabled /
   live-verified**. Source publication, configured credentials and process
   health cannot substitute for operation-specific runtime evidence.

## Verification and capacity

Use disposable state and controlled external boundaries for privacy, authority,
replay and duplicate-effect checks. Run the normal formatter, linter and
typechecker for code changes, plus relevant existing tests and focused workflow
checks. Inspect rendered UI changes. Do not send real messages, start paid jobs,
or mutate infrastructure merely to obtain a passing check.

Limit concurrent expensive checks to the host's measured CPU, memory and disk
capacity. Keep test state, ports and generated caches isolated; do not mutate
another checkout's dependencies or delete its data to make checks pass.

Activation remains feature-local and separately authorized. Coding, memory,
imports, reflection, browser/vault and controller installation each need their
own prerequisites and evidence; none is enabled by this plan.
