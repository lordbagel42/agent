import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CapabilityBroker } from "../tools/broker.js";
import { OpaqueActionLinks } from "./opaque.js";

test("GET is inert; concurrent POSTs consume same grant once; audience and revocation enforced", async () => {
  let calls = 0;
  const broker = new CapabilityBroker(":memory:", {
    owner: "owner",
    resolveCredential: async () => "secret",
    tools: {
      send: {
        execute: async () => {
          calls++;
        },
      },
    },
  });
  const links = new OpaqueActionLinks(broker);
  const action = {
    tool: "send",
    account: "a",
    item: "i",
    origin: "https://example.com",
    arguments: {},
  };
  const grant = broker.grant("owner", {
    audience: "worker",
    action,
    expiresAt: Date.now() + 60_000,
  });
  const token = links.issue("owner", grant, Date.now() + 30_000);
  expect(() => links.inspect("stranger", token)).toThrow();
  expect(links.inspect("worker", token).status).toBe("ready");
  expect(links.inspect("worker", token).status).toBe("ready");
  expect(calls).toBe(0);
  const receipts = await Promise.all(
    Array.from({ length: 8 }, () => links.redeem("worker", token, action)),
  );
  expect(new Set(receipts.map((r) => r.id)).size).toBe(1);
  expect(calls).toBe(1);
  expect((await links.redeem("worker", token, action)).status).toBe(
    "succeeded",
  );
  links.revoke("owner", token);
  expect(() => links.inspect("worker", token)).toThrow();
  broker.close();
});

test("separate SQLite connections share atomic consumption; stored links are digests only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "links-"));
  const path = join(dir, "db");
  let calls = 0;
  const options = {
    owner: "owner",
    resolveCredential: async () => "secret",
    tools: {
      send: {
        execute: async () => {
          calls++;
        },
      },
    },
  };
  const first = new CapabilityBroker(path, options);
  const second = new CapabilityBroker(path, options);
  try {
    const links = new OpaqueActionLinks(first);
    const other = new OpaqueActionLinks(second);
    const action = {
      tool: "send",
      account: "a",
      item: "i",
      origin: "https://example.com",
      arguments: {},
    };
    const grant = first.grant("owner", {
      audience: "worker",
      action,
      expiresAt: Date.now() + 60_000,
    });
    const token = links.issue("owner", grant, Date.now() + 30_000);
    const before = readFileSync(`${path}-wal`);
    links.inspect("worker", token);
    expect(readFileSync(`${path}-wal`)).toEqual(before);
    const receipts = await Promise.all([
      links.redeem("worker", token, action),
      other.redeem("worker", token, action),
    ]);
    expect(receipts[0]?.id).toBe(receipts[1]?.id);
    expect(calls).toBe(1);
    expect(readFileSync(`${path}-wal`).includes(Buffer.from(token))).toBe(
      false,
    );
    expect(readFileSync(path).includes(Buffer.from(token))).toBe(false);
    second.revoke("owner", grant);
    expect(() => links.redeem("worker", token, action)).toThrow();
  } finally {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("link expiry and owner-only creation/revocation are enforced", () => {
  let now = 100;
  const broker = new CapabilityBroker(":memory:", {
    owner: "owner",
    now: () => now,
    resolveCredential: async () => null,
    tools: { send: { execute: async () => {} } },
  });
  const links = new OpaqueActionLinks(broker);
  const action = {
    tool: "send",
    account: "a",
    item: "i",
    origin: "https://example.com",
    arguments: {},
  };
  const grant = broker.grant("owner", {
    audience: "worker",
    action,
    expiresAt: 300,
  });
  expect(() => links.issue("worker", grant, 200)).toThrow();
  expect(() => links.issue("owner", grant, 301)).toThrow();
  const token = links.issue("owner", grant, 200);
  expect(() => links.revoke("worker", token)).toThrow();
  expect(() => links.inspect("worker", "not-a-token")).toThrow();
  now = 200;
  expect(() => links.inspect("worker", token)).toThrow();
  expect(() => links.redeem("worker", token, action)).toThrow();
  broker.close();
});
