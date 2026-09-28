import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BrowserCompanion } from "./companion.js";
import { browserCommandSchema } from "./contracts.js";
import type { BrowserSession } from "./session.js";

it("rejects forged authority, secrets and unsafe destinations", () => {
  const start = {
    action: "start",
    url: "https://example.com/",
    goal: "review",
  };
  expect(browserCommandSchema.parse(start)).toEqual(start);
  for (const input of [
    { ...start, owner: "other" },
    { ...start, pin: "123456" },
    { ...start, url: "http://example.com/" },
    { ...start, url: "https://user:pass@example.com/" },
  ])
    expect(browserCommandSchema.safeParse(input).success).toBe(false);
});

it("keeps PIN bytes volatile, resumes once, and fences saved tasks after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-companion-"));
  const event = {
    type: "message" as const,
    id: "event",
    messageId: "1",
    occurredAt: 1,
    senderId: "U",
    direct: true,
    browserPinEligible: true,
    botMentioned: false,
    text: "Review this page",
    address: { channel: "slack" as const, accountId: "T", conversationId: "D" },
  };
  let state: "live" | "private" | "ended" = "live";
  let entered = "";
  let runs = 0;
  let revision = 0;
  let challengeId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const session: BrowserSession = {
    generation: "generation",
    get state() {
      return state;
    },
    epoch: 0,
    observe: async () => ({ text: "page" }),
    frame: async () => undefined,
    tool: async () => {
      state = "private";
      return { text: "waiting" };
    },
    pendingInput: () =>
      state === "private"
        ? { origin: "https://example.com", question: "PIN?", challengeId }
        : undefined,
    enterPin: async (pin) => {
      entered = pin;
      state = "live";
    },
    close: async () => {
      state = "ended";
    },
  };
  const options = {
    directory,
    home: directory,
    tempDirectory: directory,
    codexHome: directory,
    navigationOrigins: ["https://example.com"],
    resourceOrigins: ["https://example.com"],
    owner: {
      id: "owner",
      identities: [
        { channel: "slack" as const, accountId: "T", senderId: "U" },
      ],
    },
    createSession: async () => session,
    revision: () => revision,
    deleteThread: async () => {},
    runTurn: async (input: {
      onThread(id: string): Promise<void>;
      tool(name: string, args: unknown): Promise<unknown>;
    }) => {
      runs++;
      await input.onThread("thread");
      if (runs <= 2) {
        if (runs === 2) challengeId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        await input.tool("request_pin", {});
      }
      return {
        threadId: "thread",
        report: "Visual evidence",
        waitingForInput: runs <= 2,
      };
    },
  };
  const companion = new BrowserCompanion(options);
  const context = {
    event,
    operationId: "op",
    signal: new AbortController().signal,
    valid: () => true,
    review: async () => "June's review",
  };
  try {
    const first = await companion.run(
      { action: "start", url: "https://example.com/", goal: "review" },
      context,
    );
    expect(first.status).toBe("waiting_for_input");
    const reply = {
      ...event,
      id: "reply",
      text: `!browser-pin ${first.id} aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa 739251`,
    };
    expect(
      companion.consumePin({ ...reply, senderId: "other" }),
    ).toHaveProperty("text", expect.stringContaining("not accepted"));
    for (const text of [
      `  ${reply.text}`,
      `> ${reply.text}`,
      `\`${reply.text}\``,
    ])
      expect(companion.consumePin({ ...reply, text })?.text).not.toContain(
        "739251",
      );
    expect(
      companion.consumePin({ ...reply, browserPinEligible: false })?.text,
    ).toContain("not accepted");
    expect(companion.consumePin(reply)?.text).not.toContain("739251");
    expect(companion.consumePin(reply)?.text).not.toContain("739251");
    const retry = await companion.run(
      { action: "status", taskId: first.id },
      context,
    );
    expect(entered).toBe("739251");
    expect(runs).toBe(2);
    expect(retry.status).toBe("waiting_for_input");
    expect(companion.consumePin(reply)?.text).toContain("not accepted");
    expect(
      companion.consumePin({
        ...reply,
        text: `!browser-pin ${first.id} ${challengeId} 111111`,
      })?.text,
    ).toContain("not accepted");
    expect(
      companion.consumePin({
        ...reply,
        id: "fresh-reply",
        messageId: "2",
        text: `!browser-pin ${first.id} ${challengeId} 111111`,
      })?.text,
    ).toContain("reply accepted");
    const next = await companion.run(
      { action: "status", taskId: first.id },
      context,
    );
    expect(entered).toBe("111111");
    expect(next.status).toBe("completed");
    expect(JSON.stringify(next)).not.toContain("739251");
    expect(
      (await companion.run({ action: "status", taskId: first.id }, context))
        .status,
    ).toBe("completed");
    expect(runs).toBe(3);
    runs = 0;
    challengeId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const waiting = await companion.run(
      {
        action: "start",
        url: "https://example.com/",
        goal: "private abandoned goal",
      },
      { ...context, operationId: "second" },
    );
    expect(waiting.status).toBe("waiting_for_input");
    revision++;
    expect(companion.session(waiting.id, "owner")).toBeUndefined();
    await vi.waitFor(
      () =>
        expect(
          companion.list().find((task) => task.id === waiting.id),
        ).toMatchObject({ status: "expired", goal: "", url: "" }),
      { timeout: 2000 },
    );
    expect(state).toBe("ended");
    expect(runs).toBe(1);
  } finally {
    await companion.close();
    const restored = new BrowserCompanion(options);
    expect(restored.list().every((task) => task.status !== "running")).toBe(
      true,
    );
    await restored.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("joins an aborted visual review before deleting transcripts or allowing a replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-settlement-"));
  const reviewing = Promise.withResolvers<void>();
  const result = Promise.withResolvers<string>();
  const deletion = vi.fn(async (_options: { threadId: string }) => {});
  const close = vi.fn(async () => {});
  const image = {
    mimeType: "image/jpeg" as const,
    data: new Uint8Array([1, 2, 3]),
  };
  const session: BrowserSession = {
    generation: "session",
    state: "live",
    epoch: 0,
    observe: async () => ({ text: "page", image }),
    tool: async () => ({ text: "frame", image }),
    frame: async () => undefined,
    pendingInput: () => undefined,
    enterPin: async () => {},
    close,
  };
  const event = {
    type: "message" as const,
    id: "event",
    messageId: "message",
    senderId: "U",
    direct: true,
    text: "Private goal",
    occurredAt: 1,
    address: { channel: "slack" as const, accountId: "T", conversationId: "D" },
  };
  let reviewSignal: AbortSignal | undefined;
  const context = {
    event,
    operationId: "first",
    signal: new AbortController().signal,
    valid: () => true,
    review: async (_report: string, _images: unknown, signal: AbortSignal) => {
      reviewSignal = signal;
      reviewing.resolve();
      return result.promise;
    },
  };
  const companion = new BrowserCompanion({
    directory,
    home: directory,
    tempDirectory: directory,
    codexHome: directory,
    owner: {
      id: "owner",
      identities: [{ channel: "slack", accountId: "T", senderId: "U" }],
    },
    navigationOrigins: ["https://example.com"],
    resourceOrigins: [],
    createSession: async () => session,
    deleteThread: deletion,
    runTurn: async (input) => {
      await input.onThread("thread-to-delete");
      await input.tool("observe", {});
      return {
        threadId: "thread-to-delete",
        report: "private report",
        waitingForInput: false,
      };
    },
  });
  try {
    const start = {
      action: "start" as const,
      url: "https://example.com/",
      goal: "private goal",
    };
    const first = companion.run(start, context);
    await reviewing.promise;
    const id = companion.list()[0]?.id;
    if (!id) throw new Error("Missing task");
    const cancel = companion.run({ action: "cancel", taskId: id }, context);
    expect(reviewSignal?.aborted).toBe(true);
    expect(companion.isSettled()).toBe(false);
    expect(deletion).not.toHaveBeenCalled();
    await expect(
      companion.run(start, { ...context, operationId: "replacement" }),
    ).rejects.toThrow("settle");
    result.resolve("Late review must not resurrect a cancelled task");
    expect((await first).status).toBe("cancelled");
    expect((await cancel).status).toBe("cancelled");
    expect(deletion).toHaveBeenCalledOnce();
    expect(deletion.mock.calls[0]?.[0]).toMatchObject({
      threadId: "thread-to-delete",
    });
    expect(JSON.stringify(companion.list())).not.toContain("Late review");
    expect(companion.list()[0]).toMatchObject({ goal: "", url: "" });
    expect(companion.isSettled()).toBe(true);
  } finally {
    result.resolve("cleanup");
    await companion.close();
    await rm(directory, { recursive: true, force: true });
  }
});
