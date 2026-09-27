#!/bin/sh
# Installed independently at /usr/local/lib/june-deploy/preflight.sh.
# No app environment, hooks or package scripts. The build cgroup owns children.
set -eu
test "$(node --version)" = v24.21.0
test "$(corepack pnpm --version)" = 10.33.0
corepack pnpm install --frozen-lockfile --prod=false --ignore-scripts --package-import-method=copy
test "$(corepack pnpm exec node --version)" = v24.21.0
test -f src/main.ts
test -x node_modules/.bin/tsx
test -x node_modules/.bin/codex
corepack pnpm exec biome check src
corepack pnpm exec tsc --noEmit
corepack pnpm exec vitest run src/core/routing.test.ts src/runtime/delivery.test.ts
