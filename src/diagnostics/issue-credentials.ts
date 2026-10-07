import { createHash } from "node:crypto";
import { z } from "zod";

const grantSchema = z.strictObject({
  version: z.literal(1),
  token: z.string().regex(/^[A-Za-z0-9._~-]{1,4096}$/),
  expiresAt: z.iso.datetime({ offset: true }),
});

/** Raised only before an HTTP dispatch, never for a provider/transport failure. */
export class IssueCredentialUnavailable extends Error {
  constructor() {
    super("issue_credential_unavailable");
  }
}

export interface IssueCredentialStatus {
  state: "waiting" | "usable" | "expired";
  expiresAt?: string;
  receivedAt?: number;
}

/** Ephemeral installation token, independent of the archive and browser auth. */
export class IssueCredentials {
  #token?: string;
  #fingerprint?: string;
  #expiresAt?: string;
  #expires = 0;
  #deadline = 0;
  #receivedAt?: number;
  readonly #now: () => number;
  readonly #monotonic: () => number;

  constructor(options: { now?: () => number; monotonic?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#monotonic = options.monotonic ?? (() => performance.now());
  }

  accept(input: unknown): void {
    const parsed = grantSchema.safeParse(input);
    if (!parsed.success) throw new Error("issue_credential_invalid");
    const { token, expiresAt } = parsed.data;
    const expires = Date.parse(expiresAt);
    const fingerprint = createHash("sha256").update(token).digest("hex");
    if (fingerprint === this.#fingerprint && expires === this.#expires) return;
    const remaining = expires - this.#now();
    if (remaining <= 5 * 60_000 || remaining > 61 * 60_000)
      throw new Error("issue_credential_invalid");
    if (expires <= this.#expires || fingerprint === this.#fingerprint)
      throw new Error("issue_credential_conflict");
    this.#token = token;
    this.#fingerprint = fingerprint;
    this.#expiresAt = expiresAt;
    this.#expires = expires;
    this.#receivedAt = this.#now();
    this.#deadline = this.#monotonic() + remaining - 2 * 60_000;
  }

  get(): string {
    // Reserve the provider's full 10-second request budget on BOTH clocks.
    if (
      !this.#token ||
      this.#now() + 10_000 >= this.#expires - 2 * 60_000 ||
      this.#monotonic() + 10_000 >= this.#deadline
    ) {
      this.#token = undefined;
      throw new IssueCredentialUnavailable();
    }
    return this.#token;
  }

  status(): IssueCredentialStatus {
    let state: IssueCredentialStatus["state"] = "usable";
    try {
      this.get();
    } catch {
      state = this.#expiresAt ? "expired" : "waiting";
    }
    return {
      state,
      ...(this.#expiresAt
        ? { expiresAt: this.#expiresAt, receivedAt: this.#receivedAt }
        : {}),
    };
  }
}

/** Auth must precede this bounded read. No input/error text escapes this boundary. */
export async function readIssueCredential(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("issue_credential_invalid");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) throw new Error("issue_credential_invalid");
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  };
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("issue_credential_invalid")),
          2000,
        );
      }),
    ]);
  } catch {
    throw new Error("issue_credential_invalid");
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}
