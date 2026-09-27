import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { MessageEvent } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import {
  createGmailHistoryFetcher,
  HistoryImports,
  importCoverageDigest,
} from "../imports/index.js";
import { EvidenceStore, type ImportCoverage } from "../memory/store.js";
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
  const cursors: (string | null)[] = [];
  const imports = new HistoryImports(store, {
    mail: {
      coverage,
      credentialAccount: "FIXTURE_MAIL_TOKEN",
      async fetchPage({ cursor }) {
        reads++;
        cursors.push(cursor);
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
          nextCursor: cursor === null ? "page-two" : null,
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
  const nextProposal = await deliver({ text: "Propose the next mail page" });
  const nextReview = JSON.parse(nextProposal.split("\n")[1] ?? "");
  expect(nextReview).toEqual({
    ...displayed,
    expectedPages: 1,
    confirmation: {
      ...displayed.confirmation,
      body: { confirmed: true, digest: mail.digest, expectedPages: 1 },
    },
  });
  expect(await deliver({ text: "yes" })).toContain("No import was started");
  expect(reads).toBe(1);
  expect((await start(confirmation)).status).toBe(409);
  const nextConfirmation = nextReview.confirmation.body;
  expect((await start(nextConfirmation, false)).status).toBe(401);
  expect(
    (await start({ ...nextConfirmation, digest: "0".repeat(64) })).status,
  ).toBe(409);
  expect(reads).toBe(1);
  expect((await start(nextConfirmation)).status).toBe(200);
  expect(cursors).toEqual([null, "page-two"]);
  expect(store.importProgress("mail")).toMatchObject({
    coverage,
    pages: 2,
    complete: true,
    cursor: null,
  });
  expect(await deliver({ text: "Propose another mail page" })).toContain(
    "approval is unavailable",
  );
  expect((await start(nextConfirmation)).status).toBe(409);
  expect(reads).toBe(2);
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
      credentialAccount: "FIXTURE_SLACK_ACCOUNT",
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

it.each([
  { from: 0 },
  { to: 6000 },
  { conversations: ["STARRED"] },
  { audiences: ["other-owner"] },
  { account: "other@example.invalid" },
  { credentialAccount: "FIXTURE_OTHER_ACCOUNT" },
  {}, // Same handle can be rebound on host restart; old consent must expire.
])("invalidates pending start when binding changes: %j", async (changed) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  const coverage: ImportCoverage = {
    platform: "gmail",
    account: "fixture@example.invalid",
    conversations: ["INBOX"],
    from: 1000,
    to: 5000,
    audiences: ["owner"],
  };
  let credentialReads = 0;
  let providerReads = 0;
  const configured = (selected: ImportCoverage, credentialAccount: string) => {
    // The user-visible name stays equal; it must not substitute for identity.
    const selections = {
      Personal: {
        coverage: selected,
        credentialAccount,
        fetchPage: createGmailHistoryFetcher({
          coverage: selected,
          async accessToken() {
            credentialReads++;
            return "fixture-only-token";
          },
          async transport() {
            providerReads++;
            return Response.json({ messages: [] });
          },
        }),
      },
    };
    const imports = new HistoryImports(store, selections);
    // Simulate stale parallel route configuration. Only the service binding counts.
    const app = createImportRoutes(imports, { Personal: coverage });
    const inspect = createInspectionReader({
      audience: selected.audiences[0] as string,
      imports,
      selections: { Personal: selected },
    });
    return { imports, app, selections, inspect };
  };
  try {
    const original = configured(coverage, "FIXTURE_ACCOUNT");
    const review = (await (await original.app.request("/")).json()).Personal;
    const action = {
      target: "import-approval",
      selection: "Personal",
    } as const;
    const proposal = JSON.parse(
      (await original.inspect(action)).split("\n")[1] ?? "",
    );
    expect(proposal.digest).toBe(review.digest);
    const { credentialAccount, ...coverageChange } = changed;
    const currentCoverage = { ...coverage, ...coverageChange };
    if (Object.keys(changed).length) {
      // Prove exact identity/coverage matters independently of restart expiry.
      expect(
        importCoverageDigest(
          "Personal",
          currentCoverage,
          credentialAccount ?? "FIXTURE_ACCOUNT",
          "same-fixture-host",
        ),
      ).not.toBe(
        importCoverageDigest(
          "Personal",
          coverage,
          "FIXTURE_ACCOUNT",
          "same-fixture-host",
        ),
      );
    }
    const current = configured(
      currentCoverage,
      credentialAccount ?? "FIXTURE_ACCOUNT",
    );
    const currentReview = (await (await current.app.request("/")).json())
      .Personal;
    expect(currentReview.coverage).toEqual(currentCoverage);
    expect(currentReview.digest).not.toBe(review.digest);
    expect(JSON.stringify(currentReview)).not.toContain("FIXTURE_");
    expect(JSON.stringify(currentReview)).not.toContain("fixture-only-token");
    const freshProposal = await current.inspect(action);
    expect(freshProposal).not.toContain("FIXTURE_");
    expect(freshProposal).not.toContain("fixture-only-token");
    const fresh = JSON.parse(freshProposal.split("\n")[1] ?? "");
    expect(fresh.digest).toBe(currentReview.digest);
    await expect(
      createInspectionReader({
        audience: "owner",
        imports: current.imports,
        selections: {
          Personal: { ...coverage, account: "stale-config@example.invalid" },
        },
      })(action),
    ).rejects.toThrow("Import coverage changed");
    // Neither constructor inputs nor returned metadata can retarget the binding.
    current.selections.Personal.credentialAccount = "MUTATED_HANDLE";
    currentCoverage.conversations = ["MUTATED_LABEL"];
    currentReview.coverage.account = "mutated@example.invalid";
    expect(current.imports.review("Personal").digest).toBe(
      currentReview.digest,
    );
    const confirm = (body: unknown) =>
      current.app.request("/Personal/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await confirm(proposal.confirmation.body)).status).toBe(409);
    expect(store.importProgress("Personal")).toBeUndefined();
    expect(credentialReads).toBe(0);
    expect(providerReads).toBe(0);
    expect((await confirm(fresh.confirmation.body)).status).toBe(200);
    expect(credentialReads).toBe(1);
    expect(providerReads).toBe(1);
    expect((await confirm(fresh.confirmation.body)).status).toBe(409);
    expect(providerReads).toBe(1);
  } finally {
    store.close();
  }
});
