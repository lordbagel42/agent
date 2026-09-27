# Independent release supervisor

**Legacy, inactive proposal-based policy.** The owner's trusted direct-main
policy now uses the independent host poller in
[docs/deployment.md](../../docs/deployment.md). `feed.ts` is its safe read-only
application interface. The class below is retained for its existing callers and
tests, but is not a prerequisite or approval gate for rapid deployment.

`ReleaseSupervisor` implements local artifact staging, exact-plan review, owner
approval, durable deployment/rollback intents, release-aware health receipts, and
explicit reconciliation. It does not build candidates, install itself, extract
archives, run shell commands, migrate application data, or register June tools or
HTTP routes. There is no automatic deployment or automatic rollback.

**This module is not activated. Same-process dependency injection demonstrates
behavior in disposable tests; it is not security isolation.** Do not import this
mutation boundary into the model-writable June host or expose it as a model tool.

## Required installation and trust boundary

All of these are prerequisites to actual activation, not assurances supplied by
this TypeScript class:

1. An operator installs a reviewed supervisor version, pinned Node 24 runtime,
   dependencies, verifier, adapter and configuration outside every candidate,
   worker worktree, and mutable application release. The install tree and its
   ancestors must be read-only to June, coding workers **and the supervisor's
   runtime UID**; only the installation administrator can replace enforcement.
   Never load adapter/verifier modules, environment files, dependency resolution
   paths, hooks or executable scripts from the candidate. A release cannot replace
   its own supervisor. Supervisor upgrades need separate operator authorization.
2. Run the supervisor under a dedicated OS identity, separate from June and every
   coding/build worker. Give it only the fixed service-control capability it
   needs. Candidates must not have its credentials, socket access, ptrace/process
   control, shared writable code, or write access through ACLs/groups/mounts.
   Native worktrees and same-UID metadata are **not** this boundary.
3. Pre-create a canonical local-filesystem storage directory, mode `0700`, owned
   by that supervisor UID, outside all candidate/checkouts. Its ancestors must
   not be replaceable by a candidate. `root` holds mode-`0600` SQLite/WAL files and
   mode-`0400` retained artifacts. The class checks canonical root ownership/mode
   and regular, single-link, non-symlink files. These checks do not defeat a
   malicious same-UID process or administrator. Use a filesystem with working
   SQLite locking and fsync; do not use a shared network filesystem.
4. Supply a separate authenticated **owner-only** operator transport. `principal`
   is a trusted authentication result, never a request field or a model's claim.
   Review and approval are separate explicit actions; display the entire stored
   plan, attestation and generation before approving its ID. POST-only mutations,
   body/storage quotas, CSRF protection where applicable, private sockets and
   response/error redaction belong to that transport. Keep approval tokens out
   of model context, logs, URLs and chat. Lost tokens require a new review and
   approval, not token recovery. No GET may approve, deploy, roll back or reconcile.
5. Supply the independent artifact authority described below and a trusted fixed
   adapter. Its service name, executable paths, arguments, environment,
   installation/extraction policy, network origins and health checks are installed
   operator configuration, never plan/model input. Preserve current and target
   artifacts while receipts can refer to them; there is no automatic garbage
   collection. The initial digest is an operator-established known-good release,
   not a guess from a branch or symlink.

No service units, OS accounts, sockets, real-data writes or permissions are
installed by this module or its tests. Production installation remains a separate
authorized infrastructure task.

## A command receipt cannot attest a release

The coding supervisor's `VerificationResult` contains only command outcome,
`baseCommit`, `headCommit`, `finishedAt`, `replayed` and omitted-output metadata.
`headCommit` is read **before** the check. It has no artifact/content digest,
verifier identity/configuration digest or signature. Neither a fresh pass nor a
completed coding job covers dirty/untracked/concurrent/later changes. Historical
replay never verifies the current attempt. Do not adapt that receipt by attaching
the target digest afterward.

An independently installed authority must freeze and hash the **complete exact
artifact to be executed**, including runtime dependencies and generated files,
before verifying it. It must verify that immutable snapshot using independently
trusted verifier code/policy/configuration, not candidate-controlled test scripts
as its authority. It also attests compatibility with the exact current artifact:
same application-state and Rivet-journal formats, no migrations, and safe rollback
after the target's ordinary writes. Equal labels alone do not prove compatibility.

The operator pins `verifierDigest`, a SHA-256 identity of that verifier and its
configuration. `verification(id)` is a **trusted synchronous lookup**, returning:

```ts
{
  currentDigest: string;  // exact current artifact, SHA-256 hex
  artifactDigest: string; // exact target bytes, SHA-256 hex
  verifierDigest: string;
  compatibility: {
    state: string;
    journal: string;
    migrations: "none";
    rollbackSafe: true;
  };
  passed: true;
  completedAt: number; // trusted completion time, Unix milliseconds
}
```

IDs must designate immutable attestations in a protected authority store. If the
authority is remote, the lookup must authenticate it and verify signed evidence
against independently pinned keys before returning. The digest field itself is
**not a signature**; accepting caller-supplied JSON defeats the boundary. The
class does not implement an artifact builder, verifier service or signature
transport. A missing/revoked/failed attestation must throw or return invalid data.

Evidence is strictly parsed, pinned, checked for non-future age at most
`verificationMaxAgeMs`, and copied into the review and receipt. Approval and deploy
re-fetch it and require equality with that snapshot. A newer verification under
the same ID cannot silently replace what the owner reviewed. Both artifacts are
rehashed at review, approval and deployment. Authorization/freshness is checked
again after preflight health, immediately before the first stop. Once effects
begin, expiry does not cancel an in-flight stop/start.

## API and durable behavior

Import from `./supervisor.js`. `ReleaseOptions` requires `root`, `owner`,
`initial: { digest, state, journal }`, `verifierDigest`, `verificationMaxAgeMs`,
`approvalTtlMs`, `verification(id)`, with optional trusted `adapter` and test clock
`now`. An absent adapter denies deployment. No candidate paths or commands occur
in a `ReleasePlan`:

```ts
{ current, target, review, verificationId, compatibility }
```

- `stage(bytes, expectedDigest): void` copies opaque bytes, checks SHA-256, fsyncs
  a private temporary file, then publishes a digest-named artifact without
  replacing anything. It performs no extraction. Existing altered files are
  rejected, not repaired. A crash may leave a `.staging` file; only an operator
  should inspect/remove it after quiescence.
- `review(principal, plan): ReleaseReview` stores and returns
  `{ id, plan, evidence, generation, reviewedAt }`; it grants no authority.
- `approve(principal, reviewId): { id, token }` consumes that exact review once.
  The receipt retains its ID. Only a token hash is durable; approval has a TTL.
- `receipt(principal, id): ReleaseReceipt` returns the plan/evidence, status,
  approval times, effect generation, intent times and last settled health
  observation when available. It never returns the token/hash or adapter output.
- `cancel(principal, id): void` revokes an unused approval.
- `deploy(principal, id, token): Promise<ReleaseReceipt>` consumes approval into
  a durable `deploy_unknown` intent **before any adapter effect**. It requires
  healthy current identity, stops current, starts the retained target, then
  records `healthy` or `unhealthy` only for that target's observed identity.
- `rollback(principal, id): Promise<ReleaseReceipt>` is one new explicit owner
  action from `healthy`/`unhealthy`, including after approval expiry. It persists
  `rollback_unknown`, stops target and starts the retained previous bytes. It
  records `rolled_back` only after healthy previous-release observation. The
  reviewed/attested rollback compatibility remains mandatory; no migrations or
  data-restoration procedure are provided.
- `reconcile(principal, id): Promise<ReleaseReceipt>` observes under the trusted
  quiescence gate below. It never calls stop/start. Healthy current resolves to
  `unchanged` (deployment) or `rolled_back` (rollback); target resolves to `healthy`
  or `unhealthy`. Unhealthy targets keep the block. Unexpected identity, no
  running release, or unhealthy previous release stays blocked for operator
  repair; this API does not guess or start another release to find out.
- `close(): void` closes SQLite when no operation is running.

The protected version-1 SQLite JSON state uses `BEGIN IMMEDIATE`, WAL and
`synchronous=FULL`. One active intent blocks other deployment. Accepting an
effect increments the release generation: earlier reviews/approvals cannot become
valid again after a deploy/rollback cycle returns to the same digest. Historical
receipts cannot roll back a later installation of the same target. Stored
state/journal formats must match on reopen; there is no migration mechanism.

Errors, timeouts and interrupted stop/start leave the existing unknown intent;
they never trigger retries. Reopening does not execute anything. Reconciliation
does not rearm the deployment token or reset the rollback-attempt guard. If an
unknown rollback reconciles to healthy target, retrying that receipt is still
denied; another rollout requires a new independently attested plan and approval.
Never delete the database or restore an old backup to clear an active intent:
that loses deduplication history. After storage loss/restore, keep service control
disabled pending separate operator recovery. This is at-most-one invocation per
approved attempt, not an exactly-once guarantee for an external service.

## Adapter contract

`stop(expectedDigest)` must atomically enforce the expected running identity,
drain application/Rivet writers and coding children, and definitively stop them.
`start({ digest, artifactPath })` receives only a supervisor-generated path. It
must safely materialize exactly those bytes into an immutable installed release,
without traversal, symlink escapes, candidate installation hooks or fetching
unattested dependencies. Resolve only when the launch attempt has finished;
never detach an operation that can mutate the installation later or internally
retry an ambiguous effect. The adapter must prevent out-of-band service changes.

`health()` returns `{ digest, healthy }` from actual running identity and readiness
observations, not an echo of a requested digest/current symlink. Check the running
process/service as well as application readiness; an untrusted candidate's
self-reported JSON is insufficient. The existing generic June health response
does not establish release identity and is not enough to activate this adapter.

`withQuiescence(observe)` must hold an exclusive service-wide fence while awaiting
`observe()`. Before invoking it, independently establish that all previous
supervisor processes, service-manager jobs, adapters and children are finished or
fenced from causing any future effect. An owner-provided `true`, empty health
probe or application inactivity alone is not evidence. Refuse if this cannot be
established. The class rejects reconciliation during its own in-flight operation
and checks the durable generation/status again after observation; cross-process
and external-service fencing still belongs to this installed adapter/host.

Run local core checks with `pnpm exec vitest run src/deployment/supervisor.test.ts`.
They use temporary directories and injected file-backed service/authority
fixtures, testing approval, attestation/digest integrity, durable duplicate-effect
guards, health identity and rollback. They do not validate real OS isolation,
the actual artifact builder, service control, power-loss durability, signed
attestations or production journal compatibility.
