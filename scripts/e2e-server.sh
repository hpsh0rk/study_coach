#!/usr/bin/env bash
# Fresh local stack for Playwright: empty D1, migrations, a known admin, built web app.
set -euo pipefail
cd "$(dirname "$0")/.."
PERSIST="$PWD/.wrangler-e2e"
PORT="${E2E_PORT:-8788}"
rm -rf "$PERSIST"

KJ_DEV_PAGES=1 pnpm --filter @kj/web build >/dev/null
cd apps/app
npx wrangler d1 migrations apply DB --local --persist-to "$PERSIST" >/dev/null
cd ../..
node scripts/create-admin.mjs --username admin --password Admin12345 --persist-to "$PERSIST" >/dev/null
cd apps/app
# External parsing replays a recorded MinerU response: E2E never calls outside services.
exec npx wrangler dev --port "$PORT" --ip 127.0.0.1 --persist-to "$PERSIST" --var PARSER_MINERU_MODE:stub --show-interactive-dev-session=false
