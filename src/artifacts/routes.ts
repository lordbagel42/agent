import { randomBytes } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { artifactId } from "./contracts.js";
import { type ArtifactRenderer, artifactAsset } from "./render.js";
import { mergeScene, parseScene } from "./scene.js";
import type { ArtifactService } from "./service.js";
import { artifactPage, HTML_CSP } from "./view.js";

export function createArtifactRoutes(
  service: ArtifactService,
  renderer: ArtifactRenderer,
  options: { allowLoopbackHttp?: boolean; shutdown?: AbortSignal } = {},
) {
  const origin = new URL(service.options.origin);
  if (
    origin.protocol !== "https:" &&
    !(
      options.allowLoopbackHttp &&
      origin.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(origin.hostname)
    )
  )
    throw new Error("artifact_https_required");
  const app = new Hono<{ Variables: { nonce: string } }>();
  let viewers = 0;
  const writes = new Map<string, { count: number; until: number }>();
  app.onError((_error, c) => c.json({ error: "artifact_unavailable" }, 503));
  app.use("*", bodyLimit({ maxSize: 1_100_000 }));
  app.use("*", async (c, next) => {
    const nonce = randomBytes(18).toString("base64url");
    c.set("nonce", nonce);
    c.header("Cache-Control", "no-store, private");
    // Preserve the same-origin form's Origin header without leaking URLs to
    // external sites. Chromium sends Origin: null under no-referrer.
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
    c.header(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self' https://app.slack.com https://*.slack.com`,
    );
    if (c.req.method !== "GET" && c.req.header("origin") !== origin.origin)
      return c.json({ error: "origin_denied" }, 403);
    await next();
  });
  app.get("/artifacts/assets/*", async (c) => {
    try {
      const asset = await artifactAsset(
        renderer.assets,
        c.req.path.slice("/artifacts/assets/".length),
      );
      return new Response(asset.bytes, {
        headers: {
          "content-type": asset.type,
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return c.notFound();
    }
  });
  app.use("/artifacts/:id/*", async (c, next) => {
    const id = c.req.param("id");
    if (!artifactId.safeParse(id).success || !service.store.get(id))
      return c.notFound();
    await next();
  });
  app.get("/artifacts/:id/", (c) =>
    c.html(
      artifactPage(
        c.req.param("id"),
        c.get("nonce"),
        !service.store.authorized(
          c.req.param("id"),
          getCookie(c, "june_artifact"),
        ),
      ),
    ),
  );
  app.post("/artifacts/:id/unlock", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    // No untrusted forwarded IP headers: the artifact-wide budget remains active.
    let peer = "unknown";
    try {
      peer = getConnInfo(c).remote.address ?? peer;
    } catch {
      /* In-process tests have no socket. */
    }
    const token = service.store.unlock(
      id,
      typeof form.pin === "string" ? form.pin : "",
      peer,
    );
    if (!token)
      return c.html(artifactPage(id, c.get("nonce"), true, true), 403);
    setCookie(c, "june_artifact", token, {
      path: `/artifacts/${id}/`,
      httpOnly: true,
      secure: origin.protocol === "https:",
      sameSite: "Lax",
      maxAge: 3600,
    });
    return c.redirect(`/artifacts/${id}/`, 303);
  });
  app.get("/artifacts/:id/preview.png", async (c) => {
    const id = c.req.param("id");
    const record = service.store.get(id);
    if (!record) return c.notFound();
    const locked = !service.store.authorized(id, getCookie(c, "june_artifact"));
    const workflow = locked ? undefined : await service.view(record);
    const bytes = await renderer.render(record, workflow, locked);
    if (!locked && record.kind === "workflow") await service.view(record);
    const latest = service.store.get(id);
    if (
      !latest ||
      latest.generation !== record.generation ||
      latest.revision !== record.revision ||
      (!locked && !service.store.authorized(id, getCookie(c, "june_artifact")))
    )
      return c.json({ error: "artifact_changed" }, 409);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "image/png",
        "cache-control": "no-store, private",
      },
    });
  });
  app.use("/artifacts/:id/*", async (c, next) => {
    if (
      !service.store.authorized(
        c.req.param("id"),
        getCookie(c, "june_artifact"),
      )
    )
      return c.json({ error: "pin_required" }, 401);
    await next();
  });
  app.get("/artifacts/:id/document", (c) => {
    const record = service.store.get(c.req.param("id"));
    if (record?.kind !== "html") return c.notFound();
    c.header("Content-Security-Policy", HTML_CSP);
    return c.html(record.content);
  });
  app.get("/artifacts/:id/data", async (c) => {
    const id = c.req.param("id");
    const record = service.store.get(id);
    if (!record) return c.notFound();
    let workflow: Awaited<ReturnType<typeof service.view>>;
    try {
      workflow = await service.view(record);
    } catch {
      return c.json({ error: "artifact_revoked" }, 410);
    }
    if (
      !service.store.authorized(id, getCookie(c, "june_artifact")) ||
      service.store.get(id)?.generation !== record.generation
    )
      return c.json({ error: "pin_required" }, 401);
    const { title, kind, visibility, revision, generation, content } = record;
    return c.json({
      title,
      kind,
      visibility,
      revision,
      generation,
      content,
      workflow,
    });
  });
  app.post("/artifacts/:id/scene", async (c) => {
    const id = c.req.param("id");
    const budget = writes.get(id);
    if (budget && budget.until > Date.now()) {
      if (++budget.count > 30) return c.json({ error: "rate_limited" }, 429);
    } else writes.set(id, { count: 1, until: Date.now() + 1000 });
    const body = z
      .strictObject({ generation: z.number().int(), elements: z.unknown() })
      .parse(await c.req.json());
    const record = service.store.get(id);
    if (
      record?.kind !== "board" ||
      record.generation !== body.generation ||
      !service.store.authorized(id, getCookie(c, "june_artifact"))
    )
      return c.json({ error: "artifact_changed" }, 409);
    const elements = mergeScene(
      parseScene(JSON.parse(record.content)),
      parseScene(body.elements),
    );
    const updated = service.store.updateScene(
      id,
      record.generation,
      JSON.stringify(elements),
    );
    return c.json({ revision: updated.revision });
  });
  app.get("/artifacts/:id/events", (c) => {
    if (viewers >= 64) return c.json({ error: "viewer_limit" }, 503);
    const id = c.req.param("id");
    const generation = service.store.get(id)?.generation;
    const token = getCookie(c, "june_artifact");
    viewers++;
    return streamSSE(c, async (stream) => {
      try {
        while (!stream.aborted && !options.shutdown?.aborted) {
          if (
            !service.store.authorized(id, token) ||
            service.store.get(id)?.generation !== generation
          ) {
            await stream.writeSSE({ data: "locked" });
            break;
          }
          await stream.writeSSE({ data: "refresh" });
          await stream.sleep(2000);
        }
      } finally {
        viewers--;
      }
    });
  });
  return app;
}
