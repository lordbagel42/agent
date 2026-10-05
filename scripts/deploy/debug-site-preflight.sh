#!/bin/sh
# Installed policy, run only as the isolated june-debug-build user.
set -eu
test "$(id -u)" != 0
test "$(node --version)" = v24.21.0
test "$(corepack pnpm --version)" = 10.33.0
test -n "$JUNE_DEBUG_BUILD_REVISION"
PNPM_MAX_WORKERS=1 NODE_OPTIONS=--max-old-space-size=384 \
  corepack pnpm install --frozen-lockfile --prod=false --ignore-scripts \
  --package-import-method=copy --network-concurrency=1
corepack pnpm exec biome check --vcs-enabled=false src scripts/build-debug-site.ts
corepack pnpm exec tsc --noEmit
corepack pnpm --dir debug-site exec biome check --vcs-enabled=false .
corepack pnpm --dir debug-site exec prettier --check '**/*.svelte'
corepack pnpm --dir debug-site exec svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
# A storage-permission fixture explicitly expects a 0644 unrelated file. This
# child umask never changes the controller, service, archive or secret modes.
(umask 022; corepack pnpm exec vitest run src/diagnostics --maxWorkers=1)
corepack pnpm --dir debug-site exec vitest run --config vitest.config.ts --maxWorkers=1
corepack pnpm --dir debug-site exec vite build
corepack pnpm exec tsx scripts/build-debug-site.ts

# Test the built artifact, not a development server, with disposable data only.
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'june-debug-smoke-'));
const socket = createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [resolve('dist/debug-site/server.mjs')], {
  env: {
    PORT: String(port), JUNE_DEBUG_DATABASE: join(directory, 'archive.sqlite'),
    JUNE_DEBUG_ORIGIN: origin,
    JUNE_DEBUG_VIEWER_TOKEN: 'synthetic-build-viewer-not-a-production-secret',
    JUNE_DEBUG_INGEST_TOKEN: 'synthetic-build-uploader-not-a-production-secret',
  },
  stdio: 'ignore',
});
const exited = new Promise(resolve => child.once('exit', resolve));
try {
  let response;
  for (let attempt = 0; attempt < 50; attempt++) {
    assert.equal(child.exitCode, null, 'bundle exited before readiness');
    response = await fetch(`${origin}/health`, {signal: AbortSignal.timeout(1000)}).catch(() => undefined);
    if (response?.ok) break;
    await sleep(100);
  }
  assert.ok(response?.ok, 'bundle readiness timeout');
  const health = await response.json();
  assert.equal(health.ready, true);
  assert.equal(health.revision, process.env.JUNE_DEBUG_BUILD_REVISION);
  assert.equal((await fetch(`${origin}/api/snapshots`)).status, 401);
  assert.equal((await fetch(`${origin}/s/00000000-0000-4000-8000-000000000001/conversation`)).status, 200);
} finally {
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(5000).then(() => {child.kill('SIGKILL'); throw new Error('smoke shutdown timeout');})]);
  await rm(directory, {recursive: true, force: true});
}
console.log('june_debug_bundle_smoke_passed');
JS
