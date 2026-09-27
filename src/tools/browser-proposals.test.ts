import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, test, vi } from "vitest";
import { CapabilityBroker, type ToolAction } from "./broker.js";
import { BrowserAdapter, type BrowserOperation } from "./browser.js";
import {
  browserMutationSchema,
  createBrowserProposal,
} from "./browser-proposals.js";
import { createCapabilityRoutes } from "./routes.js";

test("exact human approval binds one browser mutation; fill grants cannot submit POSTs and replay cannot repeat a write", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "browser-proposal-"));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key"),
      "-out",
      join(directory, "cert"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  const writes: string[] = [];
  let reads = 0;
  let autoSubmit = false;
  const server = createServer(
    {
      key: readFileSync(join(directory, "key")),
      cert: readFileSync(join(directory, "cert")),
    },
    (request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          writes.push(body);
          response.end('<p id="ok">sent</p>');
        });
      } else {
        reads++;
        response.end(
          `<form method="POST" action="/write"><input name="note" value="before" oninput="${autoSubmit ? "this.form.requestSubmit()" : "document.querySelector('#ok').textContent=this.value"}"><button type="submit">send</button></form><p id="ok">ready</p>`,
        );
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture port");
  const origin = `https://127.0.0.1:${address.port}`;
  // Only this disposable fixture accepts its generated self-signed certificate.
  const launch = chromium.launch.bind(chromium);
  vi.spyOn(chromium, "launch").mockImplementation(async (options) => {
    const browser = await launch(options);
    const newContext = browser.newContext.bind(browser);
    vi.spyOn(browser, "newContext").mockImplementation((options) =>
      newContext({ ...options, ignoreHTTPSErrors: true }),
    );
    return browser;
  });
  t.onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const read: BrowserOperation = {
    name: "read-form",
    account: "fixture-account",
    item: "anonymous",
    origin,
    url: `${origin}/form`,
    requests: [{ url: `${origin}/form`, method: "GET" }],
    success: { selector: "#ok", text: "ready" },
  };
  const fill: BrowserOperation = {
    ...read,
    name: "fill-note",
    steps: [{ kind: "fill", selector: "[name=note]", value: "approved note" }],
    success: { selector: "#ok", text: "approved note" },
  };
  const click: BrowserOperation = {
    ...read,
    name: "send-note",
    steps: [{ kind: "click", selector: "button" }],
    requests: [...read.requests, { url: `${origin}/write`, method: "POST" }],
    success: { selector: "#ok", text: "sent" },
  };
  const markup: BrowserOperation = {
    ...fill,
    name: "markup",
    steps: [
      {
        kind: "fill",
        selector: "input",
        value: "<@U123> & `*_~ https://example.com/path www.example.com",
      },
    ],
  };
  const adapter = new BrowserAdapter({
    operations: [read, fill, click, markup],
    requireRecipeDigest: true,
    timeoutMs: 5000,
  });
  t.onTestFinished(() => adapter.close());
  let credentials = 0;
  const options = {
    owner: "owner",
    tools: { browser: adapter },
    resolveCredential: async () => {
      credentials++;
      return null;
    },
  };
  let broker = new CapabilityBroker(join(directory, "broker.sqlite"), options);
  t.onTestFinished(() => broker.close());
  const propose = createBrowserProposal({
    operations: [fill, click],
    browser: adapter,
    broker,
  });
  expect(propose(null)).toContain('"fill-note","send-note"');
  expect(() => propose(read.name)).toThrow();
  const report = propose(click.name);
  const proposal = JSON.parse(report.slice(report.indexOf("\n") + 1)) as {
    action: ToolAction;
    recipe: BrowserOperation;
  };
  expect(proposal.action).toEqual(adapter.action(click.name));
  expect(proposal.recipe.steps).toEqual(click.steps);
  expect(report.length).toBeLessThan(3500);
  const markupReport = createBrowserProposal({
    operations: [markup],
    browser: adapter,
    broker,
  })(markup.name);
  const encoded = markupReport.slice(markupReport.indexOf("\n") + 1);
  expect(encoded).not.toMatch(/[<>&`*_~@/.]/u);
  expect(JSON.parse(encoded).recipe.steps).toEqual(markup.steps);
  expect(() =>
    createBrowserProposal({
      operations: [
        {
          ...fill,
          steps: [
            {
              kind: "fill",
              selector: "[name=note]",
              value: "different review",
            },
          ],
        },
      ],
      browser: adapter,
      broker,
    }),
  ).toThrow("browser_proposal_recipe_mismatch");
  expect(reads).toBe(0);
  expect(credentials).toBe(0);
  expect(broker.auditEvents("owner")).toEqual([]);

  const readAction = adapter.action(read.name);
  const readGrant = broker.grant("owner", {
    audience: "owner",
    action: readAction,
    expiresAt: Date.now() + 60_000,
  });
  const fillAction = adapter.action(fill.name);
  for (const action of [fillAction, proposal.action])
    await expect(broker.execute("owner", readGrant, action)).rejects.toThrow();
  const grantFill = broker.grant("owner", {
    audience: "owner",
    action: fillAction,
    expiresAt: Date.now() + 60_000,
  });
  expect((await broker.execute("owner", grantFill, fillAction)).status).toBe(
    "succeeded",
  );
  expect(writes).toEqual([]);

  const routes = createCapabilityRoutes({
    broker,
    owner: "owner",
    operatorToken: "fixture-token".repeat(3),
  });
  const grantInput = {
    audience: "owner",
    action: proposal.action,
    expiresAt: Date.now() + 60_000,
  };
  expect(
    (
      await routes.request("/grants", {
        method: "POST",
        body: JSON.stringify(grantInput),
      })
    ).status,
  ).toBe(401);
  const approved = await routes.request("/grants", {
    method: "POST",
    headers: {
      authorization: `Bearer ${"fixture-token".repeat(3)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(grantInput),
  });
  expect(approved.status).toBe(201);
  const { grantId } = (await approved.json()) as { grantId: string };
  for (const action of [
    { ...proposal.action, account: "other" },
    { ...proposal.action, item: "other" },
    { ...proposal.action, origin: "https://other.example" },
    {
      ...proposal.action,
      arguments: { operation: click.name, recipeDigest: "0".repeat(64) },
    },
  ])
    await expect(broker.execute("owner", grantId, action)).rejects.toThrow();
  expect(credentials).toBe(1);
  expect(writes).toEqual([]);
  const receipt = await broker.execute("owner", grantId, proposal.action);
  expect(receipt.status).toBe("succeeded");
  expect(writes).toEqual(["note=before"]);
  broker.close();
  broker = new CapabilityBroker(join(directory, "broker.sqlite"), options);
  expect(await broker.execute("owner", grantId, proposal.action)).toEqual(
    receipt,
  );
  expect(writes).toEqual(["note=before"]);
  expect(credentials).toBe(2);

  // A page attempting to submit on input cannot spend the fill grant on a POST.
  autoSubmit = true;
  const autoSubmitGrant = broker.grant("owner", {
    audience: "owner",
    action: fillAction,
    expiresAt: Date.now() + 60_000,
  });
  expect(
    (await broker.execute("owner", autoSubmitGrant, fillAction)).status,
  ).toBe("unknown");
  expect(writes).toEqual(["note=before"]);

  for (const invalid of [
    read,
    { ...fill, requests: click.requests },
    { ...fill, steps: [...(fill.steps ?? []), ...(click.steps ?? [])] },
    {
      ...click,
      requests: [
        ...click.requests,
        { url: `${origin}/second`, method: "POST" },
      ],
    },
    {
      ...fill,
      steps: [{ kind: "fill", selector: "input", value: "x".repeat(1400) }],
    },
  ])
    expect(browserMutationSchema.safeParse(invalid).success).toBe(false);
});

test("credential proposals expose references and credential kind without reading values or granting authority", async (t) => {
  const bearer: BrowserOperation = {
    name: "private-status",
    account: "fixture",
    item: "status",
    origin: "https://fixture.invalid",
    url: "https://fixture.invalid/status",
    requests: [
      {
        url: "https://fixture.invalid/status",
        method: "GET",
        credential: true,
      },
    ],
    success: { selector: "#ok", text: "ready" },
  };
  const login: BrowserOperation = {
    ...bearer,
    name: "private-login",
    item: "login",
    requests: [{ url: bearer.url, method: "GET" }],
    steps: [
      {
        kind: "login",
        usernameSelector: "#username",
        passwordSelector: "#password",
      },
    ],
  };
  const browser = new BrowserAdapter({ operations: [bearer, login] });
  let reads = 0;
  const broker = new CapabilityBroker(":memory:", {
    owner: "owner",
    tools: { browser },
    resolveCredential: async () => {
      reads++;
      return { bearerToken: "synthetic-value-never-for-review" };
    },
  });
  t.onTestFinished(async () => {
    await browser.close();
    broker.close();
  });
  const options = {
    operations: [],
    credentialOperations: [bearer, login],
    browser,
    broker,
  };
  const propose = createBrowserProposal(options);
  expect(propose(null)).toContain('"private-status","private-login"');
  for (const [recipe, kind] of [
    [bearer, "bearer"],
    [login, "login"],
  ] as const) {
    const report = propose(recipe.name);
    const encoded = report.slice(report.indexOf("\n") + 1);
    const review = JSON.parse(encoded);
    expect(review.credential).toEqual({ kind, values: "not_exposed" });
    expect(review.recipe.url).toBe("https://fixture.invalid/status");
    expect(review.recipe.steps).toEqual(recipe.steps ?? []);
    expect(review.action.arguments.operation).toBe(recipe.name);
    expect(encoded).not.toMatch(/[<>&`*_~@/.]/u);
    expect(report).not.toContain("synthetic-value-never-for-review");
    expect(report.length).toBeLessThan(3500);
  }
  expect(() => propose("unknown")).toThrow("browser_proposal_unavailable");
  expect(() =>
    createBrowserProposal({
      ...options,
      credentialOperations: [{ ...bearer, outputSelector: "#private" }],
    }),
  ).toThrow();
  expect(reads).toBe(0);
  expect(broker.auditEvents("owner")).toEqual([]);
});
