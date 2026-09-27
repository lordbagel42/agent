- Always start code from the latest commit on GitHub's `main` branch.
- Once code is tested and reviewed, push directly to `main`. Use trunk-based development.
- Do not impose push holds on this or other agents for measurements, settings changes, or coordination. Rebase over concurrent work; use deployment/operator locks for live mutations, not Git publication freezes.
- Keep unit tests few and focused. Prioritize thorough manual testing of real workflows, edge cases, and failure paths.
- Always have a more capable or higher-effort agent review changes before pushing (for example, Oracle in Amp or Opus at higher effort in Claude Code).

## Slack app configuration

- Additive June Slack app changes managed through the Slack CLI (or equivalent
  Slack app-management APIs) are pre-authorized: add features, scopes, event
  subscriptions, and the installation updates needed to enable them without
  asking Raygen again.
- Ask Raygen before removing or disabling existing Slack app features,
  permissions, subscriptions, or installations. Start from a fresh live manifest
  and preserve unrelated settings, including OAuth redirects and MCP settings.
- This permission concerns Slack app configuration, not unrelated infrastructure,
  private credential disclosure, or bypassing June's runtime permission checks.

## June-facing capabilities

- Every tool or feature built for June must be accessible to June herself, not
  only to humans through dashboards, CLIs, or developer-only workflows.
- Provide a discoverable, agent-callable interface and instructions so she can
  use each capability within the existing permission and safety boundaries.
- For example, analytics tooling must let June query and inspect her own
  analytics. Apply the same requirement to every other capability.
- Verify the June-facing workflow before considering a feature complete.

## Deployed June

- June runs in LXC 215 at `192.168.0.215`. Health: `curl -fsS http://192.168.0.215:3080/health`.
- On `homelab-amp`, run `bash .amp/in/june-ops/ssh-june '<command>'` from `/home/amp/workspaces/pulumi-homelab-june`. It uses existing private credentials and pinned host verification; do not copy keys or weaken SSH checks.
- App logs: `journalctl -u june.service -n 100 --no-pager`. Status: `systemctl status june.service june-deploy.service --no-pager`.
- Deployment logs: `journalctl -u june-deploy.service -n 100 --no-pager`. Safe deployment feed: `/var/lib/june-deploy/public/events.json`.
- Verify the running revision using health and `readlink /proc/$(systemctl show june.service -p MainPID --value)/cwd`, not just GitHub or the `current` symlink.
- Config is `/etc/june/config.json`; persistent data is `/var/lib/june/rivet`. Never print credentials, Codex auth, or private message bodies, and never restore old conversation data to roll back code.
- Rivet UI is `http://127.0.0.1:6420/ui/` on June. Use an authorized SSH tunnel for access; it has administrative controls, so do not expose it publicly or assume browsing is read-only.
- Main pushes deploy automatically. Follow `docs/deployment.md` for recovery and coordinated config changes; config is bound to immutable releases. Do not run the old provisioner or change config/services concurrently with deployment.
