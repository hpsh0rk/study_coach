#!/usr/bin/env bash
# One-command Cloudflare deploy. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
# Optional: AI_CONFIG_KEY / INTERNAL_SECRET (set as Worker secrets on first deploy).
# Untested against a real account (no credentials were available when this was written).
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
cd "$(dirname "$0")/.."
DB_NAME="${D1_NAME:-study-coach}"
BUCKET="${R2_BUCKET:-study-coach-files}"
W="npx wrangler"

cd apps/app
DB_ID=$($W d1 list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).find(x=>x.name===process.argv[1]);process.stdout.write(r?r.uuid:'')})" "$DB_NAME")
if [ -z "$DB_ID" ]; then
  $W d1 create "$DB_NAME" >/dev/null
  DB_ID=$($W d1 list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.parse(s).find(x=>x.name===process.argv[1]).uuid)})" "$DB_NAME")
fi
$W r2 bucket list | grep -q "name:\s*$BUCKET" || $W r2 bucket create "$BUCKET"

# Deploy config = wrangler.jsonc with the real database id and production vars.
node -e '
const fs=require("fs");
const src=fs.readFileSync("wrangler.jsonc","utf8").replace(/^\s*\/\/.*$/gm,"");
const c=JSON.parse(src);
c.d1_databases[0].database_id=process.argv[1];
c.d1_databases[0].database_name=process.argv[2];
c.r2_buckets[0].bucket_name=process.argv[3];
c.vars={...c.vars,ENVIRONMENT:"production",AI_ALLOW_STUB:"false"};
fs.writeFileSync(".wrangler.deploy.jsonc",JSON.stringify(c,null,2));
' "$DB_ID" "$DB_NAME" "$BUCKET"

$W d1 migrations apply DB --remote --config .wrangler.deploy.jsonc
cd ../..
pnpm --filter @kj/web build
cd apps/app
for s in AI_CONFIG_KEY INTERNAL_SECRET; do
  if [ -n "${!s:-}" ]; then printf '%s' "${!s}" | $W secret put "$s" --config .wrangler.deploy.jsonc; fi
done
$W deploy --config .wrangler.deploy.jsonc
echo "Deployed. Create the first admin with: pnpm admin:create --username admin --remote --config .wrangler.deploy.jsonc"
