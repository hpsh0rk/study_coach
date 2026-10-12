# AI 课件工坊 · study_coach

Teachers upload a textbook PDF, pick chapters, set the lesson length, confirm a time-budgeted outline, and get an HTML slide deck they can edit, present, or share with students. Architecture and decisions: [`docs/architecture.md`](docs/architecture.md).

Stack: pnpm monorepo · Cloudflare Workers + Hono · D1 (Drizzle) · static assets · React 19 + Vite. The PDF is parsed in the browser with pdf.js; only page text is uploaded. Everything runs locally with `wrangler dev` and fits the Workers Free plan.

## Local development

Requires Node 22+ and pnpm 10.

```bash
pnpm install
pnpm db:migrate:local                       # local D1 (apps/app/.wrangler)
pnpm admin:create --username admin          # prints a one-time password; change it at first login
pnpm dev                                    # builds the web app, serves everything on http://127.0.0.1:8787
```

- Flow: upload PDF → choose chapters/pages (printed page numbers; scanned pages are flagged and their text can be pasted) → lesson settings → outline (±15% time budget; over-budget confirm needs an explicit acknowledgement) → generate, edit/undo/regenerate per slide → present (←/→, S speaker notes, F fullscreen, B blank) or share a read-only link frozen at one outline version (unshare any time).
- `/admin` creates teacher accounts and configures the AI model: one enabled provider (DeepSeek, GLM, or any OpenAI-compatible endpoint: base URL + key) plus one model name serves every call. Keys are encrypted in D1 with `AI_CONFIG_KEY`. With no model enabled, local dev falls back to a deterministic stub (`AI_ALLOW_STUB=true`).
- `/dev/gallery` renders every layout at its hard content budget (English and Chinese); `/dev/render` renders a deck JSON. Both exist only under `vite dev` and in builds made with `KJ_DEV_PAGES=1` (the e2e server and `eval:render` set it); production builds leave them out.
- Built-in simulations live in `apps/web/public/sims/` and are listed in `EMBED_CATALOG` (`packages/widgets`). Experiment pages are only planned when a catalog sim matches the chapter.
- Secrets: copy `apps/app/.dev.vars.example` to `apps/app/.dev.vars`. Local dev also works without it, using development-only fallback keys.
- For web-only work, run `pnpm --filter @kj/web dev` (Vite on :5173, proxying the API to :8787).

## Tests

```bash
pnpm lint          # ESLint + model SDKs/endpoints only in packages/ai + dependency-cruiser boundaries
pnpm typecheck
pnpm test          # vitest across all packages; apps/app runs inside workerd (D1 gate, auth, slide reuse/undo)
pnpm test:e2e --project=overflow --project=e2e   # Playwright: max-budget fit per layout + full teacher flow on :8788
SHOTS_DIR=out pnpm test:e2e --project=e2e        # same flow, saving a screenshot per step
```

CI installs `fonts-noto-cjk` so the overflow test measures real CJK glyphs. `node scripts/make-fixture-pdf.mjs` regenerates the e2e PDFs (`waves-mini.pdf`, and `newton-zh-cid.pdf`: Chinese in a non-embedded CID font plus two scanned pages). `node scripts/bench-pbkdf2.mjs` measures the password-hash cost (see architecture §9).

## Evals (`tools/eval`)

Offline harness for ablation runs; it is not product code (dependency-cruiser forbids product code from importing it).

```bash
pnpm eval:run --eval-dir <dir with manifest.json + pdfs/ or pages.json> --out results/B0 [--scenarios S01,S03 | --all] [--runs 3] [--flags writerSource=none,phases=false]
pnpm eval:render results/B0      # renders every slide in Chromium and writes slides[].overflow
```

Provider: `KJ_EVAL_API_KEY` (+ `KJ_EVAL_PROVIDER` deepseek|glm|custom, `KJ_EVAL_MODEL`, `KJ_EVAL_BASE_URL`), or `DEEPSEEK_API_KEY` / `GLM_API_KEY`. Without a key every call uses the deterministic stubs. Flags map to `PipelineOptions` in `@kj/generation` (defaults = full pipeline) plus eval-only switches (`scope`, `outline`, `renderMode`, `autoConfirm`).

## Deploy to Cloudflare (not yet run)

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... AI_CONFIG_KEY=... pnpm run deploy
```

`scripts/deploy.sh` creates or finds the D1 database, writes `apps/app/.wrangler.deploy.jsonc` with the real database id, applies migrations remotely, builds the web app, sets the secret and runs `wrangler deploy`. The same steps run in GitHub Actions through `.github/workflows/deploy.yml` (manual trigger, repo secrets). Afterwards create the first admin with `pnpm admin:create --remote --config .wrangler.deploy.jsonc`.

China notes: fonts (Arimo, Noto Sans SC), KaTeX and the simulations are self-hosted, with no third-party CDN. A custom domain (sh0rk.cn) is still to be configured.

## Pending

- Everything that needs a real Cloudflare account: the first deploy, remote D1, and mainland-China access tests.
- Next iteration: number-source check on generated slides, table visual and more sims, a presenter window for notes, an offline single-file deck export, figures from the PDF.
