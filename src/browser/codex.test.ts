import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodexRunner } from "../coding/codex.js";
import {
  browserCodexConfig,
  deleteBrowserThread,
  runBrowserTurn,
} from "./codex.js";

const threadId = "browser-thread";
const turnId = "browser-turn";
function policy() {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(browserCodexConfig)) {
    const parts = key.split(".");
    let parent = config;
    for (const part of parts.slice(0, -1)) {
      parent[part] ??= {};
      parent = parent[part] as Record<string, unknown>;
    }
    parent[parts.at(-1) as string] = value;
  }
  return {
    config: {
      ...config,
      chatgpt_base_url: "https://chatgpt.com/backend-api/",
      model_providers: {},
      mcp_servers: {},
      instructions: null,
      developer_instructions: null,
      model_instructions_file: null,
      hooks: null,
    },
    layers: [{ name: { type: "sessionFlags" }, config }],
  };
}
const handshake = () => [
  { id: 1, result: {} },
  { id: 2, result: { account: { type: "chatgpt" } } },
  { id: 3, result: policy() },
  { id: 4, result: { requirements: null } },
  {
    id: 5,
    result: {
      thread: { id: threadId, status: { type: "idle" } },
      approvalPolicy: "never",
      modelProvider: "openai",
      sandbox: { type: "readOnly" },
      instructionSources: [],
    },
  },
  { id: 6, result: { turn: { id: turnId } } },
];
const ending = [
  {
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: { type: "agentMessage", text: "Observed visuals only." },
    },
  },
  {
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status: "completed" } },
  },
  { id: 7, result: { status: "unsubscribed" } },
  { method: "thread/closed", params: { threadId } },
];
const call = (
  id: number,
  tool = "observe",
  args: unknown = {},
  overrides = {},
) => ({
  id,
  method: "item/tool/call",
  params: {
    threadId,
    turnId,
    callId: `call-${id}`,
    tool,
    arguments: args,
    ...overrides,
  },
});
function fixture(events: unknown[], close = async () => {}) {
  const sent: Record<string, unknown>[] = [];
  const calls: { name: string; args: unknown }[] = [];
  const runner: CodexRunner = () => ({
    send: (m) => {
      sent.push(m);
    },
    messages: (async function* () {
      yield* events;
    })(),
    close,
  });
  const options = {
    home: "/dedicated-browser-codex",
    cwd: "/isolated-browser",
    goal: "Review visual evidence",
    signal: new AbortController().signal,
    runner,
    onThread: async (_id: string) => {},
    tool: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return {
        text: "Observed",
        image: {
          mimeType: "image/jpeg" as const,
          data: new Uint8Array([255, 216, 255]),
        },
      };
    },
  };
  return { options, sent, calls };
}

describe("restricted browser Codex protocol", () => {
  it("does not dispatch inference when authority expires while saving the thread", async () => {
    let valid = true;
    const f = fixture([...handshake(), ...ending]);
    await expect(
      runBrowserTurn({
        ...f.options,
        valid: () => valid,
        onThread: async () => {
          valid = false;
        },
      }),
    ).rejects.toThrow();
    expect(f.sent.some((m) => m.method === "turn/start")).toBe(false);
  });
  it("removes execution environments on creation and every turn, including resumes", async () => {
    for (const resume of [false, true]) {
      const f = fixture([...handshake(), ...ending]);
      await runBrowserTurn({ ...f.options, ...(resume ? { threadId } : {}) });
      expect(f.sent.find((m) => m.method === "turn/start")).toMatchObject({
        params: { environments: [] },
      });
      if (!resume)
        expect(f.sent.find((m) => m.method === "thread/start")).toMatchObject({
          params: {
            environments: [],
            runtimeWorkspaceRoots: [],
            selectedCapabilityRoots: [],
          },
        });
      expect(f.sent.some((m) => m.method === "thread/delete")).toBe(false);
    }
  });

  it("rejects unsafe or missing effective thread policy before dispatching tools", async () => {
    for (const override of [
      { approvalPolicy: "on-request" },
      { modelProvider: "other" },
      { sandbox: { type: "dangerFullAccess" } },
      { sandbox: undefined },
      { instructionSources: [{}] },
      { instructionSources: undefined },
    ]) {
      for (const resume of [false, true]) {
        const events = handshake();
        const response = events[4];
        if (!response) throw Error("Missing thread fixture");
        Object.assign(response.result, override);
        const f = fixture([...events, call(81), ...ending]);
        await expect(
          runBrowserTurn({ ...f.options, ...(resume ? { threadId } : {}) }),
        ).rejects.toMatchObject({ code: "invalid_configuration" });
        expect(f.calls).toEqual([]);
        expect(f.sent.some((m) => m.method === "turn/start")).toBe(false);
      }
    }
  });

  it("deletes through the authenticated restricted protocol and waits for owned close", async () => {
    const closing = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const f = fixture(
      [
        ...handshake().slice(0, 4),
        { method: "thread/deleted", params: { threadId } },
        { id: 5, result: {} },
      ],
      async () => {
        closing.resolve();
        await stopped.promise;
      },
    );
    let resolved = false;
    const result = deleteBrowserThread({ ...f.options, threadId }).then(() => {
      resolved = true;
    });
    await closing.promise;
    expect(resolved).toBe(false);
    expect(
      f.sent.filter((m) => String(m.method).startsWith("thread/")),
    ).toEqual([{ id: 5, method: "thread/delete", params: { threadId } }]);
    stopped.resolve();
    await result;
    expect(f.calls).toEqual([]);
  });

  it("never certifies failed, unacknowledged or unclean deletion", async () => {
    for (const response of [
      [],
      [{ id: 5, error: { code: -1, message: "failed" } }],
      [call(81)],
      [{ id: 5, result: null }],
      [{ method: "thread/deleted", params: { threadId } }],
      [{ id: 5, result: { status: "archived" } }],
      [{ id: 99, result: {} }],
    ]) {
      const f = fixture([...handshake().slice(0, 4), ...response]);
      await expect(
        deleteBrowserThread({ ...f.options, threadId }),
      ).rejects.toMatchObject({ code: "completion_unknown" });
      expect(f.calls).toEqual([]);
    }
    const f = fixture(
      [...handshake().slice(0, 4), { id: 5, result: {} }],
      async () => {
        throw Error("close failed");
      },
    );
    await expect(
      deleteBrowserThread({ ...f.options, threadId }),
    ).rejects.toMatchObject({ code: "completion_unknown" });
  });

  it("requires auth, safe config, and a live cleanup signal before deletion", async () => {
    for (const authenticated of [false, true]) {
      const events = handshake().slice(0, 4);
      if (!authenticated) events[1] = { id: 2, result: {} };
      else {
        const response = events[2];
        if (!response) throw Error("Missing config fixture");
        const config = (response.result as ReturnType<typeof policy>)
          .config as Record<string, unknown>;
        (config.features as Record<string, unknown>).shell_tool = true;
      }
      const f = fixture([...events, { id: 5, result: {} }]);
      await expect(
        deleteBrowserThread({ ...f.options, threadId }),
      ).rejects.toMatchObject({
        code: authenticated
          ? "invalid_configuration"
          : "authentication_required",
      });
      expect(f.sent.some((m) => m.method === "thread/delete")).toBe(false);
    }
    const f = fixture([]);
    await expect(
      deleteBrowserThread({
        ...f.options,
        threadId,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(f.sent).toEqual([]);
    const controller = new AbortController();
    const cancelled = fixture(
      [...handshake().slice(0, 4), { id: 5, result: {} }],
      async () => {
        controller.abort();
      },
    );
    await expect(
      deleteBrowserThread({
        ...cancelled.options,
        threadId,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "completion_unknown" });
  });

  it("persists before work, returns inline images using RPC ids, and waits for clean close", async () => {
    const closing = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const saving = Promise.withResolvers<void>();
    const saved = Promise.withResolvers<void>();
    const f = fixture(
      [
        ...handshake(),
        call(81),
        call(82, "scroll", { deltaY: 300 }),
        ...ending,
      ],
      async () => {
        closing.resolve();
        await stopped.promise;
      },
    );
    let resolved = false;
    const result = runBrowserTurn({
      ...f.options,
      onThread: async (id) => {
        expect(id).toBe(threadId);
        expect(f.sent.some((m) => m.method === "turn/start")).toBe(false);
        saving.resolve();
        await saved.promise;
      },
    }).then((r) => {
      resolved = true;
      return r;
    });
    await saving.promise;
    expect(f.sent.some((m) => m.method === "turn/start")).toBe(false);
    saved.resolve();
    await closing.promise;
    expect(resolved).toBe(false);
    expect(f.sent.find((m) => m.id === 81)).toEqual({
      id: 81,
      result: {
        success: true,
        contentItems: [
          { type: "inputText", text: "Observed" },
          { type: "inputImage", imageUrl: "data:image/jpeg;base64,/9j/" },
        ],
      },
    });
    expect(f.calls).toEqual([
      { name: "observe", args: {} },
      { name: "scroll", args: { deltaY: 300 } },
    ]);
    const start = f.sent.find((m) => m.method === "thread/start");
    if (!start) throw Error("Missing thread/start");
    expect(
      (start.params as { dynamicTools: { name: string }[] }).dynamicTools.map(
        (t) => t.name,
      ),
    ).toEqual([
      "navigate",
      "observe",
      "scroll",
      "discover_media",
      "video_frame",
      "request_pin",
    ]);
    expect(f.sent[0]).toMatchObject({
      params: { capabilities: { experimentalApi: true } },
    });
    stopped.resolve();
    await expect(result).resolves.toEqual({
      threadId,
      report: "Observed visuals only.",
      waitingForInput: false,
    });
  });

  it("rejects mismatched, duplicate, unknown, and malformed calls without dispatch", async () => {
    for (const bad of [
      call(82, "observe", {}, { turnId: "other" }),
      call(82, "observe", {}, { threadId: "other" }),
      call(82, "observe", {}, { callId: "call-81" }),
      call(81),
      call(82, "shell"),
      call(82, "observe", { extra: true }),
      call(82, "video_frame", { index: -1, timeSeconds: 1 }),
      { ...call(82), result: {} },
      { ...call(82), error: {} },
      { method: "item/tool/call", params: call(82).params },
      { id: 82, method: "item/commandExecution/requestApproval", params: {} },
    ]) {
      const f = fixture([...handshake(), call(81), bad, ...ending]);
      await expect(runBrowserTurn(f.options)).rejects.toMatchObject({
        code: "completion_unknown",
      });
      expect(f.calls).toHaveLength(1);
    }
  });

  it("yields PIN wait without an open RPC or more browser actions and resumes the saved thread", async () => {
    const f = fixture([
      ...handshake(),
      call(90, "request_pin", { inputRef: "e1", submitRef: "e2" }),
      call(91),
      ...ending,
    ]);
    await expect(
      runBrowserTurn({ ...f.options, threadId }),
    ).resolves.toMatchObject({ waitingForInput: true });
    expect(f.calls).toEqual([
      { name: "request_pin", args: { inputRef: "e1", submitRef: "e2" } },
    ]);
    expect(f.sent.find((m) => m.id === 90)).toMatchObject({
      result: {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: "waiting_for_input: End this turn. The host will resume after owner input; never request or repeat PIN bytes.",
          },
        ],
      },
    });
    expect(f.sent.find((m) => m.method === "thread/resume")).toMatchObject({
      params: { threadId, excludeTurns: true },
    });
    const resume = f.sent.find((m) => m.method === "thread/resume");
    if (!resume) throw Error("Missing thread/resume");
    expect(
      (resume.params as Record<string, unknown>).dynamicTools,
    ).toBeUndefined();
  });

  it("requires terminal turn, thread unload, clean process close, and durable thread identity", async () => {
    for (const events of [
      [...handshake()],
      [...handshake(), ...ending.slice(0, 2)],
      [...handshake(), ...ending.slice(0, 3)],
    ]) {
      await expect(
        runBrowserTurn(fixture(events).options),
      ).rejects.toMatchObject({ code: "completion_unknown" });
    }
    const f = fixture([...handshake(), ...ending], async () => {
      throw Error("private close error");
    });
    await expect(runBrowserTurn(f.options)).rejects.toMatchObject({
      code: "completion_unknown",
    });
    const unsaved = fixture(handshake());
    await expect(
      runBrowserTurn({
        ...unsaved.options,
        onThread: async () => {
          throw Error("private storage error");
        },
      }),
    ).rejects.toMatchObject({ code: "thread_save_failed" });
    expect(unsaved.sent.some((m) => m.method === "turn/start")).toBe(false);
    await expect(
      runBrowserTurn({ ...fixture(handshake()).options, threadId: "other" }),
    ).rejects.toMatchObject({ code: "thread_mismatch" });
  });

  it("rejects effective tool-policy overrides before thread creation", async () => {
    const events = handshake();
    const response = events[2];
    if (!response) throw Error("Missing config fixture");
    const config = (response.result as ReturnType<typeof policy>)
      .config as Record<string, unknown>;
    (config.features as Record<string, unknown>).shell_tool = true;
    const f = fixture(events);
    await expect(runBrowserTurn(f.options)).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    expect(f.sent.some((m) => m.method === "thread/start")).toBe(false);
  });

  it("launches without ambient credentials or native tools and drains owned-process shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-codex-test-"));
    const home = join(root, "auth-home");
    const cwd = join(root, "work");
    const executable = join(root, "fake-codex");
    try {
      await mkdir(home, { mode: 0o700 });
      await mkdir(cwd, { mode: 0o700 });
      // No real authentication: the fake server only checks transport policy.
      await writeFile(join(home, "auth.json"), "{}", { mode: 0o600 });
      await writeFile(
        executable,
        `#!${process.execPath}
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.deepEqual(Object.keys(process.env).sort(), ['CODEX_HOME','HOME','LANG','PATH']);
assert.equal(process.env.CODEX_HOME, ${JSON.stringify(home)});
const flags = Object.fromEntries(process.argv.slice(2).filter(x => x.includes('=')).map(x => { const i=x.indexOf('='); return [x.slice(0,i), JSON.parse(x.slice(i+1))]; }));
for (const name of ['shell_tool','unified_exec','view_image','browser_use','computer_use','apps','plugins','hooks','multi_agent','memories']) assert.equal(flags['features.'+name], false);
assert.equal(flags.web_search, 'disabled');
assert.equal(flags.approval_policy, 'never');
assert.equal(flags.model_provider, 'openai');
assert.equal(flags.cli_auth_credentials_store, 'file');
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
const responses = ${JSON.stringify(handshake())};
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.id >= 1 && m.id <= 6) send(responses[m.id-1]);
  if (m.id === 6) { send(${JSON.stringify(ending[0])}); send(${JSON.stringify(ending[1])}); }
  if (m.id === 7) { send(${JSON.stringify(ending[2])}); send(${JSON.stringify(ending[3])}); }
});
rl.on('close', () => { process.stdout.write(JSON.stringify({method:'shutdown/draining'})+'\\n'); setTimeout(() => fs.writeFileSync('settled', 'yes'), 30); });
`,
        { mode: 0o700 },
      );
      const f = fixture([]);
      await expect(
        runBrowserTurn({
          ...f.options,
          home,
          cwd,
          executable,
          runner: undefined,
          signal: AbortSignal.timeout(10_000),
        }),
      ).resolves.toMatchObject({ threadId, waitingForInput: false });
      expect(await readFile(join(cwd, "settled"), "utf8")).toBe("yes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
