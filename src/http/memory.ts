import { Hono } from "hono";
import { z } from "zod";
import type { CuratedPersonalityStore } from "../memory/curated.js";
import type { EvidenceStore } from "../memory/store.js";

const id = z.string().min(1).max(2048);

/** Mount ONLY behind the host's owner bearer authentication. No model access. */
export function createMemoryRoutes(deps: {
  store: EvidenceStore;
  personality?: CuratedPersonalityStore;
  audience(value: unknown): string;
  forget(audience: string, sourceId: string): Promise<void>;
}) {
  const app = new Hono();
  app.onError((_error, c) => c.json({ error: "memory_request_rejected" }, 400));
  app.get("/", (c) => {
    const audience = deps.audience(c.req.query("audience"));
    return c.json({
      ...deps.store.retrieve(audience, c.req.query("query") ?? ""),
      proposals: deps.store.proposals(audience),
      personality: deps.personality?.effectiveTraits(audience) ?? {},
      revisions: deps.personality?.ownerHistory() ?? null,
    });
  });
  app.get("/tombstones", (c) => {
    if (Object.values(c.req.queries()).some((values) => values.length !== 1))
      throw new Error("Invalid tombstone export query");
    const integer = z
      .string()
      .regex(/^(0|[1-9]\d{0,15})$/)
      .transform(Number);
    const { audience, ...options } = z
      .strictObject({
        audience: id.optional(),
        after: integer.optional(),
        watermark: integer.optional(),
        limit: integer.optional(),
      })
      .parse(c.req.query());
    deps.audience(audience);
    // Ledger-wide owner export. Tombstones intentionally retain no audiences.
    return c.json(deps.store.exportTombstones(options));
  });
  app.get("/backup", (c) => c.json(deps.store.backupStatus()));
  app.post("/backup", async (c) => {
    const input = z
      .strictObject({
        id: z.string().regex(/^[a-f0-9]{64}$/),
        confirmed: z.literal(true),
      })
      .parse(await c.req.json());
    return c.json({ manifest: deps.store.backup(input.id) });
  });
  app.post("/proposals/:id/review", async (c) => {
    const input = z
      .strictObject({
        audience: id.optional(),
        decision: z.enum(["accepted", "rejected"]),
      })
      .parse(await c.req.json());
    deps.store.reviewProposal(
      deps.audience(input.audience),
      id.parse(c.req.param("id")),
      input.decision,
    );
    return c.json({ reviewed: true });
  });
  app.post("/forget", async (c) => {
    const input = z
      .strictObject({
        audience: id.optional(),
        sourceId: id,
        confirmed: z.literal(true),
      })
      .parse(await c.req.json());
    const audience = deps.audience(input.audience);
    if (
      !deps.store.source(audience, input.sourceId) &&
      !deps.store.isDeleted(input.sourceId)
    )
      return c.json({ error: "not_found" }, 404);
    // Ledger first. A crash before working-context cleanup still fails closed
    // at runtime source revalidation; retry repeats the remaining cleanup.
    deps.store.deleteSource(input.sourceId);
    deps.personality?.forgetGlobalProposals();
    await deps.forget(audience, input.sourceId);
    return c.json({ forgotten: true, physicalPurge: false });
  });
  if (deps.personality) {
    const personality = deps.personality;
    app.post("/personality/revise", async (c) => {
      const input = z
        .strictObject({
          audience: id.optional(),
          id: z.uuid(),
          trait: z.enum(["verbosity", "tone", "humor", "interests"]),
          value: z.string().min(1).max(2000),
          basis: z.enum(["owner-correction", "inferred"]),
          evidenceIds: z.array(id).min(1).max(100),
          explanation: z.string().min(1).max(2000),
          confidence: z.number().min(0).max(1),
          confirmed: z.literal(true),
        })
        .parse(await c.req.json());
      const scope = deps.audience(input.audience);
      const maxAge = 604800000;
      const { audience: _audience, confirmed: _confirmed, ...proposal } = input;
      const commit = personality.ownerRevise(
        { ...proposal, scope },
        deps.store.reflectionEvidence(scope, input.evidenceIds, maxAge),
        Date.now(),
        maxAge,
      );
      return c.json({ commit });
    });
    app.post("/personality/rollback", async (c) => {
      const input = z
        .strictObject({
          id: z.uuid(),
          target: id,
          explanation: z.string().min(1).max(2000),
          confirmed: z.literal(true),
        })
        .parse(await c.req.json());
      return c.json({
        commit: personality.ownerRollback(
          input.id,
          input.target,
          input.explanation,
          Date.now(),
        ),
      });
    });
  }
  return app;
}
