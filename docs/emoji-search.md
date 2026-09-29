# June emoji search

Optional read-only integration with the standalone emoji service. Remove
`emojiSearch` from configuration to disable it. An empty object opts in to the
defaults below; a missing or empty token also leaves the capability unavailable.

```json
{
  "emojiSearch": {
    "baseUrl": "https://emojis.raygen.dev",
    "readTokenEnv": "EMOJI_SEARCH_READ_TOKEN",
    "timeoutMs": 4000
  }
}
```

Set the named environment variable in June's private service environment to the
emoji service's **read-only search token**. Never supply an admin/write token or
Slack bot token. The operator must provision a read-scoped credential; June
cannot determine a bearer token's scope locally. The endpoint must be an HTTPS
origin without credentials, path, query or fragment. No credentials are exposed
to models. No June Slack manifest, subscription or `emoji_changed` forwarding is
needed: the standalone service reconciles through GitHub Actions and stores its
catalogue in Neon. Workers serve search and embeddings without an always-on
LEGION process. Actions requires its explicit enablement variable and secrets;
source support does not prove activation. New image descriptions still require
an explicitly operated indexer; Actions never retries failed/unknown inference.

Initially only the owner's private turns can use this catalogue. Shared channels
and guest turns are denied at capability advertisement and dispatch; the owner's
private cross-surface access follows June's existing owner identity. A wider
Hack Club audience must be explicitly authorized before changing that boundary.

June discovers `emojiSearch: {query: string, limit?: number}` in her capability
schema and prompt. Queries are 1–300 characters, limits 1–20 (default 8; structured
model output may use null for default). Requests are exclusively
`GET /api/search?q=…&limit=…`, with the host's bearer read token. Models cannot
choose URLs, headers or HTTP methods. Redirects fail closed; timeout defaults to
4 seconds and cannot exceed 5 seconds, including reading the body. Bodies above
128 KiB, malformed responses and more than the requested number of hits fail
closed. Errors are generic and never include credentials or raw response bodies.

Validated hits include name, shortcode, nullable canonical name and HTTPS image URL, summary,
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

This change does not deploy or activate the integration. Semantic latency and
production service behavior have not been measured or verified by deployment.
