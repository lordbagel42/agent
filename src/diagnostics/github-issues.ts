import { z } from "zod";

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: string | null;
  authorId: number;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface IssueGitHub {
  list(since: string): Promise<GitHubIssue[]>;
  get(number: number): Promise<GitHubIssue>;
  create(title: string, body: string): Promise<GitHubIssue>;
  comments(number: number): Promise<Array<{ id: number; body: string }>>;
  comment(number: number, body: string): Promise<{ id: number }>;
  close(number: number): Promise<GitHubIssue>;
  shipped(commit: string): Promise<boolean>;
  ownerId(): Promise<number>;
}

const REPOSITORY = "lordbagel42/agent";
const API = `https://api.github.com/repos/${REPOSITORY}`;
const REQUEST_TIMEOUT_MS = 10_000;
const SCAN_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

type ErrorCode =
  | "configuration"
  | "invalid_input"
  | "invalid_response"
  | "http"
  | "transport"
  | "timeout"
  | "response_too_large"
  | "pagination_limit";

// Never attach provider text, schema errors, URLs, credentials or an error cause.
class GitHubIssuesError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status?: number,
  ) {
    super(`GitHub issues request failed (${code})`);
    this.name = "GitHubIssuesError";
  }
}

const idSchema = z.int().positive();
const timestampSchema = z.iso.datetime({ offset: true });
const shaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i)
  .toLowerCase();
const issueSchema = z.object({
  number: idSchema,
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  state_reason: z.string().nullish(),
  user: z.object({ id: idSchema }),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  pull_request: z.never().optional(),
});
const commentSchema = z.object({ id: idSchema, body: z.string() });
const pageSchema = z.array(z.unknown()).max(PAGE_SIZE);
const comparisonSchema = z.object({
  status: z.enum(["ahead", "behind", "identical", "diverged"]),
  ahead_by: z.int().nonnegative(),
  behind_by: z.int().nonnegative(),
  base_commit: z.object({ sha: shaSchema }),
  merge_base_commit: z.object({ sha: shaSchema }),
});
const repositorySchema = z.object({
  full_name: z.literal(REPOSITORY),
  owner: z.object({ login: z.literal("lordbagel42"), id: idSchema }),
});

function validate<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: "invalid_input" | "invalid_response" = "invalid_response",
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GitHubIssuesError(code);
  return parsed.data;
}

function issueReceipt(value: unknown, expectedNumber?: number): GitHubIssue {
  const issue = validate(issueSchema, value);
  if (expectedNumber !== undefined && issue.number !== expectedNumber)
    throw new GitHubIssuesError("invalid_response");
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    stateReason: issue.state_reason ?? null,
    authorId: issue.user.id,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    url: `https://github.com/${REPOSITORY}/issues/${issue.number}`,
  };
}

function issuePath(number: number): string {
  return `/issues/${validate(idSchema, number, "invalid_input")}`;
}

/** Fixed GitHub repository, one attempt per request, no automatic writes/retries.
 * Reads use GET only. A timed-out write may have succeeded: callers must reconcile
 * it rather than blindly replay it. Limits: 10s/request, 30s/scan, 2 MiB/response,
 * 100 pages of 100 entries; incomplete scans throw instead of returning a prefix.
 * `shipped` proves publication to remote main, never runtime deployment.
 * REST contract: https://docs.github.com/en/rest (API version 2026-03-10).
 */
export function createIssueGitHub(options: {
  token: string | (() => string);
  fetch?: typeof fetch;
}): IssueGitHub {
  const validToken = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9._~-]{1,4096}$/.test(value);
  if (typeof options.token !== "function" && !validToken(options.token))
    throw new GitHubIssuesError("configuration");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function request(
    path: string,
    method: "GET" | "POST" | "PATCH" = "GET",
    body?: Record<string, string>,
    deadline = Date.now() + REQUEST_TIMEOUT_MS,
  ): Promise<{ data: unknown; hasNext: boolean | undefined }> {
    // This getter may prove no request was dispatched. Keep that error outside
    // the transport catch so the journal can leave an unattempted write pending.
    const token =
      typeof options.token === "function" ? options.token() : options.token;
    if (!validToken(token)) throw new GitHubIssuesError("configuration");
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now());
    if (timeoutMs <= 0) throw new GitHubIssuesError("timeout");
    const controller = new AbortController();
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let _cancellation: Promise<void> | undefined;
    const cancelBody = () => {
      // Do not let a stalled transport's cleanup extend the deadline.
      _cancellation ??= (
        reader ? reader.cancel() : response?.body?.cancel()
      )?.catch(() => {});
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new GitHubIssuesError("timeout"));
        controller.abort();
        cancelBody();
      }, timeoutMs);
    });
    const read = async () => {
      try {
        response = await fetchImpl(`${API}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2026-03-10",
            "user-agent": "june-diagnostics",
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          redirect: "manual",
          credentials: "omit",
          signal: controller.signal,
        });
        // Also dispose of a late response from a test transport ignoring abort.
        if (controller.signal.aborted) throw new GitHubIssuesError("timeout");
        if (response.status !== (method === "POST" ? 201 : 200))
          throw new GitHubIssuesError("http", response.status);
        if (response.redirected || !response.body)
          throw new GitHubIssuesError("invalid_response");
        if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES)
          throw new GitHubIssuesError("response_too_large");
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw new GitHubIssuesError("timeout");
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES)
            throw new GitHubIssuesError("response_too_large");
          if (value.byteLength) chunks.push(value);
        }
        let data: unknown;
        try {
          data = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          );
        } catch {
          throw new GitHubIssuesError("invalid_response");
        }
        const link = response.headers.get("link");
        return {
          data,
          // Inspect only the relation; never fetch a provider-supplied URL.
          hasNext: link === null ? undefined : /;\s*rel="next"/i.test(link),
        };
      } finally {
        cancelBody();
        reader?.releaseLock();
      }
    };
    try {
      return await Promise.race([read(), timeout]);
    } catch (error) {
      if (error instanceof GitHubIssuesError) throw error;
      throw new GitHubIssuesError("transport");
    } finally {
      clearTimeout(timer);
      controller.abort();
      cancelBody();
    }
  }

  async function pages<T>(
    path: string,
    query: Record<string, string>,
    parse: (value: unknown) => T | undefined,
  ): Promise<T[]> {
    const deadline = Date.now() + SCAN_TIMEOUT_MS;
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const params = new URLSearchParams({
        ...query,
        per_page: String(PAGE_SIZE),
        page: String(page),
      });
      const { data, hasNext } = await request(
        `${path}?${params}`,
        "GET",
        undefined,
        deadline,
      );
      const batch = validate(pageSchema, data);
      for (const value of batch) {
        const item = parse(value);
        if (item !== undefined) items.push(item);
      }
      // A full page without Link is inconclusive; request the next fixed page.
      if (
        hasNext === false ||
        (hasNext === undefined && batch.length < PAGE_SIZE)
      )
        return items;
    }
    throw new GitHubIssuesError("pagination_limit");
  }

  return {
    async list(since) {
      validate(timestampSchema, since, "invalid_input");
      return pages(
        "/issues",
        { state: "all", since, sort: "updated", direction: "asc" },
        (value) => {
          if (value && typeof value === "object" && "pull_request" in value)
            return undefined;
          return issueReceipt(value);
        },
      );
    },
    async get(number) {
      return issueReceipt((await request(issuePath(number))).data, number);
    },
    async create(title, body) {
      validate(z.string().trim().min(1), title, "invalid_input");
      validate(z.string(), body, "invalid_input");
      return issueReceipt(
        (await request("/issues", "POST", { title, body })).data,
      );
    },
    async comments(number) {
      return pages(`${issuePath(number)}/comments`, {}, (value) =>
        validate(commentSchema, value),
      );
    },
    async comment(number, body) {
      const path = `${issuePath(number)}/comments`;
      validate(z.string().trim().min(1), body, "invalid_input");
      return validate(
        z.object({ id: idSchema }),
        (await request(path, "POST", { body })).data,
      );
    },
    async close(number) {
      const result = issueReceipt(
        (
          await request(issuePath(number), "PATCH", {
            state: "closed",
            state_reason: "completed",
          })
        ).data,
        number,
      );
      if (result.state !== "closed")
        throw new GitHubIssuesError("invalid_response");
      return result;
    },
    async shipped(commit) {
      const sha = validate(shaSchema, commit, "invalid_input");
      const result = validate(
        comparisonSchema,
        (await request(`/compare/${sha}...main?per_page=1`)).data,
      );
      if (result.base_commit.sha !== sha)
        throw new GitHubIssuesError("invalid_response");
      // HEAD (main) must be ahead of BASE (the supplied exact commit), not behind.
      return (
        result.behind_by === 0 &&
        result.merge_base_commit.sha === sha &&
        ((result.status === "ahead" && result.ahead_by > 0) ||
          (result.status === "identical" && result.ahead_by === 0))
      );
    },
    async ownerId() {
      return validate(repositorySchema, (await request("")).data).owner.id;
    },
  };
}
