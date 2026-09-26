# Typed deliberation providers

`createDecisionProvider` in `decision.ts` returns the existing `DecisionFunction`.
It is independent of the conversational reply adapter and does not execute tools.
Pass it directly to the native reflection workflow, which owns durable capacity
and waits for actual provider settlement. For process-local jury evaluation, use
a shared `DecisionExecutor` and the existing `runJury`. Workflow attempt ownership,
durable budgets, consent and audience selection remain outside the provider.
Nothing here starts reflection or activates an account.

```ts
const options = {
  protocol: "openai" as const,
  auth: "api-key" as const,
  model: supportedModelId,
  apiKey: operatorSuppliedKey,
  reasoningEffort: "high" as const,
};
const providers = {
  jurors: [
    { id: "one", decide: createDecisionProvider(options) },
    { id: "two", decide: createDecisionProvider(options) },
  ],
  critic: createDecisionProvider({ ...options, role: "critic" }),
  synthesize: createDecisionProvider({ ...options, role: "synthesis" }),
};
const result = await runJury(input, executor, providers, signal);
```

First passes receive the same evidence independently with no prior votes or
conversation/response IDs. Independence of calls is not statistical independence
or proof of correctness. Critic and synthesis roles explicitly receive prior
votes. `runJury` preserves first-pass decisions and computes dissent itself, rather
than trusting the synthesizer's account. Citations stay as supplied evidence IDs;
the workflow/memory owner resolves those IDs to original sources.

## Supported protocols and prerequisites

- OpenAI Responses (`POST /v1/responses`): explicit API key, explicit supported
  model ID, structured JSON outputs, optional `reasoningEffort` low/medium/high.
  `store: false`; no tools or server-side conversation continuation.
- Anthropic Messages (`POST /v1/messages`): explicit API key and model supporting
  `output_config.format`. `reasoningEffort` is rejected, not translated to a
  different provider's thinking API. Extended thinking is not enabled here.
- Optional `baseUrl` is operator-owned HTTPS only (no embedded credentials,
  query or fragment). Redirects are refused. Supplying a custom URL authorizes
  sending that provider the scoped evidence and key; the model cannot set it.
- Subscription auth, Codex protocol and Jev protocol fail at construction with
  `unsupported_decision_provider_auth`; no API-key reinterpretation of OAuth.
  The current Codex conversational adapter exposes only `CompanionReply` and no
  caller abort signal. Safely supporting typed Codex would first require a shared
  schema/parser and cancellable process primitive, not nested JSON in reply text
  or a second CLI implementation. No changes to that shared adapter are included.
- The preferred GPT-6 Astra path can use this OpenAI adapter **only if** the
  operator's endpoint/account actually supports its explicit model ID, structured
  outputs and selected reasoning effort. No model availability, alias, auth or
  fallback is inferred. Provider rejection remains an explicit sanitized error;
  `DecisionExecutor` converts failed calls into abstentions.

No SDK or dependency additions. Inject `fetch` for entirely offline verification.
No credential discovery, subscription login, paid requests or live validation was
performed. API keys must come through the operator's existing secret mechanism.

## Bounds and trust

Each call has one attempt, an output limit (default 4,096; max 32,768 tokens),
timeout (default 60s; max 300s), serialized input cap 256 KiB and response cap
128 KiB. A jury issues 2–8 first passes plus a critic and synthesis, with no
provider retries. The shared executor enforces concurrency and retains occupied
slots until even an uncooperative injected transport actually settles. Provider
cancellation aborts fetch; it does not promise cancellation of remote billing.
An outer executor timeout may be shorter than the provider timeout.

The raw provider's timeout only aborts; it never races an early return against
the transport. Do not wrap it in `DecisionExecutor.evaluate` when supplying the
native durable workflow: that legacy process-local API returns promptly on timeout
while retaining its local slot, which is not the workflow's settlement contract.
The workflow must independently recheck current audience authorization, exact
requested immutable evidence IDs, deletion and expiration before and after the
provider and on candidate reads. The provider cannot resolve current memory state.

Scope/freshness are checked before any network call, including direct adapter
calls. Unknown input metadata is not serialized; known evidence text is still
untrusted. Refusals, incomplete output, tool-bearing envelopes, invented citations
and extra decision authority fields cannot become valid decisions. Schema
validation cannot prove a rationale accurately uses a citation. Confidence is
untrusted, uncalibrated self-report and never a permission or truth probability.
`store: false` is not a promise of zero vendor retention; account/data policies
must be acceptable before sending real private evidence.

## Jev evaluation (2026-09-26)

The actual documented endpoint is `POST https://api.typesafe.ai/v1/systemone`,
with `Authorization: Bearer <API_KEY>`. Request: `state`, `model`, `questions`
map. Documentation names `jev-latest`; deployments should select and evaluate an
actual model version rather than assume stable behavior from a moving alias.

- **Noul:** yes/no `instructions`, optional true/false criteria; answer has
  `type: "noul"` and numeric `noul`. There is **no confidence field**.
- **Choice:** named criteria map; answer has selected `choice`, `probabilities`
  and `confidence`. Explicit yes/no/abstain criteria fit atomic reflection gates.
- **Score:** ordered rubric (2–10 levels); answer has weighted `score`, `legend`,
  `probabilities` and `confidence`. Useful for interruption-cost ranking, not an
  approval decision. Choice accepts at most 255 options.

Jev does not document free-text rationale or evidence citations in these answers.
Consequently this change does **not** label a made-up rationale/all input IDs as
Jev's evidence-backed decision, and does not pretend it is the jury synthesizer.
A future integration needs an explicitly different typed observation contract
preserving distributions and input provenance, then an evaluated policy for
abstention/thresholds and evidence attribution. Owner-specific held-out evaluation
must precede routing/interruption thresholds. Distribution-derived confidence is
not established calibration for June's owner or evidence distribution, regardless
of the vendor's claims; no score can confer authority. Documented SDK retries
must also be disabled or charged to the workflow budget. No Jev dependency,
account, endpoint guess or live request is needed for the current reasoning path.

Sources reviewed directly:

- https://developers.openai.com/api/docs/guides/migrate-to-responses
- https://developers.openai.com/api/docs/guides/reasoning
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- https://docs.typesafe.ai/api.md
- https://docs.typesafe.ai/confidence.md
- https://docs.typesafe.ai/llms.txt
