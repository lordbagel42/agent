import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CodexRunner, createCodexRuntime } from "./codex.js";

const thread = "actual-runtime-thread";
const turn = "actual-turn";
const handshake = [
  { id: 1, result: {} },
  { id: 2, result: { account: { type: "chatgpt" } } },
  { id: 3, result: { thread: { id: thread, status: { type: "idle" } } } },
];
const ending = [
  { id: 4, result: { turn: { id: turn } } },
  {
    method: "item/completed",
    params: {
      threadId: thread,
      turnId: turn,
      item: { type: "agentMessage", text: "Done" },
    },
  },
  {
    method: "turn/completed",
    params: { threadId: thread, turn: { id: turn, status: "completed" } },
  },
  { id: 5, result: { status: "unsubscribed" } },
  { method: "thread/closed", params: { threadId: thread } },
];

function fixture(events: unknown[], close = async () => {}) {
  const sent: Record<string, unknown>[] = [];
  const runner: CodexRunner = () => ({
    send(message) {
      sent.push(message);
    },
    messages: (async function* () {
      yield* events;
    })(),
    close,
  });
  return {
    sent,
    runtime: createCodexRuntime({ home: "/dedicated-codex", runner }),
  };
}

const input = () => ({
  cwd: "/isolated-worktree",
  prompt: "Change one file",
  signal: new AbortController().signal,
  onThread: async (_id: string) => {},
});

describe("Codex coding side-effect boundaries", () => {
  it("persists the actual thread before turn/start and awaits process settlement", async () => {
    const saved = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const { runtime, sent } = fixture([...handshake, ...ending], async () => {
      closing.resolve();
      await stopped.promise;
    });
    let resolved = false;
    const result = runtime
      .run({
        ...input(),
        onThread: async (id) => {
          expect(id).toBe(thread);
          observed.resolve();
          await saved.promise;
        },
      })
      .then((value) => {
        resolved = true;
        return value;
      });
    await observed.promise;
    expect(sent.some((event) => event.method === "turn/start")).toBe(false);
    saved.resolve();
    await closing.promise;
    expect(resolved).toBe(false);
    stopped.resolve();
    await expect(result).resolves.toEqual({ threadId: thread, report: "Done" });
    expect(sent.filter((event) => event.method === "turn/start")).toHaveLength(
      1,
    );
    expect(sent.at(-1)).toEqual({
      id: 5,
      method: "thread/unsubscribe",
      params: { threadId: thread },
    });
  });

  it.each([false, true])(
    "rechecks host validity after onThread without signal cancellation (invalidated: %s)",
    async (invalidate) => {
      for (const threadId of [undefined, thread]) {
        const { runtime, sent } = fixture([...handshake, ...ending]);
        const saved = Promise.withResolvers<void>();
        const observed = Promise.withResolvers<void>();
        const controller = new AbortController();
        let revision = 0;
        const frozenRevision = revision;
        const run = runtime.run({
          ...input(),
          threadId,
          signal: controller.signal,
          assertCurrent: () => {
            if (revision !== frozenRevision) throw new Error("stale context");
          },
          onThread: async () => {
            observed.resolve();
            await saved.promise;
          },
        });
        const outcome = run.then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        await observed.promise;
        expect(sent.some((event) => event.method === "turn/start")).toBe(false);
        if (invalidate) revision++;
        saved.resolve();
        const result = await outcome;
        expect(controller.signal.aborted).toBe(false);
        expect(
          sent.filter((event) => event.method === "turn/start"),
        ).toHaveLength(invalidate ? 0 : 1);
        if (invalidate) {
          expect(result.value).toBeUndefined();
          expect(result.error).toMatchObject({ code: "completion_unknown" });
        } else {
          expect(result.error).toBeUndefined();
          expect(result.value).toEqual({ threadId: thread, report: "Done" });
        }
        expect(
          sent.filter((event) =>
            ["thread/start", "thread/resume"].includes(String(event.method)),
          ),
        ).toHaveLength(1);
      }
    },
  );

  it("never launches after failed persistence or cancellation while saving", async () => {
    for (const cancel of [false, true]) {
      const { runtime, sent } = fixture([...handshake, ...ending]);
      const controller = new AbortController();
      await expect(
        runtime.run({
          ...input(),
          signal: controller.signal,
          onThread: async () => {
            if (cancel) controller.abort();
            else throw Error("private failure");
          },
        }),
      ).rejects.toMatchObject({
        code: cancel ? "cancelled" : "thread_save_failed",
      });
      expect(sent.some((event) => event.method === "turn/start")).toBe(false);
    }
  });

  it("resumes only the exact ID and never replaces a mismatched thread", async () => {
    const { runtime, sent } = fixture([...handshake, ...ending]);
    await runtime.run({ ...input(), threadId: thread });
    expect(sent.find((event) => event.id === 3)).toEqual({
      id: 3,
      method: "thread/resume",
      params: {
        threadId: thread,
        cwd: "/isolated-worktree",
        excludeTurns: true,
      },
    });
    const mismatch = fixture(handshake);
    await expect(
      mismatch.runtime.run({
        ...input(),
        threadId: "different-existing-thread",
        onThread: async () => {
          throw Error("must not be called");
        },
      }),
    ).rejects.toMatchObject({ code: "thread_mismatch" });
    expect(mismatch.sent.some((event) => event.method === "turn/start")).toBe(
      false,
    );
  });

  it("holds ambiguous completion and refuses interactive approval rather than claiming success", async () => {
    for (const [events, code] of [
      [[...handshake, ...ending.slice(0, 2)], "completion_unknown"],
      [[...handshake, ...ending.slice(0, 3)], "completion_unknown"],
      [[...handshake, ...ending.slice(0, 4)], "completion_unknown"],
      [[...handshake, ...ending.slice(0, 3), ending[4]], "completion_unknown"],
      [
        [
          ...handshake,
          ...ending.slice(0, 4),
          { method: "thread/closed", params: { threadId: "other-thread" } },
        ],
        "completion_unknown",
      ],
      [
        [
          ...handshake,
          {
            id: "approval",
            method: "item/commandExecution/requestApproval",
            params: {},
          },
        ],
        "interaction_required",
      ],
      [
        [
          ...handshake,
          ending[0],
          {
            method: "turn/completed",
            params: {
              threadId: thread,
              turn: { id: "wrong-turn", status: "completed" },
            },
          },
        ],
        "completion_unknown",
      ],
    ] as const) {
      const { runtime, sent } = fixture([...events]);
      await expect(runtime.run(input())).rejects.toMatchObject({ code });
      expect(sent.every((event) => !("result" in event))).toBe(true);
    }
    // Closure can race the unsubscribe response, but both receipts are required.
    await expect(
      fixture([
        ...handshake,
        ...ending.slice(0, 3),
        ending[4],
        ending[3],
      ]).runtime.run(input()),
    ).resolves.toEqual({ threadId: thread, report: "Done" });
  });

  it("does not inherit desktop credentials or ambient keys into the real child transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "june-codex-boundary-"));
    const executable = join(root, "fake-codex");
    const capture = join(root, "environment.json");
    try {
      execFileSync("git", ["init", "--quiet", root]);
      await writeFile(
        executable,
        `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ env: process.env, args: process.argv.slice(2), cwd: process.cwd() }));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
  if (msg.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { account: null, requiresOpenaiAuth: true } }) + '\\n');
});
`,
        { mode: 0o700 },
      );
      const runtime = createCodexRuntime({ home: root, executable });
      await expect(
        runtime.run({ ...input(), cwd: root }),
      ).rejects.toMatchObject({ code: "authentication_required" });
      const captured = JSON.parse(await readFile(capture, "utf8"));
      expect(captured.cwd).toBe(root);
      expect(captured.env.CODEX_HOME).toBe(root);
      expect(captured.env.HOME).toBe(root);
      expect(
        Object.keys(captured.env).every((key) =>
          [
            "CODEX_HOME",
            "HOME",
            "PATH",
            "LANG",
            "LC_ALL",
            "TZ",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
          ].includes(key),
        ),
      ).toBe(true);
      expect(captured.args).toEqual([
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        'cli_auth_credentials_store="file"',
        "-c",
        "thread_unload_delay_secs=0",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires graceful process exit, cancels active work, and bounds both output streams", async () => {
    for (const mode of [
      "success",
      "badExit",
      "cancel",
      "stdout",
      "stderr",
      "combined",
    ]) {
      const root = await mkdtemp(join(tmpdir(), "june-codex-transport-"));
      const executable = join(root, "fake-codex");
      const controller = new AbortController();
      try {
        execFileSync("git", ["init", "--quiet", root]);
        await writeFile(
          executable,
          `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const mode = ${JSON.stringify(mode)};
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
const keepAlive = setInterval(() => {}, 1000);
rl.on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync('requests.jsonl', JSON.stringify(message) + '\\n');
  if (message.id <= 3) send(${JSON.stringify(handshake)}[message.id - 1]);
  if (message.id === 4) {
    fs.writeFileSync('turn-started', 'yes');
    if (mode === 'cancel') return;
    if (mode === 'combined') {
      send({ method: 'debug', padding: 'x'.repeat(8 * 1024 * 1024) });
      process.stderr.write('x'.repeat(9 * 1024 * 1024));
      return;
    }
    if (mode === 'stdout' || mode === 'stderr') {
      process[mode].write('x'.repeat(16 * 1024 * 1024 + 1));
      return;
    }
    send({ id: 4, result: { turn: { id: ${JSON.stringify(turn)} } } });
    send({ method: 'item/completed', params: {
      threadId: ${JSON.stringify(thread)}, turnId: ${JSON.stringify(turn)},
      item: { type: 'agentMessage', text: 'a'.repeat(32001) }
    }});
    send(${JSON.stringify(ending[2])});
  }
  if (message.id === 5) {
    // Delayed close follows managed shutdown, independently of turn completion.
    send(${JSON.stringify(ending[3])});
    setTimeout(() => send(${JSON.stringify(ending[4])}), 20);
  }
});
rl.on('close', () => {
  // Work after EOF exposes destructive stdout iteration or immediate SIGKILL.
  process.stdout.write(JSON.stringify({ method: 'shutdown/draining' }) + '\\n');
  setTimeout(() => {
    fs.writeFileSync('shutdown-finished', 'yes');
    clearInterval(keepAlive);
    process.exitCode = mode === 'badExit' ? 7 : 0;
  }, 20);
});
`,
          { mode: 0o700 },
        );
        const runtime = createCodexRuntime({
          home: root,
          executable,
          timeoutMs: 5_000,
        });
        const result = runtime
          .run({ ...input(), cwd: root, signal: controller.signal })
          .then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error }),
          );
        if (mode === "cancel") {
          await expect
            .poll(() => readFile(join(root, "turn-started"), "utf8"))
            .toBe("yes");
          controller.abort();
        }
        const outcome = await result;
        if (mode === "success") {
          expect(outcome.error).toBeUndefined();
          expect(outcome.value).toEqual({
            threadId: thread,
            report: `${"a".repeat(31_980)}\n\n[Report truncated]`,
          });
        } else {
          expect(outcome.value).toBeUndefined();
          expect(outcome.error).toMatchObject({
            code: mode === "cancel" ? "cancelled" : "completion_unknown",
          });
        }
        if (["success", "badExit", "cancel"].includes(mode)) {
          expect(await readFile(join(root, "shutdown-finished"), "utf8")).toBe(
            "yes",
          );
        } else {
          // Overflow must stop immediately, not pass via the later run timeout.
          await expect(
            readFile(join(root, "shutdown-finished"), "utf8"),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
        const requests = (await readFile(join(root, "requests.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          requests.filter((message) => message.method === "turn/start"),
        ).toHaveLength(1);
        expect(requests.every((message) => !("result" in message))).toBe(true);
      } finally {
        controller.abort();
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
