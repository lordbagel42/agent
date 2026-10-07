import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { assert, expect, test, vi } from "vitest";
import { createConsoleRoutes } from "../console/routes.js";
import { usagePage } from "../console/usage.js";
import { createModelProvider } from "./provider.js";
import { tokenUsage, UsageLedger } from "./usage.js";

test("usage circles stay separated in every window without distorting relative areas", async () => {
  const root = mkdtempSync(join(tmpdir(), "june-usage-spacing-"));
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  const now = Date.parse("2026-10-07T12:30:00Z");
  const clock = vi.spyOn(Date, "now");
  try {
    const hours = [
      { calls: 4, input: 250 },
      { calls: 4, input: 1000 },
      { calls: 1, input: 250 },
      { calls: 1, input: null },
      { calls: 1, input: 0 },
    ];
    for (const [i, hour] of hours.entries()) {
      clock.mockReturnValue(now - (4 - i) * 3_600_000);
      for (let call = 0; call < hour.calls; call++) {
        await ledger.track(
          { provider: "openai", model: "spacing", stage: "fast" },
          async (report) => {
            report({
              input: hour.input,
              output: hour.input === null ? null : 0,
              cached: null,
              cacheWrite: null,
              reasoning: null,
            });
          },
        );
      }
    }
    for (const days of [1, 7, 30]) {
      for (const metric of ["tokens", "calls"] as const) {
        const markup = String(
          await usagePage(ledger.snapshot(days, "", now), "nonce", "/console", {
            metric,
          }),
        );
        const chart =
          markup.match(/<svg class="usage-chart"[\s\S]*?<\/svg>/)?.[0] ?? "";
        const circles = [
          ...chart.matchAll(
            /<circle class="usage-(?:bubble|unknown)" cx="([^"]+)" cy="([^"]+)" r="([^"]+)"/g,
          ),
        ].map((match) => ({
          x: Number(match[1]),
          y: Number(match[2]),
          r: Number(match[3]),
        }));
        expect(circles).toHaveLength(metric === "tokens" ? 4 : 5);
        for (const [i, a] of circles.entries()) {
          for (const b of circles.slice(i + 1)) {
            // Include the non-scaling 1.3px outline at the narrowest chart width.
            const gap =
              (Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r) * 0.68 - 1.3;
            expect(gap, `${days}d ${metric}`).toBeGreaterThan(1);
          }
        }
        const [first, second] = circles;
        assert(first && second);
        expect((second.r / first.r) ** 2).toBeCloseTo(
          metric === "tokens" ? 4 : 1,
        );
      }
    }
  } finally {
    clock.mockRestore();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("hourly activity covers the full filtered window, including calls beyond the recent limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "june-usage-hours-"));
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  const now = Date.parse("2026-10-05T12:30:00Z");
  const clock = vi.spyOn(Date, "now");
  const record = async (
    started: number,
    model: string,
    input: number | null,
    output: number | null,
  ) => {
    clock.mockReturnValue(started);
    await ledger.track(
      { provider: "openai", model, stage: "fast" },
      async (report) => {
        report({
          input,
          output,
          cached: null,
          cacheWrite: null,
          reasoning: null,
        });
      },
    );
  };
  try {
    const from = now - 7 * 86_400_000;
    await record(from - 1, "selected", 999, 999);
    for (let i = 0; i < 101; i++) await record(from + i, "selected", 1, 2);
    await record(from + 3_600_000, "selected", 13, null);
    await record(from + 3_600_000, "other", 31, 7);
    await record(now, "selected", null, null);
    await record(now + 1, "selected", 999, 999);
    const snapshot = ledger.snapshot(7, "selected", now);
    expect(snapshot.recent).toHaveLength(100);
    expect(snapshot.activity).toEqual([
      expect.objectContaining({
        label: Math.floor(from / 3_600_000),
        calls: 101,
        measured: 101,
        input: 101,
        output: 202,
      }),
      expect.objectContaining({
        label: Math.floor(from / 3_600_000) + 1,
        calls: 1,
        measured: 0,
        input: 13,
        output: null,
      }),
      expect.objectContaining({
        label: Math.floor(now / 3_600_000),
        calls: 1,
        measured: 0,
        input: null,
        output: null,
      }),
    ]);
    expect(ledger.snapshot(1, "other", now).activity).toEqual([]);
    expect(ledger.snapshot(30, "other", now).activity).toEqual([
      expect.objectContaining({ calls: 1, input: 31, output: 7 }),
    ]);
  } finally {
    clock.mockRestore();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP outcomes include reply validation without losing consumed tokens", async () => {
  const root = mkdtempSync(join(tmpdir(), "june-usage-outcomes-"));
  const ledger = new UsageLedger(join(root, "usage.sqlite"));
  try {
    for (const protocol of ["openai", "anthropic"] as const) {
      for (const scenario of [
        "success",
        "schema",
        "text",
        "body",
        "network",
      ] as const) {
        const measured = !["body", "network"].includes(scenario);
        const model = `${protocol}-${scenario}`;
        const provider = createModelProvider({
          protocol,
          model,
          apiKey: "fixture",
          usage: ledger,
          fetch: async () => {
            if (scenario === "network") throw new TypeError("offline");
            if (scenario === "body") return new Response("not JSON");
            const text =
              scenario === "text"
                ? "not JSON"
                : JSON.stringify({
                    text: scenario === "schema" ? 42 : "hello",
                  });
            const usage = {
              input_tokens: 101,
              output_tokens: 23,
              input_tokens_details: { cached_tokens: 17 },
              cache_read_input_tokens: 17,
              cache_creation_input_tokens: 5,
            };
            return Response.json(
              protocol === "openai"
                ? {
                    status: "completed",
                    usage,
                    output: [
                      {
                        type: "message",
                        role: "assistant",
                        status: "completed",
                        content: [{ type: "output_text", text }],
                      },
                    ],
                  }
                : {
                    type: "message",
                    role: "assistant",
                    stop_reason: "end_turn",
                    usage,
                    content: [{ type: "text", text }],
                  },
            );
          },
        });
        const reply = provider.reply({
          system: "fixture",
          messages: [],
          workspaces: [],
          usageStage: "synthesis",
        });
        if (scenario === "success")
          await expect(reply).resolves.toEqual({ text: "hello" });
        else
          await expect(reply).rejects.toMatchObject({
            code:
              scenario === "schema"
                ? "invalid_response"
                : scenario === "network"
                  ? "network_error"
                  : "malformed_response",
          });
        const snapshot = ledger.snapshot(7, model);
        expect(snapshot.total).toMatchObject({
          calls: 1,
          failed: scenario === "success" ? 0 : 1,
          pending: 0,
          measured: measured ? 1 : 0,
          input: measured ? (protocol === "openai" ? 101 : 123) : null,
          output: measured ? 23 : null,
          cached: measured ? 17 : null,
        });
        expect(snapshot.recent[0]).toMatchObject({
          status: scenario === "success" ? "completed" : "failed",
          stage: "synthesis",
        });
      }
    }
    expect(ledger.snapshot().total).toMatchObject({
      calls: 10,
      failed: 8,
      measured: 6,
      pending: 0,
      input: 672,
      output: 138,
    });
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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
    expect(html).toContain("<h1>Usage</h1>");
    expect(html).not.toContain(sentinel);
    const callsHtml = await (
      await app.request(
        "/console/usage?days=1&model=fixture-model&metric=calls",
        {
          headers: { "test-owner": "yes" },
        },
      )
    ).text();
    expect(callsHtml).toContain('data-metric="calls"');
    expect(callsHtml).toContain('name="metric" value="calls"');
    expect(callsHtml).toContain(
      "/console/usage?days=30&amp;model=fixture-model&amp;metric=calls",
    );
    expect(callsHtml).toContain(
      "/console/usage?days=1&amp;model=fixture-model&amp;metric=tokens",
    );
    expect(callsHtml).toContain(
      "/console/usage/export?days=1&amp;model=fixture-model",
    );
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
