import { type Snapshot, snapshotSchema } from "../snapshot.js";
import { config } from "./config.js";

async function json(url: string, token?: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(3000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok || !response.body) throw new Error("Snapshot unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 512_000) throw new Error("Snapshot too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
  }
}

export async function readSnapshot(): Promise<Snapshot | null> {
  const { origins, readToken } = config();
  for (const origin of origins) {
    try {
      const health = (await json(`${origin}/health`)) as {
        ready?: boolean;
        revision?: string;
      };
      if (health.ready !== true) continue;
      const snapshot = snapshotSchema.parse(
        await json(`${origin}/sandboxes/snapshot`, readToken),
      );
      if (snapshot.revision !== health.revision) continue;
      return snapshot;
    } catch {
      /* No provider errors, private URLs or credentials reach the browser. */
    }
  }
  return null;
}
