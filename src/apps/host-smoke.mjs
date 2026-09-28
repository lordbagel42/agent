// Disposable container-only check: no real credentials, cluster or cloud writes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

assert.equal(process.getuid(), 10001);
const control = randomBytes(32).toString("hex");
const viewer = randomBytes(32).toString("hex");
const engineToken = randomBytes(32).toString("hex");
const source =
  "export default { fetch: r => { console.log('private-application-log'); return Response.json({ value: 37, authorization: r.headers.get('authorization') }); } };";
const privateValues = [
  control,
  viewer,
  engineToken,
  source,
  "private-path",
  "private-query",
  "private-application-log",
];
let privateLeak = false;
for (const directory of ["/data/host", "/data/engine"]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}
await writeFile(
  "/data/engine.json",
  JSON.stringify({
    file_system: { path: "/data/engine/db" },
    guard: { host: "127.0.0.1", port: 6420 },
    api_peer: { host: "127.0.0.1", port: 6421 },
    metrics: { host: "127.0.0.1", port: 6430 },
  }),
);
await writeFile(
  "/data/host.json",
  JSON.stringify({
    port: 3090,
    directory: "/data/host",
    origin: "https://apps.example.invalid",
    controlTokenEnv: "JUNE_APPS_CONTROL_TOKEN",
    viewerTokenEnv: "JUNE_APPS_VIEWER_TOKEN",
  }),
);
let engine;
let host;
let diagnostics = "";
let lastRequest = "startup";
const capture = (child) => {
  for (const stream of [child.stdout, child.stderr]) {
    let overlap = "";
    stream.on("data", (chunk) => {
      const text = overlap + chunk.toString();
      privateLeak ||= privateValues.some((value) => text.includes(value));
      overlap = text.slice(
        -Math.max(...privateValues.map((value) => value.length)),
      );
      diagnostics = (diagnostics + chunk.toString()).slice(-65_536);
    });
  }
};
const start = () => {
  engine = spawn(
    "/opt/june-apps/rivet-engine",
    ["start", "--config", "/data/engine.json"],
    {
      env: {
        ...process.env,
        HOME: "/data/engine",
        RIVET__AUTH__ADMIN_TOKEN: engineToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  capture(engine);
  host = spawn(process.execPath, ["src/apps/supervisor.mjs"], {
    env: {
      ...process.env,
      HOME: "/data/host",
      JUNE_ALLOW_DYNAMIC_APPS: "1",
      JUNE_APPS_CONFIG: "/data/host.json",
      JUNE_APPS_CONTROL_TOKEN: control,
      JUNE_APPS_VIEWER_TOKEN: viewer,
      RIVET_TOKEN: engineToken,
      RIVET_ENDPOINT: "http://127.0.0.1:6420",
      RIVET_NAMESPACE: "default",
      RIVET_POOL: "default",
      RIVET_RUN_ENGINE: "0",
      RIVETKIT_ENGINE_SPAWN: "never",
      RIVET_RUN_SERVICES: "0",
      RIVETKIT_RUNTIME_MODE: "envoy",
      RIVET_ENVOY_VERSION: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  capture(host);
};
const stop = async () => {
  for (const child of [host, engine]) {
    if (!child || child.exitCode !== null || child.signalCode !== null)
      continue;
    child.kill("SIGTERM");
    for (
      let attempt = 0;
      attempt < 90 && child.exitCode === null && child.signalCode === null;
      attempt++
    )
      await sleep(1000);
    if (child.exitCode === null && child.signalCode === null)
      throw new Error("child_did_not_stop");
    if (child === host)
      assert.equal(child.exitCode, 0, "unclean_host_shutdown");
  }
};
const viewerDurations = [];
const call = async (path, token, body) => {
  lastRequest = path;
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:3090${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(path.startsWith("/apps/") ? 60_000 : 10_000),
  });
  if (token === viewer)
    viewerDurations.push(Math.round(performance.now() - started));
  return response;
};
const ready = async () => {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (host.exitCode !== null || engine.exitCode !== null)
      throw new Error("runtime_exited");
    if ((await call("/health/ready").catch(() => null))?.status === 200) return;
    await sleep(1000);
  }
  throw new Error("runtime_not_ready");
};
let result = 1;
try {
  start();
  await ready();
  await chmod("/data/host/audit.ndjson", 0o400);
  await call("/apps/smoke/");
  assert.equal((await call("/health/ready")).status, 503);
  await chmod("/data/host/audit.ndjson", 0o600);
  assert.equal((await call("/health/ready")).status, 200);
  assert.equal((await call("/control/prepare", viewer, {})).status, 401);
  const prepared = await call("/control/prepare", control, {
    jobId: "a".repeat(64),
    requestId: "b".repeat(64),
    artifact: {
      appId: "smoke",
      files: {
        "package.json": JSON.stringify({ type: "module", main: "index.js" }),
        "index.js": source,
      },
    },
  });
  assert.equal(prepared.status, 200);
  const receipt = await prepared.json();
  assert.equal(
    (await call(`/control/deploy/${receipt.id}`, control, {})).status,
    202,
  );
  // Drain while the first build is active, before it starts the SDK registry.
  await stop();
  start();
  await ready();
  let deployed;
  for (let attempt = 0; attempt < 180; attempt++) {
    deployed = await (
      await call(`/control/receipts/${receipt.id}`, control)
    ).json();
    if (deployed.status !== "deploying") break;
    await sleep(1000);
  }
  assert.equal(
    deployed.status,
    "deployed",
    deployed.failureCode ?? "deployment_failed",
  );
  assert.equal((await call("/apps/smoke/")).status, 401);
  assert.deepEqual(await (await call("/apps/smoke/", viewer)).json(), {
    value: 37,
    authorization: null,
  });
  assert.equal(
    (await (await call(`/control/deploy/${receipt.id}`, control, {})).json())
      .release,
    deployed.release,
  );
  await call("/control/receipts/private-path?token=private-query", control);
  const second = await (
    await call("/control/prepare", control, {
      jobId: "c".repeat(64),
      requestId: "d".repeat(64),
      artifact: {
        appId: "second",
        files: {
          "package.json": JSON.stringify({ type: "module", main: "index.js" }),
          "index.js": source.replace("value: 37", "value: 39"),
        },
      },
    })
  ).json();
  assert.equal(
    (await call(`/control/deploy/${second.id}`, control, {})).status,
    202,
  );
  // The registry now already exists: it must not see SIGTERM before receipts drain.
  await stop();
  start();
  await ready();
  assert.equal(
    (await (await call(`/control/receipts/${receipt.id}`, control)).json())
      .status,
    "deployed",
  );
  assert.deepEqual(await (await call("/apps/smoke/", viewer)).json(), {
    value: 37,
    authorization: null,
  });
  assert.equal(
    (await (await call(`/control/receipts/${second.id}`, control)).json())
      .status,
    "deployed",
  );
  assert.deepEqual(await (await call("/apps/second/", viewer)).json(), {
    value: 39,
    authorization: null,
  });
  await stop();
  const audit =
    (await readFile("/data/host/audit.ndjson", "utf8")) +
    (await readFile("/data/host/audit.ndjson.1", "utf8").catch(() => ""));
  for (const privateValue of privateValues) {
    assert.equal(audit.includes(privateValue), false, "audit_privacy_boundary");
  }
  assert.equal(privateLeak, false, "stdout_privacy_boundary");
  assert.equal(audit.includes('"event":"deploy_finished"'), true);
  console.info(
    JSON.stringify({
      event: "smoke_passed",
      architecture: process.arch,
      restart: true,
      privacy: true,
      viewerDurations,
    }),
  );
  result = 0;
} catch (error) {
  // This harness contains only disposable fixture source and credentials.
  for (const token of [control, viewer, engineToken])
    diagnostics = diagnostics.replaceAll(token, "[fixture-token]");
  console.error(
    JSON.stringify({ error: String(error), lastRequest, diagnostics }),
  );
} finally {
  await stop();
  process.exit(result);
}
