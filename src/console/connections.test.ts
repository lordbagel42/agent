import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { McpConnections } from "../tools/connections.js";
import { createConnectionRoutes } from "./connections.js";

test("connection validation retains safe entries, clears secrets and permits correction without weakening failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connection-form-"));
  const store = new McpConnections({
    directory,
    key: Buffer.alloc(32, 1),
    owner: "owner",
    origin: "https://console.example",
  });
  const base = "/console/connections";
  const app = new Hono().route(
    base,
    createConnectionRoutes(
      {
        origin: "https://console.example",
        csrfSecret: "x".repeat(32),
        authenticate: async () => "owner",
      },
      { store },
    ),
  );
  const proofOf = (markup: string) =>
    markup.match(/name="proof" value="([^"]+)"/)?.[1] ?? "";
  const post = (proof: string, values: Record<string, string>) =>
    app.request(`${base}/add`, {
      method: "POST",
      headers: {
        origin: "https://console.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ proof, ...values }),
    });
  try {
    const proof = proofOf(await (await app.request(base)).text());
    const invalid = await post(proof, {
      name: "Research & notes",
      url: "http://fixture.example/mcp",
      token: "private-fixture-token",
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("cache-control")).toContain("no-store");
    const markup = await invalid.text();
    expect(markup).toContain("Use an HTTPS URL");
    expect(markup).toContain('value="Research &amp; notes"');
    expect(markup).toContain(
      'value="http://fixture.example/mcp" aria-invalid="true"',
    );
    expect(markup).not.toContain("private-fixture-token");
    expect(markup).not.toContain(proof);
    expect(store.list()).toEqual([]);
    const corrected = await post(proofOf(markup), {
      name: "Research & notes",
      url: "https://fixture.example/mcp",
      token: "private-fixture-token",
    });
    expect(corrected.status).toBe(303);
    expect(store.list()).toMatchObject([
      {
        name: "Research & notes",
        url: "https://fixture.example/mcp",
        authenticated: true,
        status: "not_tested",
      },
    ]);
    expect(
      (await app.request(corrected.headers.get("location") ?? "")).status,
    ).toBe(200);

    for (const url of [
      "malformed-private-url",
      "https://user:private-pass@fixture.example/mcp",
      "https://fixture.example/mcp?key=private-query",
      "https://fixture.example/mcp#private-fragment",
    ]) {
      const response = await post(proof, {
        name: "Safe name",
        url,
        token: "private-fixture-token",
      });
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain('value="Safe name"');
      expect(body).not.toContain(url);
      for (const secret of [
        "private-pass",
        "private-query",
        "private-fragment",
        "private-fixture-token",
      ])
        expect(body).not.toContain(secret);
    }
    const tokenError = await post(proof, {
      name: "Safe name",
      url: "https://fixture.example/mcp",
      token: "Bearer private-token",
    });
    expect(tokenError.status).toBe(400);
    expect(await tokenError.text()).toContain(
      'id="token" name="token" type="password" maxlength="4000" autocomplete="off" aria-invalid="true"',
    );
    const nameError = await post(proof, {
      name: " ",
      url: "https://fixture.example/mcp",
    });
    expect(nameError.status).toBe(400);
    expect(await nameError.text()).toContain(
      "Enter a name of 1–80 characters.",
    );
    expect(
      (
        await post("invalid-private-proof", {
          name: "Safe",
          url: "https://fixture.example/mcp",
        })
      ).status,
    ).toBe(403);

    const failure = vi.spyOn(store, "add").mockImplementation(() => {
      throw new Error("private-storage-failure");
    });
    const failed = await post(proof, {
      name: "Safe",
      url: "https://fixture.example/mcp",
      token: "private-fixture-token",
    });
    expect(failed.status).toBe(503);
    const failureMarkup = await failed.text();
    expect(failureMarkup).toContain("No success has been confirmed");
    expect(failureMarkup).not.toContain("private-storage-failure");
    expect(failureMarkup).not.toContain("private-fixture-token");
    expect(failureMarkup).not.toContain(proof);
    expect(failureMarkup).not.toContain('action="/console/connections/add"');
    failure.mockRestore();
    for (let i = 1; i < 20; i++)
      store.add({ name: `Server ${i}`, url: "https://fixture.example/mcp" });
    const limit = await post(proof, {
      name: "One too many",
      url: "https://fixture.example/extra",
    });
    expect(limit.status).toBe(400);
    expect(await limit.text()).toContain("20-connection limit");
    expect(store.list()).toHaveLength(20);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
