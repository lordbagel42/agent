# June project guidance

## Trunk-based delivery

- Push release-ready commits directly to `lordbagel42/agent:main`. Do not create
  remote feature branches or pull requests for June. Keep unfinished work local.
- Merge and deploy ready changes promptly; do not accumulate release batches or
  add approval gates. The June-only deployment controller follows `main`.
- Fail fast and recover forward. Preserve conversation data and unknown-effect
  markers; never restore an old database or downgrade incompatible journals.
- Run the formatter, linter, typechecker and relevant focused checks before
  pushing. Use small Conventional Commits and report verification limitations.
- Distinguish published code from the actually running revision. Follow deployment
  through to health verification, and fix failed releases forward.
- This authorization covers June, not unrelated infrastructure or a whole-homelab
  deployment. Follow `docs/deployment.md` for the controller and recovery contract.

## Tests and verification

- Keep tests minimal. Do not write new tests unless they protect absolute core
  logic, such as permission enforcement, privacy boundaries, or preventing
  duplicate external side effects.
- Prefer straightforward implementation and focused runtime checks over broad
  test suites, routine unit tests, or test-driven development ceremonies.
- Still run the formatter, linter, and typechecker for code changes and use
  relevant existing tests when useful. Report meaningful verification limits.
- Do not remove existing tests solely because of this policy.
