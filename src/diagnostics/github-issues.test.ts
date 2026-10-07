import { afterEach, describe, expect, it, vi } from "vitest";
import { createIssueGitHub, type IssueGitHub } from "./github-issues.js";

const token = "github_pat_fixture_secret";
const origin = "https://api.github.com/repos/lordbagel42/agent";
const since = "2026-10-01T00:00:00.000Z";
const commit = "0123456789abcdef0123456789abcdef01234567";
const otherCommit = "abcdef0123456789abcdef0123456789abcdef01";
const issue = {
  number: 42,
  title: "Diagnostic fixture",
  body: "Fixture details",
  state: "open",
  state_reason: null,
  user: { id: 123, login: "fixture" },
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  html_url: "https://untrusted.example/not-an-issue",
};

function client(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return { api: createIssueGitHub({ token, fetch }), fetch };
}

afterEach(() => vi.useRealTimers());

describe("GitHub issue receipts and explicit writes", () => {
  it("pins the authenticated request and constructs the issue URL from its validated number", async () => {
    const { api, fetch } = client(Response.json(issue));
    expect(await api.get(42)).toEqual({
      number: 42,
      title: "Diagnostic fixture",
      body: "Fixture details",
      state: "open",
      stateReason: null,
      authorId: 123,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z",
      url: "https://github.com/lordbagel42/agent/issues/42",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${origin}/issues/42`);
    expect(init).toMatchObject({
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      signal: expect.any(AbortSignal),
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2026-03-10");
    expect(init?.body).toBeUndefined();
  });

  it("creates, comments and closes with exactly one explicit request apiece", async () => {
    const { api, fetch } = client(
      Response.json({ ...issue, body: null }, { status: 201 }),
      Response.json({ id: 98, body: "Published fix" }, { status: 201 }),
      Response.json({ ...issue, state: "closed", state_reason: "completed" }),
    );
    expect(await api.create("Diagnostic fixture", "")).toMatchObject({
      number: 42,
      body: "",
    });
    expect(await api.comment(42, "Published fix")).toEqual({ id: 98 });
    expect(await api.close(42)).toMatchObject({
      number: 42,
      state: "closed",
      stateReason: "completed",
    });
    expect(
      fetch.mock.calls.map(([url, init]) => ({
        url: String(url),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      })),
    ).toEqual([
      {
        url: `${origin}/issues`,
        method: "POST",
        body: { title: "Diagnostic fixture", body: "" },
      },
      {
        url: `${origin}/issues/42/comments`,
        method: "POST",
        body: { body: "Published fix" },
      },
      {
        url: `${origin}/issues/42`,
        method: "PATCH",
        body: { state: "closed", state_reason: "completed" },
      },
    ]);
  });

  it("reads the numeric repository owner ID, not the token's user", async () => {
    const { api, fetch } = client(
      Response.json({
        full_name: "lordbagel42/agent",
        owner: { login: "lordbagel42", id: 456 },
      }),
    );
    expect(await api.ownerId()).toBe(456);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(origin);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("rejects invalid identities and malformed receipts without exposing their contents", async () => {
    const invalidIssues = [
      { ...issue, number: 43 },
      { ...issue, number: 0 },
      { ...issue, number: "42" },
      { ...issue, user: { id: 0 } },
      { ...issue, user: { id: Number.MAX_SAFE_INTEGER + 1 } },
      { ...issue, user: null },
      { ...issue, title: 7 },
      { ...issue, body: undefined },
      { ...issue, state: "unknown" },
      { ...issue, state_reason: 1 },
      { ...issue, updated_at: "invalid date" },
      { ...issue, pull_request: { url: "https://untrusted.example" } },
    ];
    for (const receipt of invalidIssues) {
      const { api } = client(Response.json(receipt));
      await expect(api.get(42)).rejects.toThrow(/invalid_response/);
    }
    for (const receipt of [
      { full_name: "someone/agent", owner: { login: "someone", id: 456 } },
      { full_name: "lordbagel42/agent", owner: { login: "other", id: 456 } },
      {
        full_name: "lordbagel42/agent",
        owner: { login: "lordbagel42", id: "456" },
      },
    ]) {
      const { api } = client(Response.json(receipt));
      await expect(api.ownerId()).rejects.toThrow(/invalid_response/);
    }
    await expect(client(Response.json(issue)).api.close(42)).rejects.toThrow(
      /invalid_response/,
    );
    await expect(
      client(Response.json({ id: -1 }, { status: 201 })).api.comment(42, "fix"),
    ).rejects.toThrow(/invalid_response/);
  });

  it("rejects invalid path identities and timestamps before sending any requests", async () => {
    const { api, fetch } = client();
    for (const number of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await expect(api.get(number)).rejects.toThrow(/invalid_input/);
      await expect(api.close(number)).rejects.toThrow(/invalid_input/);
      await expect(api.comments(number)).rejects.toThrow(/invalid_input/);
      await expect(api.comment(number, "fix")).rejects.toThrow(/invalid_input/);
    }
    await expect(api.list("not-a-timestamp")).rejects.toThrow(/invalid_input/);
    await expect(api.create("", "body")).rejects.toThrow(/invalid_input/);
    for (const invalidCommit of [
      "main",
      "0123456",
      `${commit}...other`,
      "g".repeat(40),
    ])
      await expect(api.shipped(invalidCommit)).rejects.toThrow(/invalid_input/);
    for (const invalidToken of ["", " token ", "token\r\nheader: value"])
      expect(() => createIssueGitHub({ token: invalidToken, fetch })).toThrow(
        /configuration/,
      );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("fixed pagination", () => {
  it("lists open and closed issues on every page, excluding PRs without following Link URLs", async () => {
    const { api, fetch } = client(
      Response.json([{ ...issue, pull_request: {} }], {
        headers: {
          link: '<https://untrusted.example/steal?page=99>; rel="next"',
        },
      }),
      Response.json([issue], {
        headers: {
          link: '<https://api.github.com/repos/other/repo/issues?page=9>; rel="next"',
        },
      }),
      Response.json([{ ...issue, number: 43, state: "closed" }]),
    );
    expect(
      (await api.list(since)).map(({ number, state }) => ({ number, state })),
    ).toEqual([
      { number: 42, state: "open" },
      { number: 43, state: "closed" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [index, [url, init]] of fetch.mock.calls.entries()) {
      const parsed = new URL(String(url));
      expect(`${parsed.origin}${parsed.pathname}`).toBe(`${origin}/issues`);
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        state: "all",
        since,
        sort: "updated",
        direction: "asc",
        per_page: "100",
        page: String(index + 1),
      });
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
    }
  });

  it("walks full comment pages even without Link and returns only validated IDs and bodies", async () => {
    const { api, fetch } = client(
      Response.json(
        Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          body: `comment ${i + 1}`,
        })),
      ),
      Response.json([
        { id: 101, body: "last", html_url: "https://untrusted.example" },
      ]),
    );
    const comments = await api.comments(42);
    expect(comments).toHaveLength(101);
    expect(comments[0]).toEqual({ id: 1, body: "comment 1" });
    expect(comments[100]).toEqual({ id: 101, body: "last" });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `${origin}/issues/42/comments?per_page=100&page=1`,
      `${origin}/issues/42/comments?per_page=100&page=2`,
    ]);
    for (const receipt of [
      [{ id: "1", body: "bad" }],
      [{ id: 1, body: null }],
      {},
    ])
      await expect(
        client(Response.json(receipt)).api.comments(42),
      ).rejects.toThrow(/invalid_response/);
  });

  it.each(["list", "comments"] as const)(
    "throws rather than silently truncating %s at the page cap",
    async (method) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () =>
          Response.json(
            method === "list" ? [issue] : [{ id: 1, body: "fixture" }],
            {
              headers: {
                link: '<https://untrusted.example/endless>; rel="next"',
              },
            },
          ),
        );
      const api = createIssueGitHub({ token, fetch });
      await expect(
        method === "list" ? api.list(since) : api.comments(42),
      ).rejects.toThrow(/pagination_limit/);
      expect(fetch).toHaveBeenCalledTimes(100);
      expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(
        true,
      );
    },
  );

  it("accepts a full final page at the cap when Link confirms the end", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (url) => {
        const page = Number(new URL(String(url)).searchParams.get("page"));
        return Response.json(
          Array.from({ length: 100 }, (_, i) => ({
            id: (page - 1) * 100 + i + 1,
            body: "fixture",
          })),
          {
            headers: {
              link: `<https://untrusted.example/ignored>; rel="${page < 100 ? "next" : "prev"}"`,
            },
          },
        );
      });
    const comments = await createIssueGitHub({ token, fetch }).comments(42);
    expect(comments).toHaveLength(10_000);
    expect(comments.at(-1)).toEqual({ id: 10_000, body: "fixture" });
    expect(fetch).toHaveBeenCalledTimes(100);
  });

  it("bounds the whole paginated scan, not just each individual request", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(
            () =>
              resolve(
                Response.json([issue], {
                  headers: {
                    link: '<https://untrusted.example/endless>; rel="next"',
                  },
                }),
              ),
            8_000,
          ),
        ),
    );
    const pending = createIssueGitHub({ token, fetch }).list(since);
    const rejected = expect(pending).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[3]?.[1]?.signal?.aborted).toBe(true);
    // A test transport can ignore abort. Its late body must still be cancelled.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("publication to remote main (not deployment)", () => {
  it.each([
    { status: "ahead", ahead_by: 9, behind_by: 0, merge: commit, want: true },
    {
      status: "identical",
      ahead_by: 0,
      behind_by: 0,
      merge: commit,
      want: true,
    },
    {
      status: "behind",
      ahead_by: 0,
      behind_by: 9,
      merge: otherCommit,
      want: false,
    },
    {
      status: "diverged",
      ahead_by: 9,
      behind_by: 2,
      merge: otherCommit,
      want: false,
    },
  ])(
    "compares commit...main for $status",
    async ({ status, ahead_by, behind_by, merge, want }) => {
      const { api, fetch } = client(
        Response.json({
          status,
          ahead_by,
          behind_by,
          base_commit: { sha: commit },
          merge_base_commit: { sha: merge },
        }),
      );
      expect(await api.shipped(commit)).toBe(want);
      const url = new URL(String(fetch.mock.calls[0]?.[0]));
      expect(`${url.origin}${url.pathname}`).toBe(
        `${origin}/compare/${commit}...main`,
      );
      expect(url.searchParams.get("per_page")).toBe("1");
      expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("rejects unproven or inconsistent ancestry and a different returned base SHA", async () => {
    const comparison = {
      status: "ahead",
      ahead_by: 9,
      behind_by: 0,
      base_commit: { sha: commit },
      merge_base_commit: { sha: commit },
    };
    for (const invalid of [
      { ...comparison, base_commit: { sha: otherCommit } },
      { ...comparison, base_commit: { sha: commit.slice(0, 7) } },
      { ...comparison, ahead_by: "9" },
      { ...comparison, behind_by: -1 },
      { ...comparison, status: "unknown" },
    ])
      await expect(
        client(Response.json(invalid)).api.shipped(commit),
      ).rejects.toThrow(/invalid_response/);
    for (const invalid of [
      { ...comparison, behind_by: 2 },
      { ...comparison, merge_base_commit: { sha: otherCommit } },
      { ...comparison, status: "identical", ahead_by: 9 },
    ])
      expect(await client(Response.json(invalid)).api.shipped(commit)).toBe(
        false,
      );
  });
});

describe("bounded, secret-free failures", () => {
  it("never follows redirects, retries HTTP failures, or reads their private bodies", async () => {
    for (const status of [301, 302, 307, 308, 401, 404, 429, 503]) {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const { api, fetch } = client(
        new Response(body, {
          status,
          headers: { location: "https://untrusted.example" },
        }),
      );
      await expect(api.get(42)).rejects.toMatchObject({ status });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
      expect(cancel).toHaveBeenCalledOnce();
    }
  });

  it("sanitizes transport, parsing and schema failures, including ambiguous writes", async () => {
    const secret = `private remote body ${token}`;
    const operations: Array<(api: IssueGitHub) => Promise<unknown>> = [
      (api) => api.get(42),
      (api) => api.create("title", "body"),
      (api) => api.comment(42, "fix"),
      (api) => api.close(42),
    ];
    for (const operation of operations) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new Error(secret));
      const error = await operation(createIssueGitHub({ token, fetch })).catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/transport/);
      expect(String(error)).not.toContain(secret);
      expect(error).not.toHaveProperty("cause");
      expect(fetch).toHaveBeenCalledOnce();
    }
    for (const response of [
      new Response(secret),
      Response.json({ ...issue, number: secret }),
      new Response(secret, { status: 403 }),
    ]) {
      const error = await client(response)
        .api.get(42)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain("private remote body");
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("bounds streamed bytes even when content-length lies and cancels oversized bodies", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel,
    });
    const { api, fetch } = client(
      new Response(body, { headers: { "content-length": "1" } }),
    );
    await expect(api.get(42)).rejects.toThrow(/response_too_large/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["headers", "body"] as const)(
    "enforces the request deadline while waiting for %s",
    async (phase) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(() =>
          phase === "headers"
            ? new Promise<Response>(() => {})
            : Promise.resolve(
                new Response(new ReadableStream<Uint8Array>({ cancel })),
              ),
        );
      const pending = createIssueGitHub({ token, fetch }).get(42);
      const rejected = expect(pending).rejects.toThrow(/timeout/);
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledOnce();
      if (phase === "body") expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
