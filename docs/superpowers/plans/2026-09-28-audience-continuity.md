# Audience continuity implementation plan

**Goal:** Preserve June's recent conversation across locations, with a separate,
tool-free privacy agent projecting context for the destination audience.

**Approved design:** One private activity context across verified owner
conversations. Three hours of human inactivity starts fresh working context;
changing reply location does not. Operational actors, jobs and permission scopes
remain separate. Verified owner DMs receive unfiltered continuity. Shared
destinations receive only filtered excerpts. Relationship memory is immature:
the filter defaults to public-safe material, never guesses trust, and respects
explicit non-disclosure. Unknown audiences or filter failures receive no imported
context. Channel threads also receive bounded parent-channel context.

**Implementation and checks:**
- [x] Extend Slack context reads to combine thread and parent-channel messages,
  retaining their actual source/thread attribution; update both host and prompt
  same-surface checks. Exercise existing Slack and prompt tests.
- [x] Add a private bounded SQLite activity-context store with duplicate input
  protection, idle rotation and deletion-revision invalidation. Keep raw context
  out of public actor history and unrelated worker scopes.
- [x] Add authenticated audience discovery and a separate JSON-only model call.
  Validate excerpt provenance, enforce restricted-content exclusions, fail closed
  on missing/incomplete audience information, and prevent automatic repeat of an
  ambiguous filter invocation.
- [x] Wire continuity into legacy and activity-session request construction and
  record actual conversational output. Make the runtime explain the behavior to
  June, including configuration, bounds and failure limitations. Do not activate
  configuration or any transport as part of source publication.
- [x] Verify core privacy/time/duplicate boundaries with focused tests and real
  disposable Rivet checks where applicable; run formatter, lint and typecheck,
  inspect the diff, obtain the required Oracle review, then publish separately
  from the already-pushed hourglass change.

Review fixes separate idle expiry from explicit revocation, propagate volatile
ancestry through workers and wakeups, omit derived archive text while preserving
active replies, and retain spent filter receipts at capacity. The focused set
passed 208 checks, including real local Rivet workflows. Provider censorship and
live Slack/WhatsApp compatibility were not exercised with production credentials.
Publication follows a rebase over concurrent main; runtime activation remains an
operator action.

**Non-goals:** Rebuilding long-term memory, inferring durable trust grants,
activating WhatsApp, enabling unsupported messaging surfaces, or merging tool
authority across audiences. Full provider prompts remain bounded; continuity is
not unlimited recall or a claim that a probabilistic privacy filter is perfect.
