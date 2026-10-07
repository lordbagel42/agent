import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { GitHubIssue, IssueGitHub } from "./github-issues.js";
import { IssueCredentialUnavailable } from "./issue-credentials.js";
import { IssueTracker } from "./issue-tracker.js";
import { DiagnosticStore } from "./store.js";

const start = Date.parse("2026-10-07T12:00:00Z");
const source = "debug:e782a1c4-9d2f-4ace-a1c0-5f3e9d7b1142";
const claimId = "10000000-0000-4000-8000-000000000001";
const key = "20000000-0000-4000-8000-000000000002";
const threadId = "T-30000000-0000-4000-8000-000000000003";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function fixture(enabledAt = start) {
  const directory = mkdtempSync(join(tmpdir(), "june-issues-"));
  const store = new DiagnosticStore(join(directory, "archive.sqlite"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanup.push(() => store.close());
  const remote: GitHubIssue[] = [];
  const comments: Array<{ id: number; body: string }> = [];
  let loseCreate = false;
  let loseComment = false;
  let loseClose = false;
  let published = false;
  let unavailable: "create" | "comment" | "close" | undefined;
  function add(number: number, authorId = 42, created = start + 1000) {
    const issue: GitHubIssue = {
      number,
      authorId,
      title: `Issue ${number}`,
      body: "Requested code work",
      state: "open",
      stateReason: null,
      createdAt: new Date(created).toISOString(),
      updatedAt: new Date(created).toISOString(),
      url: `https://github.com/lordbagel42/agent/issues/${number}`,
    };
    remote.push(issue);
    return issue;
  }
  function get(number: number) {
    const issue = remote.find((item) => item.number === number);
    if (!issue) throw new Error("issue not found");
    return issue;
  }
  const github: IssueGitHub = {
    list: async () => structuredClone(remote),
    get: async (number) => structuredClone(get(number)),
    ownerId: async () => 42,
    create: async (title, body) => {
      if (unavailable === "create") throw new IssueCredentialUnavailable();
      const issue = add(100 + remote.length, 91);
      Object.assign(issue, { title, body });
      if (loseCreate) throw new Error("lost create response");
      return structuredClone(issue);
    },
    comments: async () => structuredClone(comments),
    comment: async (_number, body) => {
      if (unavailable === "comment") throw new IssueCredentialUnavailable();
      const comment = { id: comments.length + 1, body };
      comments.push(comment);
      if (loseComment) throw new Error("lost comment response");
      return comment;
    },
    close: async (number) => {
      if (unavailable === "close") throw new IssueCredentialUnavailable();
      const issue = get(number);
      issue.state = "closed";
      issue.stateReason = "completed";
      if (loseClose) throw new Error("lost close response");
      return structuredClone(issue);
    },
    shipped: async () => published,
  };
  const options = {
    store,
    github,
    creatorId: 91,
    origin: "https://debug.example.test",
    now: () => start + 2000,
  };
  const tracker = new IssueTracker({ ...options, now: () => enabledAt });
  return {
    tracker,
    options,
    remote,
    comments,
    add,
    loseCreate: () => {
      loseCreate = true;
    },
    loseComment: () => {
      loseComment = true;
    },
    loseClose: () => {
      loseClose = true;
    },
    publish: () => {
      published = true;
    },
    expire: (stage: typeof unavailable) => {
      unavailable = stage;
    },
  };
}

it.each(["create", "comment", "close"] as const)(
  "leaves %s retryable only when credentials prove no HTTP dispatch",
  async (stage) => {
    const f = fixture();
    f.add(7);
    f.publish();
    f.expire(stage);
    if (stage === "create") {
      await f.tracker.run({ action: "track", source, snapshotOnly: true });
      await f.tracker.sync();
      expect(f.tracker.index().pending).toEqual([
        { source, status: "pending" },
      ]);
      f.expire(undefined);
      await f.tracker.sync();
      expect(f.tracker.index().pending).toEqual([]);
      expect(f.remote).toHaveLength(2);
    } else {
      const input = {
        action: "complete" as const,
        number: 7,
        key,
        body: "Verified code shipped",
        commit: "a".repeat(40),
      };
      expect(await f.tracker.run(input)).toMatchObject({
        phase: stage === "comment" ? "pending" : "commented",
      });
      f.expire(undefined);
      expect(await f.tracker.run(input)).toMatchObject({ status: "done" });
      expect(f.comments).toHaveLength(1);
      expect(f.remote[0]?.state).toBe("closed");
    }
  },
);

it("reconciles lost issue creation by source without queuing a second investigator", async () => {
  const f = fixture();
  f.loseCreate();
  await f.tracker.run({ action: "track", source, snapshotOnly: true });
  await f.tracker.sync();
  const restarted = new IssueTracker(f.options);
  await restarted.sync();
  const linked = await restarted.run({ action: "inspect", source });
  expect(linked).toMatchObject({
    source,
    status: "linked",
    number: 100,
    issue: { captureOnly: true },
  });
  expect(f.remote).toHaveLength(1);
  expect(f.remote[0]?.body).toContain(
    "https://debug.example.test/s/e782a1c4-9d2f-4ace-a1c0-5f3e9d7b1142",
  );
  expect(f.remote[0]?.body).toContain("Capture only");
  expect(await restarted.claim(claimId)).toEqual({ job: null });
});

it("does not bind copied public markers from another author or an older issue", async () => {
  const f = fixture();
  const foreign = f.add(4, 93);
  const older = f.add(5, 91, start - 1000);
  f.loseCreate();
  await f.tracker.run({ action: "track", source });
  await f.tracker.sync();
  foreign.body = older.body = f.remote[2]?.body ?? "";
  const restarted = new IssueTracker(f.options);
  await restarted.sync();
  expect(await restarted.run({ action: "inspect", source })).toMatchObject({
    status: "linked",
    number: 102,
  });
  expect(
    restarted.index().items.find((item) => item.number === 102)?.job,
  ).toBeUndefined();
  f.publish();
  await expect(
    restarted.run({
      action: "complete",
      number: 4,
      key,
      body: "Copied marker is not source authority",
      commit: "a".repeat(40),
    }),
  ).rejects.toThrow("issue_triage_only");
});

it("retains monotonic host source receipts before and after GitHub linkage", async () => {
  const f = fixture();
  await f.tracker.sourceReceipt({ source, phase: "queued" });
  await f.tracker.sourceReceipt({ source, phase: "unknown" });
  await f.tracker.sourceReceipt({ source, phase: "running", threadId });
  await f.tracker.sync();
  const restarted = new IssueTracker(f.options);
  expect(restarted.index().items[0]).toMatchObject({
    phase: "unknown",
    threadId,
  });
  await expect(
    restarted.sourceReceipt({ source, phase: "returned" }),
  ).rejects.toThrow();
  await expect(
    restarted.sourceReceipt({
      source,
      phase: "returned",
      threadId: "T-40000000-0000-4000-8000-000000000004",
    }),
  ).rejects.toThrow("issue_thread_conflict");
  await restarted.sourceReceipt({ source, phase: "returned", threadId });
  await restarted.sourceReceipt({ source, phase: "queued" });
  expect(restarted.index().items[0]).toMatchObject({
    phase: "returned",
    threadId,
    state: "open",
  });
  expect(await restarted.claim(claimId)).toEqual({ job: null });
});

it("records upload metadata while GitHub sync is stalled", async () => {
  const f = fixture();
  const remote = Promise.withResolvers<GitHubIssue[]>();
  f.options.github.list = () => remote.promise;
  const sync = f.tracker.sync();
  const receipt = f.tracker.sourceReceipt({ source, phase: "unavailable" });
  try {
    await Promise.resolve();
    expect(f.tracker.index().pending).toEqual([{ source, status: "pending" }]);
  } finally {
    remote.resolve([]);
    await sync;
    await receipt;
  }
  expect(f.tracker.index().items[0]).toMatchObject({ phase: "unavailable" });
});

it("settles an operator-proven no-launch without inventing a thread or accepting late callbacks", async () => {
  const f = fixture();
  f.add(7);
  f.add(8);
  await f.tracker.sync();
  await f.tracker.claim(claimId);
  await f.tracker.receipt(7, { claimId, phase: "unknown" });
  const input = {
    claimId,
    resolution: "no_launch" as const,
    evidence:
      "Operator checked runner records; no process or thread was created.",
  };
  await expect(
    f.tracker.reconcile(7, { ...input, claimId: key }),
  ).rejects.toThrow("issue_claim_conflict");
  await expect(
    f.tracker.reconcile(7, { ...input, resolution: "settled" }),
  ).rejects.toThrow();
  await f.tracker.reconcile(7, input);
  const restarted = new IssueTracker(f.options);
  await restarted.reconcile(7, input);
  expect(await restarted.claim(claimId)).toMatchObject({
    job: { number: 7, phase: "reconciled" },
  });
  await expect(
    restarted.receipt(7, { claimId, phase: "returned", threadId }),
  ).rejects.toThrow("issue_claim_reconciled");
  expect(await restarted.claim(key)).toMatchObject({ job: { number: 8 } });
  expect(f.remote[0]?.state).toBe("open");
});

it("does not miss issues created within GitHub's whole-second activation timestamp", async () => {
  const f = fixture(start + 750);
  f.add(6, 42, start - 1000);
  f.add(7, 42, start);
  await f.tracker.sync();
  expect(await f.tracker.claim(claimId)).toMatchObject({ job: { number: 7 } });
});

it("admits new issues once, binds author authority, and preserves uncertain claims across restart", async () => {
  const f = fixture();
  f.add(5, 42, start - 1);
  f.add(7);
  f.add(8, 93);
  f.add(9).state = "closed";
  await f.tracker.sync();
  expect(await f.tracker.claim(claimId)).toMatchObject({
    job: { number: 7, ownerRequest: true, phase: "claimed" },
  });
  await f.tracker.receipt(7, { claimId, phase: "unknown", threadId });
  const restarted = new IssueTracker(f.options);
  await restarted.sync();
  expect(await restarted.claim(claimId)).toMatchObject({
    job: { number: 7, phase: "unknown", threadId },
  });
  expect(await restarted.claim(key)).toMatchObject({
    job: { number: 8, ownerRequest: false },
  });
  await expect(
    restarted.receipt(7, { claimId: key, phase: "returned", threadId }),
  ).rejects.toThrow();
  await restarted.receipt(7, { claimId, phase: "returned", threadId });
  await restarted.sync();
  expect(await restarted.claim("40000000-0000-4000-8000-000000000004")).toEqual(
    { job: null },
  );
});

it("reconciles a posted comment after response loss and rejects changed idempotency payloads", async () => {
  const f = fixture();
  f.add(7);
  await f.tracker.sync();
  f.loseComment();
  const input = {
    action: "comment" as const,
    number: 7,
    body: "Reproduced the timeout",
    key,
    threadId,
  };
  expect(await f.tracker.run(input)).toMatchObject({ status: "unknown" });
  const restarted = new IssueTracker(f.options);
  expect(await restarted.run(input)).toMatchObject({ status: "done" });
  expect(f.comments).toHaveLength(1);
  await expect(
    restarted.run({ ...input, body: "Different comment" }),
  ).rejects.toThrow();
});

it("requires publication before completion and reconciles a lost close without another comment", async () => {
  const f = fixture();
  f.add(7);
  await f.tracker.sync();
  const input = {
    action: "complete" as const,
    number: 7,
    body: "Fixed and verified",
    key,
    commit: "a".repeat(40),
    threadId,
  };
  await expect(f.tracker.run(input)).rejects.toThrow(
    "issue_commit_not_shipped",
  );
  expect(f.comments).toEqual([]);
  expect(f.remote[0]?.state).toBe("open");
  f.publish();
  f.loseClose();
  expect(await f.tracker.run(input)).toMatchObject({ status: "unknown" });
  expect(await new IssueTracker(f.options).run(input)).toMatchObject({
    status: "done",
  });
  expect(f.remote[0]?.state).toBe("closed");
  expect(f.comments).toHaveLength(1);
  expect(f.comments[0]?.body).toContain(`/commit/${"a".repeat(40)}`);
  f.add(8, 93);
  await f.tracker.sync();
  await expect(
    f.tracker.run({ ...input, number: 8, key: claimId }),
  ).rejects.toThrow("issue_triage_only");
});
