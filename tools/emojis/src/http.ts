import { z } from "zod";
import { WORKSPACE_ID } from "./shared.js";

export async function boundedJson(
  response: Response,
  maxBytes = 16 * 1024 * 1024,
): Promise<unknown> {
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("response_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(
    new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(bytes),
  );
}

export const catalogSchema = z.record(z.string(), z.string().min(1).max(2048));

export async function slackCatalog(
  token: string,
): Promise<Record<string, string>> {
  async function call(method: string) {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ team_id: WORKSPACE_ID }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`slack_http_${response.status}`);
    }
    const data = z
      .object({ ok: z.boolean(), error: z.string().optional() })
      .passthrough()
      .parse(await boundedJson(response));
    if (!data.ok)
      throw new Error(
        `slack_${["missing_scope", "invalid_auth", "token_expired", "ratelimited"].includes(data.error ?? "") ? data.error : "request_failed"}`,
      );
    return data;
  }
  const auth = await call("auth.test");
  if (auth.team_id !== WORKSPACE_ID)
    throw new Error("slack_workspace_mismatch");
  return catalogSchema.parse((await call("emoji.list")).emoji);
}

export const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://emoji.slack-edge.com https://a.slack-edge.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
