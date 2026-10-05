import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const sessionSeconds = 8 * 60 * 60;
export const sessionCookie = "sandbox_session";

export function createSessions(hash: string, now = Date.now) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid viewer key hash");
  const expected = Buffer.from(hash, "hex");
  const sessions = new Map<string, number>();
  let attempts: number[] = [];
  return {
    login(key: string): string | null {
      const time = now();
      attempts = attempts.filter((at) => time - at < 60_000);
      if (attempts.length >= 10) return null;
      attempts.push(time);
      if (key.length < 32 || key.length > 512) return null;
      const actual = createHash("sha256").update(key).digest();
      if (!timingSafeEqual(expected, actual)) return null;
      for (const [id, expiry] of sessions)
        if (expiry <= time) sessions.delete(id);
      if (sessions.size >= 32)
        sessions.delete(sessions.keys().next().value as string);
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, time + sessionSeconds * 1000);
      return id;
    },
    valid(id: string | undefined) {
      if (!id) return false;
      const expiry = sessions.get(id);
      if (expiry === undefined) return false;
      if (expiry <= now()) {
        sessions.delete(id);
        return false;
      }
      return true;
    },
    logout(id: string | undefined) {
      if (id) sessions.delete(id);
    },
  };
}
