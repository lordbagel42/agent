import { expect, it, vi } from "vitest";
import { createIssueGitHub } from "./github-issues.js";
import {
  IssueCredentials,
  IssueCredentialUnavailable,
} from "./issue-credentials.js";

const start = Date.parse("2026-10-07T12:00:00Z");
const token = "ghs_synthetic_first";
const nextToken = "ghs_synthetic_second";

it("expires on either clock without extending deadlines on duplicate delivery", () => {
  let now = start;
  let monotonic = 0;
  const credentials = new IssueCredentials({
    now: () => now,
    monotonic: () => monotonic,
  });
  expect(() => credentials.get()).toThrow(IssueCredentialUnavailable);
  const grant = { version: 1, token, expiresAt: "2026-10-07T13:00:00Z" };
  credentials.accept(grant);
  expect(credentials.get()).toBe(token);
  now += 10 * 60_000;
  monotonic += 10 * 60_000;
  credentials.accept(grant);
  now = start - 60_000; // Wall-clock rollback cannot extend token life.
  monotonic = 58 * 60_000 - 10_001;
  expect(credentials.get()).toBe(token);
  monotonic += 1; // The full request budget no longer fits before early expiry.
  expect(() => credentials.get()).toThrow(IssueCredentialUnavailable);
  expect(credentials.status()).toEqual({
    state: "expired",
    expiresAt: grant.expiresAt,
    receivedAt: start,
  });
  expect(JSON.stringify(credentials.status())).not.toContain(token);
});

it("rejects altered or stale grants without discarding the newer credential", () => {
  for (const [remaining, valid] of [
    [300_000, false],
    [300_001, true],
    [3_660_000, true],
    [3_660_001, false],
  ] as const) {
    const fresh = new IssueCredentials({
      now: () => start,
      monotonic: () => 0,
    });
    const accept = () =>
      fresh.accept({
        version: 1,
        token,
        expiresAt: new Date(start + remaining).toISOString(),
      });
    if (valid) expect(accept).not.toThrow();
    else expect(accept).toThrow();
  }
  const credentials = new IssueCredentials({
    now: () => start,
    monotonic: () => 0,
  });
  credentials.accept({ version: 1, token, expiresAt: "2026-10-07T12:50:00Z" });
  credentials.accept({
    version: 1,
    token: nextToken,
    expiresAt: "2026-10-07T13:00:00Z",
  });
  for (const grant of [
    { version: 1, token, expiresAt: "2026-10-07T12:50:00Z" },
    { version: 1, token, expiresAt: "2026-10-07T13:00:00Z" },
    { version: 1, token: nextToken, expiresAt: "2026-10-07T13:01:00Z" },
    { version: 1, token, expiresAt: "2026-10-07T12:05:00Z" },
    { version: 1, token, expiresAt: "2026-10-07T13:01:01Z" },
    {
      version: 1,
      token,
      expiresAt: "2026-10-07T13:00:01Z",
      repository: "another/repo",
    },
  ]) {
    expect(() => credentials.accept(grant)).toThrow();
    expect(credentials.get()).toBe(nextToken);
  }
});

it("obtains a credential before dispatch and rotates without retrying a write", async () => {
  let now = start;
  const credentials = new IssueCredentials({
    now: () => now,
    monotonic: () => 0,
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () =>
      Response.json({ id: 8, body: "public progress" }, { status: 201 }),
    );
  const github = createIssueGitHub({ token: () => credentials.get(), fetch });
  await expect(github.comment(17, "public progress")).rejects.toBeInstanceOf(
    IssueCredentialUnavailable,
  );
  expect(fetch).not.toHaveBeenCalled();
  credentials.accept({ version: 1, token, expiresAt: "2026-10-07T12:30:00Z" });
  await github.comment(17, "public progress");
  credentials.accept({
    version: 1,
    token: nextToken,
    expiresAt: "2026-10-07T13:00:00Z",
  });
  await github.comment(17, "public progress");
  expect(
    fetch.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("authorization"),
    ),
  ).toEqual([`Bearer ${token}`, `Bearer ${nextToken}`]);
  now = start + 58 * 60_000 - 10_001;
  expect(credentials.get()).toBe(nextToken);
  now += 1;
  await expect(github.close(17)).rejects.toBeInstanceOf(
    IssueCredentialUnavailable,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
