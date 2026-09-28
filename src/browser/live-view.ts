import { html, raw } from "hono/html";
import {
  type PrivateRouteSecurity,
  privateRoutes,
} from "../console/security.js";
import { messagePage, page } from "../console/view.js";
import type { BrowserCompanion } from "./companion.js";
import type { BrowserSession } from "./session.js";

const interval = 500;
const deadline = 5_000;
const maxFrameBytes = 1024 * 1024;

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Live view unavailable")),
          deadline,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Fixed viewer code only: no visited-page HTML, task values, or credentials.
const script = String.raw`(() => {
  const image = document.getElementById('frame');
  const status = document.getElementById('viewer-status');
  const placeholder = document.getElementById('placeholder');
  const captured = document.getElementById('captured');
  const stream = new EventSource(location.pathname.replace(/\/$/, '') + '/stream');
  let generation = null, epoch = -1, state = 'connecting', last = Date.now();
  function clear(message) {
    image.hidden = true;
    image.removeAttribute('src');
    captured.textContent = '—';
    captured.removeAttribute('datetime');
    placeholder.hidden = false;
    placeholder.textContent = message;
  }
  function fail() {
    state = 'error';
    status.textContent = 'Disconnected';
    status.dataset.status = 'failed';
    clear('Live view unavailable. Reload to reconnect.');
    stream.close();
    clearInterval(watchdog);
  }
  stream.addEventListener('state', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (generation !== null && data.generation !== generation) { fail(); return; }
      if (data.epoch < epoch) return;
      if (data.epoch !== epoch) clear('Waiting for a fresh frame…');
      generation = data.generation; epoch = data.epoch; state = data.state; last = Date.now();
      const labels = { live: 'Live', private: 'Private input', ended: 'Ended', error: 'Disconnected' };
      status.textContent = labels[state] || 'Unavailable';
      status.dataset.status = state === 'live' ? 'active' : state === 'private' ? 'awaiting-review' : 'unknown';
      if (state === 'error') { fail(); return; }
      if (state !== 'live') clear(state === 'private' ? 'Observation paused for private input. The browser remains open.' : 'This live view has ended. No browser was restarted.');
      if (state === 'ended') { stream.close(); clearInterval(watchdog); }
    } catch { fail(); }
  });
  stream.addEventListener('frame', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (state !== 'live' || data.generation !== generation || data.epoch !== epoch) return;
      if (typeof data.image !== 'string' || !data.image.startsWith('data:image/jpeg;base64,')) { fail(); return; }
      const time = new Date(data.capturedAt);
      captured.dateTime = time.toISOString(); captured.textContent = time.toLocaleString();
      image.src = data.image; image.hidden = false; placeholder.hidden = true; last = Date.now();
    } catch { fail(); }
  });
  image.addEventListener('error', fail);
  stream.onerror = fail;
  const watchdog = setInterval(() => { if (Date.now() - last > 7000) fail(); }, 1000);
  addEventListener('pagehide', () => { stream.close(); clearInterval(watchdog); clear('Live view closed.'); });
})();`;

/** Mount once at /console/browser on the existing private ingress. This router
 * reads the companion's session only; disconnect never closes the browser. */
export function createBrowserLiveView(
  security: PrivateRouteSecurity,
  companion: Pick<BrowserCompanion, "status" | "session">,
  shutdown?: AbortSignal,
) {
  const app = privateRoutes(security);
  const viewers = new Map<string, number>();
  app.use("*", async (c, next) => {
    const nonce = c.get("nonce");
    c.header(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
    );
    await next();
  });
  app.get("/:taskId", (c) => {
    if (!companion.status(c.req.param("taskId"), c.get("principal")))
      return c.html(
        messagePage(
          c.get("nonce"),
          "Browser unavailable",
          "No browser task is available for this owner.",
          404,
        ),
        404,
      );
    const nonce = c.get("nonce");
    return c.html(
      page(
        "Browser live view",
        nonce,
        html`
      <style nonce="${nonce}">#frame{display:block;width:100%;height:auto}#frame[hidden],#placeholder[hidden]{display:none}.viewer{min-height:240px}.viewer-meta{margin-bottom:20px}</style>
      <div class="summary-bar viewer-meta"><div><span class="eyebrow">Status</span><span class="status" id="viewer-status" role="status">Connecting</span></div><div><span class="eyebrow">Captured</span><time id="captured">—</time></div><div><span class="eyebrow">Coverage</span><p>Up to 2 frames/s · No audio</p></div></div>
      <section class="panel viewer" aria-label="Read-only browser view"><p class="empty" id="placeholder">Waiting for a fresh frame…</p><img id="frame" alt="Current page in June’s browser" hidden></section>
      <p class="hint">The same browser June is using. Read-only; no controls or recordings. Private input clears this view.</p>
      <noscript><p class="callout">JavaScript is required for the live view. No browser is started by opening this page.</p></noscript>
      <script nonce="${nonce}">${raw(script)}</script>`,
        {
          description:
            "Follow the existing browser session. Viewing never starts a browser or authorizes an action.",
        },
      ),
    );
  });
  app.get("/:taskId/stream", (c) => {
    if (shutdown?.aborted) return c.body(null, 503);
    const id = c.req.param("taskId");
    const principal = c.get("principal");
    if (!companion.status(id, principal)) return c.body(null, 404);
    if ((viewers.get(id) ?? 0) >= 2) return c.body(null, 429);
    viewers.set(id, (viewers.get(id) ?? 0) + 1);
    const session = companion.session(id, principal);
    const generation = session?.generation ?? null;
    const encoder = new TextEncoder();
    let stopped = false;
    type EventData = {
      generation: string | null;
      epoch: number;
      state?: string;
      capturedAt?: number;
      image?: string;
    };
    const transport = new TransformStream<
      { event: string; data: EventData },
      Uint8Array
    >({
      async transform(message, controller) {
        // Transform executes only when the consumer is ready. Recheck here too:
        // a blocked write must not deliver a frame captured before PIN entry.
        if (message.event === "frame") {
          const authorized = await bounded(security.authenticate(c.req.raw));
          const current = companion.session(id, principal);
          const epoch = session?.epoch ?? 0;
          const state =
            authorized !== principal
              ? "error"
              : !session ||
                  current !== session ||
                  current.generation !== generation
                ? "ended"
                : current.state;
          if (state !== "live" || epoch !== message.data.epoch) {
            message = { event: "state", data: { state, generation, epoch } };
          }
        }
        if (stopped || c.req.raw.signal.aborted)
          throw new Error("Disconnected");
        controller.enqueue(
          encoder.encode(
            `event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`,
          ),
        );
      },
    });
    const writer = transport.writable.getWriter();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      const count = (viewers.get(id) ?? 1) - 1;
      if (count) viewers.set(id, count);
      else viewers.delete(id);
      c.req.raw.signal.removeEventListener("abort", stop);
      shutdown?.removeEventListener("abort", stop);
      void writer.abort().catch(() => {});
    };
    c.req.raw.signal.addEventListener("abort", stop, { once: true });
    shutdown?.addEventListener("abort", stop, { once: true });
    if (shutdown?.aborted) stop();
    void writer.closed.catch(stop);
    async function send(event: string, data: EventData) {
      if (stopped) throw new Error("Disconnected");
      await bounded(writer.write({ event, data }));
    }
    void (async () => {
      type Frame = Awaited<ReturnType<BrowserSession["frame"]>>;
      let pending: { epoch: number; ready: boolean; frame?: Frame } | undefined;
      let lastState = "";
      let heartbeat = 0;
      try {
        while (!stopped) {
          if (c.req.raw.signal.aborted) break;
          const authorized = await bounded(security.authenticate(c.req.raw));
          if (stopped) break;
          const current = companion.session(id, principal);
          const epoch = session?.epoch ?? 0;
          const state =
            authorized !== principal
              ? "error"
              : !session ||
                  current !== session ||
                  current.generation !== generation
                ? "ended"
                : current.state;
          const stamp = JSON.stringify([state, epoch]);
          if (stamp !== lastState || Date.now() - heartbeat >= 2000) {
            // Status contains no page data; privacy/terminal events erase pixels.
            await send("state", { state, generation, epoch });
            lastState = stamp;
            heartbeat = Date.now();
            if (state === "ended" || state === "error") break;
          } else if (state === "live" && session) {
            // No await between these identity/state checks and publication.
            // Captures are polled so private/ended events are not held behind a
            // screenshot await. Never queue more than one capture per viewer.
            if (pending?.ready) {
              const result = pending;
              pending = undefined;
              const frame = result.frame;
              if (
                result.epoch === epoch &&
                frame &&
                frame.epoch === epoch &&
                frame.generation === generation &&
                frame.data.byteLength <= maxFrameBytes
              ) {
                await send("frame", {
                  generation,
                  epoch,
                  capturedAt: frame.capturedAt,
                  image: `data:image/jpeg;base64,${Buffer.from(frame.data).toString("base64")}`,
                });
              } else if (result.epoch === epoch) {
                await send("state", { state: "error", generation, epoch });
                break;
              }
            } else if (!pending) {
              const capture = {
                epoch,
                ready: false,
                frame: undefined as Frame,
              };
              pending = capture;
              void bounded(session.frame()).then(
                (frame) => {
                  capture.frame = frame;
                  capture.ready = true;
                },
                () => {
                  capture.ready = true;
                },
              );
            }
          }
          await new Promise((resolve) => setTimeout(resolve, interval));
        }
        if (!stopped) await bounded(writer.close());
      } catch {
        // Do not expose capture/auth errors or leave stale content labelled live.
        // Transport failure closes EventSource; its error handler clears pixels.
      } finally {
        stop();
      }
    })();
    c.header("Content-Type", "text/event-stream");
    c.header("X-Accel-Buffering", "no");
    return c.body(transport.readable);
  });
  return app;
}
