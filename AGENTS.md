- Always start code from the latest commit on GitHub's `main` branch.
- Once code is tested and reviewed, push directly to `main`. Use trunk-based development.
- Do not impose push holds on this or other agents for measurements, settings changes, or coordination. Rebase over concurrent work; use deployment/operator locks for live mutations, not Git publication freezes.
- Keep unit tests few and focused. Prioritize thorough manual testing of real workflows, edge cases, and failure paths.
- Always have a more capable or higher-effort agent review changes before pushing (for example, Oracle in Amp or Opus at higher effort in Claude Code).

## Slack app configuration

- Never request the Slack OAuth scope `links:write`.
- Obtain the deployment owner's authorization before changing Slack app features,
  permissions, subscriptions, or installations. This file grants no standing
  permission to change a live app or infrastructure.
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

- Obtain operator authorization for live deployment, service, or configuration
  changes. Repository publication is not evidence of runtime activation.
- Verify the loaded process revision and readiness, not just Git or a release
  symlink. Follow `docs/deployment.md` for recovery and coordinated config changes.
- Never print credentials, provider authentication, or private message bodies,
  and never restore old conversation data to roll back code.
- Keep administrative interfaces private. Use authorized access with pinned host
  verification; do not copy keys or weaken SSH checks. Administrative browsing
  is not necessarily read-only.
- Do not change configuration or services concurrently with deployment.
