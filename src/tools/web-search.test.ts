import { expect, test } from "vitest";
import { createTavilyWebSearchProvider } from "./web-search.js";

const apiKey = "tvly-offline-fixture";

test("only the explicit query crosses the web-search privacy boundary", async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const options = {
    apiKey,
    owner: "private-owner-name",
    sourceIds: ["private-source-id"],
    messages: [{ role: "user", content: "private-conversation" }],
    memory: "private-memory",
  };
  const provider = createTavilyWebSearchProvider(options, {
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({
        query: "provider-echo",
        answer: "unrequested-answer",
        images: [],
        response_time: 0.01,
        request_id: "provider-request-id",
        results: [
          {
            title: "Public documentation",
            url: "https://docs.tavily.com/",
            content: "Public snippet",
            raw_content: "unrequested-full-page",
            score: 0.9,
          },
        ],
      });
    },
  });
  expect(await provider.search(" public search API ")).toEqual({
    status: "ready",
    results: [
      {
        title: "Public documentation",
        url: "https://docs.tavily.com/",
        snippet: "Public snippet",
      },
    ],
  });
  expect(requests).toHaveLength(1);
  const request = requests[0];
  expect(request?.url).toBe("https://api.tavily.com/search");
  expect(request?.init?.method).toBe("POST");
  expect(request?.init?.credentials).toBe("omit");
  expect(request?.init?.redirect).toBe("error");
  expect(new Headers(request?.init?.headers).get("authorization")).toBe(
    `Bearer ${apiKey}`,
  );
  expect(JSON.parse(String(request?.init?.body))).toEqual({
    query: "public search API",
    topic: "general",
    search_depth: "basic",
    auto_parameters: false,
    max_results: 5,
    chunks_per_source: 2,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
  });
  // A mistaken ModelRequest cannot be coerced/serialized into a query.
  // @ts-expect-error Runtime boundary also rejects non-string inputs.
  expect(await provider.search(options)).toEqual({
    status: "error",
    code: "invalid_query",
    requestState: "not_sent",
  });
  expect(requests).toHaveLength(1);
});

test("a failed or cancelled search is never retried and cannot echo secrets", async () => {
  for (const failure of [
    "transport",
    "malformed",
    307,
    401,
    429,
    432,
    500,
  ] as const) {
    let calls = 0;
    const provider = createTavilyWebSearchProvider(
      { apiKey },
      {
        fetch: async () => {
          calls++;
          if (failure === "transport") throw new Error(apiKey);
          return new Response(apiKey, {
            status: failure === "malformed" ? 200 : failure,
            headers: {
              "Retry-After": "0",
              Location: "https://other.example.com/",
            },
          });
        },
      },
    );
    expect(
      await provider.search("public query", AbortSignal.abort(apiKey)),
    ).toEqual({ status: "error", code: "cancelled", requestState: "not_sent" });
    expect(calls).toBe(0);
    const result = await provider.search("public query");
    expect(result).toMatchObject({ requestState: "possibly_sent" });
    expect(result.status).not.toBe("ready");
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(calls).toBe(1);
  }
});

test("citations cannot expose credentials or local destinations as public links", async () => {
  const rejected = [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:secret@example.com/",
    "http://127.1/",
    "https://0x7f000001/",
    "http://169.254.169.254/latest/meta-data",
    "https://[::ffff:127.0.0.1]/",
    "https://localhost/",
    "https://vault.internal/",
    "https://service.local/",
    "https://example.com:444/",
    "https://example.com/\n@everyone",
    "https://example.com/%0a@everyone",
    "https://example.com/|spoof",
    "https://example.com/\\spoof",
  ];
  const provider = createTavilyWebSearchProvider(
    { apiKey },
    {
      fetch: async () =>
        Response.json({
          results: [
            ...rejected.map((url) => ({
              url,
              title: "Rejected",
              content: "Not public citation data",
            })),
            {
              url: "https://en.wikipedia.org/wiki/June_(name)",
              title: "June\u202e (name)",
              content: "A\npublic\tname",
            },
          ],
        }),
    },
  );
  expect(await provider.search("public name origins")).toEqual({
    status: "ready",
    results: [
      {
        url: "https://en.wikipedia.org/wiki/June_%28name%29",
        title: "June (name)",
        snippet: "A public name",
      },
    ],
  });
});
