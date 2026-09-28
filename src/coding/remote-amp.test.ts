import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { createRemoteAmpJobs } from "./remote-amp.js";

const launch = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: launch }));

it("pins SSH authority, persists init before result, and never retries ambiguous dispatch", async () => {
  const thread = "T-00000000-0000-0000-0000-000000000001";
  const transport = createRemoteAmpJobs({
    enabled: true,
    host: "fixture.invalid",
    user: "amp",
    identityFile: "/fixture/ordinary-key",
    knownHostsFile: "/fixture/pinned-hosts",
    policyRevision: "v1",
    workspaces: { "amp-june": "/remote/june" },
    timeoutMs: 1000,
  });
  for (const exitCode of [0, 255]) {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, kill: vi.fn() });
    launch.mockReturnValueOnce(child);
    const receipt = vi.fn(async () => {});
    const promise = transport.run({
      id: "a".repeat(64),
      workspace: "amp-june",
      goal: "Synthetic task; 'quoted'",
      signal: new AbortController().signal,
      onThread: receipt,
    });
    const expected =
      exitCode === 0
        ? expect(promise).resolves.toEqual({
            threadId: thread,
            report: "Fixture result",
          })
        : expect(promise).rejects.toThrow("Remote completion unknown");
    stdout.write(
      `${JSON.stringify({ type: "system", subtype: "init", session_id: thread })}\n`,
    );
    await expect.poll(() => receipt.mock.calls.length).toBe(1);
    stdout.end(
      `${JSON.stringify({ type: "result", session_id: thread, is_error: false, result: "Fixture result" })}\n`,
    );
    child.emit("close", exitCode);
    await expected;
  }
  expect(launch).toHaveBeenCalledTimes(2);
  const [executable, argv, options] = launch.mock.calls[0] ?? [];
  expect(executable).toBe("/usr/bin/ssh");
  expect(argv).toContain("StrictHostKeyChecking=yes");
  expect(argv).toContain("IdentityAgent=none");
  expect(argv).toContain("UserKnownHostsFile=/fixture/pinned-hosts");
  expect(options).toEqual({
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  expect(argv.at(-1)).toMatch(/^june-job [A-Za-z0-9_-]+$/);
});
