import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { HistoryImports } from "../imports/index.js";
import { EvidenceStore } from "../memory/store.js";
import { createHttpApp } from "./app.js";
import { createImportRoutes } from "./imports.js";
import { createMemoryRoutes } from "./memory.js";

it("requires owner auth, exact import review and a fresh page confirmation; forget tombstones before cleanup", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const audience = JSON.stringify(["private", "owner"]);
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
    owner: { id: "owner", identities: [] },
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
  const confirmation = {
    confirmed: true,
    digest: mail.digest,
    expectedPages: 0,
  };
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
});
