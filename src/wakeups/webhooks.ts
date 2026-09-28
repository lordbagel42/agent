import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { eventSchema, type WakeupEvent } from "./state.js";

const payload = z.strictObject({
  id: z.string().min(1).max(256),
  type: z.string().min(1).max(100),
  data: z.record(z.string(), z.unknown()),
});
export interface WakeupWebhooks {
  /** Independently scoped HMAC credentials, never operator/deployment tokens. */
  sources: Record<string, string>;
  publish(
    event: WakeupEvent,
  ): Promise<{ accepted: boolean; duplicate: boolean }>;
}

export function createWakeupWebhooks(deps: WakeupWebhooks) {
  if (
    new Set(Object.values(deps.sources)).size !==
    Object.keys(deps.sources).length
  )
    throw new Error("webhook_sources_require_distinct_credentials");
  for (const [name, key] of Object.entries(deps.sources))
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(name) || key.length < 32)
      throw new Error("invalid_webhook_configuration");
  const app = new Hono();
  app.use(
    "*",
    bodyLimit({
      maxSize: 16_384,
      onError: (c) => c.json({ error: "body_too_large" }, 413),
    }),
  );
  app.post("/:source", async (c) => {
    c.header("Cache-Control", "no-store");
    const source = c.req.param("source");
    const key = Object.hasOwn(deps.sources, source)
      ? deps.sources[source]
      : undefined;
    const timestamp = c.req.header("x-june-timestamp") ?? "";
    const signature = c.req.header("x-june-signature") ?? "";
    if (
      !key ||
      !/^\d{10}$/.test(timestamp) ||
      Math.abs(Date.now() - Number(timestamp) * 1000) > 300_000 ||
      !/^v1=[a-f0-9]{64}$/.test(signature)
    )
      return c.json({ error: "unauthorized" }, 401);
    const raw = Buffer.from(await c.req.arrayBuffer());
    const expected = createHmac("sha256", key)
      .update(`${timestamp}.`)
      .update(raw)
      .digest();
    if (!timingSafeEqual(Buffer.from(signature.slice(3), "hex"), expected))
      return c.json({ error: "unauthorized" }, 401);
    let event: WakeupEvent;
    try {
      // The signature timestamp is transport freshness, not event occurrence.
      // Observe receipt in milliseconds so a new watch works in the same second.
      event = eventSchema.parse({
        ...payload.parse(JSON.parse(raw.toString("utf8"))),
        source: `webhook.${source}`,
        occurredAt: Date.now(),
      });
    } catch {
      return c.json({ error: "invalid_event" }, 400);
    }
    try {
      const receipt = await deps.publish(event);
      if (!receipt.accepted) throw new Error("event_not_accepted");
      return c.json(receipt, 202);
    } catch {
      c.header("Retry-After", "5");
      return c.json({ error: "storage_unavailable" }, 503);
    }
  });
  return app;
}
