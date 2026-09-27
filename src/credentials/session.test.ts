import { execFileSync } from "node:child_process";
import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createBitwardenCredentialResolver } from "./bitwarden.js";
import { createBitwardenFileSession } from "./session.js";

test("lease reads are lazy, private, bounded, fresh and fail closed without exposing content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "june-lease-"));
  const path = join(directory, "session.json");
  const session = createBitwardenFileSession(path);
  const lease = { key: "synthetic-session", expiresAt: 200 };
  try {
    await expect(session()).rejects.toThrow(/^credential_unavailable$/);
    await writeFile(path, JSON.stringify(lease), { mode: 0o600 });
    expect(await session()).toEqual(lease);
    await writeFile(path, JSON.stringify({ ...lease, key: "rotated-fixture" }));
    expect(await session()).toEqual({ ...lease, key: "rotated-fixture" });
    await chmod(path, 0o640);
    await expect(session()).rejects.toThrow(/^credential_unavailable$/);
    await chmod(path, 0o600);

    const alias = join(directory, "alias.json");
    await symlink(path, alias);
    await expect(createBitwardenFileSession(alias)()).rejects.toThrow(
      /^credential_unavailable$/,
    );
    await rm(alias);
    await link(path, alias);
    await expect(session()).rejects.toThrow(/^credential_unavailable$/);
    await rm(alias);
    execFileSync("mkfifo", [alias]);
    await expect(createBitwardenFileSession(alias)()).rejects.toThrow(
      /^credential_unavailable$/,
    );
    await expect(createBitwardenFileSession(directory)()).rejects.toThrow(
      /^credential_unavailable$/,
    );

    for (const content of [
      "synthetic-invalid-json-secret",
      JSON.stringify({ key: "synthetic-session", expiresAt: "200" }),
      JSON.stringify({ ...lease, key: "x".repeat(4096) }),
    ]) {
      await writeFile(path, content);
      await expect(session()).rejects.toThrow(/^credential_unavailable$/);
    }
    await writeFile(path, JSON.stringify(lease));
    const binding = {
      account: "fixture",
      item: "login",
      origin: "https://fixture.example",
      vaultItemId: "12345678-1234-1234-1234-123456789abc",
      field: "login" as const,
    };
    let calls = 0;
    const resolve = createBitwardenCredentialResolver(
      {
        executable: "/usr/bin/bw",
        appDataDir: directory,
        bindings: [binding],
        session,
        now: () => 200,
      },
      async () => {
        calls++;
        return "must not execute";
      },
    );
    await expect(resolve(binding)).rejects.toThrow(/^credential_unavailable$/);
    expect(calls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
