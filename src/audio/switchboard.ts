import { Predicate, Schema } from "effect";
import { WebSocket } from "ws";
import { Uuid } from "../effect/schema.js";
import {
  type AudioConnection,
  audioError,
  type CallTransport,
} from "./contracts.js";
import { PhonePcm } from "./pcm.js";

const record = Schema.Struct({
  id: Uuid,
  state: Schema.String,
  reason: Schema.NullOr(Schema.String),
  direction: Schema.Literals(["inbound", "outbound"]),
  media_path: Schema.String,
  audio: Schema.Struct({
    encoding: Schema.Literal("pcm_s16le"),
    sample_rate: Schema.Literal(8000),
    channels: Schema.Literal(1),
    frame_bytes: Schema.Literal(320),
  }),
  expires_at: Schema.optionalKey(Schema.Number),
});
const decode = Schema.decodeUnknownSync(record);
export const terminalCall = (state: string) =>
  ["ended", "failed", "expired", "interrupted"].includes(state);

/** Bearer credentials stay on the server side of the Chromium boundary. */
export function switchboard(
  name: string,
  origin: string,
  token: string,
): CallTransport {
  if (!token.trim()) throw audioError("authentication_required");
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
    key?: string,
  ) => {
    const response = await fetch(`${origin}/api/v1/calls${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(5000),
        ...(signal ? [signal] : []),
      ]),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw audioError(
        response.status === 401
          ? "authentication_required"
          : response.status >= 400 && response.status < 500
            ? "rejected"
            : "provider_failed",
      );
    }
    // Bound reads even without Content-Length; never retain provider error bodies.
    const reader = response.body?.getReader();
    if (!reader) throw audioError("protocol_error");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 16384) throw audioError("protocol_error");
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
    } finally {
      await reader.cancel();
    }
  };
  const validate = (value: unknown) => {
    const call = decode(value);
    if (call.media_path !== `/api/v1/calls/${call.id}/media`)
      throw audioError("protocol_error");
    return call;
  };
  return {
    name,
    async dial(key, maxSeconds, signal) {
      const call = validate(
        await request(
          "",
          "POST",
          { max_duration_seconds: maxSeconds },
          signal,
          key,
        ),
      );
      if (call.direction !== "outbound") throw audioError("protocol_error");
      return call.id;
    },
    async incoming(signal) {
      const value = await request("/incoming", "GET", undefined, signal);
      if (
        !Predicate.isObject(value) ||
        !Array.isArray(value.calls) ||
        value.calls.length > 1
      )
        throw audioError("protocol_error");
      return value.calls.map((v) => {
        const call = validate(v);
        if (
          call.direction !== "inbound" ||
          call.state !== "offered" ||
          !call.expires_at ||
          call.expires_at * 1000 <= Date.now()
        )
          throw audioError("protocol_error");
        return call.id;
      });
    },
    async inspect(id) {
      const call = validate(await request(`/${id}`));
      if (call.id !== id) throw audioError("protocol_error");
      return call;
    },
    async end(id) {
      await request(`/${id}`, "DELETE");
    },
    async attach(id, input, signal): Promise<AudioConnection> {
      Schema.decodeUnknownSync(Uuid)(id);
      if (signal.aborted) throw audioError("cancelled");
      const ws = new WebSocket(
        `${origin.replace("https:", "wss:")}/api/v1/calls/${id}/media`,
        {
          headers: { Authorization: `Bearer ${token}` },
          maxPayload: 16384,
          perMessageDeflate: false,
          handshakeTimeout: 5000,
          followRedirects: false,
        },
      );
      const opened = Promise.withResolvers<void>();
      const connected = Promise.withResolvers<void>();
      const ended = Promise.withResolvers<void>();
      void connected.promise.catch(() => {});
      void ended.promise.catch(() => {});
      const pcm = new PhonePcm();
      let ready = false;
      let closed = false;
      const queue: Uint8Array[] = [];
      const fail = () => {
        opened.reject(audioError("media_disconnected"));
        connected.reject(audioError("media_disconnected"));
        ended.reject(audioError("media_disconnected"));
        ws.terminate();
      };
      let nextFrameAt = performance.now() + 20;
      let timer: ReturnType<typeof setTimeout>;
      const tick = () => {
        if (closed) return;
        if (ws.bufferedAmount > 8000 || performance.now() - nextFrameAt > 500) {
          fail();
          return;
        }
        // Correct timer drift without bursting stale audio after a stalled loop.
        if (performance.now() - nextFrameAt > 20) {
          queue.length = 0;
          nextFrameAt = performance.now();
        }
        const frame =
          ready && ws.readyState === WebSocket.OPEN ? queue.shift() : undefined;
        if (frame) ws.send(frame);
        nextFrameAt += 20;
        timer = setTimeout(tick, Math.max(0, nextFrameAt - performance.now()));
      };
      timer = setTimeout(tick, 20);
      ws.on("open", () => opened.resolve());
      ws.on("error", fail);
      ws.on("close", () => {
        closed = true;
        ready = false;
        queue.length = 0;
        clearTimeout(timer);
        signal.removeEventListener("abort", fail);
        opened.reject(audioError("media_disconnected"));
        connected.reject(audioError("media_disconnected"));
        ended.resolve();
      });
      ws.on("message", (data, binary) => {
        try {
          if (binary) {
            const frame = Buffer.from(data as Buffer);
            if (frame.length !== 320) throw audioError("invalid_media");
            if (ready) input(pcm.up(frame));
          } else {
            const event = JSON.parse(data.toString());
            if (!Predicate.isObject(event)) throw audioError("protocol_error");
            if (event.type === "state") {
              if (event.id !== id || typeof event.state !== "string")
                throw audioError("protocol_error");
              if (event.state === "connected") {
                ready = true;
                connected.resolve();
              } else if (
                event.state === "ending" ||
                terminalCall(event.state)
              ) {
                ready = false;
                queue.length = 0;
                ended.resolve();
              }
            } else if (event.type !== "dtmf")
              throw audioError("protocol_error");
          }
        } catch {
          fail();
        }
      });
      signal.addEventListener("abort", fail, { once: true });
      if (signal.aborted) fail();
      await opened.promise;
      return {
        id,
        connected: connected.promise,
        ended: ended.promise,
        send(frame) {
          if (!ready || closed) return;
          if (queue.length >= 25) {
            fail();
            throw audioError("media_overflow");
          }
          queue.push(pcm.down(frame));
        },
        clearPlayback() {
          queue.length = 0;
        },
        async close() {
          if (closed) return;
          const done = new Promise<void>((resolve) =>
            ws.once("close", () => resolve()),
          );
          ws.terminate();
          await done;
        },
      };
    },
  };
}
