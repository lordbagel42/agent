import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";
import type { ArtifactRecord, WorkflowView } from "./contracts.js";
import { artifactPage, HTML_CSP } from "./view.js";

export async function artifactAsset(root: string, path: string) {
  if (
    !/^[a-zA-Z0-9_./-]+$/.test(path) ||
    path.split("/").some((part) => part === ".." || part === "")
  )
    throw new Error("asset_denied");
  const type = (
    {
      ".js": "text/javascript",
      ".css": "text/css",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
      ".txt": "text/plain",
    } as Record<string, string>
  )[extname(path)];
  if (!type) throw new Error("asset_denied");
  return { bytes: await readFile(join(root, path)), type };
}
export class ArtifactRenderer {
  private busy = false;
  private cache = new Map<string, Buffer>();
  constructor(readonly assets: string) {}
  async render(
    record: ArtifactRecord,
    workflow?: WorkflowView,
    locked = false,
  ): Promise<Buffer> {
    const key = JSON.stringify([
      record.id,
      record.revision,
      record.generation,
      workflow,
      locked,
    ]);
    const saved = this.cache.get(key);
    if (saved) return saved;
    if (this.busy) throw new Error("artifact_renderer_busy");
    this.busy = true;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        timeout: 10_000,
      });
      timeout = setTimeout(() => {
        void browser?.close();
      }, 15_000);
      const context = await browser.newContext({
        viewport: { width: 1200, height: 760 },
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      await context.routeWebSocket(/.*/, (socket) => socket.close());
      await context.route(/.*/, async (route) => {
        const url = new URL(route.request().url());
        if (
          url.origin !== "https://artifact.invalid" ||
          route.request().method() !== "GET"
        )
          return route.abort();
        try {
          if (url.pathname.startsWith("/artifacts/assets/")) {
            const asset = await artifactAsset(
              this.assets,
              url.pathname.slice("/artifacts/assets/".length),
            );
            return route.fulfill({
              body: asset.bytes,
              contentType: asset.type,
            });
          }
          if (url.pathname.endsWith("/data"))
            return route.fulfill({
              json: {
                title: record.title,
                kind: record.kind,
                visibility: record.visibility,
                generation: record.generation,
                revision: record.revision,
                content: record.content,
                workflow,
              },
            });
          if (url.pathname.endsWith("/document"))
            return route.fulfill({
              body: record.content,
              contentType: "text/html",
              headers: { "content-security-policy": HTML_CSP },
            });
          if (url.pathname === `/artifacts/${record.id}/`)
            return route.fulfill({
              body: String(await artifactPage(record.id, "preview", locked)),
              contentType: "text/html",
            });
        } catch {
          /* Block missing assets, never fetch them externally. */
        }
        return route.abort();
      });
      const page = await context.newPage();
      await page.goto(
        `https://artifact.invalid/artifacts/${record.id}/?preview`,
        {
          waitUntil: "domcontentloaded",
        },
      );
      if (!locked)
        await page
          .locator('body[data-ready="true"]')
          .waitFor({ timeout: 10_000 });
      if (!locked)
        await page
          .locator(
            record.kind === "board"
              ? "canvas"
              : record.kind === "html"
                ? "iframe"
                : ".workflow",
          )
          .first()
          .waitFor({ timeout: 10_000 });
      await page.evaluate(() => document.fonts.ready);
      // Let Excalidraw's canvas and the isolated HTML document paint.
      await page.waitForTimeout(300);
      const bytes = await page.screenshot({ type: "png" });
      if (bytes.length > 4_194_304) throw new Error("artifact_preview_limit");
      if (this.cache.size >= 16) this.cache.clear();
      this.cache.set(key, bytes);
      return bytes;
    } finally {
      clearTimeout(timeout);
      await browser?.close();
      this.busy = false;
    }
  }
}
