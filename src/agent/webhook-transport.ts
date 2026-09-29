import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export type WebhookDestination = { origin: string; pathPrefix: string };

/** Trusted host-only fixture seam. Never expose transport selection to callers.
 * Implementations must call beforeDispatch synchronously immediately before I/O,
 * after asynchronous preparation, and must obey signal cancellation.
 */
export type WebhookTransport = (request: {
  url: URL;
  body: Buffer;
  headers: Record<string, string>;
  signal: AbortSignal;
  beforeDispatch: () => void;
}) => Promise<number>;

export function publicWebhookAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

export function webhookUrl(
  value: string,
  destinations: readonly WebhookDestination[],
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("webhook_destination_denied");
  }
  // Conservative path grammar avoids encoded traversal/separator disagreements
  // between proxies and receivers. Query strings can contain receiver secrets.
  const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (
    !authority ||
    authority.includes("@") ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    value.includes("#") ||
    value.includes("\\") ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    url.pathname.includes("%") ||
    url.pathname.includes(";") ||
    !destinations.some(
      ({ origin, pathPrefix }) =>
        url.origin === origin &&
        (url.pathname === pathPrefix ||
          url.pathname.startsWith(
            pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`,
          )),
    )
  ) {
    throw new Error("webhook_destination_denied");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) && !publicWebhookAddress(hostname)) {
    throw new Error("webhook_destination_denied");
  }
  return url;
}

async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("webhook_timeout"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

/** No redirects, cookies, proxies, pooled sockets, or caller-selected headers.
 * DNS is included in the caller's deadline. Every answer must be public; the
 * connection lookup is pinned to one validated answer, keeping TLS hostname
 * verification and SNI bound to the original destination.
 */
export const httpsWebhookTransport: WebhookTransport = async ({
  url,
  body,
  headers,
  signal,
  beforeDispatch,
}) => {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await withAbort(lookup(hostname, { all: true, verbatim: true }), signal);
  signal.throwIfAborted();
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !publicWebhookAddress(address))
  ) {
    throw new Error("webhook_destination_denied");
  }
  const pinned = addresses[0];
  if (!pinned) throw new Error("webhook_destination_denied");
  beforeDispatch();
  return new Promise<number>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        agent: false,
        rejectUnauthorized: true,
        maxHeaderSize: 8192,
        signal,
        headers,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      },
      (res) => {
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024) {
            const error = new Error("webhook_response_limit");
            reject(error);
            req.destroy(error);
          }
        });
        res.once("error", reject);
        res.once("aborted", () =>
          reject(new Error("webhook_response_aborted")),
        );
        res.once("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.once("error", reject);
    req.end(body);
  });
};
