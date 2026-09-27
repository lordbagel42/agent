import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createDeploymentReader, createDeploymentRoutes } from "./feed.js";

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
