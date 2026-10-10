# June project guidance

## Session startup

- Unless running in an Amp orb, first create a new Git worktree for the task
  from the latest remote code, rather than working in an existing checkout.
  Fetch the remote, then add the worktree from the upstream branch (for example,
  `git worktree add -b <branch> <path> origin/main`). Do all work inside that
  worktree and leave other checkouts and worktrees untouched.
- Always pull the latest code from the current branch's configured remote
  upstream at the start of every session, before beginning work. Use
  `git pull --ff-only` to avoid implicit merge commits or rebases.
- Check Git status first and preserve all local changes and unpushed commits.
  If the pull is blocked by local changes, divergent history, a missing upstream,
  or an authentication failure, report the blocker rather than resetting,
  discarding, or automatically stashing work.

## Trunk-based development and shipping

- Work directly on `main`. Do not create feature branches or pull requests;
  this repository uses trunk-based development, not a branch-and-PR workflow.
- Ship the smallest working, verified increment to remote `main` as soon as it
  is ready, even when the larger feature is unfinished. Keep `main` usable;
  do not wait to batch independently shippable changes into a complete feature.
- Use small, atomic Conventional Commits. Run the project's formatter, linter,
  and typechecker before committing code, plus relevant focused checks.
- Larger or high-impact changes require an Oracle review before shipping.
  Address material findings before pushing; small, routine changes do not
  require Oracle review.
- Agents have standing permission to commit and push ready changes directly to
  remote `main` without asking for approval each time. This permission does not
  authorize force-pushing, discarding others' work, or unrelated external actions.
- Fetch the latest remote `main` and rebase onto it before pushing code, then
  integrate concurrent changes safely, rerunning affected checks. Use normal,
  non-force pushes only.
- Preserve other sessions' work. If an existing shared checkout is on another
  branch, do not switch it out from under them or ship their unreviewed changes;
  use a separate checkout on `main` instead.
- Do not impose push holds on this or other agents for measurements, settings changes, or coordination. Rebase over concurrent work; use deployment/operator locks for live mutations, not Git publication freezes.

## Post-push deployment follow-up

- Own the result after pushing: follow the automatic deployment through live
  verification and tell the user when it is deployed. Do not close out or archive
  a thread with only "pushed", "not yet deployed", or "deployment not verified".
  A successful push starts this follow-up; it does not complete the task.
- Immediately check the exact pushed SHA and affected services. If deployment
  is not already verified, set a durable timer in this same thread before ending
  the turn. This is standing authorization for post-push deployment monitoring.
  Load `building-schedules`, prefer a supported deployment-event subscription
  when available, otherwise use an existing-thread Amp schedule every five
  minutes (`RRULE:FREQ=MINUTELY;INTERVAL=5`). Do not substitute a promise to check
  later, a detached shell loop, or a timer that only reminds the user to check.
- Read the thread's existing schedule first. Reuse the deployment follow-up for
  later pushes, preserving all unverified SHAs and affected services; do not
  silently replace unrelated scheduled work. Save the target SHAs, push time,
  services, evidence sources, and success/blocker/stop conditions in the prompt.
  If scheduling is unavailable or conflicts with unrelated work, keep checking
  in the current turn and report the limitation rather than dropping ownership.
- On each check, execute read-only checks, not just a review of earlier messages.
  Inspect GitHub's native `june/deploy` check and controller receipts for the
  target; `june/build` success alone is not deployment success. For example,
  with `SHA` set to the full pushed revision:

  ```sh
  gh api "repos/lordbagel42/agent/commits/$SHA/check-runs" \
    --jq '.check_runs[] | {name, status, conclusion, html_url}'
  ```

- Confirm fresh live readiness and the loaded process revision using
  `debugging-june` and `docs/deployment.md`: June's active `/health` must return
  HTTP 200 with `ready: true`, and its revision must match the running service's
  MainPID/release directory. Accept the target SHA or a verified descendant
  (`git merge-base --is-ancestor "$SHA" "$LOADED"` with both commits available).
  A coalesced/superseded commit can therefore be delivered by a later release;
  a skipped GitHub check alone cannot prove that. Historical success, a moving
  release symlink, and the GitHub branch head are not live deployment evidence.
  For blue/green deployments, also verify cutover is settled and intake is
  forwarding to that ready slot; a healthy but unrouted process or paused intake
  is not a completed deployment.
- Verify every affected companion independently. The debug site has its own
  updater, loaded revision and `/health` receipt (`docs/debug-site.md`); installed
  controllers and other companions may require a separate authorized update.
  Do not claim those are deployed because June is ready. An unchanged-input
  skip is a verified no-op only after checking the relevant inputs and receipt;
  never relabel the old process as running the new SHA.
- Report "Deployed" only after those checks pass, with the observed revision,
  affected services, and check time; then clear the deployment-only schedule.
  Routine unchanged pending checks need no repeated user message. If deployment
  fails, rolls back, is blocked, cannot be observed, or remains pending for
  30 minutes after the push, investigate and report the concrete blocker and
  next action. Follow existing recovery ownership and deployment safety rules;
  do not duplicate recovery agents, force activation, or clear an operator hold.
  Continue monitoring while deployment/recovery is progressing. Stop only on
  verified completion, explicit cancellation, accepted handoff, or a diagnosed
  blocker requiring owner action that has been reported to the user; clear the
  deployment-only timer on exit. Never silently expire or claim success to
  avoid reporting a real blocker.

## Tests and verification

- Tests are not necessary. June is maintained by modern agents and has
  recovery built in; verify changes by running the real workflow, typecheck
  and lint instead. Do not add tests for features, bug fixes or refactors.
- The only tests kept protect June's ability to self-heal: deploy controller,
  Actions build gate and recovery dispatch (`scripts/deploy/test_deploy.py`,
  `test_runner.py`, `test_actions.py`, `test_issues.py`),
  standby/rollback (`src/deployment/`), the lifecycle failure latch and drain,
  engine slot handoff, and isolated startup. Change them only when that core
  behavior intentionally changes. A new test is justified only if a change
  could otherwise silently break recovery, rollback or redeploy.
- The installed host preflights run `src/core/routing.test.ts`,
  `src/runtime/delivery.test.ts`, `tests/startup.test.ts` and
  `src/diagnostics` by path. Do not delete or rename those without first
  updating the installed preflight policy.

## Slack app configuration

- Never request the Slack OAuth scope `links:write`.
- Obtain the deployment owner's authorization before changing Slack app features,
  permissions, subscriptions, or installations. The deployment permission below
  does not authorize expanding Slack permissions or changing its installation.
- Start from a fresh live manifest and preserve unrelated settings, including
  OAuth redirects and MCP settings. Never disclose private credentials or bypass
  June's runtime permission checks.

## June-facing capabilities

- Every tool or feature built for June must be accessible to June herself, not
  only to humans through dashboards, CLIs, or developer-only workflows.
- Provide a discoverable, agent-callable interface and instructions so she can
  use each capability within the existing permission and safety boundaries.
- For example, analytics tooling must let June query and inspect her own
  analytics. Apply the same requirement to every other capability.
- Verify the June-facing workflow before considering a feature complete.
- New features ship enabled by default. Raygen adds features to have them used,
  so do not leave them behind off-by-default flags or "not enabled yet" states.
  Enable and configure them in the live deployment as part of shipping.
- If a feature genuinely cannot run yet (for example, it needs an API key,
  credential, or external account), June must know it is disabled, why, and
  exactly what is missing. Give her a way to inspect that state and resolve it
  herself within her existing permissions, such as requesting the credential
  from Raygen or completing the setup, rather than relying on a human to notice.
- Always keep June up to date on how her code functions. Changes to behavior she
  relies on must update the actual runtime instructions/context she receives in
  the same change, not only developer documentation or this file.
- Especially document automation: triggers, configuration gates, background
  work, ownership, retries/recovery, approvals, notifications, status inspection,
  and what June must not duplicate. Distinguish implemented support from enabled
  configuration, observed receipts, and verified live behavior.
- Verify this knowledge reaches the affected interaction, execution-worker, and
  automated-event prompt paths; tool-specific help alone may not reach them.

## Deployment safety

- Raygen grants standing authorization to complete requested June/debug work,
  including installing/updating its companion services, configuring the existing
  integrations, deploying reviewed code, and performing necessary service
  restarts. Do not ask again merely because completing the requested feature
  requires these actions. Carry explicit task authorization through verification.
- This permission is scoped to the requested outcome. It does not authorize
  unrelated infrastructure changes, permission expansion, deleting non-disposable
  data, bypassing runtime grants, taking another operator's hold, or repeating
  an uncertain external effect. Obtain an explicit handoff from an existing owner.
- Use the deployment tooling for app and companion updates, not ad hoc file
  replacement. Preserve journals, credentials, archive/passkeys and conversation
  data. Acquire the documented host/operator locks and settle active jobs first.
  Repository publication is not evidence of runtime activation.
- Verify the loaded process revision and readiness, not just Git or a release
  symlink. Follow `docs/deployment.md` for recovery and coordinated config changes.
- Never print credentials, provider authentication, or private message bodies,
  and never restore old conversation data to roll back code.
- Keep administrative interfaces private. Use authorized access with pinned host
  verification; do not copy keys or weaken SSH checks. Administrative browsing
  is not necessarily read-only.
- Do not change configuration or services concurrently with deployment.
