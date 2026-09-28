import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { eventSchema, type WakeupEvent } from "./state.js";

export interface GitHubWebhooks {
  secret: string;
  publish(
    event: WakeupEvent,
  ): Promise<{ accepted: boolean; duplicate: boolean }>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const identifier = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
const text = (value: unknown, max = 300) =>
  typeof value === "string" && Buffer.byteLength(JSON.stringify(value)) <= max
    ? value
    : undefined;
const sensitiveKey =
  /token|secret|password|authorization|credential|private_key/i;

/** Provider context is untrusted data. The type is deliberately not an enum:
 * new GitHub event families do not require another decision workflow. */
function normalize(
  id: string,
  type: string,
  body: Record<string, unknown>,
  occurredAt: number,
): WakeupEvent {
  const repository = record(body.repository);
  const installation = record(body.installation);
  const sender = record(body.sender);
  const truncation = {
    truncated: false,
    omittedPaths: [] as string[],
    omittedPathCount: 0,
  };
  const omit = (path: string) => {
    truncation.truncated = true;
    truncation.omittedPathCount++;
    if (truncation.omittedPaths.length < 20)
      truncation.omittedPaths.push(
        text(path, 120) ?? "[path omitted: too long]",
      );
  };
  const resources: Record<string, unknown>[] = [];
  for (const [kind, value] of Object.entries(body)) {
    if (sensitiveKey.test(kind)) continue;
    if (["repository", "installation", "sender"].includes(kind)) continue;
    const resource = record(value);
    if (resource.id === undefined && resource.number === undefined) continue;
    if (resources.length >= 12) {
      omit(`resources.${kind}`);
      continue;
    }
    resources.push({
      kind: text(kind, 80) ?? "[resource kind omitted]",
      id: identifier(resource.id) ?? text(resource.id, 100),
      number: identifier(resource.number),
      url: text(resource.html_url ?? resource.url, 500),
    });
  }
  // Bounded recursion and node/byte budgets avoid retaining a large raw payload.
  // Reserve half the envelope for normalized lookup context and omission markers.
  let budget = 7500;
  let nodes = 0;
  const copy = (value: unknown, path: string, depth: number): unknown => {
    if (++nodes > 500 || depth > 8 || budget <= 0) {
      omit(path);
      return undefined;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      const size = Buffer.byteLength(JSON.stringify(value));
      if (size > Math.min(budget, 2048)) {
        omit(path);
        return undefined;
      }
      budget -= size;
      return value;
    }
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        if (nodes >= 500 || budget <= 0) {
          omit(`${path}[${i}:]`);
          break;
        }
        const child = copy(value[i], `${path}[${i}]`, depth + 1);
        result.push(child ?? null);
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(record(value))) {
      if (nodes >= 500 || budget <= 0) {
        omit(`${path}.*`);
        break;
      }
      if (sensitiveKey.test(key) || key.length > 100) {
        omit(`${path}.${key}`);
        continue;
      }
      budget -= Buffer.byteLength(JSON.stringify(key)) + 4;
      const copied = copy(child, `${path}.${key}`, depth + 1);
      if (copied !== undefined) result[key] = copied;
    }
    return result;
  };
  const event = {
    id,
    source: "github",
    type,
    occurredAt,
    data: {
      schemaVersion: 1,
      action: text(body.action, 100),
      installation:
        installation.id !== undefined
          ? { id: identifier(installation.id) }
          : undefined,
      repository:
        repository.id !== undefined
          ? {
              id: identifier(repository.id),
              fullName: text(repository.full_name),
              url: text(repository.html_url, 500),
            }
          : undefined,
      sender:
        sender.id !== undefined
          ? { id: identifier(sender.id), login: text(sender.login, 100) }
          : undefined,
      resources,
      payload: copy(body, "payload", 0),
      truncation,
    },
  };
  // Normalize absent fields as JSON and enforce the actual UTF-8 envelope size.
  if (Buffer.byteLength(JSON.stringify(event)) > 16_384) {
    event.data.payload = {};
    omit("payload");
  }
  while (
    Buffer.byteLength(JSON.stringify(event)) > 16_384 &&
    resources.length
  ) {
    resources.pop();
    omit("resources");
  }
  return eventSchema.parse(JSON.parse(JSON.stringify(event)));
}

export function createGitHubWebhooks(deps: GitHubWebhooks) {
  if (deps.secret.length < 32) throw new Error("invalid_github_webhook_secret");
  const app = new Hono();
  app.use(
    "*",
    bodyLimit({
      maxSize: 25 * 1024 * 1024,
      onError: (c) => c.json({ error: "body_too_large" }, 413),
    }),
  );
  app.post("/", async (c) => {
    c.header("Cache-Control", "no-store");
    const occurredAt = Date.now();
    const signature = c.req.header("x-hub-signature-256") ?? "";
    if (!/^sha256=[a-f0-9]{64}$/.test(signature))
      return c.json({ error: "unauthorized" }, 401);
    const raw = Buffer.from(await c.req.arrayBuffer());
    const expected = createHmac("sha256", deps.secret).update(raw).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex")))
      return c.json({ error: "unauthorized" }, 401);
    // HMAC covers body bytes, not these transport headers. No header grants authority.
    const id = c.req.header("x-github-delivery") ?? "";
    const type = c.req.header("x-github-event") ?? "";
    if (
      !/^[a-zA-Z0-9-]{1,256}$/.test(id) ||
      !/^[a-z][a-z0-9_]{0,99}$/.test(type)
    )
      return c.json({ error: "invalid_event" }, 400);
    let event: WakeupEvent;
    try {
      const value: unknown = JSON.parse(raw.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid_body");
      event = normalize(id, type, record(value), occurredAt);
    } catch {
      return c.json({ error: "invalid_event" }, 400);
    }
    try {
      const result = await deps.publish(event);
      if (!result.accepted) throw new Error("not_admitted");
      return c.json(result, 202);
    } catch {
      c.header("Retry-After", "5");
      return c.json({ error: "admission_unavailable" }, 503);
    }
  });
  return app;
}
