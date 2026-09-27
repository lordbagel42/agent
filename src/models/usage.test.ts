import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { createConsoleRoutes } from "../console/routes.js";
import { createModelProvider } from "./provider.js";
import { tokenUsage, UsageLedger } from "./usage.js";

test("usage persists only allowlisted counters and remains owner-only in HTML and exports", async () => {
  const root = mkdtempSync(join(tmpdir(), "june-usage-privacy-"));
  const path = join(root, "usage.sqlite");
  let ledger = new UsageLedger(path);
  try {
    const sentinel = "PRIVATE-PROMPT-CREDENTIAL-REPLY-SENTINEL";
    const model = createModelProvider({
      protocol: "openai",
      model: "fixture-model",
      apiKey: sentinel,
      usage: ledger,
      fetch: async () =>
        Response.json({
          status: "completed",
          usage: {
            input_tokens: 321,
            output_tokens: 47,
            input_tokens_details: { cached_tokens: 123, private: sentinel },
            output_tokens_details: { reasoning_tokens: 19 },
            private: sentinel,
          },
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ text: sentinel }),
                },
              ],
            },
          ],
        }),
    });
    await model.reply({
      system: sentinel,
      messages: [{ role: "user", content: sentinel }],
      workspaces: [],
      usageStage: "synthesis",
    });
    ledger.close();
    ledger = new UsageLedger(path);
    expect(readFileSync(path).includes(Buffer.from(sentinel))).toBe(false);
    expect(statSync(path).mode & 0o077).toBe(0);
    const usage = vi.fn(
      async (_principal: string, days: number, selected: string) =>
        ledger.snapshot(days, selected),
    );
    const app = new Hono().route(
      "/console",
      createConsoleRoutes({
        security: {
          origin: "https://private.example",
          csrfSecret: "x".repeat(32),
          authenticate: async (request) =>
            request.headers.get("test-owner") === "yes" ? "owner" : undefined,
        },
        inspect: async () => ({ observedAt: "now", sections: {} }),
        usage,
      }),
    );
    for (const endpoint of ["/console/usage", "/console/usage/export"]) {
      expect((await app.request(endpoint)).status).toBe(401);
      expect(usage).not.toHaveBeenCalled();
    }
    const response = await app.request("/console/usage/export", {
      headers: { "test-owner": "yes" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.text();
    expect(body).not.toContain(sentinel);
    expect(JSON.parse(body).total).toMatchObject({
      calls: 1,
      input: 321,
      output: 47,
      cached: 123,
      reasoning: 19,
    });
    expect(JSON.parse(body).byStage[0].label).toBe("synthesis");
    const html = await (
      await app.request("/console/usage", { headers: { "test-owner": "yes" } })
    ).text();
    expect(html).toContain("Token intelligence");
    expect(html).not.toContain(sentinel);
    expect(ledger.snapshot(7, "not-recorded").total).toMatchObject({
      calls: 0,
      measured: 0,
      input: null,
      output: null,
    });
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("telemetry settlement failure cannot turn a completed external call into a retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "june-usage-settlement-"));
  const path = join(root, "usage.sqlite");
  const ledger = new UsageLedger(path);
  try {
    const result = await ledger.track(
      { provider: "codex", model: "fixture", stage: "fast" },
      async (report) => {
        report(
          tokenUsage("codex", {
            input_tokens: 37,
            cached_input_tokens: 11,
            cache_write_input_tokens: 3,
            output_tokens: 23,
            reasoning_output_tokens: 5,
          }),
        );
        ledger.close();
        return "external effect already completed";
      },
    );
    expect(result).toBe("external effect already completed");
    const reopened = new UsageLedger(path);
    try {
      expect(reopened.snapshot().recent[0]).toMatchObject({
        status: "pending",
        input: null,
        output: null,
      });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
