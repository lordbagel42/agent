#!/bin/sh
# Installed independently at /usr/local/lib/june-deploy/preflight.sh.
# No app environment, hooks or package scripts. The build cgroup owns children.
set -eu
test "$(node --version)" = v24.21.0
test "$(corepack pnpm --version)" = 10.33.0
echo 'june_preflight: install'
# Bound install workers and their heaps, not the compiler's later heap budget.
PNPM_MAX_WORKERS=1 NODE_OPTIONS=--max-old-space-size=384 \
  corepack pnpm install --frozen-lockfile --prod=false --ignore-scripts --package-import-method=copy --network-concurrency=1
test "$(corepack pnpm exec node --version)" = v24.21.0
test -f src/main.ts
test -x node_modules/.bin/tsx
test -x node_modules/.bin/codex
echo 'june_preflight: lint'
corepack pnpm exec biome check src
echo 'june_preflight: typecheck'
corepack pnpm exec tsc --noEmit
echo 'june_preflight: safety_tests'
corepack pnpm exec vitest run src/core/routing.test.ts src/runtime/delivery.test.ts
echo 'june_preflight: isolated_startup'
# Disposable fixtures use synthetic credentials/state and no production providers.
# Run serially within the existing build cgroup; never against /var/lib/june.
corepack pnpm exec vitest run tests/startup.test.ts --maxWorkers=1
echo 'june_preflight: complete'
