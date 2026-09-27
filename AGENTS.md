- Always start code from the latest commit on GitHub's `main` branch.
- Once code is tested and reviewed, push directly to `main`. Use trunk-based development.
- Keep unit tests few and focused. Prioritize thorough manual testing of real workflows, edge cases, and failure paths.
- Always have a more capable or higher-effort agent review changes before pushing (for example, Oracle in Amp or Opus at higher effort in Claude Code).

## June-facing capabilities

- Every tool or feature built for June must be accessible to June herself, not
  only to humans through dashboards, CLIs, or developer-only workflows.
- Provide a discoverable, agent-callable interface and instructions so she can
  use each capability within the existing permission and safety boundaries.
- For example, analytics tooling must let June query and inspect her own
  analytics. Apply the same requirement to every other capability.
- Verify the June-facing workflow before considering a feature complete.
