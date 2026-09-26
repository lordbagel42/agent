# June project guidance

## Tests and verification

- Keep tests minimal. Do not write new tests unless they protect absolute core
  logic, such as permission enforcement, privacy boundaries, or preventing
  duplicate external side effects.
- Prefer straightforward implementation and focused runtime checks over broad
  test suites, routine unit tests, or test-driven development ceremonies.
- Still run the formatter, linter, and typechecker for code changes and use
  relevant existing tests when useful. Report meaningful verification limits.
- Do not remove existing tests solely because of this policy.
