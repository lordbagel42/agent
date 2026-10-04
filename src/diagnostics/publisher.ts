import type { DebugSitePublisher } from "./contracts.js";
import { snapshotIdSchema, validateSnapshot } from "./store.js";

/** Deliberately content-free: callers may persist this code/status for retries. */
export class DebugSitePublishError extends Error {
  constructor(
    readonly code:
      | "configuration"
      | "invalid_id"
      | "invalid_snapshot"
      | "http"
      | "transport"
      | "receipt",
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(`Debug site publication failed (${code})`);
    this.name = "DebugSitePublishError";
  }
}

function canonicalOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      !/^https?:\/\/[^/\\\s?#]+\/?$/i.test(origin)
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new DebugSitePublishError("configuration", false);
  }
}

async function savedReceipt(response: Response, id: string): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new DebugSitePublishError("receipt", true);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) throw new DebugSitePublishError("receipt", true);
      chunks.push(value);
    }
    const receipt = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (receipt?.id !== id || receipt?.saved !== true)
      throw new DebugSitePublishError("receipt", true);
  } catch {
    throw new DebugSitePublishError("receipt", true);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** One bounded write attempt, no investigation and no implicit retry policy. */
export function createDebugSitePublisher(options: {
  origin: string;
  token: string;
}): DebugSitePublisher {
  const origin = canonicalOrigin(options.origin);
  const token = options.token;
  if (
    typeof token !== "string" ||
    token.length < 32 ||
    token.length > 4096 ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(token)
  )
    throw new DebugSitePublishError("configuration", false);
  return {
    url(id) {
      if (!snapshotIdSchema.safeParse(id).success)
        throw new DebugSitePublishError("invalid_id", false);
      return `${origin}/s/${id}`;
    },
    async publish(value) {
      let snapshot: Parameters<DebugSitePublisher["publish"]>[0];
      try {
        snapshot = validateSnapshot(value);
      } catch {
        throw new DebugSitePublishError("invalid_snapshot", false);
      }
      try {
        const response = await fetch(`${origin}/api/ingest/${snapshot.id}`, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(snapshot),
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status !== 200 && response.status !== 201) {
          await response.body?.cancel().catch(() => {});
          throw new DebugSitePublishError(
            "http",
            response.status >= 500 || [408, 425, 429].includes(response.status),
            response.status,
          );
        }
        await savedReceipt(response, snapshot.id);
      } catch (error) {
        if (error instanceof DebugSitePublishError) throw error;
        throw new DebugSitePublishError("transport", true);
      }
    },
  };
}
