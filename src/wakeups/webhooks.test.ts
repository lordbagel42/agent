import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import type { WakeupEvent } from "./state.js";
import { createWakeupWebhooks } from "./webhooks.js";

it("authenticates raw bytes, fixes source identity, and ACKs only durable acceptance", async () => {
  const key = "a".repeat(48);
  const events: WakeupEvent[] = [];
  let unavailable = false;
  let accepted = true;
  const app = createWakeupWebhooks({
    sources: { build: key },
    async publish(event) {
      if (unavailable) throw new Error("storage unavailable");
      events.push(event);
      return { accepted, duplicate: false };
    },
  });
  const body = JSON.stringify({
    id: "delivery-1",
    type: "finished",
    data: { result: "ok" },
  });
  const request = (
    text = body,
    timestamp = String(Math.floor(Date.now() / 1000)),
    signatureBody = text,
  ) =>
    app.request("/build", {
      method: "POST",
      headers: {
        "x-june-timestamp": timestamp,
        "x-june-signature": `v1=${createHmac("sha256", key).update(`${timestamp}.${signatureBody}`).digest("hex")}`,
      },
      body: text,
    });
  expect((await request(`${body} `, undefined, body)).status).toBe(401);
  expect(
    (await request(body, String(Math.floor(Date.now() / 1000) - 3600))).status,
  ).toBe(401);
  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"id":"invalid-utf8","type":"finished","data":{"text":"'),
    Buffer.from([0x80]),
    Buffer.from('"}}'),
  ]);
  const timestamp = String(Math.floor(Date.now() / 1000));
  expect(
    (
      await app.request("/build", {
        method: "POST",
        headers: {
          "x-june-timestamp": timestamp,
          "x-june-signature": `v1=${createHmac("sha256", key)
            .update(`${timestamp}.${invalidUtf8.toString("utf8")}`)
            .digest("hex")}`,
        },
        body: invalidUtf8,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request(
        JSON.stringify({
          id: "spoof",
          source: "deployment",
          type: "healthy",
          data: {},
        }),
      )
    ).status,
  ).toBe(400);
  expect(events).toHaveLength(0);
  expect((await request()).status).toBe(202);
  expect(events[0]).toMatchObject({
    id: "delivery-1",
    source: "webhook.build",
    type: "finished",
    data: { result: "ok" },
  });
  unavailable = true;
  expect((await request()).status).toBe(503);
  unavailable = false;
  accepted = false;
  expect((await request()).status).toBe(503);
  expect(
    (
      await request(
        JSON.stringify({
          id: "large",
          type: "finished",
          data: { text: "x".repeat(20_000) },
        }),
      )
    ).status,
  ).toBe(413);
});
