/** Read-only synthetic console. No June config, credentials, or provider calls. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createConsoleRoutes } from "../src/console/routes.js";
import { UsageLedger } from "../src/models/usage.js";

const root = mkdtempSync(join(tmpdir(), "june-usage-preview-"));
const now = Date.now();
const day = 86_400_000;
const start = Math.floor(now / day) * day - 31 * day;
const port = Number(process.env.PORT ?? 4271);
const ledger = new UsageLedger(join(root, "usage.sqlite"));
const empty = new UsageLedger(join(root, "empty.sqlite"));
const db = new DatabaseSync(join(root, "usage.sqlite"));
db.prepare("UPDATE usage_meta SET value = ? WHERE key = 'since'").run(start);
const insert = db.prepare(
  "INSERT INTO usage_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
db.exec("BEGIN");
for (let i = 0; i < 32 * 24; i++) {
  const started = start + i * 3_600_000 + ((i * 17) % 60) * 60_000;
  if (started > now || i % 7 === 0 || i % 24 < 5) continue;
  for (let j = 0; j < 1 + (i % 5); j++) {
    const partial = i % 29 === 0;
    const zero = i % 43 === 0;
    const input = zero ? 0 : 4_000 + ((i * 919 + j * 2371) % 87_000);
    const output = zero ? 0 : 130 + ((i * 97 + j * 67) % 2_800);
    insert.run(
      `fixture-${i}-${j}`,
      started,
      i % 3 ? "codex" : "anthropic",
      partial ? "demo-unreported" : i % 3 ? "demo-astra" : "demo-sonnet",
      ["fast", "execution", "synthesis", "deep", "reflection"][i % 5],
      partial ? "pending" : i % 23 === 0 ? "failed" : "completed",
      partial ? null : 1800 + ((i * 1291 + j * 1537) % 52_000),
      partial ? null : input,
      partial || i % 37 === 0 ? null : output,
      partial ? null : Math.floor(input * 0.72),
      partial ? null : 0,
      partial || i % 37 === 0 ? null : Math.floor(output * 0.23),
    );
  }
}
db.exec("COMMIT");
db.close();

const app = new Hono();
app.use("*", async (c, next) => {
  await next();
  if (c.res.headers.get("content-type")?.includes("text/html")) {
    const body = await c.res.text();
    c.res = new Response(
      body.replace(
        '<header class="page-header">',
        '<p class="hint">Synthetic preview · no live data or connected services</p><header class="page-header">',
      ),
      c.res,
    );
  }
});
for (const base of ["console", "empty", "denied"]) {
  app.route(
    `/${base}`,
    createConsoleRoutes({
      security: {
        origin: `http://127.0.0.1:${port}`,
        csrfSecret: randomBytes(32).toString("hex"),
        authenticate: async () =>
          base === "denied" ? undefined : "synthetic-owner",
      },
      inspect: async () => ({
        observedAt: new Date(now).toISOString(),
        sections: {},
      }),
      usage: async (_principal, days, model) =>
        (base === "empty" ? empty : ledger).snapshot(days, model, now),
    }),
  );
}
app.get("/", (c) => c.redirect("/console/usage"));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
console.log(`Synthetic usage preview listening on port ${port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      ledger.close();
      empty.close();
      rmSync(root, { recursive: true, force: true });
      process.exit(0);
    });
  });
}
