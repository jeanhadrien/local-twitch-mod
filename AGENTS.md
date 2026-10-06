# AGENTS.md — klawz-chat-ai

Twitch chat moderator: `tmi.js` ingest → Jev Decisions judging → Helix enforcement. Express backend serves API + static Vite frontend.

## Commands

```bash
npm run build:server   # tsc -p tsconfig.server.json → dist-server/
npm run build:web      # vite build → dist/
npm run build          # server + web
npm run typecheck      # both tsconfigs (server --noEmit + web --noEmit); no eslint/prettier
npm run dev:server     # builds server, then node dist-server/index.js (PORT, default 3000)
npm run dev:web        # vite :5173, proxies /api + /auth → localhost:3000
npm start              # node dist-server/index.js (prod; serves dist/ if built)
npm run verify:judge   # mocked judge+delete checks, no network — requires `npm run build:server` first
```

No test framework. `scripts/verify-judge.cjs` (requires `dist-server/judge.js`, `dist-server/actions.js`) is the only verification. Correct prod URL is `http://localhost:3000`; `:5173` only works while `dev:web` runs.

## Architecture

- `src/server/index.ts` — Express app, static `dist/` + SPA fallback, auto-joins Twitch on boot if channel + token stored. Entry: `seedIfMissing()` → `registerRoutes(app)` → `autoConnect()`.
- `src/server/routes.ts` — all `/api/*`, `/auth/*`, SSE `/api/events`, live pipeline `handleLiveMessage()`.
- `src/server/judge.ts` — judging. `src/server/context.ts` — `{{message}}`/`{{username}}` substitution. `src/server/twitch.ts` — IRC + Helix. `src/server/actions.ts` — enforcement. `src/server/store.ts` — JSON persistence. `src/server/retry.ts` — retry helper. `src/server/events.ts` — SSE bus.
- `src/web/` — React pages `pages/Setup|Actions|Rules|Context|Live.tsx`, API client `api.ts`, entry `main.tsx` → `App.tsx`.

## Gotchas (verify before changing)

- **Judge is NOT an LLM call.** Only `POST https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13`. Never use `/api/v1/chat/completions` or chat SDKs. Request body is `{ model, state, questions }` — see `buildDecisionsBody()` in `judge.ts`.
- **Batch judging is default ON** (`settings.judging.batch`): one call for all enabled rules, batch failure → sequential per-rule fallback. Batch cost split evenly per rule. `batch: false` forces sequential.
- **Retry: 429/5xx/network/timeout retry** with fixed backoff `[500,1000,2000]ms` (4 attempts); **400/401/403 fail fast, no retry**. Same policy for Helix enforcement (delete/ban/warn). Never throws to caller — transport errors become `invalid` results / `FAILED` action outcomes.
- **Match logic:** choice-type: `choice ∈ matchValues AND (confidence ?? 1) >= minConfidence`; noul-type: `noul >= minConfidence` (default 0.6) emits `choice "true"/"false"`. Unknown choice or missing answer → `invalid`, log only, no action. Low-confidence match → log only.
- **Context `state` is user-defined** (Context page, `json`|`text` mode). Only `{{message}}` and `{{username}}` tokens exist — unknown tokens block save (client + server 400). `noul` criteria `{true,false}` omitted from request when both empty.
- **Persistence is JSON in `DATA_DIR`** (env override, default `./data/`, gitignored, auto-seeded on boot): `config.json` (non-secret settings), `rules.json`, `actions.json`, `bindings.json`, `logs.jsonl` (append-only), `.secrets.json` (mode 0600, Twitch tokens + OpenRouter key). Legacy rules without `type` normalize to `"choice"` on read.
- **Twitch OAuth redirect must match exactly:** `http://localhost:<PORT>/auth/callback` (see `TWITCH_SETUP.md`). Delete actor = logged-in account, which must be mod of the channel or deletes 403. All four action types execute: `delete`, `timeout`, `ban`, `warn`. Timeout/ban share `POST /helix/moderation/bans` (duration ⇒ timeout, absent ⇒ permanent ban; duration defaults 600, clamped 1..1209600); warn is `POST /helix/moderation/warnings` (reason required, 1..500 chars) and needs the extra `moderator:manage:warnings` scope. User-targeted actions need the message author's `user-id` from tmi.js tags; missing → FAILED outcome, no Helix call.
- **Two TypeScript projects:** `tsconfig.server.json` (CommonJS, `src/server` → `dist-server`) and `tsconfig.web.json` (bundler, `noEmit`). Root `tsconfig.json` covers `src/**/*`. Keep server/web imports separate; web must not import from `src/server`.
