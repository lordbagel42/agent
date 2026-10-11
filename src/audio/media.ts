import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { audioError } from "./contracts.js";

/** A separate, disposable Chromium owns WebRTC. No microphone permission,
 * desktop profile, speaker device or provider credentials enter this peer. */
export async function createMedia(options: {
  signal: AbortSignal;
  output(frame: Uint8Array): void;
  event(type: string): void;
}) {
  const ended = Promise.withResolvers<void>();
  void ended.promise.catch(() => {});
  const attached = Promise.withResolvers<NodeWebSocket>();
  void attached.promise.catch(() => {});
  const nonce = randomBytes(32).toString("hex");
  const worklet = await readFile(
    new URL("./media-worklet.js", import.meta.url),
  );
  let origin = "";
  let socket: NodeWebSocket | undefined;
  let closing = false;
  const server = createServer((req, res) => {
    if (req.headers.host !== new URL(origin).host) {
      res.writeHead(403).end();
      return;
    }
    if (req.url === `/${nonce}`)
      res
        .writeHead(200, {
          "Content-Type": "text/html",
          "Cache-Control": "no-store",
        })
        .end("<!doctype html><title>June audio peer</title>");
    else if (req.url === `/${nonce}/worklet.js`)
      res
        .writeHead(200, {
          "Content-Type": "text/javascript",
          "Cache-Control": "no-store",
        })
        .end(worklet);
    else res.writeHead(404).end();
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, connection, head) => {
    if (
      closing ||
      socket ||
      req.url !== `/${nonce}/pcm` ||
      req.headers.origin !== origin ||
      req.headers.host !== new URL(origin).host
    ) {
      connection.destroy();
      return;
    }
    wss.handleUpgrade(req, connection, head, (ws) => {
      socket = ws;
      ws.on("error", () => ended.reject(audioError("media_disconnected")));
      ws.on("close", () => {
        if (!closing) ended.reject(audioError("media_disconnected"));
      });
      ws.on("message", (data, binary) => {
        try {
          if (binary) {
            const frame = Buffer.from(data as Buffer);
            if (frame.byteLength !== 1920) throw audioError("invalid_media");
            options.output(frame);
          } else if (data.toString() === "overflow")
            throw audioError("media_overflow");
          else if (data.toString() === "disconnected")
            throw audioError("media_disconnected");
          else options.event(data.toString());
        } catch {
          ended.reject(audioError("invalid_media"));
        }
      });
      attached.resolve(ws);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let closePromise: Promise<void> | undefined;
  const close = () =>
    (closePromise ??= (async () => {
      closing = true;
      options.signal.removeEventListener("abort", abort);
      socket?.terminate();
      wss.close();
      const cleanup = await Promise.allSettled([
        browser?.close(),
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
      if (cleanup.some((result) => result.status === "rejected"))
        throw audioError("cleanup_unconfirmed");
      ended.resolve();
    })());
  // Do not memoize cleanup until an in-flight launch has returned its handle.
  const abort = () => {
    ended.reject(audioError("cancelled"));
    void browser?.close().catch(() => {});
  };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal.aborted) throw audioError("cancelled");
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      args: ["--autoplay-policy=no-user-gesture-required"],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    if (options.signal.aborted) throw audioError("cancelled");
    browser.on("disconnected", () => {
      if (!closing) ended.reject(audioError("media_disconnected"));
    });
    const page = await browser.newPage();
    await page.goto(`${origin}/${nonce}`);
    const offer = await page.evaluate(
      async ({ nonce }) => {
        const pcm = new WebSocket(
          `${location.origin.replace("http:", "ws:")}/${nonce}/pcm`,
        );
        pcm.binaryType = "arraybuffer";
        await new Promise<void>((resolve, reject) => {
          pcm.onopen = () => resolve();
          pcm.onerror = reject;
        });
        const audio = new AudioContext({
          sampleRate: 48000,
          latencyHint: "interactive",
        });
        await audio.audioWorklet.addModule(`/${nonce}/worklet.js`);
        const node = new AudioWorkletNode(audio, "june-audio", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        const destination = audio.createMediaStreamDestination();
        node.connect(destination);
        pcm.onmessage = ({ data }) => {
          if (data instanceof ArrayBuffer) node.port.postMessage(data, [data]);
        };
        node.port.onmessage = ({ data }) => {
          if (pcm.readyState !== WebSocket.OPEN) return;
          if (pcm.bufferedAmount > 48000) {
            pcm.send("overflow");
            return;
          }
          pcm.send(data);
        };
        const peer = new RTCPeerConnection();
        for (const track of destination.stream.getTracks())
          peer.addTrack(track, destination.stream);
        // Chromium must activate the receiver's playout path for Web Audio to
        // consume decoded samples. The element is muted: never use a speaker.
        const receiver = document.createElement("audio");
        receiver.muted = true;
        document.body.append(receiver);
        peer.ontrack = ({ track }) => {
          const stream = new MediaStream([track]);
          receiver.srcObject = stream;
          void receiver.play().catch(() => pcm.send("disconnected"));
          audio.createMediaStreamSource(stream).connect(node);
        };
        const events = peer.createDataChannel("oai-events");
        events.onmessage = ({ data }) => {
          // Forward event names only, never transcript text or remote payloads.
          try {
            const e = JSON.parse(data);
            if (typeof e.type === "string" && e.type.length < 160)
              pcm.send(e.type);
          } catch {
            /* Unknown datachannel messages are not commands. */
          }
        };
        peer.onconnectionstatechange = () => {
          if (
            ["failed", "closed", "disconnected"].includes(
              peer.connectionState,
            ) &&
            pcm.readyState === WebSocket.OPEN
          )
            pcm.send("disconnected");
        };
        Object.assign(window, { junePeer: peer, juneAudio: audio });
        await audio.resume();
        await peer.setLocalDescription(await peer.createOffer());
        // No trickle signalling API: include locally gathered candidates in offer.
        if (peer.iceGatheringState !== "complete")
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("ice_timeout")),
              8000,
            );
            peer.addEventListener("icegatheringstatechange", () => {
              if (peer.iceGatheringState === "complete") {
                clearTimeout(timer);
                resolve();
              }
            });
          });
        return peer.localDescription?.sdp;
      },
      { nonce },
    );
    await attached.promise;
    if (!offer || options.signal.aborted)
      throw audioError("media_disconnected");
    return {
      offer,
      ended: ended.promise,
      async answer(sdp: string) {
        await page.evaluate(async (sdp) => {
          const peer = (window as unknown as { junePeer: RTCPeerConnection })
            .junePeer;
          await peer.setRemoteDescription({ type: "answer", sdp });
          if (peer.connectionState !== "connected")
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error("connect_timeout")),
                12_000,
              );
              peer.addEventListener("connectionstatechange", () => {
                if (peer.connectionState === "connected") {
                  clearTimeout(timer);
                  resolve();
                } else if (
                  ["closed", "failed"].includes(peer.connectionState)
                ) {
                  clearTimeout(timer);
                  reject(new Error("connect_failed"));
                }
              });
            });
        }, sdp);
      },
      input(frame: Uint8Array) {
        if (frame.byteLength !== 1920) throw audioError("invalid_media");
        if (closing || socket?.readyState !== NodeWebSocket.OPEN)
          throw audioError("media_disconnected");
        if (socket.bufferedAmount > 48000) throw audioError("media_overflow");
        socket.send(frame);
      },
      close,
    };
  } catch {
    await close();
    throw audioError("media_disconnected");
  }
}
