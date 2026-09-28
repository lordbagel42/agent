import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { chromium, type ElementHandle } from "playwright";
import { z } from "zod";

export interface BrowserSessionOptions {
  url: string;
  navigationOrigins: string[];
  resourceOrigins: string[];
  home: string;
  tempDirectory: string;
  signal?: AbortSignal;
  executablePath?: string;
  /** Trusted disposable fixtures only, never model input. */
  allowLoopbackHttp?: boolean;
}
export interface BrowserObservation {
  text: string;
  image?: { mimeType: "image/jpeg"; data: Uint8Array };
}
export interface BrowserSession {
  readonly generation: string;
  readonly state: "live" | "private" | "ended";
  readonly epoch: number;
  observe(): Promise<BrowserObservation>;
  frame(): Promise<
    | {
        generation: string;
        epoch: number;
        capturedAt: number;
        data: Uint8Array;
      }
    | undefined
  >;
  tool(name: string, args: unknown): Promise<BrowserObservation>;
  pendingInput():
    | { origin: string; question: string; challengeId: string }
    | undefined;
  enterPin(pin: string, valid?: () => boolean): Promise<void>;
  close(): Promise<void>;
}
const unsafeDiagnostics = [
  "DEBUG",
  "PWDEBUG",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
];
const diagnosticsAtImport = unsafeDiagnostics.some((key) => process.env[key]);
const empty = z.strictObject({});
const unavailable = (): BrowserObservation => ({
  text: "Browser operation unavailable (policy, stale reference, or unsupported page).",
});

/** Routing is defense in depth, NOT a network sandbox. The caller must provide
 * external egress/process isolation, owner authorization, expiry and concurrency
 * budgets. route.fetch buffers bodies: external response-byte/memory limits are
 * required too. Never use a host credential directory as this browser's HOME. */
export async function createBrowserSession(
  options: BrowserSessionOptions,
): Promise<BrowserSession> {
  function url(value: string): URL {
    const parsed = new URL(value);
    const fixture =
      options.allowLoopbackHttp &&
      parsed.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname);
    if (
      (!fixture && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    )
      throw new Error("Invalid browser destination");
    return parsed;
  }
  function origins(values: string[]) {
    return new Set(
      values.map((value) => {
        const parsed = url(value);
        if (parsed.href !== `${parsed.origin}/`)
          throw new Error("Expected exact origins");
        return parsed.origin;
      }),
    );
  }
  const navigation = origins(options.navigationOrigins);
  const resources = origins(options.resourceOrigins);
  const initial = url(options.url);
  if (
    !navigation.has(initial.origin) ||
    !isAbsolute(options.home) ||
    !isAbsolute(options.tempDirectory) ||
    diagnosticsAtImport ||
    unsafeDiagnostics.some((key) => process.env[key]) ||
    options.signal?.aborted
  )
    throw new Error("Browser session unavailable");
  const browser = await chromium
    .launch({
      headless: true,
      chromiumSandbox: true,
      executablePath: options.executablePath,
      env: {
        HOME: options.home,
        TMPDIR: options.tempDirectory,
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
      },
    })
    .catch(() => {
      throw new Error("Sandboxed browser launch unavailable");
    });
  let state: BrowserSession["state"] = "live";
  let epoch = 0;
  const generation = randomUUID();
  let closing: Promise<void> | undefined;
  let busy = false;
  let requests = 0;
  let captures = 0;
  let denied = 0;
  let documentVersion = 0;
  let refs = new Map<string, ElementHandle>();
  type Challenge = {
    challengeId: string;
    input: ElementHandle;
    submit: ElementHandle;
    origin: string;
    action: string;
    version: number;
  };
  let pending: Challenge | undefined;
  let permit:
    | {
        action: string;
        used: boolean;
        responseApproved: boolean;
        documentUrl?: string;
        committedVersion?: number;
        redirect?: string;
        nextNavigation?: string;
        valid: () => boolean;
      }
    | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    state = "ended";
    epoch++;
    pending = undefined;
    permit = undefined;
    options.signal?.removeEventListener("abort", abort);
    closing = browser.close().catch(() => {
      throw new Error("Browser close outcome unknown");
    });
    return closing;
  };
  const abort = () => {
    void close().catch(() => {
      /* close() retains rejection for its owner. */
    });
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) throw new Error("Browser session cancelled");
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
    });
    context.setDefaultTimeout(5_000);
    context.setDefaultNavigationTimeout(10_000);
    const page = await context.newPage();
    context.on("page", (other) => {
      if (other !== page) void other.close().catch(() => {});
    });
    page.on("download", (download) => {
      void download.cancel().catch(() => {});
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        documentVersion++;
        refs = new Map();
        if (permit?.responseApproved && frame.url() === permit.documentUrl)
          permit.committedVersion = documentVersion;
      }
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", async (route) => {
      const request = route.request();
      let allowed = false;
      try {
        const target = url(request.url());
        const main = request.frame() === page.mainFrame();
        const destination = request.isNavigationRequest()
          ? navigation
          : resources;
        allowed =
          state !== "ended" &&
          ++requests <= 2000 &&
          destination.has(target.origin) &&
          request.frame().page() === page;
        if (request.method() !== "GET" && request.method() !== "HEAD") {
          allowed =
            allowed &&
            state === "private" &&
            !!permit &&
            permit.valid() &&
            !permit.used &&
            request.method() === "POST" &&
            request.url() === permit.action &&
            request.isNavigationRequest() &&
            main;
          if (allowed && permit) permit.used = true;
        } else if (state === "private") {
          // Only a host-issued exact follow-up GET or resources belonging to
          // the newly committed, validated native submission document.
          const followUp =
            main &&
            request.isNavigationRequest() &&
            request.method() === "GET" &&
            request.url() === permit?.nextNavigation;
          allowed =
            allowed &&
            !!permit?.used &&
            permit.valid() &&
            (followUp ||
              (!request.isNavigationRequest() &&
                permit.committedVersion === documentVersion));
          if (allowed && followUp && permit) permit.nextNavigation = undefined;
        }
        if (!allowed || request.redirectedFrom()) throw new Error();
        // Chromium skips route handlers for continued redirects. Fetch exactly
        // one response; never let the network stack follow a secret POST.
        const response = await route.fetch({
          maxRedirects: 0,
          maxRetries: 0,
          timeout: 10_000,
        });
        try {
          const status = response.status();
          if (status >= 300 && status < 400) {
            if (
              status !== 303 ||
              request.method() !== "POST" ||
              state !== "private" ||
              !permit?.used ||
              request.url() !== permit.action
            )
              throw new Error();
            const location = response.headers().location;
            if (!location) throw new Error();
            const target = url(new URL(location, request.url()).href);
            if (
              target.origin !== new URL(permit.action).origin ||
              !navigation.has(target.origin)
            )
              throw new Error();
            // Commit an inert receipt, then enterPin issues a fresh GET. No
            // browser redirect, no replay of the POST body or credential.
            permit.redirect = target.href;
            permit.responseApproved = true;
            permit.documentUrl = request.url();
            await route.fulfill({
              status: 200,
              contentType: "text/html",
              body: "",
            });
          } else {
            if (state === "ended") throw new Error();
            if (
              state === "private" &&
              main &&
              request.isNavigationRequest() &&
              permit
            ) {
              permit.responseApproved = true;
              permit.documentUrl = request.url();
            }
            await route.fulfill({ response });
          }
        } finally {
          await response.dispose();
        }
        return;
      } catch {
        denied++;
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    await page.goto(initial.href, { waitUntil: "domcontentloaded" });

    const valid = (stamp: number) => state === "live" && epoch === stamp;
    const frame: BrowserSession["frame"] = async () => {
      if (state !== "live" || ++captures > 7200) return undefined;
      const stamp = epoch;
      try {
        const data = await page.screenshot({
          type: "jpeg",
          quality: 65,
          timeout: 5_000,
        });
        if (!valid(stamp) || data.length > 1024 * 1024) return undefined;
        return { generation, epoch: stamp, capturedAt: Date.now(), data };
      } catch {
        return undefined;
      }
    };
    const observe = async (): Promise<BrowserObservation> => {
      if (state !== "live") return unavailable();
      const stamp = epoch;
      const version = documentVersion;
      try {
        const text = await page.locator("body").innerText({ timeout: 3_000 });
        const elements: {
          ref: string;
          tag: string;
          type: string;
          label: string;
        }[] = [];
        const nextRefs = new Map<string, ElementHandle>();
        const handles = await page
          .locator("input,button,a,video,iframe")
          .elementHandles();
        for (const handle of handles.slice(0, 100)) {
          const description = await handle.evaluate((element) => {
            if (!(element instanceof Element))
              throw new Error("Not an element");
            return {
              tag: element.tagName.toLowerCase(),
              type: element.getAttribute("type") ?? "",
              label: (
                element.getAttribute("aria-label") ??
                element.textContent ??
                ""
              ).slice(0, 160),
            };
          });
          const ref = randomUUID();
          elements.push({ ref, ...description });
          nextRefs.set(ref, handle);
        }
        const captured = await frame();
        if (!valid(stamp) || version !== documentVersion) return unavailable();
        for (const handle of refs.values())
          void handle.dispose().catch(() => {});
        refs = nextRefs;
        return {
          text: JSON.stringify({
            source: "untrusted page",
            text: text.slice(0, 16000),
            elements,
            deniedRequests: denied,
          }),
          ...(captured
            ? {
                image: { mimeType: "image/jpeg" as const, data: captured.data },
              }
            : {}),
        };
      } catch {
        return unavailable();
      }
    };
    async function formScope(input: ElementHandle, submit: ElementHandle) {
      return input.evaluate((element, button) => {
        if (
          !(element instanceof HTMLInputElement) ||
          !(
            button instanceof HTMLButtonElement ||
            button instanceof HTMLInputElement
          ) ||
          !element.isConnected ||
          !button.isConnected ||
          !["password", "text", "tel", "number"].includes(element.type)
        )
          return null;
        const form = element.form;
        if (
          !form ||
          button.form !== form ||
          button.type !== "submit" ||
          (button.getAttribute("formmethod") ?? form.method).toLowerCase() !==
            "post" ||
          (button.getAttribute("formtarget") ?? form.target)
        )
          return null;
        return {
          action: button.getAttribute("formaction")
            ? button.formAction
            : form.action,
          origin: location.origin,
        };
      }, submit);
    }
    const tool: BrowserSession["tool"] = async (name, args) => {
      if (state !== "live" || busy) return unavailable();
      busy = true;
      const stamp = epoch;
      try {
        if (name === "request_pin") {
          const parsed = z
            .strictObject({ inputRef: z.string(), submitRef: z.string() })
            .parse(args);
          const input = refs.get(parsed.inputRef);
          const submit = refs.get(parsed.submitRef);
          if (!input || !submit) return unavailable();
          // Fence every in-flight image/DOM output before any await or secret fill.
          state = "private";
          epoch++;
          const scope = await formScope(input, submit);
          if (
            !scope ||
            url(scope.action).origin !== scope.origin ||
            !navigation.has(scope.origin) ||
            new URL(scope.action).search
          ) {
            if (state === "private") state = "live";
            return unavailable();
          }
          if (state !== "private") return unavailable();
          pending = {
            challengeId: randomUUID(),
            input,
            submit,
            ...scope,
            version: documentVersion,
          };
          return {
            text: `Waiting for owner PIN for ${scope.origin}. Observations paused.`,
          };
        }
        if (name === "navigate") {
          const parsed = z
            .strictObject({ url: z.string().max(4096) })
            .parse(args);
          const target = url(parsed.url);
          if (!navigation.has(target.origin)) return unavailable();
          await page.goto(target.href, { waitUntil: "domcontentloaded" });
          return observe();
        }
        if (name === "observe") {
          empty.parse(args);
          return observe();
        }
        if (name === "scroll") {
          const parsed = z
            .strictObject({ deltaY: z.number().int().min(-1440).max(1440) })
            .parse(args);
          await page.evaluate(
            (delta) => window.scrollBy(0, delta),
            parsed.deltaY,
          );
          return observe();
        }
        if (name === "discover_media") {
          empty.parse(args);
          const observation = await observe();
          if (!valid(stamp)) return unavailable();
          return {
            ...observation,
            text: `${observation.text}\nVideo refs support video_frame; iframe embeds are unsupported. Visuals only; no audio heard. Captions, if visible, are unverified page captions.`,
          };
        }
        if (name === "video_frame") {
          const parsed = z
            .strictObject({
              ref: z.string(),
              timeSeconds: z.number().finite().min(0).max(14400),
            })
            .parse(args);
          const video = refs.get(parsed.ref);
          if (!video) return unavailable();
          const metadata = await video.evaluate(async (element, time) => {
            if (!(element instanceof HTMLVideoElement)) return null;
            if (element.readyState < 2) {
              await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                  handlers.cleanup();
                  reject(new Error("Media unavailable"));
                }, 3000);
                // Methods avoid transpiler-injected function-name helpers in
                // serialized page code (the production runner uses tsx).
                const handlers = {
                  cleanup() {
                    clearTimeout(timeout);
                    element.removeEventListener("loadeddata", handlers.ready);
                  },
                  ready() {
                    handlers.cleanup();
                    resolve();
                  },
                };
                element.addEventListener("loadeddata", handlers.ready, {
                  once: true,
                });
              });
            }
            if (!Number.isFinite(element.duration) || time >= element.duration)
              return null;
            element.pause();
            element.muted = true;
            // seeked reports decoder state, not presentation. Wait for the
            // compositor's actual frame receipt before capturing pixels.
            const presentedTime = await new Promise<number>(
              (resolve, reject) => {
                let callback = 0;
                const timeout = setTimeout(() => {
                  element.cancelVideoFrameCallback(callback);
                  reject(new Error("seek unavailable"));
                }, 3000);
                const handlers = {
                  presented(
                    _now: number,
                    metadata: VideoFrameCallbackMetadata,
                  ) {
                    if (
                      element.seeking ||
                      Math.abs(metadata.mediaTime - time) > 0.25
                    ) {
                      callback = element.requestVideoFrameCallback(
                        handlers.presented,
                      );
                      return;
                    }
                    clearTimeout(timeout);
                    resolve(metadata.mediaTime);
                  },
                };
                callback = element.requestVideoFrameCallback(
                  handlers.presented,
                );
                element.currentTime = time;
              },
            );
            if (element.readyState < 2) return null;
            return {
              timeSeconds: presentedTime,
              durationSeconds: element.duration,
            };
          }, parsed.timeSeconds);
          if (!metadata || !valid(stamp) || ++captures > 7200)
            return unavailable();
          const data = await video.screenshot({
            type: "jpeg",
            quality: 75,
            timeout: 5000,
          });
          if (!valid(stamp) || data.length > 1024 * 1024) return unavailable();
          return {
            text: JSON.stringify({
              ...metadata,
              capturedAt: Date.now(),
              coverage: "Single visual frame only; no audio heard.",
            }),
            image: { mimeType: "image/jpeg", data },
          };
        }
        return unavailable();
      } catch {
        return unavailable();
      } finally {
        busy = false;
      }
    };
    return {
      generation,
      get state() {
        return state;
      },
      get epoch() {
        return epoch;
      },
      observe,
      frame,
      tool,
      close,
      pendingInput: () =>
        pending
          ? {
              origin: pending.origin,
              challengeId: pending.challengeId,
              question: `What is the PIN for ${pending.origin}?`,
            }
          : undefined,
      async enterPin(pin, valid = () => true) {
        if (!pending || state !== "private" || busy)
          throw new Error("No pending input");
        const challenge = pending;
        pending = undefined; // Consume once, including uncertain failures.
        busy = true;
        epoch++;
        try {
          if (!valid() || !/^\d{1,32}$/.test(pin))
            throw new Error("Invalid input");
          const scope = await formScope(challenge.input, challenge.submit);
          if (
            documentVersion !== challenge.version ||
            !scope ||
            scope.origin !== challenge.origin ||
            scope.action !== challenge.action ||
            state !== "private" ||
            !valid()
          )
            throw new Error("Stale challenge");
          const credentialName = await challenge.input.getAttribute("name");
          if (!valid()) throw new Error("Input revoked");
          await challenge.input.fill(pin);
          if (!valid()) throw new Error("Input revoked");
          permit = {
            action: challenge.action,
            used: false,
            responseApproved: false,
            valid,
          };
          await challenge.submit.click({ timeout: 5000 });
          await page.waitForLoadState("domcontentloaded");
          if (permit?.redirect) {
            const destination = permit.redirect;
            permit.nextNavigation = destination;
            permit.committedVersion = undefined;
            permit.responseApproved = false;
            await page.goto(destination, { waitUntil: "domcontentloaded" });
          }
          if (
            !permit?.used ||
            !permit.responseApproved ||
            permit.committedVersion !== documentVersion ||
            documentVersion === challenge.version
          )
            throw new Error("Submission unconfirmed");
          // Clear credential fields, not hidden CSRF/state fields required by a
          // replacement form. Arbitrary page reflection is a trusted-site risk.
          const clear = await page
            .locator("input")
            .evaluateAll((inputs, name) => {
              for (const input of inputs)
                if (
                  input instanceof HTMLInputElement &&
                  (input.type === "password" || (!!name && input.name === name))
                ) {
                  input.value = "";
                  input.removeAttribute("value");
                  if (input.value !== "") return false;
                }
              return true;
            }, credentialName);
          if (!clear || !valid())
            throw new Error("Credential field not cleared or input revoked");
          if (state === "private") {
            epoch++;
            state = "live";
          }
        } catch {
          throw new Error(
            "PIN submission unavailable or uncertain; observations remain private",
          );
        } finally {
          permit = undefined;
          busy = false;
        }
      },
    };
  } catch {
    await close();
    throw new Error("Browser session initialization unavailable");
  }
}
