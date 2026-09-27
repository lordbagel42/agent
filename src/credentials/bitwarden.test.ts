import { expect, test } from "vitest";
import {
  type BitwardenBinding,
  createBitwardenCredentialResolver,
} from "./bitwarden.js";

const binding: BitwardenBinding = {
  account: "mail",
  item: "login",
  origin: "https://mail.example",
  vaultItemId: "12345678-1234-1234-1234-123456789abc",
  field: "login",
};
const item = {
  id: binding.vaultItemId,
  type: 1,
  login: {
    username: "private-user",
    password: "private-password",
    totp: "private-seed",
  },
  notes: "private-note",
};

test("inspection projects only bounded configuration metadata without obtaining secrets or mutating bindings", async () => {
  const bindings = Array.from({ length: 11 }, (_, index) => ({
    ...binding,
    account: `private-account-${index}`,
  }));
  let sessions = 0;
  let reads = 0;
  const resolver = createBitwardenCredentialResolver(
    {
      executable: "/private/bw-executable",
      appDataDir: "/private/bw-profile",
      bindings,
      now: () => 100,
      session: async () => {
        sessions++;
        return { key: "private-session", expiresAt: 200 };
      },
    },
    async () => {
      reads++;
      return JSON.stringify(item);
    },
  );
  // Both caller-owned input and returned metadata are detached from the resolver.
  bindings[0] = { ...binding, account: "replacement", field: "bearer" };
  bindings.push({ ...binding, account: "added-later" });
  const metadata = resolver.inspect();
  expect(metadata).toEqual({
    configuredBindings: 11,
    bindings: Array.from({ length: 10 }, (_, index) => ({
      binding: index + 1,
      field: "login",
    })),
  });
  metadata.bindings[0] = { binding: 1, field: "bearer" };
  expect(resolver.inspect().bindings[0]).toEqual({
    binding: 1,
    field: "login",
  });
  expect(sessions).toBe(0);
  expect(reads).toBe(0);
  expect(await resolver({ ...binding, account: "private-account-0" })).toEqual({
    kind: "login",
    username: "private-user",
    password: "private-password",
  });
  expect(resolver.inspect().bindings[0]).toEqual({
    binding: 1,
    field: "login",
  });
  expect(sessions).toBe(1);
  expect(reads).toBe(1);
});

test("only exact owner-bound scopes release requested fields without session arguments or inherited env", async () => {
  let calls = 0;
  let sessions = 0;
  const resolver = createBitwardenCredentialResolver(
    {
      executable: "/usr/bin/bw",
      appDataDir: "/private/bw",
      bindings: [binding],
      now: () => 100,
      session: async () => {
        sessions++;
        return { key: "private-session", expiresAt: 200 };
      },
    },
    async (executable, args, options) => {
      calls++;
      expect(executable).toBe("/usr/bin/bw");
      expect(args).toEqual([
        "get",
        "item",
        binding.vaultItemId,
        "--nointeraction",
      ]);
      expect(options.env).toEqual({
        PATH: "/usr/local/bin:/usr/bin:/bin",
        BITWARDENCLI_APPDATA_DIR: "/private/bw",
        BW_SESSION: "private-session",
      });
      expect(options.timeout).toBe(100);
      return JSON.stringify(item);
    },
  );
  for (const scope of [
    { ...binding, account: "other" },
    { ...binding, item: "other" },
    { ...binding, origin: "https://mail.example.evil" },
  ])
    await expect(resolver(scope)).rejects.toThrow("credential_unavailable");
  expect(sessions).toBe(0);
  expect(calls).toBe(0);
  expect(await resolver(binding)).toEqual({
    kind: "login",
    username: "private-user",
    password: "private-password",
  });
  expect(calls).toBe(1);
  const bearer = createBitwardenCredentialResolver(
    {
      executable: "/usr/bin/bw",
      appDataDir: "/private/bw",
      bindings: [{ ...binding, field: "bearer" }],
      now: () => 100,
      session: async () => ({ key: "private-session", expiresAt: 200 }),
    },
    async () => JSON.stringify(item),
  );
  expect(await bearer(binding)).toEqual({ bearerToken: "private-password" });
});

test("expired leases, wrong vault identities and secret-bearing transport errors fail closed", async () => {
  for (const failure of [
    "expired-before",
    "expired-after",
    "wrong-id",
    "transport",
  ]) {
    let now = 100;
    let calls = 0;
    const resolver = createBitwardenCredentialResolver(
      {
        executable: "/usr/bin/bw",
        appDataDir: "/private/bw",
        bindings: [binding],
        now: () => now,
        session: async () => ({
          key: "private-session",
          expiresAt: failure === "expired-before" ? 100 : 200,
        }),
      },
      async () => {
        calls++;
        if (failure === "transport")
          throw new Error("private-session private-password");
        if (failure === "expired-after") now = 200;
        return JSON.stringify({
          ...item,
          id: failure === "wrong-id" ? "other" : item.id,
        });
      },
    );
    await expect(resolver(binding)).rejects.toThrow(/^credential_unavailable$/);
    expect(calls).toBe(failure === "expired-before" ? 0 : 1);
  }
});
