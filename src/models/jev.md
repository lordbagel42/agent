# Jev observations, not deliberation

`createJevObserver(options)` returns a `JevObserver`:
`(input: JevObservationInput, signal: AbortSignal) => Promise<JevObservationResult>`.
It is deliberately **not** `DecisionFunction`, a text generator, or a jury member.
Jev does not document rationale or citation output. `sourceIds` records only the
caller's input provenance; it is never sent or attributed to individual answers.

Required constructor options are `apiKey`, `endpoint` (full operator-approved
HTTPS URL, normally `https://api.typesafe.ai/v1/systemone`), `model`, and
`questions`. `fetch` is injectable for offline use. `timeoutMs` defaults to 30s,
maximum 300s. Questions are snapshotted at construction, not read from history,
imports, or a model response. This intentionally supports a narrow documented
subset: string instructions/criteria, text state, and 1–16 atomic questions.
Choice accepts 2–255 options and requires an explicit `abstainChoice` among them;
Score accepts 2–10 ordered levels. Question/option IDs are 1–80 ASCII letters,
digits, underscores or hyphens, excluding `__proto__`. Instructions/criteria are
trimmed, nonempty strings of at most 4,096 UTF-16 code units each. Invalid
configuration throws only `invalid_jev_configuration`, without credential or
rubric details.

```ts
const observe = createJevObserver({
  apiKey: operatorKey,
  endpoint: operatorEndpoint,
  model: operatorModel,
  questions: {
    relevance: {
      type: "choice",
      instructions: "Is the proposed topic relevant to the current commitment?",
      criteria: {
        yes: "Directly relevant",
        no: "Not relevant",
        unknown: "Insufficient evidence; abstain",
      },
      abstainChoice: "unknown", // Local metadata, not a Jev request field.
    },
    interruptionCost: {
      type: "score",
      instructions: "Rate interruption cost, not permission to interrupt.",
      criteria: ["Low", "Medium", "High"],
    },
  },
});
const result = await observe({ state: authorizedSummary, sourceIds }, signal);
```

Choice preserves the selected option/distribution and explicitly marks the
configured abstention option. Score preserves its weighted value, ordered legend,
and distribution. Noul preserves its 0–1 numeric answer **without confidence**.
Choice/Score confidence is `{ value, calibration: "uncalibrated" }`; it is not a
permission, evidence of truth, or an owner-calibrated probability. Noul likewise
has no established owner-specific calibration. No thresholds or default approval
policy are implemented. Use Choice when an explicit abstention is required;
Score/Noul have no documented native abstention. Missing/invalid answers remain
`unknown`, not zero, false, or a fabricated abstention. A top-level `observed`
result can contain only unknown answers; consumers must check every outcome.
The returned model name and token usage are vendor-reported metadata, not proof
of which weights ran or an authoritative billing receipt. Model aliases may
return a different concrete name. Distributions must match the configured
options/levels and sum to one; Score must match the probability-weighted level
indices. The local numeric-rounding tolerance is 0.0001, not an action threshold.
Unknown envelope fields fail the response; unknown answer fields invalidate that
answer. No free-text rationale, citations, or tool requests are accepted.

## Integration boundary

The caller must independently authorize and minimize state before every call,
and recheck current audience, deletion, freshness, and exact immutable source IDs
before using its result. The provider cannot query the memory store or establish
consent. Imported instructions are data, never policy; even a confident injected
answer cannot grant authority. This remains optional and unmounted. The native
reflection factory still expects genuine cited `DecisionFunction` results.
Returned observations and local source IDs retain the input's privacy scope;
they are not public telemetry and must not be logged indiscriminately.

State is limited to 64 KiB UTF-8, rubrics to 64 KiB serialized JSON, provenance to
256 IDs of up to 256 UTF-16 code units, and streamed responses to 128 KiB. JSON
escaping can increase the request size but it remains bounded. Malformed UTF-8
responses are rejected. Redirects are refused. HTTP bodies and transport error
messages never escape as errors or logs.
The API key goes only to the fixed configured endpoint. Choosing a custom endpoint
is an operator decision to disclose the key and authorized state to that endpoint.
No vendor retention/storage option is documented for this endpoint; the adapter
does not invent a `store: false` field or claim zero retention.

Each observation invokes fetch at most once, including on 429/529. Injected
transports are trusted code: they must honor abort and preserve the no-retry,
no-redirect, no-logging behavior. Errors report `not_sent` or conservatively
`possibly_sent`; the latter includes cancellation, timeout, invalid responses and
HTTP errors after dispatch. Do not retry these automatically: a remote paid
request may have completed. Aborting native fetch does not establish remote
cancellation or reverse charges. An uncooperative injected transport can exceed
the deadline; the promise waits for actual transport and body cleanup settlement
so a worker does not release capacity prematurely.

## Verification and activation prerequisites

Live documentation read 2026-09-26:
- https://docs.typesafe.ai/api.md
- https://docs.typesafe.ai/confidence.md

Historical offline fixtures covered all three answer primitives, local-only provenance,
rubric snapshots, explicit abstention/unknown, byte boundaries, malformed/extra
response data, cleanup settlement, cancellation and no duplicate paid attempts.
Disposable loopback checks also exercised Node's native fetch with refused
redirects, cancellation after headers, and a timeout during a partial response.
No paid requests, account login, credential discovery, or live model evaluation
occurred.

Before activation, the operator must supply a supported model/version and API key,
approve the vendor's retention/privacy terms, and validate the deployed protocol.
Owner-specific held-out evaluation must precede relevance, novelty, uncertainty,
or interruption thresholds; vendor confidence claims do not supply that evidence.
The workflow owner still owns durable attempts/budgets, capacity, quiet hours,
consent, current scope checks, and any external approval policy.
