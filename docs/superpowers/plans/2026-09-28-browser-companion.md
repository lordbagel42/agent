# Browser Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Keep implementation and verification in the checkout containing the changes; do not launch separate threads for phases of this work.

**Goal:** Give June a Codex browser companion with owner PIN handoff, real video evidence, and a discoverable authenticated HTML live view of the same browser.

**Architecture:** A durable browser task owns an isolated Playwright session and a resumable Codex thread. Host-defined tools enforce authority; June owns conversation and review. A read-only HTML viewer consumes privacy-gated frames from that existing session, independently of Slack embedding.

**Tech Stack:** TypeScript, Rivet actors/workflows, Hono, Playwright 1.63.0, Codex 0.157.1 app-server dynamic tools, Vitest, existing private-console authentication.

**Spec:** `docs/superpowers/specs/2026-09-28-browser-companion-design.md`

## Execution record

Implementation uses existing durable execution workers for orchestration and
notification, with `src/browser/companion.ts` owning private receipts and volatile
sessions; the proposed separate `src/runtime/browser.ts` actor was unnecessary.
Contract tests live with companion tests. PIN replies bind a fresh challenge and
verified Slack message receipt. Historical Slack/tool readers also redact them.
Local Codex cleanup uses the supported `thread/delete` protocol after settlement.
The API, session, provider-image, runtime-discovery and authenticated HTML/SSE
surfaces are implemented locally. Publication, isolated runtime provisioning,
authenticated Codex inference and the owner's actual URL remain unverified.
The task checklists below are the original plan, not a claim that every proposed
verification or implementation detail was executed verbatim.

## Global Constraints

- Owner-private only for the first release; no imported desktop sessions or browser-control endpoint.
- A 30-minute idle expiry and a 60-minute hard task deadline.
- PINs never enter ordinary history, memory, model prompts, task records, or observations. The originating chat platform may retain its original message.
- The HTML live view shares the task's actual browser, is read-only, and blanks during secret entry.
- Existing recipe-based browser broker behavior and coding authorization stay unchanged.
- Feature disabled until operator-provided process/network isolation and dedicated authentication are provisioned. No service/configuration mutation is part of local implementation.
- Never claim video/audio coverage beyond observed evidence. HTML stream playback is not video-review evidence.
- June discovers and calls every capability herself. Slack HTML embedding is outside scope.
- Few focused tests plus real workflow verification. Format and lint before each commit; Oracle review before pushing to main.
- Use the task-specific clone at `/home/amp/workspaces/agent-browser-01a0e6c1`; do not repair or reset the corrupt original checkout. Fetch current main before implementation and preserve the design changes. Resolve Git author identity through existing account configuration, never invent one.

## Ownership map

- New `src/browser/contracts.ts`: task/action/input/evidence/live-view contracts and schema.
- New `src/browser/session.ts`: session ownership, host tools, request controls, secret interval, media frames.
- New `src/browser/codex.ts`: browser-specific dynamic-tool protocol and turn settlement.
- New `src/runtime/browser.ts`: durable task actor and challenge lifecycle.
- New `src/browser/live-view.ts`: private HTML and frame-stream routes.
- Existing `src/core/contracts.ts`, `src/models/provider.ts`, `src/models/codex-hot.ts`: agent actions and private image inputs.
- Existing `src/runtime/inbox.ts`, `src/runtime/registry.ts`, `src/runtime/prompt.ts`: notifications, dispatch, discovery, scoped synthesis.
- Existing `src/channels/slack.ts`, `src/main.ts`: verified secret-reply interception before persistence, configuration and lifecycle wiring.
- Existing `src/http/app.ts`, `src/console/security.ts`, `src/console/session.ts`: private route mounting and authentication. Do not loosen shared CSP globally.
- Existing `src/config.ts`, `config.example.json`, `docs/browser.md`: disabled-by-default configuration, activation constraints, June-facing usage.

## Task 1: Task contracts and fail-closed configuration

**Files:** `src/browser/contracts.ts`, `src/browser/contracts.test.ts`, `src/core/contracts.ts`, `src/config.ts`, `config.example.json`.

**Interfaces:** Export `BrowserCommand`, `BrowserTaskStatus`, and `BrowserLiveView` from the new contract file. Owner and audience are host context, not model arguments. Secret response bytes deliberately are not part of `BrowserCommand`.

```ts
type BrowserCommand =
  | { action: "start"; url: string; goal: string }
  | { action: "status" | "cancel"; taskId: string };
type BrowserLiveView =
  | { available: false; reason: string }
  | {
      available: true;
      url: string;
      state: "live" | "private" | "waiting" | "ended";
      expiresAt: number;
      generation: string;
    };
type BrowserTaskStatus =
  | "queued" | "running" | "waiting_for_input"
  | "completed" | "cancelled" | "expired" | "needs_review";
```

- [ ] Add strict schemas and a failing test that `https://example.com/` is a valid start URL while embedded credentials, non-HTTPS URLs, extra owner fields and secret arguments are rejected. Host fixture construction alone may permit loopback HTTP.
- [ ] Run `pnpm exec vitest run src/browser/contracts.test.ts`; confirm the missing contract fails before implementation.
- [ ] Implement the contracts and a separate `browserCompanion` configuration, disabled by default. Require isolated worker directories, bounded session concurrency, approved navigation/resource origins, dedicated Codex home, and an external-isolation host gate. Live-view origin comes from the canonical private console configuration, never request Host headers.
- [ ] Re-run the focused test and `pnpm typecheck`. Verify the example config does not enable a browser or introduce secret values.

## Task 2: Session tools, privacy gate, and media evidence

**Files:** `src/browser/session.ts`, `src/browser/session.test.ts`, fixture assets under `tests/fixtures/browser-companion/`.

**Interfaces:** `BrowserSession` owns `generation`, `observe`, `navigate`, `scroll`, `discoverMedia`, `captureMediaFrame`, `enterPin`, and `close`. All public tool operations receive a task-bound host authorization context. `enterPin` is host-only, never a dynamic tool accepting secret text. Tool results return bounded text/inline images or safe error codes. Browser/page handles stay private.

```ts
interface BrowserFrame {
  generation: string;
  observationEpoch: number;
  capturedAt: number;
  mimeType: "image/jpeg";
  bytes: Uint8Array;
  mediaTimeSeconds?: number;
}
// Inside every asynchronous capture path:
const epoch = observationEpoch;
const image = await captureOwnedPage();
if (epoch !== observationEpoch || privacyActive || closing) return undefined;
```

- [ ] Create a disposable fixture with a PIN login, cookie-protected page, scrolling content and a short asymmetric video. Choose independently known frame content/timestamps; do not derive assertions from the capture implementation.
- [ ] Write failing tests for same-session continuation, denied cross-origin redirect, and a delayed capture completing after the privacy gate closes. Assert the delayed frame is discarded, not merely marked private.
- [ ] Run `pnpm exec vitest run src/browser/session.test.ts` and confirm missing behavior fails.
- [ ] Implement sandbox-enabled owned Chromium, host-issued element references, fixed DOM/media operations and request budgets. No arbitrary JS, shell, file upload, downloads, WebSockets or uncontrolled popups. Require configured resource origins and exact approval for PIN submission; block unclassified mutations.
- [ ] Implement one shared observation epoch for Codex screenshots, evidence and live-view captures. Increment before secret fill/cancellation; suspend observations, clear subscribers, fill/submit once, and resume only after the gate is gone. Wrong PIN stays private until secret fields are cleared.
- [ ] Capture actual rendered media frames after seeking completes; report duration, inspected timestamps, captions provenance, and missing audio. Bound bytes and total frames; use the approved session for permitted media fetching rather than an unrestricted downloader.
- [ ] Run focused tests with real Chromium. Verify close settlement, expiry, denied resources and no global browser cleanup. Inspect representative media captures with the media tool.

## Task 3: Codex dynamic-tool worker

**Files:** `src/browser/codex.ts`, `src/browser/codex.test.ts`, `src/coding/codex.ts` only if extracting genuinely shared transport is necessary.

**Interfaces:** The browser runtime accepts task goal, optional saved thread ID, a durable `onThread` callback, session-bound tool dispatch and cancellation. It returns settled completion, waiting-for-input metadata, or an explicitly uncertain outcome. It never returns or accepts PIN bytes.

```ts
// Browser worker initialization only; do not change coding approval policy.
connection.send({
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "june_browser", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  },
});
// A correlated item/tool/call response:
connection.send({
  id: request.id,
  result: { success: true, contentItems: [{ type: "inputText", text: resultText }] },
});
```

- [ ] Write a failing protocol test with two distinct request IDs and a mismatched turn ID; assert only the correctly scoped request reaches the tool and the JSON-RPC response uses request ID, not call ID.
- [ ] Run `pnpm exec vitest run src/browser/codex.test.ts`.
- [ ] Implement initialize/account-read/start-or-resume/turn lifecycle, dynamic tool declarations and inline image responses. Persist the thread ID before starting work. Disable unrelated tools and reject every server request except known correlated browser-tool calls.
- [ ] Implement `request_owner_input` as a structured yield: record its metadata, answer the tool with a safe waiting result, and require turn settlement before accepting another turn. Do not keep an RPC open throughout the human wait.
- [ ] Run the focused protocol test and the existing coding-runtime tests. Perform a real pinned app-server smoke test with already authorized dedicated credentials if available; otherwise report the credential prerequisite, without reauthenticating another session.

## Task 4: Durable task, owner reply and conversational handoff

**Files:** `src/runtime/browser.ts`, `src/runtime/browser.test.ts`, `src/runtime/inbox.ts`, `src/runtime/registry.ts`, `src/main.ts`, `src/channels/slack.ts`, `src/models/provider.ts`, `src/runtime/prompt.ts`.

**Interfaces:** The actor exposes start/status/cancel, pending challenge metadata, one-use challenge consumption, and worker-result admission. `BrowserCommand` is available in the companion reply schema and role allowlists. A browser notification contains task/generation/result references, not observations or secrets.

```ts
// This must precede memory.source/appendSource and conversation.receive.
const consumed = await browserInput.consumeVerifiedReply(scope, event);
if (consumed) return;
```

- [ ] Write a failing ingress test whose owner reply contains a distinctive fixture PIN. Spy on memory append, conversation admission and model invocation; assert none receives the raw reply. Use a different owner and stale challenge in negative cases.
- [ ] Run `pnpm exec vitest run src/runtime/browser.test.ts`.
- [ ] Implement actor state transitions with generation fences, durable start/submit markers, deadlines and deduplicated notification IDs. Use existing Rivet queue/workflow and conversation-notify patterns; do not keep browser handles in persisted actor state.
- [ ] Route verified owner replies before the first persistence boundary in `src/main.ts`. Match a specific pending question/reply context; do not interpret arbitrary numeric messages as PINs. Atomically consume the challenge before host-only secret delivery. Reject duplicates; a lost/uncertain delivery requests a new challenge rather than replaying stored credentials.
- [ ] Wire start/status/cancel and pending-input questions into June's existing scoped dispatch and prompt discovery. Preserve public/guest denial and deletion/revocation boundaries. Include live-view metadata in task status.
- [ ] Test wrong PIN, reply after expiry/cancel, restart with missing live session, duplicate notification and cancellation settlement. June must say unavailable/unknown instead of inventing resumed browser success.

## Task 5: Authenticated HTML live view

**Files:** `src/browser/live-view.ts`, `src/browser/live-view.test.ts`, `src/http/app.ts`, `src/main.ts`. Reuse `src/console/security.ts` and `src/console/session.ts` without weakening their other consumers.

**Interfaces:** `GET /console/browser/:taskId` returns fixed HTML; `GET /console/browser/:taskId/stream` returns server-sent events. Both require existing console authentication plus owner/task scope. Status uses the canonical origin and HTML path; there is no bearer credential in the URL.

```ts
type BrowserViewEvent =
  | { type: "frame"; generation: string; epoch: number; capturedAt: number; jpeg: string }
  | { type: "state"; generation: string; epoch: number;
      state: "live" | "private" | "waiting" | "ended" };
// Viewer receives images only, never visited-page HTML or scripts.
if (event.type === "state" && event.state !== "live") {
  image.removeAttribute("src");
  image.hidden = true;
}
```

- [ ] Write failing route tests: unauthenticated/wrong-owner HTML and stream requests fail; authenticated requests subscribe to the existing session rather than create one. A pending frame followed by a privacy transition must not emit image bytes.
- [ ] Run `pnpm exec vitest run src/browser/live-view.test.ts`.
- [ ] Implement a fixed responsive HTML viewer with connection status, capture timestamp and image area. Use a nonce-authorized script, `img-src data:`, `connect-src 'self'`, no-store/referrer protections and existing framing denial. Do not add controls, PIN forms or a raw CDP connection.
- [ ] Start with at most two JPEG frames per second, one in-flight capture per session, at most 1 MiB per frame and two viewers per task. Revalidate authentication and scope before each emission; await writes and disconnect stalled clients. Do not retain frames for replay or record the stream.
- [ ] Apply session/observation-generation checks on server and client. Privacy/terminal states clear frames; client errors/disconnects clear stale images. End or revoke streams on session expiry, owner revocation and authorization expiry, not just at initial connection.
- [ ] Render the viewer using this thread's isolated agent-browser session. Trigger worker scrolling/navigation; inspect live, privacy and ended screenshots. Verify closing the viewer leaves the task alive and does not extend expiry. Do not expose the administrative console through the runner preview portal.

## Task 6: June sees the evidence and gives her review

**Files:** `src/core/contracts.ts`, `src/models/provider.ts`, `src/models/codex.ts`, `src/models/codex-hot.ts`, their focused test files, `src/runtime/registry.ts`, `src/runtime/prompt.ts`, `src/browser/contracts.ts`.

**Interfaces:** Add host-only image inputs with evidence ID, MIME type, bounded bytes and timestamp metadata to `ModelRequest`. Persist scoped references, not base64 images, in conversation state. Resolve references immediately before the authorized review invocation; reject expired/revoked artifacts.

```ts
interface ModelImageInput {
  evidenceId: string;
  mimeType: "image/jpeg" | "image/png";
  data: Uint8Array;
  mediaTimeSeconds?: number;
}
// OpenAI Responses representation; not a text-only caption replacement:
const imagePart = {
  type: "input_image",
  image_url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`,
};
```

- [ ] Write provider payload tests with two distinct images/timestamps; assert binary images reach the provider representation and host metadata is excluded from ordinary text prompt serialization. Unsupported providers must reject explicitly rather than discard images.
- [ ] Run targeted provider tests before implementing the mapping.
- [ ] Implement OpenAI and Anthropic image mapping in `createJsonProvider`, and pinned app-server image inputs for the conversational Codex provider. Preserve single-use conversational sessions and existing tool restrictions. Check the pinned protocol schema before choosing its image-input variant.
- [ ] Add scoped evidence resolution, retention/deletion, and a review prompt that distinguishes worker observations, visual evidence, captions and unavailable audio. Deliver June's own assessment with timestamps and limitations; never call sparse screenshots full video/audio coverage.
- [ ] Verify the fixture's changing visual content is reflected in June's actual review. A mocked provider establishes payload shape, not that June can inspect images; require a real authorized provider run for that claim.

## Task 7: End-to-end verification, docs and publication

**Files:** `docs/browser.md`, `docs/usage.md`, the feature's focused tests and fixture. Store inspection artifacts under repository-excluded `.amp/in/artifacts/`.

- [ ] Exercise June's agent-callable start → PIN question → owner reply → same-session resume → video evidence → review. Retrieve `liveView.url` through her status tool and open it as the authorized owner while the worker runs.
- [ ] Exercise cancellation, expiry, restart, wrong PIN, denied resource origin, no image-capable provider, unsupported media and live-view auth expiry. Search local fixture artifacts/task data/model input captures for the test PIN without printing real secrets.
- [ ] Document feature discovery, actual supported video/audio behavior, private live-view URL use, low-frame-rate/no-audio stream limits, and deferred Slack embedding. Document isolation and provisioning steps without claiming they are deployed.
- [ ] Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, focused browser/provider/runtime tests and the broader relevant suite. Inspect all formatter changes and preserve unrelated concurrent work.
- [ ] Request Oracle review of the complete diff, emphasizing secret ingress before persistence, dynamic-tool authority, async privacy frame races, owner authentication throughout streaming, and uncertain-action recovery. Address findings and re-run affected checks.
- [ ] Commit related changes atomically with Conventional Commit messages once author identity is configured. Fetch/rebase latest main, reverify and publish per repository policy. Never force-push or infer permission to alter live service/configuration.
- [ ] Report implemented/published/provisioned/live-tested states separately. Link an inspected representative HTML-view screenshot. The user's real PIN-protected URL is accepted only after an explicitly authorized live run, not fixture success alone.
