# Shared Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Keep implementation and verification in this worktree; delegation is optional only for independently owned work.

**Goal:** Let June create shared HTML, live workflow views, and collaborative Excalidraw boards with portable image/link delivery and optional creator-DM PIN access.

**Architecture:** A bounded artifact service owns SQLite persistence, authorization, secret delivery receipts, and rendering. A separate public presentation listener exposes only artifact routes, not the console or operator API. Rivet remains authoritative for workflows; artifacts consume filtered status projections and never execute workflow commands.

**Tech Stack:** Existing Node 24, TypeScript, Hono, SQLite, Playwright, Rivet, and Zod; add pinned Excalidraw, compatible React/React DOM, and a small esbuild browser bundle.

**Spec:** `docs/superpowers/specs/2026-09-29-shared-artifacts-design.md`

## Implementation record

The implementation follows this plan with the security narrowing recorded in the
spec: generated HTML scripts are blocked; host-authored live clients are not.
The design checklist below is retained as the original implementation guide,
not a claim of live activation. Current setup/limits are in `docs/shared-artifacts.md`.

Verification performed locally: model action schema and dispatcher, creator/owner
authorization, actual host notification readback redaction, mocked Slack DM
transport, durable replay/unknown delivery, PIN throttling and session revocation;
two real browser contexts for drawing, layer reordering, reload persistence,
workflow detail refresh, PIN unlock and open-page revocation; actual PNG rendering.
Oracle's initial three blockers were fixed and its follow-up found none in those
paths. No live Slack delivery/iframe, production deployment or configuration
change was tested or performed.

## Global Constraints

- June chooses public/private access; private creation generates exactly eight random digits, including leading zeroes.
- Creator identity comes from verified inbound channel/account/user context, never model arguments.
- Only the owner or original creator can manage content/access or change a PIN. A browser PIN grants viewing/collaboration, not management authority.
- DM secrets only to the creator. Never expose them to the model, public messages, URLs, logs, analytics, ordinary journals, or retained history.
- PIN rotation revokes viewer sessions and open streams. Private previews cannot expose protected content.
- Preserve existing approvals, workflow privacy, uncertain-delivery handling, and Dynamic Apps isolation.
- Use Excalidraw directly; do not copy Kyto AGPL code.
- Test core privacy, authorization, and duplicate-effect logic; use focused runtime/browser checks for rendering and collaboration.
- Run formatter, linter, typechecker, applicable tests, and expert review before publication. Follow current trunk-based publication guidance; no live deployment/configuration changes without authorization.

## Task 1: Durable artifact ownership, secrets, and operation receipts

**Create:** `src/artifacts/contracts.ts`, `src/artifacts/store.ts`, `src/artifacts/store.test.ts`.

**Interfaces:** Export `ArtifactCommand`, `ArtifactReceipt`, `ArtifactContext`, and `ArtifactStore`. Context contains verified `event: MessageEvent`, `operationId: string`, and `isCurrent(): boolean`. Receipts contain metadata only. The store constructor takes a file path, owner configuration, encryption key, PIN pepper, and an injectable clock.

```ts
type ArtifactKind = "html" | "board" | "workflow";
type ArtifactVisibility = "public" | "private";
interface ArtifactReceipt {
  id: string;
  title: string;
  kind: ArtifactKind;
  visibility: ArtifactVisibility;
  revision: number;
  generation: number;
  pinDelivery: "not_required" | "pending" | "sent" | "rejected" | "unknown";
}
```

- [ ] Define a strict command schema with `create`, `inspect`, `update`, and `change_pin`. Use nullable fields for provider compatibility: ID, title, kind, visibility, HTML, scene JSON, workflow run ID, and private-input handle. The model never supplies creator identity, PIN, target DM, arbitrary URL, or database path.
- [ ] Implement a private 0700 storage directory and 0600 database with artifact, mutation-receipt, encrypted-secret-delivery, browser-session, and throttle tables. Bind each operation ID to a request digest and initiating identity; conflicting reuse fails without mutation.
- [ ] Generate PINs with `randomInt(0, 100_000_000).toString().padStart(8, "0")`. Salt and scrypt a peppered PIN for verification. Encrypt temporary delivery material with AES-GCM and artifact/generation/recipient associated data; never store the plaintext.
- [ ] Make artifact creation and access rotation atomic with delivery intent. Increment the access generation on rotation, delete viewer sessions, and preserve a notification for active streams. Keep encrypted pending secrets for at most 24 hours; wipe on settled send or expiry.
- [ ] Check exact channel/account/user creator identity or `isOwner(event, owner)` before management. Require `isCurrent()` before committing. Inspection exposes only permitted metadata and excludes verifier/ciphertext fields.
- [ ] Add focused tests: unrelated user denied, matching user ID in another account denied, owner allowed, creator allowed, operation replay returns the original generation, conflicting replay rejected, supplied PIN leading zeroes retained, and raw PIN absent from stored JSON/receipts. Run `pnpm exec vitest run src/artifacts/store.test.ts`.

## Task 2: PIN-gated browser routes and secret-safe intake

**Create:** `src/artifacts/routes.ts`, `src/artifacts/routes.test.ts`, `src/artifacts/private-input.ts`.
**Modify:** `src/main.ts`, `src/config.ts`, `src/core/private-input.ts`, `src/core/contracts.ts`, `src/channels/slack.ts`, `src/channels/slack-history.ts`.

**Interfaces:** `createArtifactRoutes({store, origin})` returns a Hono app. `consumeArtifactPin(event)` returns a sanitized event and stores a short-lived, single-use private-input handle bound to artifact, caller, and generation. Add authenticated `artifactPinEligible` provenance for plain DM commands, including guest creators.

- [ ] Add optional artifact configuration: loopback listener port, HTTPS public origin, store path, encryption-key and pepper environment-variable names. Validate secrets are distinct from operator/deployment credentials. Do not enable by default or mount administrative routes on the presentation listener.
- [ ] Add page, unlock, scene, event-stream, preview, and static-asset routes under `/artifacts`. Use opaque artifact IDs. Unauthenticated private requests expose only the generic PIN page/locked thumbnail, not title or content.
- [ ] Unlock via POST with bounded eight-digit body, trusted-origin/CSRF checks, persistent per-artifact and per-client throttles, and a hashed random session token. Use Secure HttpOnly scoped cookies with one-hour expiry. Permit HTTP only for explicit loopback fixtures, never by automatic fallback.
- [ ] Authorize every data/preview request and mutation using current generation. Recheck authorization before each event publication and periodically while idle; close streams on rotation/expiry. Configure Slack framing only for this presentation surface. Third-party cookie rejection must leave an ordinary browser link usable.
- [ ] Intercept `!artifact-pin <artifactId> <eightDigits>` before memory ingestion and actor admission. Accept a new value only from a fresh plain authenticated creator/owner DM; scrub malformed, quoted, stale, public, and disabled-feature commands too. Bind accepted input to one management action and redact it in history-import paths.
- [ ] Test bypass attempts against HTML, JSON, PNG, and events, stale cookies after rotation, wrong-artifact cookies, cross-origin POSTs, throttling across store reopen, and plaintext-free intake. Run the new route tests plus existing private-input/history tests selected by exact file names.

## Task 3: Creator-DM delivery with durable uncertainty handling

**Create:** `src/artifacts/service.ts`, `src/artifacts/service.test.ts`, `src/channels/slack-artifacts.ts`.
**Modify:** `src/core/contracts.ts`, `src/channels/slack.ts`, `src/main.ts`.

**Interfaces:** `ArtifactService.request(command, context): Promise<ArtifactReceipt>` orchestrates store changes and secret delivery. Add an optional adapter `sendArtifactSecret` method that receives a host-constructed creator identity and secret callback; it returns `SendResult` only. No caller-selected recipient or general-purpose messaging bypass.

- [ ] Implement Slack DM resolution for the verified creator using the existing bot token and account. Validate the returned conversation. Keep credentials and API errors out of returned text. Do not add or change live scopes; missing permissions produce an explicit rejected result.
- [ ] Use existing `deliver` semantics with an empty ephemeral message in persistence. Decrypt only inside the dispatch closure; verify current generation and recipient immediately before sending. Persist `sending` before external IO and record only a sanitized receipt afterward.
- [ ] On recovery, turn interrupted sends into unknown without resending. Replaying the original action returns the existing receipt. Rotation creates a new deliberate generation and notifies the original creator, including when the owner requested it.
- [ ] If DM capability is unavailable, report it without claiming full private delivery. A failed/unknown DM never changes visibility or puts the PIN in a thread. Keep the artifact protected and allow explicit recovery through rotation.
- [ ] Test creator A versus owner B recipient routing, rotation during a delayed send, transport acceptance followed by connection loss, replay after restart, and ciphertext deletion after settlement. Assert exact outgoing destination and absence of secret text in tool results/history.

## Task 4: Shared Excalidraw and isolated interactive HTML

**Create:** `src/artifacts/client.tsx`, `src/artifacts/view.ts`, `src/artifacts/scene.ts`, `scripts/build-artifacts.ts`.
**Modify:** `src/artifacts/routes.ts`, `src/artifacts/store.ts`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`.

**Interfaces:** The scene API accepts `{mutationId, generation, elements}` and acknowledges an accepted revision. SSE carries revision notifications; browser clients fetch/resynchronize the authoritative scene. SQLite transactions serialize scene mutations. A shared scene merge function is used by host and client.

- [ ] Pin compatible Excalidraw/React dependencies after inspecting package peer requirements; bundle locally with esbuild, including fonts and licenses. Do not use public CDNs. Include TSX and build-script typechecking without changing server module semantics.
- [ ] Validate bounded vector/text scenes, numeric coordinates, IDs, versions, tombstones, and element types; explicitly reject image/iframe elements, external links, unsafe custom data, excessive counts, and oversized payloads. Cap retained scene size at 1 MiB and 2,000 elements.
- [ ] Independently implement deterministic per-element reconciliation using version plus a documented tie-breaker, retaining deletion tombstones. Reject equal-version conflicting payloads rather than allowing arrival order to oscillate state. Track mutation IDs and return an authoritative revision acknowledgement.
- [ ] Use Excalidraw's callback API and remote-update mode:

```ts
api.updateScene({
  elements: reconciledElements,
  captureUpdate: CaptureUpdateAction.NEVER,
});
```

- [ ] Keep edits pending until acknowledged; debounce sends, reconnect with bounded backoff, and merge a fresh full scene before resending pending edits. Do not replay old-generation edits after PIN rotation. Provide visible saved/offline/reconnect status; cursors remain ephemeral.
- [ ] Render model HTML in a sandboxed opaque-origin iframe allowing scripts but not same-origin, top navigation, forms, popups, downloads, or external connections. Serve the document with restrictive CSP headers, not merely a removable meta tag. The trusted shell alone calls artifact APIs.
- [ ] Load frontend-design guidance during implementation and render a restrained responsive shell with title, revision/status, sharing state, and browser-link fallback. Avoid a redundant editor around Excalidraw's controls.
- [ ] Manually exercise two isolated browser sessions editing different and overlapping elements, deletion, network loss, reconnect, and server restart. Inspect screenshots for board, HTML interaction, PIN entry, locked view, and narrow viewport. Keep only relevant review artifacts.

## Task 5: Live workflow projection without private payload disclosure

**Create:** `src/artifacts/workflow.ts`.
**Modify:** `src/workflows/actors.ts`, `src/artifacts/service.ts`, `src/artifacts/routes.ts`, `src/artifacts/client.tsx`, `src/runtime/capabilities.ts`, `src/runtime/execution-capabilities.ts`.

**Interfaces:** Add a dedicated workflow `presentation` inspection action returning only run ID, name, revision, current status, and operation name/status. It does not return `input`, `source`, `result`, `error`, receipt signatures, or operation values. The artifact stores the authorized originating workflow binding and deletion revision.

- [ ] Authorize creation against the existing owner-private workflow scope; non-owner artifact creation does not grant workflow access. June chooses whether to publish the resulting bounded projection publicly or PIN-protected.
- [ ] Build a live timeline/graph from recorded operations and expandable status details. Label planned annotations separately. Never infer dependencies or completion from source text or a model's drawing.
- [ ] Poll the authorized projection only while viewers exist, at a bounded two-second interval; fan out revision notifications, stop at terminal state, and clear protected content when deletion/revocation invalidates the source. Recheck after async reads before publication.
- [ ] Use the same artifact shell, access checks, and image pipeline as boards/HTML. The view offers no signal/cancel/start controls.
- [ ] Add one privacy regression with sentinel secrets in every excluded workflow field and assert none appear in projection, page payload, preview metadata, or notifications. Manually inspect running/waiting/completed/revoked views.

## Task 6: Actual PNG previews and client-aware delivery

**Create:** `src/artifacts/render.ts`.
**Modify:** `src/core/contracts.ts`, `src/artifacts/service.ts`, `src/artifacts/routes.ts`, `src/channels/slack.ts`, `src/channels/whatsapp.ts`, `src/runtime/registry.ts`, `src/runtime/execution-capabilities.ts`.

**Interfaces:** Add a host-only artifact presentation to outbound content containing canonical URL, title, accessible summary, revision, visibility, and public-safe preview URL. Client capability metadata describes HTML/image support explicitly. The model cannot fabricate this outbound object.

- [ ] Render the saved revision in a fresh sandboxed Playwright context with no credentials, external network, local files, downloads, or reused browser profile. Serve only explicitly mapped in-memory/local bundle resources. Bound timeout, viewport, image bytes, and concurrent render count; key preview cache by artifact/revision/generation.
- [ ] For boards, use documented `exportToBlob` with `exportEmbedScene:false` and bounded dimensions; for workflow/HTML use the rendered page. Never accept a browser-uploaded screenshot as a trustworthy server preview.
- [ ] Public artifacts receive real public PNG previews. Private shared delivery gets a generic locked image; full PNG requires PIN session. Generation/revision checks prevent late render completion from publishing after access rotation.
- [ ] Slack sends image block plus canonical link, with the existing video-block technique optional on configured approved origins. Preserve the portable image/link independently of iframe support. Do not loosen `allowedWebEmbed` for arbitrary private destinations.
- [ ] WhatsApp sends supported image/link content within its service-window policy; text-only adapters get summary/link. Private content never gets a tokenized unauthenticated image URL. Renderer/client failures produce honest text/link fallback.
- [ ] Exercise outbound payloads through adapters and the durable outbox, including unknown sends and render failure. Verify no duplicate posts and no image-content leakage. Inspect actual generated PNGs, not only dimensions or file existence.

## Task 7: June-facing schemas, dispatch, and operating knowledge

**Modify:** `src/models/provider.ts`, `src/core/contracts.ts`, `src/runtime/capabilities.ts`, `src/runtime/registry.ts`, `src/runtime/prompt.ts`, `src/runtime/execution-capabilities.ts`, `src/runtime/execution-context.ts`, `src/main.ts`, `config.example.json`, `.env.example`, `README.md`.
**Create:** `src/runtime/artifacts.test.ts`, `docs/artifacts.md`.

- [ ] Add `artifact` to CompanionReply, provider JSON schema, parse/availability checks, mutually exclusive action accounting, and execution tool catalog. Add `artifactsAvailable` only when the service is configured and the current event is admitted. Public/guest creators are supported without receiving owner-only capabilities.
- [ ] Pass verified event/operation/currentness context from both interaction and execution dispatch to the same ArtifactService. Mutations require a user-originated request; automated events can inspect existing permitted artifacts and update already-bound workflow projections, not rotate PINs or invent creators.
- [ ] Add shared help describing create/inspect/update/change-PIN, privacy choice, creator DM behavior, custom private PIN input, owner/creator authority, static fallback, experimental inline support, unknown delivery, and missing configuration. Include it in interaction, worker, and automated-event instructions, not just tool help.
- [ ] Ensure host notifications are marked delivered/unknown in the returned receipt and not repeated by June. No secret content reaches synthesis, debug observations, memory, or conversation journaling.
- [ ] Verify the complete June-facing flow using a fixture model response through actual parse/dispatch: guest creates private board, creator receives one DM, owner rotates, unrelated user denied, replay does not rotate, and model receives only metadata. Verify disabled capability and forged generated fields fail closed.
- [ ] Document setup prerequisites, dedicated-origin routing, storage/keys, retention, supported clients, PIN-sharing implications, image irreversibility, and live-vs-local verification. Do not edit live infrastructure or Slack configuration.

## Task 8: Integrated verification, review, and publication

- [ ] Run `pnpm format`, reread changed files, then `pnpm lint`, `pnpm typecheck`, focused privacy/delivery tests and affected existing provider/runtime/channel tests. Resolve failures without unrelated cleanup.
- [ ] Run local end-to-end fixtures through June, two browser sessions, the presentation listener, and mocked channel transport. Confirm encrypted delivery recovery, service restart, renderer failure, rate limits, reconnect, and rotation during open streams.
- [ ] Capture and inspect representative screenshots with `view_media`; publish one useful artifact link in the final report. Close only thread-owned browser sessions and remove temporary scripts/fixtures. Leave any user-requested preview running.
- [ ] Ask Oracle for the repository-required review of the actual diff and approved design. Fix and reverify findings, especially source disclosure, secret intake, request authorization, renderer isolation, and delivery duplication.
- [ ] Fetch and rebase onto latest `origin/main`, rerun affected checks, and publish tested/reviewed atomic Conventional Commits to main under repository guidance. Report publication separately from runtime activation; request specific deployment/configuration authorization only if needed.

## Documentation references checked during planning

- Excalidraw API: https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api
- Excalidraw export: https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/utils/export
- Slack video block: https://docs.slack.dev/reference/block-kit/blocks/video-block/
- Context7 quota was exhausted; official documentation was read directly instead.
