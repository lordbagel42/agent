import { createHash } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { ImportedMemoryExtraction } from "../imports/extraction.js";
import type { HistoryImports } from "../imports/index.js";
import { ImportBudgetExceeded, type ImportCoverage } from "../memory/store.js";

/** Mount behind owner bearer auth. A selection is not consent to fetch it.
 * Every page requires exact coverage confirmation and the expected page count;
 * a lost response cannot advance another page with the same confirmation.
 */
export function createImportRoutes(
  imports: HistoryImports,
  selections: Record<string, ImportCoverage>,
  extraction?: ImportedMemoryExtraction,
) {
  const approved = Object.fromEntries(
    Object.entries(selections).map(([id, coverage]) => [
      id,
      {
        coverage: structuredClone(coverage),
        digest: createHash("sha256")
          .update(JSON.stringify([id, coverage]))
          .digest("hex"),
      },
    ]),
  );
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof ImportBudgetExceeded
      ? c.json(
          {
            error: "import_budget_exceeded",
            dimension: error.dimension,
            reason: error.message,
          },
          409,
        )
      : c.json({ error: "import_request_rejected" }, 400),
  );
  app.get("/", (c) =>
    c.json(
      Object.fromEntries(
        Object.entries(approved).map(([id, selection]) => [
          id,
          {
            ...selection,
            ...imports.status(id),
          },
        ]),
      ),
    ),
  );
  app.post("/:id/start", async (c) => {
    const id = c.req.param("id");
    const selection = Object.hasOwn(approved, id) ? approved[id] : undefined;
    if (!selection) return c.json({ error: "not_found" }, 404);
    const input = z
      .strictObject({
        confirmed: z.literal(true),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        expectedPages: z.number().int().nonnegative().safe(),
      })
      .parse(await c.req.json());
    if (
      input.digest !== selection.digest ||
      input.expectedPages !== (imports.status(id).progress?.pages ?? 0)
    )
      return c.json({ error: "import_review_changed" }, 409);
    // beginImport durably binds the approved coverage before credential lookup.
    return c.json(await imports.start(id));
  });
  app.post("/:id/cancel", (c) => c.json(imports.cancel(c.req.param("id"))));
  app.get("/:id/extraction", (c) =>
    extraction
      ? c.json(extraction.review(c.req.param("id")))
      : c.json({ error: "extraction_unavailable" }, 503),
  );
  app.post("/:id/extraction/start", async (c) => {
    if (!extraction) return c.json({ error: "extraction_unavailable" }, 503);
    const input = z
      .strictObject({
        confirmed: z.literal(true),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(await c.req.json());
    const id = c.req.param("id");
    if (extraction.review(id).digest !== input.digest)
      return c.json({ error: "extraction_review_changed" }, 409);
    return c.json(await extraction.start(id, input.digest));
  });
  app.post("/:id/extraction/cancel", async (c) => {
    if (!extraction) return c.json({ error: "extraction_unavailable" }, 503);
    const input = z
      .strictObject({
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(await c.req.json());
    return c.json(extraction.cancel(c.req.param("id"), input.digest));
  });
  return app;
}
