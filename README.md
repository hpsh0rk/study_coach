# AI 课件工坊 · study_coach

Teachers upload a textbook PDF, pick chapters, confirm an outline, and get an HTML slide deck they can present or share with students. This repo is spike S0 + milestone M1a-1: the backbone, the deck schema, the HTML renderer/player, and whitelist login.

Stack: pnpm monorepo · Cloudflare Workers + Hono · D1 (Drizzle) · Durable Objects · R2 · Workflows · React 19 + Vite. Everything runs locally with `wrangler dev` and no paid Cloudflare features.

## Local development

Requires Node 22+ and pnpm 10.

```bash
pnpm install
pnpm db:migrate:local                       # local D1 (apps/app/.wrangler)
pnpm admin:create --username admin          # prints a one-time password; change it at first login
pnpm seed:sims                              # optional: self-host PhET sims in local R2
pnpm dev                                    # builds the web app, serves everything on http://127.0.0.1:8787
```

- `/demo` shows the 10-slide S0 sample deck (←/→ to page, F for fullscreen, S for the speaker view).
- `/admin` is where you create teacher accounts and configure AI providers: DeepSeek, GLM, or any OpenAI-compatible endpoint (base URL + key + model). Keys are encrypted in D1 with `AI_CONFIG_KEY`. With no provider configured, local dev falls back to a deterministic stub (`AI_ALLOW_STUB=true`).
- Secrets: copy `apps/app/.dev.vars.example` to `apps/app/.dev.vars`. Local dev also works without it, using development-only fallback keys.
- For web-only work, run `pnpm --filter @kj/web dev` (Vite on :5173, proxying the API to :8787).

### Heavy PDF parser (Docker)

The in-Worker `pdf-lite` parser reads bookmarks and the text layer. `containers/heavy` handles heavier parsing (pypdfium2, plus Docling as an option). On Cloudflare it would run as a Container, which needs a paid plan; locally it runs under Docker:

```bash
docker compose up -d heavy
cd apps/app && npx wrangler dev --ip 0.0.0.0 --var PARSER:heavy
```

The container downloads the PDF from `/internal/documents/:id/pdf` and posts the result back to `/internal/documents/:id/parsed`, authenticated with an HMAC token. `CALLBACK_BASE_URL` defaults to `http://host.docker.internal:8787`. Python tests: `pip install -r containers/heavy/requirements-dev.txt && cd containers/heavy && pytest tests`.

## Tests

```bash
pnpm lint          # ESLint + check that model calls only happen in packages/ai
pnpm typecheck
pnpm test          # vitest across all packages; apps/app runs inside workerd (DO gate + auth)
pnpm test:e2e --project=e2e        # Playwright full flow against a fresh wrangler dev on :8788
SHOTS_DIR=out pnpm screenshots     # renders the S0 deck to PNGs
```

## Deploy to Cloudflare (not yet run)

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... AI_CONFIG_KEY=... INTERNAL_SECRET=... pnpm run deploy
```

`scripts/deploy.sh` does the following:

1. Creates or finds the D1 database and the R2 bucket.
2. Writes `apps/app/.wrangler.deploy.jsonc` with the real database id.
3. Applies migrations remotely.
4. Builds the web app.
5. Sets the secrets and runs `wrangler deploy`.

The same steps run in GitHub Actions through `.github/workflows/deploy.yml`, triggered manually with repo secrets. Afterwards, create the first admin with `pnpm admin:create --remote --config .wrangler.deploy.jsonc`, and seed sims with `pnpm seed:sims --remote`.

China notes: fonts (Arimo, Noto Sans SC), KaTeX and PhET sims are all self-hosted, with no third-party CDN. A custom domain (sh0rk.cn) is still to be configured.

## Pending

- Everything that needs a real Cloudflare account: the first deploy, remote D1/R2, FTS5 trigram on real D1, and the custom domain plus mainland-China access tests.
- argon2id login costs about 190 ms of CPU, which exceeds the Workers Free limit of 10 ms per request. This needs a paid plan or a cheaper KDF.
- Cloudflare Containers / Browser Run require a paid plan; locally, Docker is used instead. The Docling engine is not exercised in tests.
- Not built yet: presigned multipart R2 uploads (uploads currently go through the Worker), Cloudflare Access in front of `/admin`, the MinerU API adapter, AI outline revision, the offline Service Worker, and pptx export.
- `wrangler dev` logs "code had hung" after each Workflow instance completes. Results are still persisted; this looks like a local Workflows engine artifact and is unconfirmed.
- `@cloudflare/vitest-pool-workers` has been renamed to `@cloudflare/vitest-plugin`; migrate when convenient.
