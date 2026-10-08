import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { expect, type TestContext, test, vi } from "vitest";
import { CapabilityBroker, type ToolAction } from "./broker.js";
import { BrowserAdapter, type BrowserOperation } from "./browser.js";
import {
  browserMutationSchema,
  createBrowserProposal,
} from "./browser-proposals.js";

const mutation: BrowserOperation = {
  name: "send-note",
  account: "fixture-account",
  item: "anonymous",
  origin: "https://fixture.invalid",
  url: "https://fixture.invalid/form",
  requests: [
    { url: "https://fixture.invalid/form", method: "GET" },
    { url: "https://fixture.invalid/write", method: "POST" },
  ],
  steps: [{ kind: "click", selector: "button" }],
  success: { selector: "#ok", text: "sent" },
};

function executionFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "browser-execution-"));
  const browser = new BrowserAdapter({ operations: [mutation] });
  const actions: ToolAction[] = [];
  let credentials = 0;
  const options = {
    owner: "owner",
    tools: {
      browser: {
        execute: async (action: ToolAction) => {
          actions.push(action);
          return { untrustedText: "private external result".repeat(1000) };
        },
      },
    },
    resolveCredential: async () => {
      credentials++;
      return null;
    },
  };
  let broker = new CapabilityBroker(join(directory, "broker.sqlite"), options);
  const service = () =>
    createBrowserProposal({
      owner: "owner",
      path: join(directory, "operations.sqlite"),
      operations: [mutation],
      browser,
      broker,
    });
  t.onTestFinished(async () => {
    await browser.close();
    broker.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    actions,
    options,
    browser,
    service,
    broker: () => broker,
    credentials: () => credentials,
    reopen: () => {
      broker.close();
      broker = new CapabilityBroker(join(directory, "broker.sqlite"), options);
    },
  };
}

function receiptReport(report: string) {
  expect(report.length).toBeLessThanOrEqual(3500);
  const encoded = report.slice(report.indexOf("\n") + 1);
  expect(encoded).not.toMatch(/[<>&`*_~@/.]/u);
  return JSON.parse(encoded);
}

test("a host operation ID executes once across concurrent calls, restart and grant expiry", async (t) => {
  const f = executionFixture(t);
  const execute = f.service();
  const [first, concurrent] = await Promise.all([
    execute(mutation.name, "host-operation", () => true),
    execute(mutation.name, "host-operation", () => true),
  ]);
  const receipt = receiptReport(first);
  expect(receipt.receipt).toMatchObject({ status: "succeeded" });
  expect(receiptReport(concurrent).grantId).toBe(receipt.grantId);
  expect(first).not.toContain("private external result");
  expect(f.actions).toEqual([f.browser.action(mutation.name)]);
  expect(f.credentials()).toBe(1);
  f.reopen();
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_000);
  t.onTestFinished(() => now.mockRestore());
  expect(
    receiptReport(
      await f.service()(mutation.name, "host-operation", () => true),
    ),
  ).toEqual(receipt);
  expect(f.actions).toHaveLength(1);
  expect(
    f
      .broker()
      .auditEvents("owner")
      .map(({ event }) => event),
  ).toEqual([
    "granted",
    "execution_claimed",
    "adapter_admitted",
    "adapter_succeeded",
  ]);
});

test("discovery and missing or disabled recipes create no grants or external effects", async (t) => {
  const f = executionFixture(t);
  const execute = f.service();
  expect(await execute(null, "discovery", () => true)).toContain('"send-note"');
  await expect(execute("missing", "missing", () => true)).rejects.toThrow(
    "browser_proposal_unavailable",
  );
  await f.browser.close();
  await expect(
    execute(mutation.name, "disabled", () => true),
  ).rejects.toThrow();
  expect(f.actions).toEqual([]);
  expect(f.credentials()).toBe(0);
  expect(f.broker().auditEvents("owner")).toEqual([]);
});

test("a stale task does not grant, and loss of the current guard during credential lookup cannot dispatch", async (t) => {
  const f = executionFixture(t);
  const execute = f.service();
  expect(await execute(mutation.name, "stale", () => false)).toContain(
    "Nothing ran",
  );
  expect(f.broker().auditEvents("owner")).toEqual([]);
  const lookup = Promise.withResolvers<null>();
  const started = Promise.withResolvers<void>();
  f.options.resolveCredential = async () => {
    started.resolve();
    return lookup.promise;
  };
  f.reopen();
  let current = true;
  const pending = f.service()(mutation.name, "cancelled", () => current);
  await started.promise;
  current = false;
  lookup.resolve(null);
  expect(receiptReport(await pending).receipt.status).toBe("unknown");
  expect(f.actions).toEqual([]);
  expect(
    receiptReport(await f.service()(mutation.name, "cancelled", () => true))
      .receipt.status,
  ).toBe("unknown");
  expect(f.actions).toEqual([]);
});

test("an uncertain effect stays unknown on replay without retry or exposing adapter errors", async (t) => {
  const f = executionFixture(t);
  f.options.tools.browser.execute = async (action) => {
    f.actions.push(action);
    throw new Error("synthetic-private-credential-and-page-body");
  };
  f.reopen();
  const first = await f.service()(mutation.name, "uncertain", () => true);
  const receipt = receiptReport(first);
  expect(receipt.receipt).toMatchObject({ status: "unknown" });
  expect(first).toMatch(/do not retry/i);
  expect(first).toMatch(/stoppage/i);
  expect(first).not.toContain("synthetic-private-credential-and-page-body");
  f.reopen();
  expect(
    receiptReport(await f.service()(mutation.name, "uncertain", () => true)),
  ).toEqual(receipt);
  expect(f.actions).toHaveLength(1);
  expect(f.credentials()).toBe(1);
});

test("an interrupted grant with no receipt is never executed on replay", async (t) => {
  const f = executionFixture(t);
  const interrupted = vi
    .spyOn(f.broker(), "execute")
    .mockRejectedValueOnce(new Error("interrupted before broker dispatch"));
  const first = await f.service()(mutation.name, "interrupted", () => true);
  const report = receiptReport(first);
  expect(report.receipt).toBeNull();
  expect(f.broker().audit("owner", report.grantId)).toBeUndefined();
  interrupted.mockRestore();
  f.reopen();
  expect(
    receiptReport(await f.service()(mutation.name, "interrupted", () => true)),
  ).toEqual(report);
  expect(f.actions).toEqual([]);
  expect(f.credentials()).toBe(0);
});

test("cancellation during browser launch waits for cleanup and never reaches the page", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "browser-cancel-"));
  const browser = new BrowserAdapter({ operations: [mutation] });
  const broker = new CapabilityBroker(":memory:", {
    owner: "owner",
    tools: { browser },
    resolveCredential: async () => null,
  });
  const launching = Promise.withResolvers<void>();
  const launched = Promise.withResolvers<Browser>();
  const closed = Promise.withResolvers<void>();
  let pageOpened = false;
  const launch = vi.spyOn(chromium, "launch").mockImplementation(() => {
    launching.resolve();
    return launched.promise;
  });
  t.onTestFinished(async () => {
    launch.mockRestore();
    await browser.close();
    broker.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const execute = createBrowserProposal({
    owner: "owner",
    path: join(directory, "operations.sqlite"),
    operations: [mutation],
    browser,
    broker,
  });
  const controller = new AbortController();
  let settled = false;
  const pending = execute(
    mutation.name,
    "cancel-launch",
    () => true,
    controller.signal,
  ).then((report) => {
    settled = true;
    return report;
  });
  await launching.promise;
  controller.abort();
  launched.resolve({
    newContext: async () => {
      pageOpened = true;
      throw new Error("cancelled browser must not create a page");
    },
    close: () => closed.promise,
  } as unknown as Browser);
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  closed.resolve();
  const report = receiptReport(await pending);
  expect(report.receipt.status).toBe("unknown");
  expect(pageOpened).toBe(false);
  expect(
    receiptReport(await execute(mutation.name, "cancel-launch", () => true)),
  ).toEqual(report);
  expect(
    broker.auditEvents("owner").some(({ event }) => event === "revoked"),
  ).toBe(true);
});

test("exact selections execute browser mutations; fill cannot submit POSTs and replay cannot repeat a write", async (t) => {
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
    success: {
      selector: "#ok",
      text: "<@U123> & `*_~ https://example.com/path www.example.com",
    },
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
  const proposalOptions = {
    owner: "owner",
    path: join(directory, "operations.sqlite"),
    operations: [fill, click, markup],
    browser: adapter,
  };
  let execute = createBrowserProposal({ ...proposalOptions, broker });
  expect(await execute(null, "catalog", () => true)).toContain(
    '"fill-note","send-note","markup"',
  );
  await expect(execute(read.name, "read", () => true)).rejects.toThrow();
  expect(() =>
    createBrowserProposal({
      ...proposalOptions,
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
  const clickAction = adapter.action(click.name);
  for (const action of [fillAction, clickAction])
    await expect(broker.execute("owner", readGrant, action)).rejects.toThrow();
  const fillReceipt = receiptReport(
    await execute(fill.name, "fill", () => true),
  );
  expect(fillReceipt.receipt.status).toBe("succeeded");
  expect(credentials).toBe(1);
  expect(writes).toEqual([]);

  const receipt = receiptReport(await execute(click.name, "click", () => true));
  expect(receipt.receipt.status).toBe("succeeded");
  expect(writes).toEqual(["note=before"]);
  const { grantId } = receipt;
  for (const action of [
    { ...clickAction, account: "other" },
    { ...clickAction, item: "other" },
    { ...clickAction, origin: "https://other.example" },
    {
      ...clickAction,
      arguments: { operation: click.name, recipeDigest: "0".repeat(64) },
    },
  ])
    await expect(broker.execute("owner", grantId, action)).rejects.toThrow();
  await expect(execute(fill.name, "click", () => true)).rejects.toThrow(
    "browser_proposal_operation_mismatch",
  );
  broker.close();
  broker = new CapabilityBroker(join(directory, "broker.sqlite"), options);
  execute = createBrowserProposal({ ...proposalOptions, broker });
  expect(receiptReport(await execute(click.name, "click", () => true))).toEqual(
    receipt,
  );
  expect(writes).toEqual(["note=before"]);
  expect(credentials).toBe(2);
  expect(broker.audit("owner", readGrant)).toBeUndefined();
  const markupReport = await execute(markup.name, "markup", () => true);
  expect(receiptReport(markupReport).receipt.status).toBe("succeeded");
  expect(markupReport).not.toContain("U123");

  // A page attempting to submit on input cannot spend the fill grant on a POST.
  autoSubmit = true;
  const uncertain = receiptReport(
    await execute(fill.name, "autosubmit", () => true),
  );
  expect(uncertain.receipt.status).toBe("unknown");
  expect(
    receiptReport(await execute(fill.name, "autosubmit", () => true)),
  ).toEqual(uncertain);
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

test("credential selections resolve only their configured scopes and return no credential values or result bodies", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "browser-credentials-"));
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
  const scopes: unknown[] = [];
  const received: unknown[] = [];
  const broker = new CapabilityBroker(":memory:", {
    owner: "owner",
    tools: {
      browser: {
        execute: async (action, credential) => {
          received.push({ action, credential });
          return { echo: credential, page: "private page body".repeat(1000) };
        },
      },
    },
    resolveCredential: async (scope) => {
      scopes.push(scope);
      return scope.item === "login"
        ? {
            kind: "login",
            username: "fixture-user",
            password: "synthetic-value-never-for-review",
          }
        : { bearerToken: "synthetic-value-never-for-review" };
    },
  });
  t.onTestFinished(async () => {
    await browser.close();
    broker.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const options = {
    owner: "owner",
    path: join(directory, "operations.sqlite"),
    operations: [],
    credentialOperations: [bearer, login],
    browser,
    broker,
  };
  const execute = createBrowserProposal(options);
  expect(await execute(null, "catalog", () => true)).toContain(
    '"private-status","private-login"',
  );
  expect(scopes).toEqual([]);
  expect(broker.auditEvents("owner")).toEqual([]);
  for (const [recipe, kind] of [
    [bearer, "bearer"],
    [login, "login"],
  ] as const) {
    const report = await execute(recipe.name, recipe.name, () => true);
    const review = receiptReport(report);
    expect(review.credential).toEqual({ kind, values: "not_exposed" });
    expect(review.receipt.status).toBe("succeeded");
    expect(report).not.toContain("synthetic-value-never-for-review");
    expect(report).not.toContain("fixture-user");
    expect(report).not.toContain("private page body");
    expect(scopes.at(-1)).toEqual({
      account: "fixture",
      item: recipe.item,
      origin: "https://fixture.invalid",
    });
    expect(received.at(-1)).toEqual({
      action: browser.action(recipe.name),
      credential:
        kind === "login"
          ? {
              kind: "login",
              username: "fixture-user",
              password: "synthetic-value-never-for-review",
            }
          : { bearerToken: "synthetic-value-never-for-review" },
    });
  }
  await expect(execute("unknown", "unknown", () => true)).rejects.toThrow(
    "browser_proposal_unavailable",
  );
  expect(() =>
    createBrowserProposal({
      ...options,
      credentialOperations: [{ ...bearer, outputSelector: "#private" }],
    }),
  ).toThrow();
  expect(scopes).toHaveLength(2);
  expect(received).toHaveLength(2);
});
