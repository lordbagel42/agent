import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it, vi } from "vitest";
import { appReceiptSchema } from "./client.js";
import { createAppsHost } from "./host.js";

const artifact = {
  appId: "counter",
  files: {
    "package.json": '{"type":"module"}',
    "index.js": "export default {}",
  },
};
const viewer = {
  port: 3091,
  publicDomain: "public.example.invalid",
  signedInDomain: "signed.example.invalid",
  issuer: "https://fixture.cloudflareaccess.com",
  audience: "a".repeat(64),
};
const controlToken = "control-fixture-".repeat(3);
const viewerToken = "viewer-fixture-".repeat(3);

it("binds publication to consumed approval, not preparation order, and fences uncertain changes", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "june-viewer-"));
  t.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  let finish = Promise.withResolvers<{ release: string }>();
  let deployments = 0;
  let hold: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const admitted = Promise.withResolvers<void>();
  let currentSource = "public-source";
  const invokedSources: string[] = [];
  const host = createAppsHost({
    database: join(cwd, "state.sqlite"),
    controlToken,
    viewerToken,
    viewer,
    origin: "https://internal.example.invalid",
    binding: "fixture",
    deploy: () => {
      deployments++;
      currentSource = deployments === 1 ? "public-source" : "signed-source";
      return finish.promise;
    },
    serve: async () => {
      if (hold) {
        admitted.resolve();
        await hold.promise;
      }
      invokedSources.push(currentSource);
      return Response.json({ value: 73 });
    },
  });
  t.onTestFinished(async () => {
    hold?.resolve();
    finish.resolve({ release: "cleanup" });
    await host.close();
  });
  const post = (path: string, body: unknown) =>
    host.app.request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const prepare = async (
    access: "public" | "signed-in",
    requestId = "c".repeat(64),
  ) => {
    const response = await post("/control/prepare", {
      artifact,
      jobId: "b".repeat(64),
      requestId,
      access,
    });
    expect(response.status).toBe(200);
    return appReceiptSchema.parse(await response.json());
  };
  // Prepare the private source FIRST, but deploy it LAST. Row order is not activation order.
  const signed = await prepare("signed-in");
  const publicReceipt = await prepare("public");
  expect(signed.id).not.toBe(publicReceipt.id);
  expect(signed.url).toBe(
    "https://counter.signed.example.invalid/apps/counter/",
  );
  expect(publicReceipt.url).toBe(
    "https://counter.public.example.invalid/apps/counter/",
  );
  const published = host.viewer;
  if (!published) throw new Error("missing viewer");
  const read = () => published.request(publicReceipt.url);
  expect((await read()).status).toBe(404);
  await post(`/control/deploy/${publicReceipt.id}`, {});
  expect((await read()).status).toBe(404);
  finish.resolve({ release: "public-release" });
  await expect.poll(async () => (await read()).status).toBe(200);
  expect(await (await read()).json()).toEqual({ value: 73 });
  // The SDK can await an uploaded body before choosing which source to invoke.
  hold = Promise.withResolvers<void>();
  const slowAnonymousRequest = read();
  await admitted.promise;
  finish = Promise.withResolvers();
  await post(`/control/deploy/${signed.id}`, {});
  expect((await read()).status).toBe(404);
  expect(deployments).toBe(1);
  hold.resolve();
  expect((await slowAnonymousRequest).status).toBe(404);
  expect(invokedSources.at(-1)).toBe("public-source");
  await expect.poll(() => deployments).toBe(2);
  finish.resolve({ release: "signed-release" });
  await expect
    .poll(async () => (await published.request(signed.url)).status)
    .toBe(401);
  expect((await read()).status).toBe(404);
  const next = await prepare("public", "d".repeat(64));
  // A new unapproved public proposal cannot widen the running signed-in app.
  expect((await read()).status).toBe(404);
  finish = Promise.withResolvers();
  await post(`/control/deploy/${next.id}`, {});
  finish.reject(new Error("uncertain deployment with PRIVATE DATA"));
  await expect
    .poll(
      async () =>
        (
          await (
            await host.app.request(`/control/receipts/${next.id}`, {
              headers: { authorization: `Bearer ${controlToken}` },
            })
          ).json()
        ).status,
    )
    .toBe("unknown");
  expect((await read()).status).toBe(404);
  await post(`/control/deploy/${publicReceipt.id}`, {});
  expect(deployments).toBe(3);
  expect((await read()).status).toBe(404);
});

it("accepts a non-owner signed-in viewer but rejects forged identity, cross-app access and credential leakage", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "june-viewer-auth-"));
  t.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const keys = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "fixture",
    alg: "RS256",
  };
  vi.stubGlobal("fetch", async (url: URL) => {
    expect(String(url)).toBe(
      "https://fixture.cloudflareaccess.com/cdn-cgi/access/certs",
    );
    return Response.json({ keys: [jwk] });
  });
  t.onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  const sign = (overrides: Record<string, unknown> = {}) =>
    new SignJWT({
      email: "someone-else@example.invalid",
      sub: "not-the-owner",
      type: "app",
      iss: viewer.issuer,
      aud: [viewer.audience],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 120,
      ...overrides,
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .sign(keys.privateKey);
  const events: Record<string, string | number>[] = [];
  const options = {
    database: join(cwd, "state.sqlite"),
    controlToken,
    viewerToken,
    viewer,
    origin: "https://internal.example.invalid",
    binding: "fixture",
    deploy: async () => ({ release: "signed-release" }),
    serve: async (request: Request) => {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        headers[name] = value;
      });
      return Response.json(headers, {
        headers: {
          "set-cookie": "private-cookie",
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=900",
          "cdn-cache-control": "public, max-age=900",
          "cloudflare-cdn-cache-control": "public, max-age=900",
          "surrogate-control": "max-age=900",
          "content-security-policy": "script-src 'self'",
        },
      });
    },
    log: (event: Record<string, string | number>) => events.push(event),
  };
  let host = createAppsHost(options);
  t.onTestFinished(() => host.close());
  const post = (path: string, body: unknown) =>
    host.app.request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const receipt = appReceiptSchema.parse(
    await (
      await post("/control/prepare", {
        artifact,
        jobId: "b".repeat(64),
        requestId: "c".repeat(64),
        access: "signed-in",
      })
    ).json(),
  );
  await post(`/control/deploy/${receipt.id}`, {});
  const jwt = await sign();
  const read = (
    token = jwt,
    url = receipt.url,
    extra: Record<string, string> = {},
  ) => {
    if (!host.viewer) throw new Error("missing viewer");
    return host.viewer.request(url, {
      headers: {
        "cf-access-jwt-assertion": token,
        accept: "application/json",
        ...extra,
      },
    });
  };
  await expect.poll(async () => (await read()).status).toBe(200);
  // Persisted policy survives replacement; it is not a process-local cache.
  await host.close();
  host = createAppsHost(options);
  const response = await read(jwt, receipt.url, {
    authorization: `Bearer ${viewerToken}`,
    cookie: `CF_Authorization=${jwt}`,
    "cf-access-authenticated-user-email": "owner@example.invalid",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accept: "application/json" });
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(response.headers.has("access-control-allow-origin")).toBe(false);
  expect(response.headers.get("cache-control")).toBe("no-store, private");
  expect(response.headers.has("cdn-cache-control")).toBe(false);
  expect(response.headers.has("cloudflare-cdn-cache-control")).toBe(false);
  expect(response.headers.has("surrogate-control")).toBe(false);
  expect(response.headers.get("content-security-policy")).toContain(
    "script-src 'self'",
  );
  for (const invalid of [
    "",
    "forged",
    await sign({ aud: ["another-app"] }),
    await sign({ iss: "https://evil.invalid" }),
    await sign({ exp: 1 }),
    await sign({ email: undefined }),
    await sign({ sub: undefined }),
    await sign({ sub: "", email: undefined, common_name: "service.access" }),
    await sign({ type: "service" }),
  ])
    expect((await read(invalid)).status).toBe(401);
  for (const url of [
    "https://counter.public.example.invalid/apps/counter/",
    "https://other.signed.example.invalid/apps/counter/",
    "https://counter.signed.example.invalid/apps/other/",
    "https://counter.signed.example.invalid/control/apps/counter",
    "https://counter.signed.example.invalid/health/ready",
  ])
    expect((await read(jwt, url)).status).toBe(404);
  expect(
    (
      await read(jwt, receipt.url, {
        origin: "https://other.public.example.invalid",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await read(jwt, receipt.url, {
        "sec-fetch-site": "same-site",
        "sec-fetch-mode": "cors",
      })
    ).status,
  ).toBe(403);
  expect(JSON.stringify(events)).not.toMatch(
    /someone-else|PRIVATE DATA|private-cookie|example\.invalid/,
  );
  expect(JSON.stringify(events)).not.toContain(jwt);
});
