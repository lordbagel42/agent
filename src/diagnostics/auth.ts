import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { DiagnosticStore } from "./store.js";

const SESSION_MS = 8 * 60 * 60 * 1000;
const CEREMONY_MS = 5 * 60 * 1000;
const hash = (value: string) => createHash("sha256").update(value).digest();
interface Browser {
  id: string;
  expires: number;
}
type AuthEnv = {
  Variables: { authEpoch: number; browser: Browser | undefined };
};
interface Challenge {
  kind: "register" | "login";
  value: string;
  expires: number;
  session: string | undefined;
  epoch: number;
  used: boolean;
  browser: Browser;
}

/** Viewer authentication belongs to this independent site, never June. */
export function createDebugAuth(options: {
  origin: string;
  viewerToken: string;
  store: DiagnosticStore;
  now?: () => number;
}) {
  const app = new Hono<AuthEnv>();
  const now = options.now ?? Date.now;
  const origin = new URL(options.origin);
  const secure = origin.protocol === "https:";
  const cookie = secure ? "__Host-june-debug" : "june-debug-dev";
  const challengeCookie = `${cookie}-ceremony`;
  const browserCookie = `${cookie}-browser`;
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: "Strict" as const,
    path: "/",
  };
  // Browser identity survives ceremony/session rotation so logout also revokes
  // a successful sign-in whose Set-Cookie has not arrived in another tab yet.
  const browsers = new Map<string, Browser>();
  const sessions = new Map<string, { at: number; browser: Browser }>();
  const challenges = new Map<string, Challenge>();
  let epoch = 0;
  const viewer = hash(options.viewerToken);
  const matches = (value: unknown) =>
    typeof value === "string" &&
    value.length <= 4096 &&
    timingSafeEqual(hash(value), viewer);
  let loginWindow = 0;
  let loginAttempts = 0;
  let passkeyWindow = 0;
  let passkeyAttempts = 0;

  const prune = () => {
    for (const [id, { at }] of sessions)
      if (at + SESSION_MS <= now()) sessions.delete(id);
    for (const [id, challenge] of challenges)
      if (challenge.expires <= now()) challenges.delete(id);
    for (const [id, browser] of browsers)
      if (browser.expires <= now()) browsers.delete(id);
  };
  const authenticated = (request: Request, session?: string) => {
    prune();
    if (request.headers.has("authorization"))
      return matches(
        /^Bearer (.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1],
      );
    return !!session && sessions.has(session);
  };
  const session = (c: Context) => {
    prune();
    return sessions.get(getCookie(c, cookie) ?? "")?.at;
  };
  const recent = (c: Context) => {
    const at = session(c);
    return at !== undefined && at + CEREMONY_MS > now();
  };
  const activeBrowser = (c: Context<AuthEnv>) => {
    const browser = c.get("browser");
    return c.get("authEpoch") === epoch &&
      browser &&
      browsers.get(browser.id) === browser &&
      browser.expires > now()
      ? browser
      : undefined;
  };
  const signIn = (c: Context<AuthEnv>) => {
    prune();
    const browser = activeBrowser(c);
    if (!browser) return c.json({ error: "signin_revoked" }, 400);
    const previous = getCookie(c, cookie);
    if (previous) sessions.delete(previous);
    if (sessions.size >= 64) return c.json({ error: "session_capacity" }, 503);
    const id = randomBytes(32).toString("base64url");
    sessions.set(id, { at: now(), browser });
    setCookie(c, cookie, id, { ...cookieOptions, maxAge: SESSION_MS / 1000 });
    browser.expires = now() + SESSION_MS;
    setCookie(c, browserCookie, browser.id, {
      ...cookieOptions,
      maxAge: SESSION_MS / 1000,
    });
    return c.json({ authenticated: true });
  };
  const remember = (
    c: Context<AuthEnv>,
    kind: Challenge["kind"],
    value: string,
  ) => {
    prune();
    const browser = activeBrowser(c);
    if (!browser) return false;
    const previous = getCookie(c, challengeCookie);
    if (previous) challenges.delete(previous);
    if (challenges.size >= 64) return false;
    const id = randomBytes(32).toString("base64url");
    challenges.set(id, {
      kind,
      value,
      expires: now() + CEREMONY_MS,
      session: kind === "register" ? getCookie(c, cookie) : undefined,
      epoch,
      used: false,
      browser,
    });
    setCookie(c, challengeCookie, id, {
      ...cookieOptions,
      maxAge: CEREMONY_MS / 1000,
    });
    return true;
  };
  const consume = (c: Context<AuthEnv>, kind: Challenge["kind"]) => {
    const id = getCookie(c, challengeCookie) ?? "";
    const challenge = challenges.get(id);
    const valid =
      challenge &&
      !challenge.used &&
      challenge.kind === kind &&
      challenge.browser === activeBrowser(c) &&
      challenge.expires > now() &&
      challenge.epoch === epoch &&
      (kind !== "register" || challenge.session === getCookie(c, cookie));
    // Single use before yielding; retain identity so logout can revoke work
    // already inside asynchronous cryptographic verification.
    if (challenge) challenge.used = true;
    return valid ? challenge : undefined;
  };
  const finish = (c: Context<AuthEnv>, challenge: Challenge) => {
    const id = getCookie(c, challengeCookie) ?? "";
    const valid =
      challenges.get(id) === challenge &&
      challenge.browser === activeBrowser(c) &&
      challenge.expires > now() &&
      challenge.epoch === epoch;
    challenges.delete(id);
    return valid;
  };
  app.use("*", async (c, next) => {
    if (
      c.req.method === "POST" &&
      (c.req.header("origin") !== options.origin ||
        c.req.header("sec-fetch-site") === "cross-site")
    )
      return c.json({ error: "origin_rejected" }, 403);
    // Admission precedes bodyLimit and JSON parsing, which can both yield.
    c.set("authEpoch", epoch);
    prune();
    c.set("browser", browsers.get(getCookie(c, browserCookie) ?? ""));
    await next();
  });
  const identifyBrowser = (c: Context<AuthEnv>) => {
    if (c.get("browser")) return true;
    if (browsers.size >= 128) return false;
    const browser = {
      id: randomBytes(32).toString("base64url"),
      expires: now() + CEREMONY_MS,
    };
    browsers.set(browser.id, browser);
    c.set("browser", browser);
    return true;
  };
  app.get("/session", (c) =>
    c.json({ authenticated: authenticated(c.req.raw, getCookie(c, cookie)) }),
  );
  app.post(
    "/session",
    bodyLimit({
      maxSize: 8192,
      onError: (c) => c.json({ error: "request_too_large" }, 413),
    }),
    async (c) => {
      if (now() - loginWindow >= 60_000) {
        loginWindow = now();
        loginAttempts = 0;
      }
      if (++loginAttempts > 10) {
        c.header("Retry-After", "60");
        return c.json({ error: "rate_limited" }, 429);
      }
      if (c.req.header("content-type")?.split(";")[0] !== "application/json")
        return c.json({ error: "json_required" }, 415);
      const body = await c.req.json().catch(() => null);
      if (!matches(body?.token)) return c.json({ error: "unauthorized" }, 401);
      if (!identifyBrowser(c))
        return c.json({ error: "session_capacity" }, 503);
      return signIn(c);
    },
  );
  app.post("/logout", (c) => {
    const browser = c.get("browser");
    if (browser) {
      browsers.delete(browser.id);
      for (const [id, session] of sessions)
        if (session.browser === browser) sessions.delete(id);
      for (const [id, challenge] of challenges)
        if (challenge.browser === browser) challenges.delete(id);
    }
    const id = getCookie(c, cookie);
    if (id) sessions.delete(id);
    challenges.delete(getCookie(c, challengeCookie) ?? "");
    deleteCookie(c, cookie, cookieOptions);
    deleteCookie(c, challengeCookie, cookieOptions);
    deleteCookie(c, browserCookie, cookieOptions);
    return c.json({ authenticated: false });
  });

  app.use(
    "/passkeys/*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: "request_too_large" }, 413),
    }),
  );
  app.use("/passkeys/*", async (c, next) => {
    if (c.req.method === "POST") {
      if (c.req.header("content-type")?.split(";")[0] !== "application/json")
        return c.json({ error: "json_required" }, 415);
      if (now() - passkeyWindow >= 60_000) {
        passkeyWindow = now();
        passkeyAttempts = 0;
      }
      if (++passkeyAttempts > 60) {
        c.header("Retry-After", "60");
        return c.json({ error: "rate_limited" }, 429);
      }
    }
    await next();
  });
  app.post("/passkeys/login/options", async (c) => {
    if (!identifyBrowser(c)) return c.json({ error: "session_capacity" }, 503);
    // Discoverable credentials: don't publish the owner's credential IDs.
    const result = await generateAuthenticationOptions({
      rpID: origin.hostname,
      userVerification: "required",
    });
    if (!remember(c, "login", result.challenge))
      return c.json({ error: "rate_limited" }, 429);
    const browser = c.get("browser");
    if (browser)
      setCookie(c, browserCookie, browser.id, {
        ...cookieOptions,
        maxAge: SESSION_MS / 1000,
      });
    return c.json(result);
  });
  app.post("/passkeys/login/verify", async (c) => {
    const body = await c.req.json().catch(() => null);
    const challenge = consume(c, "login");
    if (
      !challenge ||
      typeof body?.id !== "string" ||
      body.response?.userHandle !==
        Buffer.from(options.store.passkeyUserId()).toString("base64url")
    )
      return c.json({ error: "passkey_rejected" }, 400);
    const key = options.store.passkeys().find((key) => key.id === body.id);
    if (!key) return c.json({ error: "passkey_rejected" }, 400);
    const result = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: challenge.value,
      expectedOrigin: options.origin,
      expectedRPID: origin.hostname,
      credential: key,
      requireUserVerification: true,
    }).catch(() => null);
    if (
      !finish(c, challenge) ||
      !result?.verified ||
      !options.store.advancePasskey(
        key.id,
        key.counter,
        result.authenticationInfo.newCounter,
        now(),
      )
    )
      return c.json({ error: "passkey_rejected" }, 400);
    return signIn(c);
  });

  // Enrollment and revocation require an actual recent browser session, not
  // either Bearer token. June's write-only credential never reaches this path.
  app.use("/passkeys*", async (c, next) => {
    if (session(c) === undefined) return c.json({ error: "unauthorized" }, 401);
    if (c.req.method === "POST" && !recent(c))
      return c.json({ error: "reauthentication_required" }, 403);
    await next();
  });
  app.get("/passkeys", (c) =>
    c.json({
      items: options.store
        .passkeys()
        .map(({ id, name, createdAt, lastUsedAt }) => ({
          id,
          name,
          createdAt,
          lastUsedAt,
        })),
    }),
  );
  app.post("/passkeys/register/options", async (c) => {
    const keys = options.store.passkeys();
    if (keys.length >= 16) return c.json({ error: "passkey_capacity" }, 409);
    const result = await generateRegistrationOptions({
      rpName: "June Debug",
      rpID: origin.hostname,
      userName: "owner",
      userDisplayName: "June Debug owner",
      userID: options.store.passkeyUserId(),
      attestationType: "none",
      excludeCredentials: keys.map(({ id, transports }) => ({
        id,
        transports,
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });
    if (!recent(c)) return c.json({ error: "reauthentication_required" }, 403);
    if (!remember(c, "register", result.challenge))
      return c.json({ error: "rate_limited" }, 429);
    return c.json(result);
  });
  app.post("/passkeys/register/verify", async (c) => {
    const body = await c.req.json().catch(() => null);
    const challenge = consume(c, "register");
    if (
      !challenge ||
      typeof body?.name !== "string" ||
      !body.name.trim() ||
      body.name.trim().length > 80
    )
      return c.json({ error: "passkey_rejected" }, 400);
    const result = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge.value,
      expectedOrigin: options.origin,
      expectedRPID: origin.hostname,
      requireUserVerification: true,
      requireUserPresence: true,
    }).catch(() => null);
    if (!finish(c, challenge) || !result?.verified || !recent(c))
      return c.json({ error: "passkey_rejected" }, 400);
    if (
      !options.store.addPasskey(
        result.registrationInfo.credential,
        body.name.trim(),
        now(),
      )
    )
      return c.json({ error: "passkey_capacity_or_duplicate" }, 409);
    return c.json({ registered: true }, 201);
  });
  app.post("/passkeys/:id/delete", (c) => {
    if (!options.store.removePasskey(c.req.param("id")))
      return c.json({ error: "not_found" }, 404);
    // Revocation also invalidates in-flight ceremonies and all browser sessions.
    epoch++;
    browsers.clear();
    challenges.clear();
    sessions.clear();
    deleteCookie(c, cookie, cookieOptions);
    deleteCookie(c, challengeCookie, cookieOptions);
    deleteCookie(c, browserCookie, cookieOptions);
    return c.json({ authenticated: false });
  });
  for (const path of ["/snapshots*", "/operations*", "/issues"]) {
    app.use(path, async (c, next) => {
      if (!authenticated(c.req.raw, getCookie(c, cookie)))
        return c.json({ error: "unauthorized" }, 401);
      await next();
    });
  }
  return app;
}
