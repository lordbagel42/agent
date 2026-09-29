import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  httpsWebhookTransport,
  publicWebhookAddress,
  type WebhookTransport,
  webhookUrl,
} from "../src/agent/webhook-transport.js";
import {
  registerWebhookSchema,
  sendWebhookSchema,
  WebhookService,
} from "../src/agent/webhooks.js";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));

const directories: string[] = [];
const services: WebhookService[] = [];
const destinations = [
  { origin: "https://receiver.example", pathPrefix: "/hooks" },
];
const registration = () => ({
  idempotencyKey: randomUUID(),
  name: "fixture",
  url: "https://receiver.example/hooks/june?secret=private-fixture-token",
  expiresAt: Date.now() + 60_000,
  events: ["reply", "message"],
  conversationId: "conversation-1",
});
const message = (webhookId: string) => ({
  idempotencyKey: "host:stable:reply-1",
  webhookId,
  type: "reply",
  payload: { text: "private-fixture-payload", nested: { b: 2, a: 1 } },
});
function fixture(transport?: WebhookTransport) {
  const directory = mkdtempSync(join(tmpdir(), "june-webhooks-"));
  directories.push(directory);
  const options = {
    path: join(directory, "outbox.sqlite"),
    key: randomBytes(32),
    destinations,
    clientActive: (_id: string) => true,
  };
  const service = new WebhookService(options, transport);
  services.push(service);
  return { service, options };
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  mocks.lookup.mockReset();
  mocks.request.mockReset();
});

describe("webhook privacy and durable side-effect boundaries", () => {
  it("encrypts secrets, reveals signing keys once, and binds canonical input and principal", async () => {
    let effects = 0;
    let signed: Parameters<WebhookTransport>[0] | undefined;
    const { service, options } = fixture(async (request) => {
      request.beforeDispatch();
      effects++;
      signed = request;
      return 202;
    });
    const input = registration();
    const registered = service.register("owner-a", input);
    expect(registered.signingKey).toBeTruthy();
    expect(service.register("owner-a", input)).not.toHaveProperty("signingKey");
    expect(() =>
      service.register("owner-a", { ...input, name: "changed" }),
    ).toThrow("idempotency_conflict");
    expect(service.register("owner-b", input).id).not.toBe(registered.id);
    const send = message(registered.id);
    const [first, second] = await Promise.all([
      service.send("owner-b", send),
      service.send("owner-b", {
        ...send,
        payload: { nested: { a: 1, b: 2 }, text: send.payload.text },
      }),
    ]);
    expect(first).toEqual(second);
    expect(first.status).toBe("accepted");
    expect(effects).toBe(1);
    expect(() =>
      service.enqueue("owner-b", { ...send, type: "message" }),
    ).toThrow("idempotency_conflict");
    if (!signed || !registered.signingKey)
      throw new Error("missing fixture signature");
    const signature = createHmac(
      "sha256",
      Buffer.from(registered.signingKey, "base64url"),
    )
      .update(`${signed.headers["X-June-Timestamp"]}.`)
      .update(signed.body)
      .digest("hex");
    expect(signed.headers["X-June-Signature"]).toBe(`v1=${signature}`);
    expect(JSON.parse(signed.body.toString())).toMatchObject({
      version: 1,
      id: first.id,
      type: "reply",
      conversationId: "conversation-1",
      payload: send.payload,
    });
    const publicData = JSON.stringify([
      service.list(),
      service.get(registered.id),
      service.delivery(first.id),
    ]);
    for (const secret of [
      input.url,
      registered.signingKey,
      send.payload.text,
    ]) {
      expect(publicData).not.toContain(secret);
      expect(readFileSync(options.path).includes(Buffer.from(secret))).toBe(
        false,
      );
    }
    expect(statSync(options.path).mode & 0o777).toBe(0o600);
    await service.close();
    expect(
      () => new WebhookService({ ...options, key: randomBytes(32) }),
    ).toThrow("invalid_key");
    expect(
      () => new WebhookService({ ...options, key: Buffer.alloc(31) }),
    ).toThrow("32_bytes");
    const restarted = new WebhookService(options, async () => {
      throw new Error("must not dispatch twice");
    });
    services.push(restarted);
    expect(await restarted.send("owner-b", send)).toEqual(first);
  });

  it("never retries interrupted dispatches or HTTP failures, but drains safe queued work", async () => {
    let effects = 0;
    const transport: WebhookTransport = async ({ beforeDispatch }) => {
      beforeDispatch();
      effects++;
      return 500;
    };
    const { service, options } = fixture(transport);
    const webhook = service.register("owner", registration());
    const failed = await service.send("owner", message(webhook.id));
    expect(failed.status).toBe("unknown");
    const interrupted = service.enqueue("owner", {
      ...message(webhook.id),
      idempotencyKey: "interrupted",
    });
    const queued = service.enqueue("owner", {
      ...message(webhook.id),
      idempotencyKey: "safe",
    });
    await service.close();
    // Simulate the exact durable crash boundary: marker committed, outcome absent.
    const db = new DatabaseSync(options.path);
    db.prepare(
      "UPDATE webhook_deliveries SET status='dispatching' WHERE id=?",
    ).run(interrupted.id);
    db.close();
    const restarted = new WebhookService(options, transport);
    services.push(restarted);
    await Promise.all([restarted.drain(), restarted.drain()]);
    expect(effects).toBe(2);
    expect(restarted.delivery(interrupted.id)).toMatchObject({
      status: "unknown",
      code: "interrupted",
    });
    expect(restarted.delivery(queued.id)?.status).toBe("unknown");
    await restarted.send("owner", message(webhook.id));
    expect(effects).toBe(2);
  });

  it("rechecks revocation, original credential, expiry, and policy after asynchronous preparation", async () => {
    for (const reason of [
      "revoke",
      "credential",
      "expiry",
      "policy",
      "forget",
    ] as const) {
      const prepared = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let effects = 0;
      const { service, options } = fixture(async ({ beforeDispatch }) => {
        prepared.resolve();
        await resume.promise;
        beforeDispatch();
        effects++;
        return 200;
      });
      const active = new Set(["creator", "sender"]);
      // The callback closes over mutable host credential state.
      await service.close();
      const current = new WebhookService(
        { ...options, clientActive: (id) => active.has(id) },
        async ({ beforeDispatch }) => {
          prepared.resolve();
          await resume.promise;
          beforeDispatch();
          effects++;
          return 200;
        },
      );
      services.push(current);
      const webhook = current.register("creator", registration());
      if (reason === "policy") {
        const queued = current.enqueue("sender", message(webhook.id));
        await current.close();
        const restricted = new WebhookService(
          { ...options, destinations: [] },
          async () => {
            effects++;
            return 200;
          },
        );
        services.push(restricted);
        await restricted.drain();
        expect(restricted.delivery(queued.id)?.status).toBe("rejected");
      } else {
        const sending = current.send("sender", message(webhook.id));
        await prepared.promise;
        if (reason === "revoke") current.revoke(webhook.id);
        if (reason === "forget") current.invalidatePending();
        if (reason === "credential") active.delete("creator");
        if (reason === "expiry")
          vi.spyOn(Date, "now").mockReturnValue(webhook.expiresAt + 1);
        resume.resolve();
        expect((await sending).status).toBe("rejected");
        vi.restoreAllMocks();
      }
      expect(effects).toBe(0);
    }
  });

  it("waits for active requests on close and does not expose callback error text", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { service } = fixture(async ({ beforeDispatch }) => {
      beforeDispatch();
      started.resolve();
      await release.promise;
      throw new Error("secret receiver response and URL");
    });
    const webhook = service.register("owner", registration());
    const sending = service.send("owner", message(webhook.id));
    await started.promise;
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(() => service.enqueue("owner", message(webhook.id))).toThrow(
      "closed",
    );
    release.resolve();
    expect(await sending).toMatchObject({
      status: "unknown",
      code: "dispatch_uncertain",
    });
    await closing;
    expect(closed).toBe(true);
  });

  it("rejects unbounded/non-JSON inputs and preserves tombstones at capacity", () => {
    const { service } = fixture();
    const webhook = service.register("owner", registration());
    const send = message(webhook.id);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const payload of [
      cycle,
      { text: "x".repeat(65537) },
      { sparse: new Array(1e8) },
      { number: Number.NaN },
      { date: new Date() },
      JSON.parse('{"__proto__":{"hidden":true}}'),
    ]) {
      expect(sendWebhookSchema.safeParse({ ...send, payload }).success).toBe(
        false,
      );
    }
    expect(
      registerWebhookSchema.safeParse({
        ...registration(),
        headers: { Authorization: "secret" },
      }).success,
    ).toBe(false);
    expect(() => z.toJSONSchema(sendWebhookSchema)).not.toThrow();
    for (let i = 1; i < 256; i++) service.register("owner", registration());
    service.revoke(webhook.id);
    expect(() => service.register("owner", registration())).toThrow(
      "registration_limit",
    );
    const original = service.enqueue("owner", send);
    for (let i = 1; i < 4096; i++)
      service.enqueue("owner", { ...send, idempotencyKey: `bounded-${i}` });
    expect(() =>
      service.enqueue("owner", { ...send, idempotencyKey: "over-limit" }),
    ).toThrow("outbox_limit");
    expect(service.enqueue("owner", send)).toEqual(original);
  });
});

describe("production transport SSRF and network boundaries (no external calls)", () => {
  it("denies nonpublic/mapped addresses and URL authority/path escapes", async () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "100.64.0.1",
      "224.0.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "2001:db8::1",
    ])
      expect(publicWebhookAddress(address)).toBe(false);
    expect(publicWebhookAddress("8.8.8.8")).toBe(true);
    expect(publicWebhookAddress("2606:4700:4700::1111")).toBe(true);
    for (const url of [
      "http://receiver.example/hooks",
      "https://user:pass@receiver.example/hooks",
      "https://@receiver.example/hooks",
      "https://receiver.example/hooks#",
      "https://receiver.example/hooks-other",
      "https://receiver.example/hooks/../admin",
      "https://receiver.example/hooks/%2fadmin",
      "https://receiver.example/hooks/..;/admin",
      "https://receiver.example.evil/hooks",
    ])
      expect(() => webhookUrl(url, destinations)).toThrow("destination_denied");
    mocks.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "::ffff:127.0.0.1", family: 6 },
    ]);
    const beforeDispatch = vi.fn();
    await expect(
      httpsWebhookTransport({
        url: new URL(registration().url),
        body: Buffer.from("{}"),
        headers: {},
        signal: new AbortController().signal,
        beforeDispatch,
      }),
    ).rejects.toThrow("destination_denied");
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("pins the validated address, preserves normal TLS, rejects redirects and caps response bytes", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    let status = 302;
    let bytes = 0;
    mocks.request.mockImplementation(
      (
        _url: URL,
        options: RequestOptions,
        callback: (response: IncomingMessage) => void,
      ) => {
        expect(options.agent).toBe(false);
        expect(options.rejectUnauthorized).toBe(true);
        const pinned = vi.fn();
        options.lookup?.("receiver.example", { all: true }, pinned);
        expect(pinned).toHaveBeenCalledWith(null, [
          { address: "8.8.8.8", family: 4 },
        ]);
        const req = new EventEmitter() as EventEmitter & {
          end: () => void;
          destroy: (error: Error) => void;
        };
        req.destroy = (error) => {
          req.emit("error", error);
        };
        req.end = () =>
          queueMicrotask(() => {
            const res = Object.assign(new EventEmitter(), {
              statusCode: status,
            });
            callback(res as IncomingMessage);
            res.emit("data", Buffer.alloc(bytes));
            res.emit("end");
          });
        return req;
      },
    );
    const { service } = fixture();
    const webhook = service.register("owner", registration());
    expect((await service.send("owner", message(webhook.id))).status).toBe(
      "unknown",
    );
    expect(mocks.request).toHaveBeenCalledTimes(1); // No redirect follow-up.
    status = 200;
    bytes = 16385;
    expect(
      (
        await service.send("owner", {
          ...message(webhook.id),
          idempotencyKey: "oversized",
        })
      ).status,
    ).toBe("unknown");
    expect(mocks.lookup).toHaveBeenCalledTimes(2); // No second, unpinned DNS lookup.
  });

  it("includes DNS in the deadline and never dispatches a late resolution", async () => {
    vi.useFakeTimers();
    const dns =
      Promise.withResolvers<Array<{ address: string; family: number }>>();
    mocks.lookup.mockReturnValue(dns.promise);
    const { service } = fixture();
    const webhook = service.register("owner", registration());
    const sending = service.send("owner", message(webhook.id));
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await sending).status).toBe("rejected");
    dns.resolve([{ address: "8.8.8.8", family: 4 }]);
    await Promise.resolve();
    expect(mocks.request).not.toHaveBeenCalled();

    // A deadline after the dispatch marker has a different, uncertain outcome.
    mocks.request.mockImplementation((_url: URL, options: RequestOptions) => {
      const req = Object.assign(new EventEmitter(), { end: () => {} });
      options.signal?.addEventListener(
        "abort",
        () => req.emit("error", new Error("timeout")),
        { once: true },
      );
      return req;
    });
    const second = service.send("owner", {
      ...message(webhook.id),
      idempotencyKey: "network-timeout",
    });
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await second).status).toBe("unknown");
    await service.drain();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});
