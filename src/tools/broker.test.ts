import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  type BrokerOptions,
  CapabilityBroker,
  MAX_GRANT_TTL_MS,
  type ToolAdapter,
} from "./broker.js";
import { createCapabilityRoutes } from "./routes.js";

const action = {
  tool: "mail.send",
  account: "account",
  item: "item",
  origin: "https://mail.example",
  arguments: { text: "private-payload", to: "friend" },
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function setup(execute?: ToolAdapter["execute"]) {
  const dir = mkdtempSync(join(tmpdir(), "broker-"));
  dirs.push(dir);
  const path = join(dir, "db");
  let calls = 0;
  const options = {
    owner: "owner",
    resolveCredential: async () => "secret-credential",
    tools: {
      "mail.send": {
        execute:
          execute ??
          (async (_action: unknown, credential: unknown) => {
            expect(credential).toBe("secret-credential");
            calls++;
            return "secret-credential";
          }),
      },
    },
  };
  const broker = new CapabilityBroker(path, options);
  return { broker, path, options, calls: () => calls };
}
test("only owner grants; exact arguments and all scopes bind a one-use grant", async () => {
  const { broker, calls, path } = setup();
  expect(() =>
    broker.grant("model", {
      audience: "worker",
      action,
      expiresAt: Date.now() + 60_000,
    }),
  ).toThrow();
  const grant = broker.grant("owner", {
    audience: "worker",
    action,
    expiresAt: Date.now() + 60_000,
  });
  for (const changed of [
    { ...action, account: "other" },
    { ...action, item: "other" },
    { ...action, tool: "other" },
    { ...action, origin: "https://mail.example.evil" },
    { ...action, arguments: { to: "enemy", text: "private-payload" } },
  ]) {
    await expect(broker.execute("worker", grant, changed)).rejects.toThrow();
  }
  await expect(broker.execute("stranger", grant, action)).rejects.toThrow();
  const receipt = await broker.execute("worker", grant, {
    ...action,
    arguments: { to: "friend", text: "private-payload" },
  });
  expect(receipt.status).toBe("succeeded");
  expect(await broker.execute("worker", grant, action)).toEqual(receipt);
  expect(calls()).toBe(1);
  expect(JSON.stringify(receipt)).not.toContain("secret");
  broker.close();
  expect(readFileSync(path).includes(Buffer.from("secret-credential"))).toBe(
    false,
  );
  expect(readFileSync(path).includes(Buffer.from("private-payload"))).toBe(
    false,
  );
});
test("caller mutation cannot rebind approved adapters or broker authority", async () => {
  const deliveries: [string, unknown][] = [];
  class Adapter {
    #destination = "approved";
    async execute(_action: unknown, credential: unknown) {
      deliveries.push([this.#destination, credential]);
    }
  }
  const adapter = new Adapter();
  const replacement = {
    async execute(_action: unknown, credential: unknown) {
      deliveries.push(["replacement", credential]);
    },
  };
  const pending = Promise.withResolvers<unknown>();
  let resolutions = 0;
  const options: BrokerOptions = {
    owner: "owner",
    tools: { "mail.send": adapter },
    now: () => 100,
    resolveCredential: async () => {
      resolutions++;
      return pending.promise;
    },
  };
  const broker = new CapabilityBroker(":memory:", options);
  try {
    const input = { audience: "worker", action, expiresAt: 200 };
    const grant = broker.grant("owner", input);
    const execution = broker.execute("worker", grant, action);
    adapter.execute = replacement.execute;
    options.tools["mail.send"] = replacement;
    pending.resolve("approved-credential");
    expect((await execution).status).toBe("succeeded");
    expect(deliveries).toEqual([["approved", "approved-credential"]]);

    options.owner = "replacement";
    options.tools = { "mail.send": replacement, extra: replacement };
    options.now = () => 201;
    options.resolveCredential = async () => "replacement-credential";
    expect(() => broker.grant("replacement", input)).toThrow(
      "capability_denied",
    );
    expect(() => broker.propose({ ...action, tool: "extra" })).toThrow(
      "capability_denied",
    );
    const next = broker.grant("owner", input);
    expect((await broker.execute("worker", next, action)).status).toBe(
      "succeeded",
    );
    expect(resolutions).toBe(2);
    expect(deliveries).toEqual([
      ["approved", "approved-credential"],
      ["approved", "approved-credential"],
    ]);
  } finally {
    broker.close();
  }
});

test("expired, revoked grants and malformed JSON fail closed", async () => {
  const { broker } = setup();
  for (const args of [
    undefined,
    NaN,
    Infinity,
    -0,
    { __proto__: { x: 1 } },
    JSON.parse('{"__proto__":1}'),
    [undefined],
  ]) {
    expect(() => broker.propose({ ...action, arguments: args })).toThrow();
  }
  for (const origin of [
    "https://mail.example/",
    "https://mail.example@evil.example",
    "https://mail.example/path",
    "http://mail.example",
    "https://MAIL.example",
  ]) {
    expect(() => broker.propose({ ...action, origin })).toThrow();
  }
  expect(() =>
    broker.grant("owner", { audience: "worker", action, expiresAt: 1 }),
  ).toThrow();
  const grant = broker.grant("owner", {
    audience: "worker",
    action,
    expiresAt: Date.now() + 60_000,
  });
  broker.revoke("owner", grant);
  await expect(broker.execute("worker", grant, action)).rejects.toThrow();
  broker.close();
});
test("durable in-flight intent is unknown on reopen and cannot execute again", async () => {
  const started = Promise.withResolvers<void>();
  const { broker, path, options } = setup(async () => {
    started.resolve();
    return new Promise(() => {});
  });
  const grant = broker.grant("owner", {
    audience: "worker",
    action,
    expiresAt: Date.now() + 60_000,
  });
  void broker.execute("worker", grant, action);
  await started.promise;
  broker.close();
  const reopened = new CapabilityBroker(path, options);
  expect((await reopened.execute("worker", grant, action)).status).toBe(
    "unknown",
  );
  reopened.close();
});

test("rejects array properties that JSON would silently discard", () => {
  const { broker } = setup();
  const args: unknown[] = [];
  Object.defineProperty(args, "hidden", { value: "changed" });
  expect(() => broker.propose({ ...action, arguments: args })).toThrow();
  broker.close();
});

test("expiry at execution and revocation while resolving credentials prevent transport", async () => {
  const { broker, options, path, calls } = setup();
  broker.close();
  let now = 100;
  const timed = new CapabilityBroker(path, { ...options, now: () => now });
  const stale = timed.grant("owner", {
    audience: "worker",
    action,
    expiresAt: 200,
  });
  now = 200;
  await expect(timed.execute("worker", stale, action)).rejects.toThrow();
  const grant = timed.grant("owner", {
    audience: "worker",
    action,
    expiresAt: 300,
  });
  const execution = timed.execute("worker", grant, action);
  timed.revoke("owner", grant);
  expect((await execution).status).toBe("unknown");
  expect(calls()).toBe(0);
  timed.close();
});

test("transport exception is redacted, persistent unknown and never retried", async () => {
  let calls = 0;
  const { broker, options, path } = setup(async () => {
    calls++;
    throw new Error("secret-credential private-payload");
  });
  const grant = broker.grant("owner", {
    audience: "worker",
    action,
    expiresAt: Date.now() + 60_000,
  });
  const receipt = await broker.execute("worker", grant, action);
  expect(receipt.status).toBe("unknown");
  expect(JSON.stringify(receipt)).not.toContain("secret");
  broker.close();
  const reopened = new CapabilityBroker(path, options);
  expect(await reopened.execute("worker", grant, action)).toEqual(receipt);
  expect(calls).toBe(1);
  reopened.close();
});

test("owner can audit a revoked consumed grant without replay or payload access", async () => {
  const { broker } = setup();
  const grant = broker.grant("owner", {
    audience: "worker",
    action,
    expiresAt: Date.now() + 60_000,
  });
  expect(broker.audit("owner", grant)).toBeUndefined();
  const receipt = await broker.execute("worker", grant, action);
  broker.revoke("owner", grant);
  expect(broker.audit("owner", grant)).toEqual(receipt);
  expect(() => broker.audit("worker", grant)).toThrow();
  expect(broker.matchesGrant("owner", grant, action)).toBe(true);
  expect(
    broker.matchesGrant("owner", grant, { ...action, arguments: {} }),
  ).toBe(false);
  expect(() => broker.matchesGrant("worker", grant, action)).toThrow();
  broker.close();
});

test("argument canonicalization rejects unsafe types and snapshots caller mutations", async () => {
  const { broker } = setup();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const getter = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      throw new Error("must-not-run");
    },
  });
  for (const argumentsValue of [
    cyclic,
    getter,
    new Date(),
    1n,
    Number.MAX_SAFE_INTEGER + 1,
    Array(1),
    {
      toJSON() {
        return {};
      },
    },
    "x".repeat(65537),
  ]) {
    expect(() =>
      broker.propose({ ...action, arguments: argumentsValue }),
    ).toThrow("capability_denied");
  }
  const proposed = broker.propose(action);
  const grant = broker.grant("owner", {
    audience: "worker",
    action: proposed,
    expiresAt: Date.now() + 60_000,
  });
  const execution = broker.execute("worker", grant, proposed);
  proposed.arguments = { changed: true };
  expect((await execution).status).toBe("succeeded");
  broker.close();
});

test("short grants, cancellation and owner reconciliation never reopen a consumed effect", async () => {
  const { broker, options, path, calls } = setup();
  broker.close();
  const timed = new CapabilityBroker(path, { ...options, now: () => 100 });
  expect(() =>
    timed.grant("owner", {
      audience: "worker",
      action,
      expiresAt: 101 + MAX_GRANT_TTL_MS,
    }),
  ).toThrow();
  const grant = timed.grant("owner", {
    audience: "worker",
    action,
    expiresAt: 100 + MAX_GRANT_TTL_MS,
  });
  const execution = timed.execute("worker", grant, action);
  const reconciliation = { confirmedStopped: true, outcome: "failed" };
  expect(() => timed.reconcile("owner", grant, reconciliation)).toThrow();
  expect(timed.cancel("owner", grant)?.status).toBe("unknown");
  expect((await execution).status).toBe("unknown");
  expect(calls()).toBe(0);
  expect(() => timed.reconcile("worker", grant, reconciliation)).toThrow();
  expect(() =>
    timed.reconcile("owner", grant, {
      ...reconciliation,
      confirmedStopped: false,
    }),
  ).toThrow();
  expect(timed.reconcile("owner", grant, reconciliation).status).toBe("failed");
  await expect(timed.execute("worker", grant, action)).rejects.toThrow();
  expect(timed.auditEvents("owner").map((event) => event.event)).toEqual([
    "granted",
    "execution_claimed",
    "revoked",
    "reconciled_failed",
  ]);
  expect(() => timed.auditEvents("worker")).toThrow();
  expect(JSON.stringify(timed.auditEvents("owner"))).not.toMatch(
    /secret|private-payload/,
  );
  timed.close();
  const reopened = new CapabilityBroker(path, options);
  expect(reopened.audit("owner", grant)?.status).toBe("failed");
  await expect(reopened.execute("worker", grant, action)).rejects.toThrow();
  reopened.close();
});

test("independent owner routes reject unauthenticated/cross-origin writes and principal substitution", async () => {
  const { broker, calls } = setup();
  const token = "t".repeat(32);
  const app = createCapabilityRoutes({
    broker,
    owner: "owner",
    operatorToken: token,
    consoleOrigin: "https://console.example",
  });
  const body = JSON.stringify({
    audience: "worker",
    action,
    expiresAt: Date.now() + 60_000,
  });
  expect((await app.request("/grants", { method: "POST", body })).status).toBe(
    401,
  );
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  expect(
    (
      await app.request("/grants", {
        method: "POST",
        body,
        headers: { ...headers, origin: "https://attacker.example" },
      })
    ).status,
  ).toBe(403);
  const grantResponse = await app.request("/grants", {
    method: "POST",
    body,
    headers,
  });
  expect(grantResponse.status).toBe(400);
  const grantId = broker.grant("owner", JSON.parse(body));
  const response = await app.request(`/grants/${grantId}/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify(action),
  });
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(calls()).toBe(0);
  expect(
    (await app.request(`/grants/${grantId}/execute`, { headers })).status,
  ).toBe(404);
  const ownerGrant = await app.request("/grants", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...JSON.parse(body), audience: "owner" }),
  });
  expect(ownerGrant.status).toBe(201);
  const ownerId = (await ownerGrant.json()).grantId;
  const success = await app.request(`/grants/${ownerId}/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify(action),
  });
  expect((await success.json()).status).toBe("succeeded");
  expect(calls()).toBe(1);
  broker.close();
});

test("deferred credentials stay one-use and are not released after revocation or execution settlement", async () => {
  for (const failure of [
    "revoked",
    "cancelled",
    "expired",
    "link-revoked",
    "settled",
    "pending-after-settlement",
  ]) {
    let now = 100;
    const pending = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<void>();
    let retained: (() => Promise<unknown>) | undefined;
    let lateLookup: Promise<unknown> | undefined;
    let executionSignal: AbortSignal | undefined;
    let reads = 0;
    let releases = 0;
    const broker = new CapabilityBroker(":memory:", {
      owner: "owner",
      now: () => now,
      resolveCredential: async () => {
        reads++;
        entered.resolve();
        return pending.promise;
      },
      tools: {
        "mail.send": {
          execute: async () => {
            throw new Error("must use deferred path");
          },
          executeWithCredentialResolver: async (_action, resolve, signal) => {
            retained = resolve;
            executionSignal = signal;
            if (failure === "settled") return;
            if (failure === "pending-after-settlement") {
              lateLookup = resolve().then((credential) => {
                releases++;
                return credential;
              });
              return;
            }
            await resolve();
            releases++;
          },
        },
      },
    });
    try {
      const grant = broker.grant("owner", {
        audience: "worker",
        action,
        expiresAt: 200,
      });
      const link = broker.issueLink("owner", grant, 200);
      const running = broker.execute("worker", grant, action, link);
      if (failure !== "settled" && failure !== "pending-after-settlement") {
        await entered.promise;
        if (failure === "revoked") broker.revoke("owner", grant);
        if (failure === "cancelled") {
          broker.cancel("owner", grant);
          expect(executionSignal?.aborted).toBe(true);
          expect(() =>
            broker.reconcile("owner", grant, {
              confirmedStopped: true,
              outcome: "failed",
            }),
          ).toThrow("capability_denied");
        }
        if (failure === "expired") now = 200;
        if (failure === "link-revoked") broker.revokeLink("owner", link);
        pending.resolve("synthetic-private-value");
      }
      const receipt = await running;
      expect(receipt.status).toBe("unknown");
      if (failure === "pending-after-settlement") {
        pending.resolve("synthetic-private-value");
        await expect(lateLookup).rejects.toThrow("capability_denied");
      }
      expect(retained).toBeDefined();
      await expect(retained?.()).rejects.toThrow("capability_denied");
      expect(reads).toBe(failure === "settled" ? 0 : 1);
      expect(releases).toBe(0);
      expect(JSON.stringify(broker.auditEvents("owner"))).not.toContain(
        "synthetic-private-value",
      );
    } finally {
      broker.close();
    }
  }
});
