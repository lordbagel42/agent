import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { afterEach, expect, it, vi } from "vitest";
import { createDebugSite } from "./server.js";
import { DiagnosticStore } from "./store.js";

const origin = "https://debug.example.test";
const viewerToken = "synthetic-viewer-token".padEnd(48, "v");
const ingestToken = "synthetic-ingest-token".padEnd(48, "i");
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest();
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});

// Real P-256 signatures and WebAuthn wire data, not a mocked verifier.
function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const id = randomBytes(32);
  const key = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x as string, "base64url")],
      [-3, Buffer.from(jwk.y as string, "base64url")],
    ]),
  );
  const clientData = (type: string, challenge: string, clientOrigin = origin) =>
    Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: clientOrigin,
        crossOrigin: false,
      }),
    );
  const authData = (
    flags: number,
    counter: number,
    rp = "debug.example.test",
  ) => {
    const data = Buffer.alloc(37);
    digest(rp).copy(data);
    data[32] = flags;
    data.writeUInt32BE(counter, 33);
    return data;
  };
  return {
    id: id.toString("base64url"),
    register(challenge: string, flags = 0x45): RegistrationResponseJSON {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(id.length);
      return {
        id: id.toString("base64url"),
        rawId: id.toString("base64url"),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData("webauthn.create", challenge).toString(
            "base64url",
          ),
          attestationObject: Buffer.from(
            isoCBOR.encode(
              new Map<string, string | Uint8Array | Map<string, never>>([
                ["fmt", "none"],
                ["attStmt", new Map<string, never>()],
                [
                  "authData",
                  Buffer.concat([
                    authData(flags, 0),
                    Buffer.alloc(16),
                    length,
                    id,
                    key,
                  ]),
                ],
              ]),
            ),
          ).toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    authenticate(
      challenge: string,
      userHandle: string,
      settings: {
        counter?: number;
        flags?: number;
        origin?: string;
        rp?: string;
      } = {},
    ): AuthenticationResponseJSON {
      const data = authData(
        settings.flags ?? 5,
        settings.counter ?? 1,
        settings.rp,
      );
      const client = clientData("webauthn.get", challenge, settings.origin);
      return {
        id: id.toString("base64url"),
        rawId: id.toString("base64url"),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          authenticatorData: data.toString("base64url"),
          clientDataJSON: client.toString("base64url"),
          signature: sign(
            "sha256",
            Buffer.concat([data, digest(client)]),
            privateKey,
          ).toString("base64url"),
          userHandle,
        },
      };
    },
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "june-passkeys-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "archive.sqlite");
  let store = new DiagnosticStore(file);
  let clock = 1000;
  const options = () => ({
    origin,
    viewerToken,
    ingestToken,
    store,
    assets: directory,
    now: () => clock,
  });
  let app = createDebugSite(options());
  cleanup.push(() => store.close());
  function browser() {
    const cookies = new Map<string, string>();
    return async (
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const response = await app.request(`${origin}/api${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin,
          "content-type": "application/json",
          cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      for (const item of response.headers.getSetCookie()) {
        const [name, value] = item.split(";")[0]?.split("=") ?? [];
        if (name) cookies.set(name, value ?? "");
      }
      return response;
    };
  }
  const owner = browser();
  const device = authenticator();
  async function enroll() {
    expect((await owner("/session", { token: viewerToken })).status).toBe(200);
    const response = await owner("/passkeys/register/options", {});
    expect(response.status).toBe(200);
    const options = await response.json();
    expect(options).toMatchObject({
      rp: { id: "debug.example.test" },
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });
    expect(
      (
        await owner("/passkeys/register/verify", {
          name: "Test laptop",
          response: device.register(options.challenge),
        })
      ).status,
    ).toBe(201);
    return options.user.id as string;
  }
  return {
    owner,
    device,
    browser,
    enroll,
    send: (request: Request) => app.fetch(request),
    advance: (ms: number) => {
      clock += ms;
    },
    restart: () => {
      store.close();
      store = new DiagnosticStore(file);
      app = createDebugSite(options());
    },
  };
}

it("persists enrolled passkeys across restart, signs in without the viewer token, and revokes sessions when a key is removed", async () => {
  const f = fixture();
  const user = await f.enroll();
  f.restart();
  const request = f.browser();
  const options = await (await request("/passkeys/login/options", {})).json();
  expect(options.allowCredentials ?? []).toEqual([]);
  const response = await request(
    "/passkeys/login/verify",
    f.device.authenticate(options.challenge, user),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect((await request("/snapshots")).status).toBe(200);
  expect(await (await request("/passkeys")).json()).toMatchObject({
    items: [{ id: f.device.id, name: "Test laptop" }],
  });
  const another = f.browser();
  await another("/session", { token: viewerToken });
  expect((await another(`/passkeys/${f.device.id}/delete`, {})).status).toBe(
    200,
  );
  expect((await request("/snapshots")).status).toBe(401);
  expect((await another("/snapshots")).status).toBe(401);
  const retry = await (await request("/passkeys/login/options", {})).json();
  expect(
    (
      await request(
        "/passkeys/login/verify",
        f.device.authenticate(retry.challenge, user, { counter: 2 }),
      )
    ).status,
  ).toBe(400);
  expect((await another("/session", { token: viewerToken })).status).toBe(200);
  expect(await (await another("/passkeys")).json()).toEqual({ items: [] });
});

it("requires recent browser authentication and same origin for enrollment/removal, never the ingest token", async () => {
  const f = fixture();
  expect((await f.owner("/passkeys")).status).toBe(401);
  expect(
    (
      await f.owner(
        "/passkeys/register/options",
        {},
        { authorization: `Bearer ${ingestToken}` },
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await f.owner(
        "/passkeys/register/options",
        {},
        { origin: "https://attacker.test" },
      )
    ).status,
  ).toBe(403);
  await f.enroll();
  f.advance(5 * 60_000 + 1);
  expect((await f.owner("/snapshots")).status).toBe(200);
  for (const path of [
    "/passkeys/register/options",
    `/passkeys/${f.device.id}/delete`,
  ]) {
    const response = await f.owner(path, {});
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "reauthentication_required",
    });
  }
});

it("makes challenges browser-bound, expiring and single-use, and requires registration user verification", async () => {
  const f = fixture();
  await f.owner("/session", { token: viewerToken });
  const options = await (
    await f.owner("/passkeys/register/options", {})
  ).json();
  const withoutUV = {
    name: "Unsafe",
    response: f.device.register(options.challenge, 0x41),
  };
  expect((await f.owner("/passkeys/register/verify", withoutUV)).status).toBe(
    400,
  );
  const correct = {
    name: "Laptop",
    response: f.device.register(options.challenge),
  };
  expect((await f.owner("/passkeys/register/verify", correct)).status).toBe(
    400,
  );
  const user = await f.enroll();
  const a = f.browser();
  const b = f.browser();
  const login = await (await a("/passkeys/login/options", {})).json();
  const assertion = f.device.authenticate(login.challenge, user);
  expect((await b("/passkeys/login/verify", assertion)).status).toBe(400);
  const attempts = await Promise.all([
    a("/passkeys/login/verify", assertion),
    a("/passkeys/login/verify", assertion),
  ]);
  expect(attempts.map((r) => r.status).sort()).toEqual([200, 400]);
  const stale = await (await b("/passkeys/login/options", {})).json();
  f.advance(5 * 60_000);
  expect(
    (
      await b(
        "/passkeys/login/verify",
        f.device.authenticate(stale.challenge, user, { counter: 2 }),
      )
    ).status,
  ).toBe(400);
});

it("rejects wrong origin/RP/user/signature/UV and old counters but accepts zero-counter synced passkeys", async () => {
  const f = fixture();
  const user = await f.enroll();
  const request = f.browser();
  for (const settings of [
    { origin: "https://attacker.test" },
    { rp: "example.test" },
    { flags: 1 },
  ]) {
    const options = await (await request("/passkeys/login/options", {})).json();
    expect(
      (
        await request(
          "/passkeys/login/verify",
          f.device.authenticate(options.challenge, user, settings),
        )
      ).status,
    ).toBe(400);
  }
  for (const defect of ["user", "signature"]) {
    const options = await (await request("/passkeys/login/options", {})).json();
    const response = f.device.authenticate(
      options.challenge,
      defect === "user" ? "wrong-owner" : user,
    );
    if (defect === "signature")
      response.response.signature = randomBytes(72).toString("base64url");
    expect((await request("/passkeys/login/verify", response)).status).toBe(
      400,
    );
  }
  for (const [counter, status] of [
    [0, 200],
    [0, 200],
    [2, 200],
    [1, 400],
    [2, 400],
  ]) {
    const options = await (await request("/passkeys/login/options", {})).json();
    expect(
      (
        await request(
          "/passkeys/login/verify",
          f.device.authenticate(options.challenge, user, { counter }),
        )
      ).status,
    ).toBe(status);
  }
});

it("does not create a session when sign-out happens during signature verification", async () => {
  const f = fixture();
  const user = await f.enroll();
  const request = f.browser();
  const options = await (await request("/passkeys/login/options", {})).json();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const verify = crypto.subtle.verify.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
    entered.resolve();
    await resume.promise;
    return verify(...args);
  });
  const pending = request(
    "/passkeys/login/verify",
    f.device.authenticate(options.challenge, user),
  );
  await entered.promise;
  expect(
    (
      await request(
        "/passkeys/login/verify",
        f.device.authenticate(options.challenge, user),
      )
    ).status,
  ).toBe(400);
  expect((await request("/logout", {})).status).toBe(200);
  resume.resolve();
  expect((await pending).status).toBe(400);
  expect((await request("/snapshots")).status).toBe(401);
});

it("revokes a completed sign-in even when its cookie response arrives after logout", async () => {
  const f = fixture();
  const user = await f.enroll();
  const request = f.browser();
  const optionsResponse = await request("/passkeys/login/options", {});
  const options = await optionsResponse.json();
  const cookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
  // Server finishes, but the browser has not received the new session headers.
  const held = await f.send(
    new Request(`${origin}/api/passkeys/login/verify`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: cookie(optionsResponse),
      },
      body: JSON.stringify(f.device.authenticate(options.challenge, user)),
    }),
  );
  expect(held.status).toBe(200);
  await request("/logout", {});
  expect(
    (await request("/snapshots", undefined, { cookie: cookie(held) })).status,
  ).toBe(401);
});

it("fences a viewer-token sign-in admitted before passkey removal, but permits fresh recovery", async () => {
  const f = fixture();
  await f.enroll();
  const reading = Promise.withResolvers<void>();
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        writer = controller;
      },
      pull() {
        reading.resolve();
      },
    },
    { highWaterMark: 0 },
  );
  const pending = f.send(
    new Request(`${origin}/api/session`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: string }),
  );
  await reading.promise;
  expect((await f.owner(`/passkeys/${f.device.id}/delete`, {})).status).toBe(
    200,
  );
  writer.enqueue(
    new TextEncoder().encode(JSON.stringify({ token: viewerToken })),
  );
  writer.close();
  const rejected = await pending;
  expect(rejected.status).toBe(400);
  expect(
    rejected.headers
      .getSetCookie()
      .some((v) => v.startsWith("__Host-june-debug=")),
  ).toBe(false);
  expect((await f.owner("/session", { token: viewerToken })).status).toBe(200);
});
