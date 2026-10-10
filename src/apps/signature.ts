import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";

/** June's Ed25519 control identity. Only the public key leaves June. */
export interface AppsKey {
  keyId: string;
  publicKey: string;
  privateKey: KeyObject;
}

export const SIGNATURE_WINDOW_MS = 120_000;
const HEADER =
  /^June-Ed25519 key=([a-f0-9]{16}), ts=(\d{13}), nonce=([A-Za-z0-9_-]{22}), sig=([A-Za-z0-9_-]{86})$/;

export const appsKeyId = (publicKey: string) =>
  createHash("sha256")
    .update(Buffer.from(publicKey, "base64url"))
    .digest("hex")
    .slice(0, 16);

const signedText = (
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: string,
) =>
  `june-apps-v2\n${method}\n${path}\n${timestamp}\n${nonce}\n${createHash("sha256").update(body).digest("hex")}`;

/** Load June's key from her state directory, creating it atomically once. */
export async function loadAppsKey(path: string): Promise<AppsKey> {
  let pem = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    },
  );
  if (pem === undefined) {
    // Both deployment slots share this directory. link() publishes a complete
    // file atomically; the slot that loses the race reads the winner's key.
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      generateKeyPairSync("ed25519")
        .privateKey.export({ format: "pem", type: "pkcs8" })
        .toString(),
      { mode: 0o600, flag: "wx" },
    );
    try {
      await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    } finally {
      await unlink(temporary);
    }
    pem = await readFile(path, "utf8");
  }
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey).export({ format: "jwk" }).x;
  if (!publicKey) throw new Error("invalid_apps_key");
  return { privateKey, publicKey, keyId: appsKeyId(publicKey) };
}

/** `path` includes the query string exactly as sent. A random nonce keeps
 * identical concurrent requests distinct (Ed25519 is deterministic). */
export function signControl(
  key: AppsKey,
  method: string,
  path: string,
  body: string,
  now = Date.now(),
) {
  const timestamp = String(now);
  const nonce = randomBytes(16).toString("base64url");
  const signature = sign(
    null,
    Buffer.from(signedText(method, path, timestamp, nonce, body)),
    key.privateKey,
  ).toString("base64url");
  return `June-Ed25519 key=${key.keyId}, ts=${timestamp}, nonce=${nonce}, sig=${signature}`;
}

/** Checks the header, key and clock before reading the body. Returns the
 * nonce for single-use tracking, or null when invalid. */
export async function verifyControl(
  header: string | undefined,
  method: string,
  path: string,
  body: () => Promise<string>,
  publicKeys: readonly string[],
  now = Date.now(),
) {
  const match = (header ?? "").match(HEADER);
  if (!match) return null;
  const [, keyId, timestamp = "", nonce = "", signature = ""] = match;
  const publicKey = publicKeys.find((key) => appsKeyId(key) === keyId);
  if (!publicKey || Math.abs(now - Number(timestamp)) > SIGNATURE_WINDOW_MS)
    return null;
  const bytes = Buffer.from(signature, "base64url");
  // Reject non-canonical encodings so one signature has exactly one spelling.
  if (bytes.length !== 64 || bytes.toString("base64url") !== signature)
    return null;
  const valid = verify(
    null,
    Buffer.from(signedText(method, path, timestamp, nonce, await body())),
    createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: publicKey },
      format: "jwk",
    }),
    bytes,
  );
  return valid ? { nonce, at: Number(timestamp) } : null;
}
