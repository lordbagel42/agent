# Effect migration: Knowledge stream

Owner thread: https://ampcode.com/threads/T-01a1284b-672e-767f-a73c-46725fcd4837
Spec: `docs/superpowers/specs/2026-10-10-effect-migration-design.md` (Workstreams).

## Converted

- `src/imports/` connectors (`b138c9c`): Slack and Gmail page fetchers are
  `Effect.fn` programs with `ImportError`/`ProviderError` tagged errors and
  Effect Schema responses. `pageFetcher()` keeps the memory store's Promise
  `PageFetcher` contract and runs on the injected `effectRuntime`.
- `src/mind/` (`42b7344`): `MindRepo`, `Transcripts`, `MindLock`,
  `MindSafety`, `runMindAgent`, `reflect`, `dream`, `advanceImprovements` are
  Effect code; `Mind` keeps Promise methods for `main.ts` and the registry.
  `safety.json` decodes with `src/effect/schema.ts` helpers.

## Remaining

`src/memory/` (`store.ts` with Conversation's embedded `sessionArchiveSchema`,
`curated.ts`, `backup.ts`), `src/reflection/`, `src/research/`,
`src/repository/`, `src/settings/` (store), `src/artifacts/` and `src/apps/`
outside HTTP, then `src/operations/`, `src/budgets/`, `src/policy/` (mostly
constant text). Model-facing contracts embedded in `companionReplySchema`
(settings, apps, artifacts, research, repository, mind, reflection jury and
proposals) stay Zod until the Providers slice converts that composite.

## Decisions

- Promise adapters at module boundaries run on `effectRuntime`; nothing builds
  its own runtime. Former `try/catch/finally` around awaited work becomes
  `Effect.catch`/`catchDefect`/`catchCause`/`onError`/`ensuring`, because JS
  `try` does not see Effect failures inside `Effect.gen`.
- Error messages that reach logs or callers stay the same text, except git
  command failures in `MindRepo`, which now report `mind_git_failed` instead of
  the command line and stderr.
- Zod replacements use `src/effect/schema.ts` (`decodeStrict`, `Int`, `Uuid`,
  `isPattern`, `withDefault`, `TrimmedString`, URL/email helpers), never
  parallel local helpers.

## Parity-probe method

Before each commit, copy the `HEAD` versions of the touched files into
`.amp/in/old/` (rewriting `../` imports to the live tree), then run a
throwaway `tsx` probe under `.amp/in/probes/` that drives old and new code
through the same scenarios and diffs normalized output (SHAs, timestamps,
UUIDs and durations masked):

- Schemas: decode a table of valid, boundary and invalid inputs with Zod and
  Effect; compare the JSON output or rejection. For persisted shapes include
  legacy inputs with defaulted keys absent.
- I/O modules: fake transports or temporary directories (a bare Git remote for
  `MindRepo`) exercising success, every error branch, aborts and restore paths;
  compare results, thrown messages and the files written.

Delete the probes after the commit; no tests are committed.
