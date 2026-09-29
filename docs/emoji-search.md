# June emoji search

Optional read-only integration with the standalone [semoji service](https://github.com/lordbagel42/semoji). Remove
`emojiSearch` from configuration to disable it. An empty object opts in to the
defaults below; public search requires no authentication.

```json
{
  "emojiSearch": {
    "baseUrl": "https://emojis.raygen.dev",
    "timeoutMs": 1500
  }
}
```

June sends no Authorization header and reads no search secret. The endpoint must
be an HTTPS origin without credentials, path, query or fragment. Status, indexer,
and admin operations remain private; public search grants no access to them.
No June Slack manifest, subscription or `emoji_changed` forwarding is needed:
semoji owns its GitHub Actions maintenance workflow, Neon catalogue, and
Cloudflare Workers for search and embeddings, without an always-on LEGION
process. Actions requires its explicit enablement variable and secrets;
source support does not prove activation. New image descriptions still require
an explicitly operated indexer; Actions never retries failed/unknown inference.

Initially only the owner's private turns can use this catalogue. Shared channels
and guest turns are denied at capability advertisement and dispatch; the owner's
private cross-surface access follows June's existing owner identity. A wider
Hack Club audience must be explicitly authorized before changing that boundary.

June discovers `emojiSearch: {query: string, limit?: number}` in her capability
schema and prompt. Queries are 1–300 characters, limits 1–20 (default 8; structured
model output may use null for default). With `limit:1`, the provider uses
`GET /v1/emoji?q=…` and returns a validated name and shortcode, without descriptions
or confidence. Exact names take one indexed lookup without AI. Requests for
multiple candidates use `GET /api/search?q=…&limit=…`, anonymously. Models cannot
choose URLs, headers or HTTP methods. Redirects fail closed; timeout defaults to
1.5 seconds and cannot exceed 5 seconds, including reading the body. Bodies above
128 KiB, malformed responses and more than the requested number of hits fail
closed. Errors are generic and never include credentials or raw response bodies.

Search is on demand: startup and ordinary replies do not make background queries.
The provider makes one request without automatic retries or image downloads.
June reuses verified names and asks for `limit:1` when only one emoji is needed;
she omits a decorative reaction rather than holding up a reply for a lookup.
Explicit search requests still use the asynchronous execution-worker workflow;
the HTTP deadline does not bound model, queue, or message-delivery time.

Validated ranked hits include name, shortcode, nullable canonical name and HTTPS image URL, summary,
description, finite score and exact/keyword/semantic match type. Responses also
include keyword/hybrid mode, durationMs, semanticAvailable and optional degradation. The text report
omits image URLs, excerpts descriptions and drops trailing hits when necessary
to remain below 8.5 KiB of JSON. Images are never fetched.

Execution agents receive this report in the existing untrusted-observation loop
and can inspect candidates before reporting a valid shortcode. The interaction
agent can use the returned name for an otherwise authorized reaction; searching
does not send a reaction. Legacy/main-model calls return bounded result text via
normal capability handling, not the non-retainable Slack history search path.
Descriptions remain untrusted data, not instructions or permission. Existing
conversation admission, execution ceilings, cancellation and synthesis/wakeup
restrictions still apply.

Source publication alone does not activate the integration. Configure the block
through the coordinated deployment process and verify the loaded release's
configuration and a real provider query; repository defaults are not proof that
the running June can search. Semantic coverage depends on semoji's backfill.
