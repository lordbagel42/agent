import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createSessions } from "./auth.js";

it("rejects invalid keys, expires sessions and revokes only the signed-out device", () => {
  let now = 1000;
  const key = "synthetic-viewer-key-with-at-least-32-characters";
  const auth = createSessions(
    createHash("sha256").update(key).digest("hex"),
    () => now,
  );
  expect(auth.login("wrong-key")).toBeNull();
  const first = auth.login(key);
  const second = auth.login(key);
  expect(first).toBeTruthy();
  expect(second).not.toBe(first);
  expect(auth.valid(first ?? undefined)).toBe(true);
  auth.logout(first ?? undefined);
  expect(auth.valid(first ?? undefined)).toBe(false);
  expect(auth.valid(second ?? undefined)).toBe(true);
  now += 8 * 60 * 60 * 1000;
  expect(auth.valid(second ?? undefined)).toBe(false);
});

it("caps login attempts without invalidating an existing session", () => {
  const key = "synthetic-viewer-key-with-at-least-32-characters";
  const auth = createSessions(createHash("sha256").update(key).digest("hex"));
  const session = auth.login(key);
  for (let i = 0; i < 20; i++) auth.login("invalid");
  expect(auth.login(key)).toBeNull();
  expect(auth.valid(session ?? undefined)).toBe(true);
});
