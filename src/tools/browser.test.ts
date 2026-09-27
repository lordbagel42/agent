import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { chromium } from "playwright";
import { afterEach, expect, test, vi } from "vitest";
import { createBitwardenCredentialResolver } from "../credentials/bitwarden.js";
import { CapabilityBroker, type ToolAction } from "./broker.js";
import { BrowserAdapter, type BrowserOperation } from "./browser.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function server(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  onUpgrade?: () => void,
) {
  const instance = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    handler(request, response);
  });
  instance.on("upgrade", (_request, socket) => {
    onUpgrade?.();
    socket.destroy();
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, "127.0.0.1", resolve),
  );
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        instance.close((error) => (error ? reject(error) : resolve()));
        instance.closeAllConnections();
      }),
  );
  const address = instance.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

function setup(origin: string, overrides: Partial<BrowserOperation> = {}) {
  const recipe: BrowserOperation = {
    name: "check",
    account: "fixture",
    item: "fixture-item",
    origin,
    url: `${origin}/`,
    requests: [{ url: `${origin}/`, method: "GET" }],
    success: { selector: "#ok", text: "done" },
    ...overrides,
  };
  const adapter = new BrowserAdapter({
    operations: [recipe],
    allowLoopbackHttp: true,
    timeoutMs: 5000,
  });
  cleanup.push(() => adapter.close());
  const action: ToolAction = {
    tool: "browser",
    account: "fixture",
    item: "fixture-item",
    origin,
    arguments: { operation: "check" },
  };
  return { adapter, action };
}

test("rejects scope/argument widening before network access and never returns reflected credentials", async () => {
  const seen: (string | undefined)[] = [];
  const publicHeaders: (string | undefined)[] = [];
  const cookies: (string | undefined)[] = [];
  const origin = await server((request, response) => {
    if (request.url === "/public") {
      publicHeaders.push(request.headers.authorization);
      response.end("public");
      return;
    }
    seen.push(request.headers.authorization);
    cookies.push(request.headers.cookie);
    response.setHeader("Set-Cookie", "session=fixture; Path=/");
    response.end(
      `<body><p>${request.headers.authorization}</p><script>fetch('/public').then(() => document.body.insertAdjacentHTML('beforeend','<div id="ok">done</div>'))</script></body>`,
    );
  });
  const { adapter, action } = setup(origin, {
    requests: [
      { url: `${origin}/`, method: "GET", credential: true },
      { url: `${origin}/public`, method: "GET" },
    ],
  });
  const credential = { bearerToken: "local-fixture-secret" };
  for (const invalid of [
    { ...action, origin: `${origin}/` },
    { ...action, origin: origin.replace("127.0.0.1", "localhost") },
    { ...action, origin: "https://127.0.0.1.evil.example" },
    { ...action, account: "other" },
    { ...action, item: "other" },
    { ...action, arguments: { operation: "check", url: `${origin}/extra` } },
  ])
    await expect(adapter.execute(invalid, credential)).rejects.toThrow(
      "browser_action_failed",
    );
  expect(seen).toEqual([]);
  for (let i = 0; i < 2; i++) {
    expect(await adapter.execute(action, credential)).toEqual({
      operation: "check",
      status: "confirmed",
    });
  }
  expect(seen).toEqual([
    "Bearer local-fixture-secret",
    "Bearer local-fixture-secret",
  ]);
  expect(cookies).toEqual([undefined, undefined]);
  expect(publicHeaders).toEqual([undefined, undefined]);
});

test("blocks redirect, cross-origin subresources and popup requests before they reach their destination", async () => {
  let escaped = 0;
  const foreign = await server(
    (_request, response) => {
      escaped++;
      response.end("escaped");
    },
    () => {
      escaped++;
    },
  );
  let html = "";
  let redirect: string | undefined = `${foreign}/`;
  const origin = await server((request, response) => {
    if (request.url === "/secondary") escaped++;
    if (redirect) {
      response.writeHead(302, { location: redirect });
      response.end();
    } else response.end(html);
  });
  const { adapter, action } = setup(origin, {
    requests: [
      { url: `${origin}/`, method: "GET", credential: true },
      { url: `${origin}/secondary`, method: "GET", credential: true },
    ],
  });
  const credential = { bearerToken: "never-cross-origins" };
  for (const destination of [
    `${foreign}/`, // Same hostname, different port.
    `${origin}/secondary`, // Even a configured same-origin request cannot redirect.
    `${origin.replace("127.0.0.1", "localhost")}/secondary`,
    "https://127.0.0.1.evil.example/",
  ]) {
    redirect = destination;
    await expect(adapter.execute(action, credential)).rejects.toThrow(
      "browser_action_failed",
    );
  }
  redirect = undefined;
  for (const attempt of [
    `<img src="${foreign}/secret">`,
    `<script>window.open('${foreign}/secret')</script>`,
    `<script>window.open('${origin}/secondary')</script>`,
    `<iframe src="${origin}/secondary"></iframe>`,
    `<script>new WebSocket('${foreign.replace("http:", "ws:")}/')</script>`,
  ]) {
    html = `${attempt}<div id="never">not confirmed</div>`;
    await expect(adapter.execute(action, credential)).rejects.toThrow(
      "browser_action_failed",
    );
  }
  expect(escaped).toBe(0);
});

test("login fields are injected only in the approved document and never returned", async () => {
  let submitted = "";
  let leaked = 0;
  const foreign = await server((_request, response) => {
    leaked++;
    response.end("leak");
  });
  let target: string | undefined;
  const origin = await server((request, response) => {
    if (request.url === "/login") {
      request.on("data", (chunk) => {
        submitted += chunk.toString();
      });
      request.on("end", () => {
        response.end(`<div id="ok">done</div><p>${submitted}</p>`);
      });
      return;
    }
    response.end(
      `<form method="POST" action="${target ?? "/login"}"><input name="username"><input name="password" type="password"><button>sign in</button></form>`,
    );
  });
  const { adapter, action } = setup(origin, {
    requests: [
      { url: `${origin}/`, method: "GET" },
      { url: `${origin}/login`, method: "POST" },
    ],
    steps: [
      {
        kind: "login",
        usernameSelector: "[name=username]",
        passwordSelector: "[name=password]",
      },
      { kind: "click", selector: "button" },
    ],
  });
  const credential = {
    kind: "login",
    username: "fixture-user",
    password: "fixture-password",
  };
  expect(await adapter.execute(action, credential)).toEqual({
    operation: "check",
    status: "confirmed",
  });
  expect(submitted).toBe("username=fixture-user&password=fixture-password");
  target = `${foreign}/steal`;
  await expect(adapter.execute(action, credential)).rejects.toThrow(
    "browser_action_failed",
  );
  expect(leaked).toBe(0);
});

test("a duplicated page mutation reaches the server at most once and is never retried", async () => {
  let writes = 0;
  const origin = await server((request, response) => {
    if (request.method === "POST") {
      writes++;
      response.end("done");
      return;
    }
    response.end(
      `<button onclick="fetch('/write',{method:'POST'}).then(()=>fetch('/write',{method:'POST'}))">submit</button>`,
    );
  });
  const { adapter, action } = setup(origin, {
    requests: [
      { url: `${origin}/`, method: "GET" },
      { url: `${origin}/write`, method: "POST" },
    ],
    steps: [{ kind: "click", selector: "button" }],
  });
  await expect(adapter.execute(action, null)).rejects.toThrow(
    "browser_action_failed",
  );
  expect(writes).toBe(1);
});

test("cancellation during header lookup prevents dispatch of an admitted mutation", async () => {
  const controller = new AbortController();
  let writes = 0;
  const origin = await server((request, response) => {
    if (request.method === "POST") {
      writes++;
      response.end("done");
      return;
    }
    response.end(
      `<button onclick="fetch('/write',{method:'POST'})">submit</button>`,
    );
  });
  // Keep real Chromium/networking; schedule cancellation at the asynchronous
  // metadata boundary, after route admission but before network dispatch.
  const launch = chromium.launch.bind(chromium);
  vi.spyOn(chromium, "launch").mockImplementation(async (options) => {
    const browser = await launch(options);
    const newContext = browser.newContext.bind(browser);
    vi.spyOn(browser, "newContext").mockImplementation(async (options) => {
      const context = await newContext(options);
      const installRoute = context.route.bind(context);
      vi.spyOn(context, "route").mockImplementation(
        (pattern, handler, options) =>
          installRoute(
            pattern,
            async (route, request) => {
              if (request.method() === "POST") {
                const allHeaders = request.allHeaders.bind(request);
                vi.spyOn(request, "allHeaders").mockImplementation(async () => {
                  const headers = await allHeaders();
                  controller.abort();
                  return headers;
                });
              }
              return handler(route, request);
            },
            options,
          ),
      );
      return context;
    });
    return browser;
  });
  const { adapter, action } = setup(origin, {
    requests: [
      { url: `${origin}/`, method: "GET" },
      { url: `${origin}/write`, method: "POST", credential: true },
    ],
    steps: [{ kind: "click", selector: "button" }],
  });
  await expect(
    adapter.execute(
      action,
      {
        bearerToken: "fixture-only-token",
      },
      controller.signal,
    ),
  ).rejects.toThrow("browser_action_failed");
  expect(controller.signal.aborted).toBe(true);
  expect(writes).toBe(0);
});

test("cancellation closes the action and bounded anonymous output remains data", async () => {
  let entered: (() => void) | undefined;
  let hang = false;
  const origin = await server((_request, response) => {
    entered?.();
    if (hang) return;
    response.end(`<div id="ok">done</div><p id="text">${"x".repeat(5000)}</p>`);
  });
  const { adapter, action } = setup(origin, { outputSelector: "#text" });
  const result = await adapter.execute(action, null);
  expect(result.untrustedText).toBe("x".repeat(4096));
  hang = true;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const controller = new AbortController();
  const running = expect(
    adapter.execute(action, null, controller.signal),
  ).rejects.toThrow("browser_action_failed");
  await started;
  controller.abort();
  await running;
  await expect(
    adapter.execute(action, null, controller.signal),
  ).rejects.toThrow("browser_action_failed");
  await adapter.close();
  await expect(adapter.execute(action, null)).rejects.toThrow(
    "browser_action_failed",
  );
});

test("host read grants bind the recipe revision and do not inherit credentials", async () => {
  let reads = 0;
  const origin = await server((_request, response) => {
    reads++;
    response.end(`<div id="ok">done</div><p id="text">${"y".repeat(5000)}</p>`);
  });
  const recipe: BrowserOperation = {
    name: "public-status",
    account: "anonymous-status",
    item: "public-page",
    origin,
    url: `${origin}/`,
    requests: [{ url: `${origin}/`, method: "GET" }],
    success: { selector: "#ok", text: "done" },
    outputSelector: "#text",
  };
  const adapter = new BrowserAdapter({
    operations: [recipe],
    requireRecipeDigest: true,
    allowLoopbackHttp: true,
  });
  cleanup.push(() => adapter.close());
  const changed = new BrowserAdapter({
    operations: [{ ...recipe, outputSelector: "#ok" }],
    requireRecipeDigest: true,
    allowLoopbackHttp: true,
  });
  cleanup.push(() => changed.close());
  const launch = vi.spyOn(chromium, "launch");
  const action = adapter.action(recipe.name);
  await expect(
    adapter.execute({ ...action, arguments: { operation: recipe.name } }, null),
  ).rejects.toThrow("browser_action_failed");
  await expect(changed.execute(action, null)).rejects.toThrow(
    "browser_action_failed",
  );
  await expect(
    adapter.execute(action, { bearerToken: "unrelated-secret" }),
  ).rejects.toThrow("browser_action_failed");
  expect(launch).not.toHaveBeenCalled();
  expect(reads).toBe(0);
  expect(await adapter.execute(action, null)).toEqual({
    operation: recipe.name,
    status: "confirmed",
    untrustedText: "y".repeat(4096),
  });
  expect(reads).toBe(1);
  expect(launch.mock.calls[0]?.[0]).toMatchObject({
    chromiumSandbox: true,
    env: {},
  });
  expect(Object.keys(launch.mock.calls[0]?.[0]?.env ?? {})).toEqual([]);
});

test("approved browser operations alone resolve fake vault secrets and suppress reflected output and failures", async () => {
  const secret = "synthetic-vault-password-134";
  const session = "synthetic-session-134";
  const seen: string[] = [];
  const local = await server((request, response) => {
    seen.push(request.headers.authorization ?? "");
    response.end(
      `<div id="ok">done</div><p>${secret} ${Buffer.from(secret).toString("base64")}</p>`,
    );
  });
  const origin = "https://vault-fixture.invalid";
  // Only the fixture transport maps HTTPS to loopback. The real browser,
  // recipe validation, route admission and response handling remain in use.
  const launch = chromium.launch.bind(chromium);
  const launchSpy = vi
    .spyOn(chromium, "launch")
    .mockImplementation(async (options) => {
      const browser = await launch(options);
      const newContext = browser.newContext.bind(browser);
      vi.spyOn(browser, "newContext").mockImplementation(async (options) => {
        const context = await newContext(options);
        const installRoute = context.route.bind(context);
        vi.spyOn(context, "route").mockImplementation(
          (pattern, handler, options) =>
            installRoute(
              pattern,
              async (route, request) => {
                const fetch = route.fetch.bind(route);
                vi.spyOn(route, "fetch").mockImplementation((options) => {
                  expect(request.url()).toBe(`${origin}/`);
                  return fetch({ ...options, url: `${local}/` });
                });
                return handler(route, request);
              },
              options,
            ),
        );
        return context;
      });
      return browser;
    });
  const { adapter } = setup(origin, {
    requests: [{ url: `${origin}/`, method: "GET", credential: true }],
  });
  const action = adapter.action("check");
  let reads = 0;
  let transportFailure = false;
  const id = "12345678-1234-1234-1234-123456789abc";
  const resolver = createBitwardenCredentialResolver(
    {
      executable: "/fixture/bw",
      appDataDir: "/fixture/profile",
      bindings: [
        {
          account: action.account,
          item: action.item,
          origin,
          vaultItemId: id,
          field: "bearer",
        },
      ],
      session: async () => ({ key: session, expiresAt: Date.now() + 10_000 }),
    },
    async () => {
      reads++;
      if (transportFailure) throw new Error(`${secret} ${session}`);
      return JSON.stringify({
        id,
        type: 1,
        login: { password: secret },
        notes: session,
      });
    },
  );
  const broker = new CapabilityBroker(":memory:", {
    owner: "owner",
    tools: { browser: adapter },
    resolveCredential: resolver,
  });
  const approve = (exact: ToolAction) =>
    broker.grant("owner", {
      audience: "june",
      action: exact,
      expiresAt: Date.now() + 60_000,
    });
  try {
    const invalidActions: ToolAction[] = [
      { ...action, arguments: { operation: "missing" } },
      {
        ...action,
        arguments: { operation: "check", recipeDigest: "0".repeat(64) },
      },
      { ...action, account: "other" },
      { ...action, origin: "https://vault-fixture.invalid.evil" },
    ];
    for (const invalid of invalidActions) {
      const receipt = await broker.execute("june", approve(invalid), invalid);
      expect(receipt.status).toBe("unknown");
    }
    for (const name of [
      "DEBUG",
      "PWDEBUG",
      "NODE_DEBUG",
      "NODE_DEBUG_NATIVE",
      "npm_config_pwdebug",
      "npm_package_config_pwdebug",
      "SELENIUM_REMOTE_URL",
      "SELENIUM_REMOTE_HEADERS",
      "SELENIUM_REMOTE_CAPABILITIES",
    ]) {
      vi.stubEnv(name, "pw:protocol");
      expect(
        (await broker.execute("june", approve(action), action)).status,
      ).toBe("unknown");
      vi.unstubAllEnvs();
    }
    expect(reads).toBe(0);
    expect(launchSpy).not.toHaveBeenCalled();
    const grant = approve(action);
    await expect(broker.execute("other", grant, action)).rejects.toThrow(
      "capability_denied",
    );
    expect(reads).toBe(0);
    const receipt = await broker.execute("june", grant, action);
    expect(receipt.status).toBe("succeeded");
    expect(await broker.execute("june", grant, action)).toEqual(receipt);
    expect(reads).toBe(1);
    expect(seen).toEqual([`Bearer ${secret}`]);
    transportFailure = true;
    const failedVault = await broker.execute("june", approve(action), action);
    expect(failedVault.status).toBe("unknown");
    transportFailure = false;
    launchSpy.mockRejectedValueOnce(new Error(`${secret} ${session}`));
    const failedBrowser = await broker.execute("june", approve(action), action);
    expect(failedBrowser.status).toBe("unknown");
    const visible = JSON.stringify([
      receipt,
      failedVault,
      failedBrowser,
      broker.auditEvents("owner"),
    ]);
    for (const value of [
      secret,
      session,
      Buffer.from(secret).toString("base64"),
    ])
      expect(visible).not.toContain(value);
    expect(reads).toBe(3);
    expect(seen).toHaveLength(1);
  } finally {
    broker.close();
  }
});

test("cancellation during credential lookup waits for settlement and never launches Chromium", async () => {
  const launch = vi.spyOn(chromium, "launch");
  const pending = Promise.withResolvers<unknown>();
  const entered = Promise.withResolvers<void>();
  const { adapter, action } = setup("https://fixture.invalid", {
    requests: [
      { url: "https://fixture.invalid/", method: "GET", credential: true },
    ],
  });
  const controller = new AbortController();
  const running = adapter.executeWithCredentialResolver(
    action,
    () => {
      entered.resolve();
      return pending.promise;
    },
    controller.signal,
  );
  await entered.promise;
  controller.abort();
  let closed = false;
  const closing = adapter.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  pending.resolve({ bearerToken: "synthetic-private-value" });
  await expect(running).rejects.toThrow("browser_action_failed");
  await closing;
  expect(closed).toBe(true);
  expect(launch).not.toHaveBeenCalled();
});
