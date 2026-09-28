# Ordinary Amp jobs (separate from Puck and recovery)

June and her execution workers use existing `coding` proposals for named
`amp-*` workspaces, followed by the owner's fresh, plain private `!approve ID`.
The host dispatches SSH → authenticated Amp CLI → `runner:homelab-amp`, using
the deployment controller's shared CLI argv builder and sanitized runner exec.
There is no new Amp API, copied token, or MCP dependency. Puck remains the
separate OAuth MCP conversational path. Deployment recovery remains incident-only.

All native Amp launch paths require `--features fast`, including automatic
deployment recovery. Reasoning modes remain unchanged; Fast is premium faster
serving, not a lighter model. The pinned SDK uses a pnpm patch because its public
options do not expose features yet. Revisit that patch on SDK upgrades. It also
forwards the flag for continuations, but does not certify that previously created
threads change their stored feature state. No live agent was launched to verify
provider serving, and publication alone does not activate the updated host scripts.

`codingJob list/inspect/report/cancel` exposes saved job receipts privately.
The host records `system/init.session_id`, a bounded final result, and sends the
existing completion notification (including the associated execution worker).
Remote `completed` means the CLI returned a final result and exited successfully,
**not independently verified code**. No local `CodingRuntime`, worktree verifier,
artifact, Dynamic App build receipt, or diff is fabricated for remote paths.

## Operator activation (not performed by publication)

Obtain explicit authorization and coordinate with deployment before changing
hosts, keys, config or services. Keep disabled until the dedicated execution
host and its filesystem/process/network isolation are accepted. Prompt rules
and worktrees are not a security sandbox. The authenticated June host is trusted
to enforce owner approval; the forced command enforces the narrower transport
policy, not natural-language task intent.

1. On the authenticated CLI host, install `scripts/deploy/jobs_runner.py`,
   `runner.py`, and `deploy.py` root-owned together outside mutable releases.
   Keep the existing recovery forced command/key/config unchanged. Authorize a
   **different ordinary-job key**, with `restrict`, an appropriate `from=` source
   restriction, and a forced command invoking `python3 -I` on the installed
   `jobs_runner.py`. No shell, PTY, forwarding, user rc, or supplied environment.
   Never authorize this key on the recovery wrapper or reuse the recovery key.
2. Install root-owned, non-group/world-writable `/etc/june-jobs/runner.json`:

   ```json
   {
     "command": ["/home/amp/.amp/bin/amp"],
     "policyRevision": "ordinary-jobs-v1",
     "workspaces": {"amp-june": "/home/amp/workspaces/june-jobs"},
     "database": "/var/lib/june-jobs/dispatch.sqlite"
   }
   ```

   Set real reviewed paths. Provision the database parent as a private persistent
   directory writable only by the CLI account. Preserve this database across
   releases/restarts: its unique job IDs prohibit second dispatches even if exec
   fails. Do not reset it to retry. Provision the named remote directories; Amp's
   existing account/runner login stays on this host. No OAuth setup for this path.
3. On June's host, provision only the new SSH identity (0600, private parent) and
   operator-verified pinned known-host entry. Fill the disabled `ampJobs` example
   in `config.example.json`; workspace names, directories and `policyRevision`
   must match the forced-command policy. Then separately authorize enabling
   `ampJobs.enabled` and `JUNE_ALLOW_REMOTE_AMP_JOBS=1`. Local coding may remain
   disabled; its separate `JUNE_ALLOW_NATIVE_CODING` opt-in is not needed here.
   `amp-*` names are reserved; local and remote workspaces cannot overlap.
4. Review permissions and loaded process revision/readiness. Only after separate
   authorization, verify a harmless owner-approved end-to-end job and its private
   thread/result receipts. Configuration and repository tests alone do not prove
   live authentication, runner availability, or isolation.

The exact proposal is bound to the local/remote configuration digest. Change
`policyRevision` on **both** hosts whenever the forced-command/CLI execution
policy or host identity changes, even if paths stay the same. Configuration
changes invalidate prior approvals, not silently retarget them.

## Uncertain execution

Durable launch intent precedes SSH. Neither workflow replay, duplicate approvals,
nor `!resume-stopped` may launch a remote job again. Cancellation/timeout only
ends local SSH observation; the remote agent may continue. Missing or partial
receipts and failed transport need manual execution-host/thread reconciliation,
not automatic retry or a replacement proposal. Lost connections do not retrieve
later results: inspect the saved thread on the execution host manually. No
remote stop/continue/poll API is implemented. Never delete dispatch claims as a
recovery shortcut. The worker has no push, publication, deployment, infrastructure,
credential-reading, or additional-agent authority.
