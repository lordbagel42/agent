import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createDebugSiteDeploymentInspection,
  createDebugSiteDeploymentReader,
} from "./deployment.js";

const status = {
  version: 1,
  controllerRevision: "1".repeat(40),
  phase: "ready",
  checkedAt: 1,
  targetRevision: "2".repeat(40),
  activeRevision: "3".repeat(40),
  reason: "source_unchanged",
};

it("reads only bounded trusted deployment metadata and fails soft on unsafe files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "debug-deployment-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "status.json");
  const read = createDebugSiteDeploymentReader({
    file,
    trustedUid: process.getuid?.(),
  });
  expect(await read()).toBeNull();
  await writeFile(file, JSON.stringify(status), { mode: 0o600 });
  expect(await read()).toEqual(status);
  await chmod(file, 0o644);
  expect(await read()).toBeNull();
  await chmod(file, 0o600);
  const link = join(directory, "redirect.json");
  await symlink(file, link);
  expect(
    await createDebugSiteDeploymentReader({
      file: link,
      trustedUid: process.getuid?.(),
    })(),
  ).toBeNull();
  await writeFile(
    file,
    JSON.stringify({ ...status, privateBody: "not public" }),
  );
  expect(await read()).toBeNull();
  await writeFile(file, "x".repeat(8192));
  expect(await read()).toBeNull();
});

it("inspects the configured site's live identity separately from stale controller receipts without credentials", async (t) => {
  const requests: {
    path?: string;
    method?: string;
    authorization?: string;
    cookie?: string;
  }[] = [];
  let mode = "healthy";
  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    if (mode === "redirect") {
      response.writeHead(302, { location: "/private" });
      response.end();
    } else if (mode === "oversized") {
      response.end("private ".repeat(2048));
    } else if (mode === "error") {
      response.writeHead(503);
      response.end("private upstream failure");
    } else {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ready: true,
          revision: "4".repeat(40),
          deployment: status,
          privateBody: "must not escape",
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const inspect = createDebugSiteDeploymentInspection(
    `http://127.0.0.1:${address.port}`,
  );
  const result = await inspect();
  expect(result).toContain(`Loaded website revision: ${"4".repeat(40)}`);
  expect(result).toContain(
    `Historical controller active revision: ${"3".repeat(40)}`,
  );
  expect(result).toContain("stale");
  expect(result).not.toContain("must not escape");
  for (mode of ["redirect", "oversized", "error"]) {
    const unavailable = await inspect();
    expect(unavailable).toContain("unavailable");
    expect(unavailable).not.toContain("private");
  }
  expect(requests).toEqual(
    Array.from({ length: 4 }, () => ({
      path: "/health",
      method: "GET",
      authorization: undefined,
      cookie: undefined,
    })),
  );
});
