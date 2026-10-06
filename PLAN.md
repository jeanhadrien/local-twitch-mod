# Chat Moderator — Plan (MVP)

## Goal
Use OpenRouter API to judge if a Twitch chat message matches user-configurable rules, then execute 1..n configured actions (delete / timeout / ban).

## Locked decisions
- On match: execute associated actions (1 rule → n actions). MVP enforces `delete`.
- Single Twitch channel. Auth as moderator account (must be mod in that channel). Simple Twitch login via localhost OAuth.
- Rule = free-text instruction + per-rule textual `choices[]` (each with a criteria description) evaluated by **TypeSafe Jev 1.13 (Decisions API, not an LLM)**. `matchValues[]` subset triggers actions, gated by per-rule `minConfidence`.
- Judging: **1 Jev call per rule** (`POST /api/alpha/decisions`, model `typesafe/jev-1.13`), on every message. No budget/latency limits for now.
- Secrets stored locally in files. JSON local persistence.
- Stack: Node 20+ TypeScript, Express backend (serves API + static frontend), Vite + React frontend, tmi.js for chat ingest, Helix for deletes.

## Architecture
```
Twitch IRC (tmi.js) → message event
  → resolve user-defined context ({{message}}/{{username}}) → Jev `state`
  → for each enabled rule (one batched Decisions call, one question per rule):
      POST https://openrouter.ai/api/alpha/decisions → { choice | noul }
  → if choice ∈ rule.matchValues: lookup Bindings → execute actions in order
  → append to logs.jsonl + push to UI via SSE
```

- Batched judge (revised decision): all enabled rules go in ONE Decisions call (one question per rule); any batch-level failure falls back to sequential per-rule calls. Toggled by `settings.judging.batch` (default ON).
- `choices` model: per-rule (confirmed).
- Delete actor: same account that logged in (confirmed must be mod).
- **User-defined context:** the Jev `state` is no longer hardcoded to `{ message, user }`. The user defines it on the Context page — either a flat JSON object (key/value rows, built structurally, never parsed from text) or a plain string. Both embed bare tokens `{{message}}` and `{{username}}` that the backend substitutes per incoming message (`src/server/context.ts`). Unknown tokens block saving (client + server 400).

## Data model
```ts
Rule { id, name, type: "choice" | "noul", instruction: string, choices: Array<{ value: string, description: string }>, criteria?: { true?: string, false?: string }, matchValues: string[], minConfidence: number, enabled: boolean }
Action { id, name, type: "delete" | "timeout" | "ban", params?: { durationSec?, reason? }, enabled: boolean }
Binding { ruleId, choiceValue, actionIds: string[] }
Context { mode: "json" | "text", fields: Array<{ key: string, value: string }>, text: string }
Settings { channel, twitch: { clientId, clientSecret, broadcasterId, moderatorId }, openrouter: { apiKey, model: "typesafe/jev-1.13" }, dryRun: boolean, context: Context }
VerdictLog { ts, user, msgId, msgText, ruleId, choice, confidence, probabilities, latencyMs, costUsd, actionsTaken[] }
```

- Why separate `Binding`: supports 1 rule → n actions and reuse of actions across rules/choices.

## Twitch integration
- Read: `tmi.js` IRC join on configured channel. Needs OAuth token with `chat:read`.
- Delete (MVP): `DELETE /helix/moderation/chat?broadcaster_id&moderator_id&message_id` with `moderator:manage:chat_messages`. `messageId` comes from tmi.js tags.
- Future: `POST /helix/moderation/bans` for timeout/ban with `moderator:manage:banned_users` (params plumbed, not wired in MVP).
- Auth flow: register one Twitch App → Client ID/Secret → `GET /auth/login` → Twitch authorize → `GET /auth/callback` at `http://localhost:3000/auth/callback` → store tokens in `.secrets.json`.

## Judge engine — TypeSafe Jev 1.13 (NOT an LLM)
- MVP uses **`typesafe/jev-1.13`** via the **Decisions API**, not `/api/v1/chat/completions`. Chat-completions SDKs will NOT work.
- Endpoint: `POST https://openrouter.ai/api/alpha/decisions` with OpenRouter API key (no TypeSafe account needed). Model pinned to `typesafe/jev-1.13` (`~typesafe/jev-latest` alias only if user opts into auto-upgrade).
- Request shape (batched by default; `judging.batch=false` → 1 call per rule). `state` is the user-defined context resolved per message (object in JSON mode, string in text mode):
  ```json
  { "model": "typesafe/jev-1.13",
    "state": { "<user-defined keys>": "..." },
    "questions": { "<ruleId>": { "type": "choice", "instructions": "<rule.instruction>", "criteria": { "<choice>": "<description>", "...": "..." } } } }
  ```
- Jev is a System One decision model: returns typed answers + probabilities, no text/reasoning/explanations. Response: `{ answers: { "<ruleId>": { "type": "choice", "choice": "...", "confidence": 0..1, "probabilities": {...} } }, usage: { input_tokens, output_tokens, cost } }`.
- Billing: input tokens only, output tokens free. `usage.cost` (USD) logged per verdict. Context 32k tokens (state + questions).
- Rule `type: "choice" | "noul"` (frontend exposes a per-rule **multi-choice** checkbox; unchecked = `noul`, the default for new rules). `choice`: each choice needs a `criteria` description (Jev reads definitions from `criteria`, not from instruction text); `matchValues[]` + `minConfidence` gate actions. `noul`: optional `criteria: { true?, false? }` (omitted from the request when both are empty); answer `noul` is the probability of yes, and a rule matches iff `noul >= minConfidence` (default 0.6), emitting `choice: "true"` / `"false"` so binding resolution is unchanged. Legacy rules without a `type` normalize to `choice` on read.
- Match logic: `choice ∈ matchValues AND (confidence ?? 1) >= minConfidence` (default threshold e.g. 0.5–0.7, user-configurable per rule; low-confidence → log only / route to review, no action).
- Docs: Jev hub at https://openrouter.ai/docs/guides/community/jev, tutorial at https://openrouter.ai/docs/guides/community/jev-tutorial, model page at https://openrouter.ai/typesafe/jev-1.13.

## Localhost UI (5 pages, no auth for v1)
1. **Setup:** channel name, Twitch login button + connection status, OpenRouter key + model picker, dry-run toggle.
2. **Actions:** CRUD action list (`delete` live in MVP; `timeout`/`ban` stubbed with reason + duration fields).
3. **Rules:** CRUD rule cards (name, instruction textarea, choices list editor, match-values checkboxes, linked actions multi-select, enabled toggle) + test playground (paste message → run judgment → show verdict, no actions executed).
4. **Context:** define the Jev `state` — JSON-object mode (flat key/value rows) or String mode (raw text), both embedding `{{message}}`/`{{username}}`; token reference, live sample preview, and validation that blocks Save on unknown tokens / empty / duplicate keys.
5. **Live:** chat feed with verdict badges + moderation log (filter by rule/action), pause/resume bot button.

API sketch:
- `GET/POST /api/rules`, `GET/POST /api/actions`
- `GET/PUT /api/settings` (PUT validates + persists `context`)
- `POST /api/test` (judge without enforcing)
- `POST /api/context/preview` (validate + resolve context for sample/custom vars)
- `GET /api/logs`, `GET /api/events` (SSE)
- `GET /auth/login`, `GET /auth/callback`

## Persistence (JSON)
- `./data/config.json` — settings (non-secret)
- `./data/rules.json`, `./data/actions.json`, `./data/bindings.json`
- `./data/logs.jsonl` — append-only verdict/action log
- `./data/.secrets.json` — twitch tokens, client secret, openrouter key (gitignored)

## File layout
```
/src/server/{ index.ts, twitch.ts, judge.ts, context.ts, actions.ts, store.ts, routes.ts }
/src/web/{ App.tsx, pages/Setup|Actions|Rules|Context|Live.tsx }
/data/{ config.json, rules.json, actions.json, bindings.json, logs.jsonl, .secrets.json }
```

## Build milestones
1. Skeleton: Express + Vite serve, JSON store, Setup page, secrets file.
2. Twitch read-only: OAuth login, join channel, Live feed shows messages.
3. Judge: OpenRouter per-rule integration + Test playground + rule CRUD.
4. Enforce (MVP done): binding resolution + delete execution + dry-run + logs.
5. Hardening: reconnect, rate-limit queue, latency display, timeout/ban params plumbed.
