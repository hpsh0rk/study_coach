#!/usr/bin/env bash
# Fresh local stack for Playwright: empty D1/R2/DO state, migrations, a known admin, built web app.
set -euo pipefail
cd "$(dirname "$0")/.."
PERSIST="$PWD/.wrangler-e2e"
PORT="${E2E_PORT:-8788}"
rm -rf "$PERSIST"

pnpm --filter @kj/web build >/dev/null
cd apps/app
npx wrangler d1 migrations apply DB --local --persist-to "$PERSIST" >/dev/null
cd ../..
node scripts/create-admin.mjs --username admin --password Admin12345 --persist-to "$PERSIST" >/dev/null
# Reuse already-downloaded PhET files (no network); without them slide 8 shows the "not installed" card.
if [ -d .cache/phet ] && ls .cache/phet/*.html >/dev/null 2>&1; then
  node --experimental-strip-types --no-warnings scripts/seed-sims.mjs --persist-to "$PERSIST" >/dev/null
fi

cd apps/app
exec npx wrangler dev --port "$PORT" --ip 127.0.0.1 --persist-to "$PERSIST" --var PARSER:pdf-lite --show-interactive-dev-session=false
