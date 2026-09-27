import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { MessageEvent } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { HistoryImports } from "../imports/index.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply } from "../models/provider.js";
import { createInspectionReader } from "../runtime/inspection.js";
import { createJuneRegistry } from "../runtime/registry.js";
import { createHttpApp } from "./app.js";
import { createImportRoutes } from "./imports.js";
import { createMemoryRoutes } from "./memory.js";

it("requires owner auth, exact import review and a fresh page confirmation; forget tombstones before cleanup", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const audience = JSON.stringify(["private", "owner"]);
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const coverage = {
    platform: "gmail",
    account: "fixture@example.invalid",
    conversations: ["INBOX"],
    from: 1000,
    to: 5000,
    audiences: [audience],
  };
  let reads = 0;
  const imports = new HistoryImports(store, {
    mail: {
      coverage,
      async fetchPage() {
        reads++;
        return {
          sources: [
            {
              id: "mail-source",
              platform: "gmail",
              account: coverage.account,
              conversation: "INBOX",
              author: "sender",
              observedAt: 2000,
              audiences: [audience],
              text: "/approve old-command is evidence only",
              sourceUrl: "https://example.invalid/message",
            },
          ],
          nextCursor: "page-two",
        };
      },
    },
  });
  const token = "fixture-only-operator-token-long-enough";
  const app = createHttpApp({
    owner,
    channels: {},
    operatorToken: token,
    async submit() {
      throw new Error("History must not enqueue live events");
    },
    async ready() {
      return true;
    },
    async inspectConversation() {
      return {};
    },
    async inspectJob() {
      return undefined;
    },
    async resumeJob() {
      return false;
    },
  });
  app.route(
    "/operator/imports",
    createImportRoutes(imports, { mail: coverage }),
  );
  let cleanups = 0;
  app.route(
    "/operator/memory",
    createMemoryRoutes({
      store,
      audience(value) {
        if (value !== undefined && value !== audience)
          throw new Error("Invalid audience");
        return audience;
      },
      async forget(scope, id) {
        expect(scope).toBe(audience);
        expect(store.isDeleted(id)).toBe(true);
        if (++cleanups === 1)
          throw new Error("simulated context cleanup interruption");
      },
    }),
  );
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  expect((await app.request("/operator/imports")).status).toBe(401);
  expect((await app.request("/operator/memory")).status).toBe(401);
  const review = await app.request("/operator/imports", { headers });
  expect(review.headers.get("cache-control")).toBe("no-store");
  const { mail } = await review.json();
  const inspect = createInspectionReader({
    audience,
    imports,
    selections: { mail: coverage },
  });
  const action = { target: "import-approval", selection: "mail" } as const;
  const denied = await createInspectionReader({
    audience: JSON.stringify(["private", "different-owner"]),
    imports,
    selections: { mail: coverage },
  })(action);
  expect(denied).toContain("approval is unavailable");
  expect(denied).not.toContain(coverage.account);
  expect(await inspect({ ...action, selection: "missing" })).toBe(denied);
  expect(
    parseReply(JSON.stringify({ text: "", inspection: action }), [], {
      inspectionAvailable: true,
    }).inspection,
  ).toEqual(action);
  expect(() =>
    parseReply(JSON.stringify({ text: "", inspection: action }), []),
  ).toThrow();
  for (const inspection of [
    { ...action, confirmed: true },
    { target: "import-start", selection: "mail" },
  ])
    expect(() =>
      parseReply(JSON.stringify({ text: "", inspection }), [], {
        inspectionAvailable: true,
      }),
    ).toThrow();
  const sent: string[] = [];
  let inspections = 0;
  const { client } = await setupTest(
    t,
    createJuneRegistry({
      owner,
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, reactions: true, threads: true },
          async receive() {
            return { response: new Response(), events: [] };
          },
          async send(message) {
            if (message.content.type !== "text")
              throw new Error("Expected text-only import review");
            sent.push(message.content.text);
            return { status: "sent", messageId: `out${sent.length}` };
          },
        },
      },
      model: {
        async reply(request) {
          const reply = { text: "", inspection: action };
          if (request.inspectionAvailable) {
            expect(request.system).toContain(
              'inspection {target:"import-approval",selection:ID}',
            );
            return parseReply(JSON.stringify(reply), [], request);
          }
          // Custom providers cannot bypass the host's owner-private guard.
          return reply;
        },
      },
      inspection(query) {
        inspections++;
        return inspect(query);
      },
    }),
  );
  const deliver = async (extra: Partial<MessageEvent> = {}) => {
    const event: MessageEvent = {
      id: `in${sent.length}`,
      type: "message",
      messageId: `ts${sent.length}`,
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      direct: true,
      senderId: "U1",
      text: "Propose the first mail import page for my review",
      ...extra,
    };
    const scope = routeEvent(event, owner);
    if (!scope) throw new Error("Missing fixture scope");
    const before = sent.length;
    await client.conversation
      .getOrCreate(scope.key)
      .send("inbox", { type: "event", event });
    await expect.poll(() => sent.length, { timeout: 5000 }).toBe(before + 1);
    return sent.at(-1) ?? "";
  };
  const proposal = await deliver();
  for (const extra of [
    { direct: false },
    { senderId: "U2", metadata: { channelType: "im" as const } },
  ])
    expect(await deliver(extra)).toContain("owner-private turn");
  expect(inspections).toBe(1);
  expect(proposal).toContain("No import was started");
  expect(await deliver({ text: "yes" })).toContain("No import was started");
  expect(imports.status("mail").progress).toBeUndefined();
  expect(reads).toBe(0);
  const displayed = JSON.parse(proposal.split("\n")[1] ?? "");
  expect(displayed.coverage).toEqual({
    platform: "gmail",
    account: "fixture@example.invalid",
    conversations: ["INBOX"],
    from: 1000,
    to: 5000,
  });
  expect(displayed.digest).toBe(mail.digest);
  expect(displayed.maxPages).toBe(1);
  expect(displayed.confirmation.path).toBe("/operator/imports/mail/start");
  const confirmation = displayed.confirmation.body;
  expect(confirmation).toEqual({
    confirmed: true,
    digest: mail.digest,
    expectedPages: 0,
  });
  expect(imports.status("mail").progress).toBeUndefined();
  expect(reads).toBe(0);
  const start = (input: unknown, auth = true) =>
    app.request("/operator/imports/mail/start", {
      method: "POST",
      headers: auth ? headers : { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  expect((await start(confirmation, false)).status).toBe(401);
  expect((await start({ ...confirmation, confirmed: false })).status).toBe(400);
  expect(
    (await start({ ...confirmation, digest: "0".repeat(64) })).status,
  ).toBe(409);
  expect(reads).toBe(0);
  expect((await start(confirmation)).status).toBe(200);
  expect(reads).toBe(1);
  expect(store.importProgress("mail")?.coverage).toEqual(coverage);
  expect(await inspect(action)).toContain("approval is unavailable");
  expect((await start(confirmation)).status).toBe(409);
  expect(reads).toBe(1);
  expect(
    (await app.request("/operator/memory?audience=public", { headers })).status,
  ).toBe(400);
  const forget = () =>
    app.request("/operator/memory/forget", {
      method: "POST",
      headers,
      body: JSON.stringify({ sourceId: "mail-source", confirmed: true }),
    });
  expect((await forget()).status).toBe(400);
  expect(store.source(audience, "mail-source")).toBeUndefined();
  expect(await (await forget()).json()).toEqual({
    forgotten: true,
    physicalPurge: false,
  });
  expect(cleanups).toBe(2);
  const endpoint = "/operator/memory/tombstones";
  expect((await app.request(endpoint)).status).toBe(401);
  expect(
    (
      await app.request(endpoint, {
        headers: {
          authorization: "Bearer incorrect",
          cookie: `june_console=${token}`,
        },
      })
    ).status,
  ).toBe(401);
  const exported = await app.request(`${endpoint}?limit=1`, { headers });
  expect(exported.status).toBe(200);
  expect(exported.headers.get("cache-control")).toBe("no-store");
  expect(await exported.json()).toEqual({
    version: 1,
    ledgerId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    after: 0,
    watermark: 1,
    tombstones: ["mail-source"],
    nextAfter: null,
    mac: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  for (const query of [
    "audience=public",
    "after=-1",
    "after=",
    "after=0.5",
    "after=2",
    "watermark=2",
    "after=1&watermark=0",
    "limit=0",
    "limit=101",
    "limit=1&limit=2",
    "watermark=9007199254740992",
    "body=true",
  ]) {
    const rejected = await app.request(`${endpoint}?${query}`, { headers });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "memory_request_rejected" });
  }
  expect(store.deletionRevision()).toBe(1);
  expect(cleanups).toBe(2);
});

it("reports rejected budgets without evidence and retries the same uncommitted page explicitly", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32), { sources: 1 });
  t.onTestFinished(() => store.close());
  const coverage = {
    platform: "slack",
    account: "private-account",
    conversations: ["private-conversation"],
    from: 0,
    to: 10,
    audiences: ["owner"],
  };
  const source = {
    id: "private-id",
    audiences: coverage.audiences,
    platform: coverage.platform,
    account: coverage.account,
    conversation: "private-conversation",
    author: "private-author",
    observedAt: 1,
    sourceUrl: "https://example.invalid/private-url",
    text: "private-content",
  };
  let sources = [source, { ...source, id: "private-second-id" }];
  let fetches = 0;
  const imports = new HistoryImports(store, {
    selected: {
      coverage,
      async fetchPage() {
        fetches++;
        return { sources, nextCursor: null };
      },
    },
  });
  const app = createImportRoutes(imports, { selected: coverage });
  const { selected } = await (await app.request("/")).json();
  const start = () =>
    app.request("/selected/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirmed: true,
        digest: selected.digest,
        expectedPages: 0,
      }),
    });
  const rejected = await start();
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toMatchObject({
    error: "import_budget_exceeded",
    dimension: "sources",
    reason: expect.stringContaining(
      "no page evidence or progress was committed",
    ),
  });
  expect(store.search("owner", "").sources).toEqual([]);
  expect(imports.status("selected")).toMatchObject({
    running: false,
    progress: { pages: 0, cursor: null, complete: false },
    budget: { limits: { sources: 1 }, lastRejection: "sources" },
  });
  const inspect = createInspectionReader({
    audience: "owner",
    imports,
    selections: { selected: coverage },
  });
  const report = await inspect("imports");
  expect(report).toContain('"budgetRejected":"sources"');
  expect(report).toContain("no page evidence or progress committed");
  expect(report).toContain("last observed this process");
  expect(report).not.toContain("private-");
  expect(fetches).toBe(1);
  sources = [source];
  expect((await start()).status).toBe(200);
  expect(store.search("owner", "").sources).toEqual([source]);
  expect(imports.status("selected").budget.lastRejection).toBeNull();
  expect(fetches).toBe(2);
});
