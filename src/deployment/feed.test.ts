import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  createDeploymentReader,
  createDeploymentRoutes,
  createReleaseTool,
  type DeploymentFeed,
} from "./feed.js";

test("June can inspect Actions waits, build success and failures without claiming deployment", async () => {
  const root = await mkdtemp(join(tmpdir(), "june-actions-feed-"));
  const file = join(root, "events.json");
  const revision = "b".repeat(40);
  const feed = {
    version: 1,
    repository: "lordbagel42/agent",
    branch: "main",
    lastHealthyRevision: "a".repeat(40),
    blocked: false,
    events: [
      {
        sequence: 1,
        revision,
        status: "deferred",
        reason: "actions_pending",
        at: 2000,
        committedAt: 1000,
        elapsedMs: 1000,
      },
    ],
  };
  const read = createDeploymentReader({
    file,
    ownerId: "owner",
    trustedUid: process.getuid?.(),
  });
  const inspect = createReleaseTool({
    read: () => read("owner"),
    runningRevision: "a".repeat(40),
  });
  try {
    for (const [status, reason, explanation] of [
      ["deferred", "actions_pending", "Waiting for"],
      ["deferred", "actions_unavailable", "retry"],
      ["preparing", "actions_build_ready", "not deployment success"],
      ["failed", "actions_build_failed", "forward fix"],
      ["failed", "actions_artifact_invalid", "not activated"],
      ["failed", "actions_policy_changed", "operator-reviewed"],
      ["blocked", "binding_changed", "candidate is not failed"],
      ["blocked", "prior_release_invalid", "integrity verification"],
      ["blocked", "standby_unavailable", "Old June was not stopped"],
      ["deferred", "intake_not_settled", "retry"],
      ["deferred", "cutover_interrupted", "acknowledged pre-stop"],
      ["blocked", "lifecycle_failed", "active revision"],
    ] as const) {
      feed.events = [
        {
          sequence: 1,
          revision,
          status,
          reason,
          at: 2000,
          committedAt: 1000,
          elapsedMs: 1000,
        },
      ];
      await writeFile(file, JSON.stringify(feed), { mode: 0o640 });
      const receipt = await inspect({ action: "inspect", revision });
      expect(receipt).toContain(reason);
      expect(receipt).toContain(explanation);
      expect(receipt).toContain("Exact revision matches running process: no");
      expect(receipt).toContain("No healthy/reconciled observation");
      await expect(read("guest")).rejects.toThrow("deployment_denied");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release inspection preserves global blocks and unknown candidate/identity evidence", async () => {
  const feed: DeploymentFeed = {
    version: 1,
    repository: "lordbagel42/agent",
    branch: "main",
    lastHealthyRevision: "a".repeat(40),
    blocked: true,
    events: [
      {
        sequence: 1,
        revision: "b".repeat(40),
        status: "blocked",
        reason: "activation_unknown",
        at: 2000,
        committedAt: null,
        elapsedMs: null,
      },
    ],
  };
  const release = createReleaseTool({
    read: async () => feed,
    runningRevision: undefined,
  });
  const unknown = await release({
    action: "inspect",
    revision: "c".repeat(40),
  });
  expect(unknown).toContain("Running revision: unknown");
  expect(unknown).toContain("Controller blocked: yes. activation_unknown");
  expect(unknown).toContain("Candidate lifecycle status unknown");
  const event = feed.events[0];
  if (!event) throw new Error("Missing fixture event");
  feed.events.push({
    ...event,
    sequence: 2,
    status: "reconciled",
    reason: null,
    at: 3000,
  });
  const laterHold = await release({ action: "inspect", revision: null });
  expect(laterHold).toContain("Controller blocked: yes. Reason is outside");
  expect(laterHold).not.toContain(
    "Controller blocked: yes. activation_unknown",
  );
  feed.events.pop();
  event.status = "fetch_failed";
  event.reason = "fetch_failed";
  const fetchOnly = await release({ action: "inspect", revision: null });
  expect(fetchOnly).toContain("Candidate lifecycle status unknown");
  expect(fetchOnly).toContain("Controller could not fetch trusted main");
  expect(fetchOnly).toContain("Reason is outside the bounded feed");
  expect(fetchOnly).not.toContain(
    "Last recorded candidate status: fetch_failed",
  );
  feed.events = [
    { ...event, sequence: 1, status: "healthy", reason: null },
    ...[2, 3, 4].map((sequence) => ({ ...event, sequence })),
  ];
  const historical = await release({
    action: "inspect",
    revision: event.revision,
  });
  expect(historical).toContain(
    "Controller verified this revision healthy at 1970-01-01T00:00:02.000Z",
  );
  expect(historical).toContain(
    "Exact revision matches running process: unknown",
  );
  const current = createReleaseTool({
    read: async () => ({ ...feed, events: [] }),
    runningRevision: event.revision,
  });
  const matching = await current({
    action: "inspect",
    revision: event.revision,
  });
  expect(matching).toContain("Exact revision matches running process: yes");
  expect(matching).toContain(
    "No healthy/reconciled observation for this revision in the bounded feed",
  );
});

test("deployment evidence is owner-only, read-only, bounded and never raw process output", async () => {
  const root = await mkdtemp(join(tmpdir(), "june-feed-"));
  const file = join(root, "events.json");
  const feed = {
    version: 1,
    repository: "lordbagel42/agent",
    branch: "main",
    lastHealthyRevision: "a".repeat(40),
    blocked: false,
    events: [
      {
        sequence: 7,
        revision: "b".repeat(40),
        status: "received",
        at: 2000,
        committedAt: 1000,
        reason: null,
        elapsedMs: null,
      },
      {
        sequence: 8,
        revision: "b".repeat(40),
        status: "failed",
        at: 2500,
        committedAt: 1000,
        reason: "preflight_failed",
        elapsedMs: 500,
      },
    ],
  };
  try {
    await writeFile(file, JSON.stringify(feed), { mode: 0o640 });
    const read = createDeploymentReader({
      file,
      ownerId: "owner",
      trustedUid: process.getuid?.(),
    });
    const app = createDeploymentRoutes({
      read,
      authenticate: async (r) =>
        r.headers.get("authorization") === "Bearer fixture"
          ? "owner"
          : undefined,
    });
    expect((await app.request("/events")).status).toBe(401);
    const authorized = { headers: { authorization: "Bearer fixture" } };
    const response = await app.request("/events?after=7", authorized);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      ...feed,
      events: [feed.events[1]],
    });
    expect(
      (await app.request("/events", { ...authorized, method: "POST" })).status,
    ).toBe(404);
    await expect(read("channel", 0)).rejects.toThrow("deployment_denied");
    expect((await app.request("/events?after=-1", authorized)).status).toBe(
      400,
    );
    const deferred = {
      ...feed,
      events: [
        { ...feed.events[1], status: "deferred", reason: "insufficient_disk" },
      ],
    };
    await writeFile(file, JSON.stringify(deferred));
    expect(await read("owner")).toEqual(deferred);
    const recovery = { at: 3000, removed: 2 };
    await writeFile(
      file,
      JSON.stringify({ ...feed, lastStageRecovery: recovery }),
    );
    expect((await read("owner", 8)).lastStageRecovery).toEqual(recovery);
    for (const invalid of [
      { ...recovery, path: "/private/stage" },
      { ...recovery, revision: "b".repeat(40) },
      { ...recovery, stderr: "private credential" },
      { ...recovery, removed: 0 },
      { ...recovery, removed: 1.5 },
    ]) {
      await writeFile(
        file,
        JSON.stringify({ ...feed, lastStageRecovery: invalid }),
      );
      const rejected = await app.request("/events", authorized);
      expect(rejected.status).toBe(503);
      expect(await rejected.json()).toEqual({
        error: "deployment_feed_unavailable",
      });
    }
    await writeFile(
      file,
      JSON.stringify({
        ...feed,
        events: [{ ...feed.events[1], reason: "private process output" }],
      }),
    );
    await expect(read("owner")).rejects.toThrow("deployment_feed_unavailable");
    await writeFile(
      file,
      JSON.stringify({ ...feed, stderr: "private credential" }),
    );
    const rejected = await app.request("/events", authorized);
    expect(rejected.status).toBe(503);
    expect(await rejected.text()).not.toContain("private credential");
    await writeFile(file, JSON.stringify(feed));
    await chmod(file, 0o666);
    await expect(read("owner")).rejects.toThrow("deployment_feed_unavailable");
    await chmod(file, 0o640);
    await symlink(file, join(root, "link"));
    await expect(
      createDeploymentReader({
        file: join(root, "link"),
        ownerId: "owner",
        trustedUid: process.getuid?.(),
      })("owner"),
    ).rejects.toThrow("deployment_feed_unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
