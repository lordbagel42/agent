import { createHash } from "node:crypto";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { z } from "zod";
import type { ToolAction, ToolAdapter } from "./broker.js";

const selector = z.string().min(1).max(512);
const step = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("click"), selector }),
  z.strictObject({
    kind: z.literal("fill"),
    selector,
    value: z.string().max(4096),
  }),
  z.strictObject({
    kind: z.literal("login"),
    usernameSelector: selector,
    passwordSelector: selector,
  }),
]);
export const browserOperationSchema = z.strictObject({
  name: z.string().min(1).max(128),
  account: z.string().min(1),
  item: z.string().min(1),
  origin: z.string().url(),
  url: z.string().url(),
  requests: z
    .array(
      z.strictObject({
        url: z.string().url(),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        credential: z.boolean().default(false),
        maxUses: z.number().int().min(1).max(16).default(1),
      }),
    )
    .min(1)
    .max(32),
  steps: z.array(step).max(16).default([]),
  success: z.strictObject({ selector, text: z.string().min(1).max(4096) }),
  /** Only available to anonymous operations; all returned text is untrusted data. */
  outputSelector: selector.optional(),
});

export type BrowserOperation = z.input<typeof browserOperationSchema>;
export function browserOperationDigest(recipe: BrowserOperation): string {
  return createHash("sha256")
    .update(JSON.stringify(browserOperationSchema.parse(recipe)))
    .digest("hex");
}

export interface BrowserOptions {
  operations: BrowserOperation[];
  timeoutMs?: number;
  /** Host integrations must bind grants to the complete immutable recipe. */
  requireRecipeDigest?: boolean;
  /** Explicit dedicated child paths; never inherit the host credential environment. */
  environment?: { HOME: string; TMPDIR: string };
  /** Trusted host-only override; use the pinned Playwright Chromium build. */
  executablePath?: string;
  /** Disposable local fixtures only. Production destinations must use HTTPS. */
  allowLoopbackHttp?: boolean;
}
const bearerCredential = z.strictObject({
  bearerToken: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[\x21-\x7e]+$/u),
});
const loginCredential = z.strictObject({
  kind: z.literal("login"),
  username: z.string().min(1).max(8192),
  password: z.string().min(1).max(8192),
});
/** Structurally matches the credential resolver's bearer/login union. */
export type BrowserCredential =
  | z.infer<typeof bearerCredential>
  | z.infer<typeof loginCredential>;
export interface BrowserResult {
  operation: string;
  status: "confirmed";
  /** Never present when a credential was supplied. Not instructions or authority. */
  untrustedText?: string;
}

function denied(): never {
  throw new Error("browser_action_denied");
}

/** Named, operator-authored recipes only. No arbitrary JS, URLs, cookies, or profiles.
 * Broker owns durable one-use receipts. This worker never retries an operation.
 * See docs/browser.md for the required external process/network isolation.
 */
export class BrowserAdapter implements ToolAdapter {
  readonly #operations: z.output<typeof browserOperationSchema>[];
  readonly #timeout: number;
  readonly #requireRecipeDigest: boolean;
  readonly #environment: Record<string, string>;
  readonly #executablePath: string | undefined;
  readonly #active = new Map<() => Promise<void>, Promise<void>>();
  #closed = false;

  constructor(options: BrowserOptions) {
    this.#timeout = options.timeoutMs ?? 15_000;
    this.#requireRecipeDigest = options.requireRecipeDigest === true;
    this.#environment = options.environment
      ? { HOME: options.environment.HOME, TMPDIR: options.environment.TMPDIR }
      : {};
    this.#executablePath = options.executablePath;
    if (
      !Number.isInteger(this.#timeout) ||
      this.#timeout < 100 ||
      this.#timeout > 60_000
    )
      denied();
    this.#operations = z
      .array(browserOperationSchema)
      .min(1)
      .max(64)
      .parse(options.operations);
    const names = new Set<string>();
    for (const recipe of this.#operations) {
      const origin = new URL(recipe.origin);
      if (origin.origin !== recipe.origin || names.has(recipe.name)) denied();
      names.add(recipe.name);
      if (
        origin.protocol !== "https:" &&
        !(
          options.allowLoopbackHttp &&
          origin.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(origin.hostname)
        )
      )
        denied();
      const urls = [
        recipe.url,
        ...recipe.requests.map((request) => request.url),
      ];
      for (const value of urls) {
        const url = new URL(value);
        if (
          url.origin !== recipe.origin ||
          url.username ||
          url.password ||
          url.hash ||
          url.href !== value
        )
          denied();
      }
      if (
        !recipe.requests.some(
          (request) => request.url === recipe.url && request.method === "GET",
        )
      )
        denied();
      const requests = new Set<string>();
      for (const request of recipe.requests) {
        const key = `${request.method} ${request.url}`;
        if (requests.has(key)) denied();
        requests.add(key);
        // Mutations cannot be silently repeated by scripts or double submissions.
        if (request.method !== "GET" && request.maxUses !== 1) denied();
      }
      const loginSteps = recipe.steps.filter(
        (step) => step.kind === "login",
      ).length;
      const bearer = recipe.requests.some((request) => request.credential);
      if (loginSteps > 1 || (loginSteps && bearer)) denied();
      if (recipe.outputSelector && (loginSteps || bearer)) denied();
    }
  }

  /** A proposal only; authorization still belongs to the broker. */
  action(name: string): ToolAction {
    const recipe = this.#operations.find((entry) => entry.name === name);
    if (!recipe || this.#closed) denied();
    return {
      tool: "browser",
      account: recipe.account,
      item: recipe.item,
      origin: recipe.origin,
      arguments: {
        operation: recipe.name,
        recipeDigest: browserOperationDigest(recipe),
      },
    };
  }

  /** Host shutdown/cancellation only, never a tool exposed to page/model content. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(
      [...this.#active].map(async ([stop, done]) => {
        await stop();
        await done;
      }),
    );
  }

  async execute(
    action: ToolAction,
    credential: unknown,
    signal?: AbortSignal,
  ): Promise<BrowserResult> {
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let complete: (() => void) | undefined;
    const stop = async () => {
      stopped = true;
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    };
    const abort = () => {
      void stop();
    };
    try {
      if (this.#closed || signal?.aborted) denied();
      const args = z
        .strictObject({
          operation: z.string(),
          recipeDigest: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .parse(action.arguments);
      const recipe = this.#operations.find(
        (entry) => entry.name === args.operation,
      );
      if (
        !recipe ||
        action.tool !== "browser" ||
        action.account !== recipe.account ||
        action.item !== recipe.item ||
        action.origin !== recipe.origin ||
        (this.#requireRecipeDigest && !args.recipeDigest) ||
        (args.recipeDigest !== undefined &&
          args.recipeDigest !== browserOperationDigest(recipe))
      )
        denied();
      const bearer = recipe.requests.some((request) => request.credential);
      const login = recipe.steps.some((step) => step.kind === "login");
      const secret = bearer
        ? bearerCredential.parse(credential).bearerToken
        : undefined;
      const credentials = login ? loginCredential.parse(credential) : undefined;
      if (!bearer && !login && credential !== null && credential !== undefined)
        denied();
      this.#active.set(
        stop,
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
      );
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, this.#timeout);
      browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        timeout: this.#timeout,
        executablePath: this.#executablePath,
        env: this.#environment,
      });
      if (stopped) denied();
      context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
        permissions: [],
      });
      if (stopped) denied();
      context.setDefaultTimeout(this.#timeout);
      context.setDefaultNavigationTimeout(this.#timeout);
      // Never connect a routed WebSocket to its server.
      await context.routeWebSocket(/.*/, (socket) => {
        socket.close();
        abort();
      });
      const page = await context.newPage();
      context.on("page", (other) => {
        if (other !== page) abort();
      });
      page.on("download", abort);
      page.on("dialog", (dialog) => {
        void dialog.dismiss().catch(() => {});
      });
      let navigations = 0;
      page.on("framenavigated", (frame) => {
        if (
          frame !== page.mainFrame() ||
          ++navigations > 8 ||
          new URL(frame.url()).origin !== recipe.origin
        )
          abort();
      });
      const used = new Map<number, number>();
      await context.route(/.*/, async (route) => {
        try {
          const request = route.request();
          const index = recipe.requests.findIndex(
            (entry) =>
              entry.url === request.url() && entry.method === request.method(),
          );
          const rule = recipe.requests[index];
          if (
            stopped ||
            !rule ||
            request.frame() !== page.mainFrame() ||
            request.redirectedFrom()
          )
            throw new Error();
          const count = (used.get(index) ?? 0) + 1;
          if (count > rule.maxUses) throw new Error();
          used.set(index, count);
          const headers = await request.allHeaders();
          // Cancellation may arrive while request metadata is being retrieved.
          if (stopped) throw new Error();
          delete headers.authorization;
          delete headers["proxy-authorization"];
          if (rule.credential) headers.authorization = `Bearer ${secret}`;
          // route.continue follows redirects without re-routing: never use it here.
          const response = await route.fetch({
            headers,
            maxRedirects: 0,
            maxRetries: 0,
            timeout: this.#timeout,
          });
          try {
            if (response.status() >= 300 && response.status() < 400)
              throw new Error();
            if (stopped) throw new Error();
            await route.fulfill({ response });
          } finally {
            await response.dispose();
          }
        } catch {
          await route.abort().catch(() => {});
          abort();
        }
      });
      await page.goto(recipe.url, { waitUntil: "domcontentloaded" });
      for (const step of recipe.steps) {
        if (stopped) denied();
        if (step.kind === "login") {
          if (!credentials) denied();
          for (const [selector, value] of [
            [step.usernameSelector, credentials.username],
            [step.passwordSelector, credentials.password],
          ] as const) {
            // The origin check and secret write run synchronously in the same
            // document, not a check-then-fill across a navigation race.
            await page.locator(selector).evaluate(
              (element, input) => {
                if (
                  element.ownerDocument.location.origin !== input.origin ||
                  !(element instanceof HTMLInputElement)
                )
                  throw new Error("invalid_login_target");
                const setter = Object.getOwnPropertyDescriptor(
                  HTMLInputElement.prototype,
                  "value",
                )?.set;
                if (!setter) throw new Error("invalid_login_target");
                setter.call(element, input.value);
                element.dispatchEvent(new Event("input", { bubbles: true }));
                element.dispatchEvent(new Event("change", { bubbles: true }));
              },
              { origin: recipe.origin, value },
            );
          }
          continue;
        }
        const target = page.locator(step.selector);
        if (step.kind === "click") await target.click();
        else await target.fill(step.value);
      }
      const confirmation = page.locator(recipe.success.selector);
      await confirmation.waitFor({ state: "visible" });
      if ((await confirmation.textContent()) !== recipe.success.text) denied();
      let untrustedText: string | undefined;
      if (recipe.outputSelector) {
        untrustedText = await page
          .locator(recipe.outputSelector)
          .evaluate((element) => (element.textContent ?? "").slice(0, 4096));
      }
      if (stopped || signal?.aborted) denied();
      return {
        operation: recipe.name,
        status: "confirmed",
        ...(untrustedText === undefined ? {} : { untrustedText }),
      };
    } catch {
      // Playwright errors can include DOM, headers, URLs, and secrets. Never forward them.
      throw new Error("browser_action_failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await stop();
      this.#active.delete(stop);
      complete?.();
    }
  }
}
