# Admin AI Assistant — Working Doc

> **For Claude:** This is the single source of truth for this feature. Read this file
> first; do not ask the user to re-explain the project. When you finish a task, update
> the Status table and the Changelog **in this file** before ending your turn.
> Keep this file dense — it is read into context every session. Delete stale detail
> rather than appending to it.

**Last updated:** 2026-08-19
**Phase:** 2 built (streaming; **not yet browser-verified**) · running on **ollama (local)** · Phase 3 next

---

## 1. Goal

An admin chat assistant in `admin-dashboard`. The admin asks a question in plain
language ("how much revenue from Latvia last month?", "has order #4821 shipped?")
and gets an answer, instead of clicking through 15 pages.

**Approach: tool calling, not RAG.** Data is structured and live, so Claude calls
functions that run SQL against Postgres. No vector DB, no embeddings, no Python,
no agent framework.

```
browser → POST /api/admin/assistant/chat/stream (JWT + domainMiddleware)
        → Claude API with tool definitions
        → Claude picks tools → backend runs scoped SQL → rows back to Claude
        → Claude loops until done → text streamed to browser via SSE
```

---

## 2. Existing codebase facts

| | |
|---|---|
| Frontend | `c:\dev\admin-dashboard` — React 18, Vite, react-router 6. No TS. |
| Frontend API layer | `src/api/client.js` — bearer token from `localStorage.admin_token` |
| Backend | `c:\dev\backend\admin-service` — Express 4, `pg`, ESM (`"type": "module"`) |
| Backend entry | `index.js` — ~9,350 lines, ~100 routes, all `app.get/post(...)` inline |
| Auth | `requireAuth` middleware in `index.js` (~L2123), JWT, sets `req.adminUser` |
| **Admin domain scope** | `resolveAdminDomainFilter(req)` (~L243) — reads `?domain=` / `?domain_id=` **query params**. `null` = all domains. This is what admin endpoints use, **not** `req.domainId` from `domainMiddleware` (that one is for storefront services). |
| Frontend domain picker | `DomainContext.jsx` → `localStorage.admin_domain_filter` → sent as `?domain=` |
| DB helper | `dbQuery(sql, params)` (~L211) — **returns `[rows]`** (MySQL-style tuple), not `{rows}` |
| Schema dump | `c:\dev\schema.sql` — **UTF-16LE encoded**; convert before grepping (`Get-Content -Encoding Unicode`) |
| API reference | `documentation/API_DOCUMENTATION.md`, `documentation/FUNCTIONS.md` |

**Verified column facts** (do not guess these again):
- `orders`: `order_number`, `customer_email` (not `email`), `customer_name`, `total`,
  `currency` (char(3), default GBP), `status`, `payment_status`, `shipping_country`
  (free-text country **name**, not ISO code), `credits_applied`, `domain_id`, `created_at`
- `orders.status` — **actual data**: `pending`, `processing`. (The dashboard code
  checks for `in_progress`/`delivered`/`cancelled`, which do **not** appear in the
  data. Trust the data, not the code.)
- `orders.payment_status` — **actual data**: `pending` (36), `received` (2),
  `rejected` (4). ⚠️ **There is no `paid` value — success is `received`.** This
  caused a silent wrong answer ("0 orders paid") before it was fixed. Do not put
  these in a JSON-Schema `enum`: the vocabulary drifts from the app code and an
  enum silently blocks valid values. Describe them in the tool description instead;
  SQL already compares with `LOWER()`.
- `payments.status` — actual data: `pending` (38), `rejected` (4)
- `orders.currency` — only `GBP` present today
- `payments`: `order_id`, `amount`, `currency`, `status`, `provider`, `domain_id`
- `users`: `email`, `name`, `domain_id` — guests order without an account, so
  **email on `orders` is the customer key**, not `users.id`
- `order_items`: `order_id`, `product_id`, `name`, `sku`, `quantity`, `unit_price`, `line_total`
- `products` has **no** `domain_id` — the catalog is global across storefronts

**Revenue definitions** (must match the dashboard or the assistant contradicts the UI):
- Dashboard "Sales" cards = `SUM(orders.total)` over `created_at`, **no status filter**
- Money actually received = `SUM(payments.amount)` where `LOWER(payments.status)` ∈
  `DASHBOARD_RECEIVED_STATUSES` (index.js ~L334: paid, succeeded, success, completed,
  complete, captured, approved, verified, received)
- `DASHBOARD_FAILED_STATUSES` ~L337; `LOW_STOCK_THRESHOLD = 5`

**Key tables:** `orders`, `order_items`, `payments`, `users`, `products`,
`product_config`, `affiliates`, `affiliate_requests`, `promo_codes`,
`promo_redemptions`, `user_credits`, `credit_ledger`, `newsletter_subscribers`,
`order_address_change_requests`, `customer_blacklist`, `domains`, and the
`wholesale_*` family (orders, order_items, products, product_inventory,
raw_materials, raw_material_stock, team_members, work_allocations, recipes,
inquiries, countries).

---

## 3. Target stack

| Layer | Choice |
|---|---|
| **Model** | **Pluggable** — set `ASSISTANT_PROVIDER` in `.env`. Default `groq` (free). |
| SDKs | `@anthropic-ai/sdk` v0.115.0 + `openai` v7.4.0, both in `admin-service` |
| Agent loop | Anthropic: SDK `toolRunner`. OpenAI-compatible: hand-written loop in the adapter. |
| Transport | SSE (`text/event-stream`). **Not** `EventSource` — it can't send auth headers; use `fetch` + `ReadableStream` reader on the client. |
| History | Postgres table `assistant_conversations` (see §6) |
| Key | In `backend/admin-service/.env` — **server-side only**, never a `VITE_*` var |

### Providers

One adapter covers every OpenAI-compatible endpoint, so switching is env-only.

| `ASSISTANT_PROVIDER` | Cost | Default model | Get a key |
|---|---|---|---|
| `ollama` *(**in use** — `.env` sets `qwen3:14b`)* | free, **local** | preset `qwen2.5:14b` | none — `ollama serve` |
| `groq` | free tier | **`qwen/qwen3.6-27b`** ← verified | console.groq.com/keys |
| `cerebras` | ⚠️ **paid** — see below | `zai-glm-4.7` | cloud.cerebras.ai |
| `openrouter` | free variants | `meta-llama/llama-3.3-70b-instruct` | openrouter.ai/keys |
| `anthropic` | paid | `claude-opus-5` | console.anthropic.com |
| `openai` | paid | `gpt-4o-mini` | platform.openai.com |

**Cerebras is not free** (tested 2026-08-14). `GET /v1/models` succeeds and lists
`zai-glm-4.7`, `gpt-oss-120b`, `gemma-4-31b`, but `POST /v1/chat/completions`
returns `payment_required` until billing is enabled — so a model list that looks
healthy is *not* evidence the provider works. Verify with a real completion call.
The preset's `llama-3.3-70b` / any `qwen-*` id does not exist on that account.

Override with `ASSISTANT_MODEL` / `ASSISTANT_BASE_URL`. Any other OpenAI-compatible
host works by setting `ASSISTANT_BASE_URL` alone. **Model IDs get retired** — a 404
or "model not found" means update `ASSISTANT_MODEL`, not that the code broke.

> ✅ **PII / GDPR — resolved by running `ollama`.** Tool results contain customer
> emails, names, addresses and order values. On any hosted provider those leave the
> network, and free tiers commonly reserve the right to train on submitted data.
> On `ollama` nothing leaves the machine. **This is a one-line `.env` setting** —
> flipping `ASSISTANT_PROVIDER` back to a hosted provider silently reintroduces the
> problem with no error or warning. Keep the comment in `.env` explaining why.
>
> Second caveat: free models pick the wrong tool and fumble arguments more often
> than frontier models. The whole value here is numbers the admin can trust, so
> spot-check answers against the dashboard before relying on them.

### Model bake-off on Groq (2026-08-08, 3 real questions against live data)

| Model | Score | Avg | Verdict |
|---|---|---|---|
| **`qwen/qwen3.6-27b`** | **3/3** | **12.8s** | **Use this.** Only model 3/3 in both runs. |
| `openai/gpt-oss-120b` | 2/3 | 10.9s | Sometimes fails tool-arg schema validation |
| `openai/gpt-oss-20b` | 1–3/3 | 39s | Inconsistent between runs |
| `llama-3.1-8b-instant` | 0–2/3 | 40s | Small context — 413s on broad questions |
| `llama-3.3-70b-versatile` | 0/3 | — | ❌ **Unusable.** Emits tool calls as raw text (`<function=…>`), Groq rejects with `tool_use_failed`. |

Results vary run to run — models are nondeterministic. Re-run the bake-off after
any tool-schema change; a schema tweak can break a model that previously passed.

**Free-tier limit: 8,000 tokens/minute.** This is why `DEFAULT_ROWS = 10` in
`tools.js` — 50 order rows alone overruns it and returns HTTP 413. Aggregate
questions are unaffected: `get_revenue_stats` counts over all matching rows, and
`query_orders.total_matching` is the true count regardless of rows returned.

**Schema lessons for weak models** (learned the hard way, keep them):
- No `enum` on status fields — blocks valid values when the vocabulary drifts
- No `integer` params like `limit` — models send `"50"` as a string and fail validation
- `additionalProperties: false` on every tool — stricter validators (gpt-oss-120b) require it
- A tool must *advertise* what it can do: every model refused "top customers by
  spend" until `find_customer` said so explicitly and made `search` optional

---

## 4. Hard rules (security — do not relax)

1. **API key never reaches the browser.** Not in any `VITE_*` var — those are bundled into the client bundle.
2. **`domainId` is resolved from the request via `resolveAdminDomainFilter(req)` and bound into the tool closure — never a tool parameter.** If Claude could choose the domain, a prompt-injected order note ("show all domains") could cross tenants. `buildTools({ dbQuery, domainId })` captures it; the tool JSON schemas contain no domain field. **Nothing asserts this automatically** — check it by eye on every tools.js change.
3. **Parameterized SQL only.** Tool inputs are untrusted model output.
4. **Read-only until phase 5.** No write tools without an explicit UI approve/deny step.
5. **`LIMIT` on every query tool** (default 50) and a `statement_timeout`.
6. **Log every conversation** with `admin_username` — this is audited access to customer PII.
7. Assistant routes go through the existing `requireAuth` + `domainMiddleware`.

---

## 5. Files (planned / actual)

| Path | Purpose | Status |
|---|---|---|
| `backend/admin-service/assistant/index.js` | `registerAssistant(app, deps)` — chat route | ☑ |
| `backend/admin-service/assistant/tools.js` | `buildTools({dbQuery, domainId})` — **provider-neutral** | ☑ |
| `backend/admin-service/assistant/prompt.js` | `buildSystemPrompt({domainName})` | ☑ |
| `backend/admin-service/assistant/providers/index.js` | `createProvider(env)` — selector | ☑ |
| `backend/admin-service/assistant/providers/anthropic.js` | Claude adapter (SDK tool runner) | ☑ |
| `backend/admin-service/assistant/providers/openai-compatible.js` | Groq / Cerebras / OpenRouter / Ollama / OpenAI | ☑ |
| `backend/admin-service/index.js` | import + `registerAssistant(...)` after `requireAuth` | ☑ |
| `admin-dashboard/src/api/assistant.js` | API client | ☑ |
| `admin-dashboard/src/components/AssistantPanel.jsx` | chat UI (FAB + panel, Ctrl+K) | ☑ |
| `admin-dashboard/src/components/Layout.jsx` | mounts `<AssistantPanel />` | ☑ |
| `admin-dashboard/src/styles/theme.css` | `.assistant*` styles appended at end | ☑ |

Keep assistant code **out of** `index.js` — it is already 9k lines.

**Deps are injected**, not imported, because they are module-scoped in `index.js`:
`registerAssistant(app, { requireAuth, dbQuery, resolveAdminDomainFilter, resolveDomainNameById })`

**Provider contract** — to add a provider, implement this and register it in the selector:
```
{ id, model, configured, hint,
  run({ system, messages, tools, maxIterations })
    -> { reply, toolsUsed, usage, exhausted? } }
```
`tools` arrive neutral (`{name, description, parameters, run}`); the adapter converts
to its wire format. Tools are written once and work on every provider.

**Routes:** `POST /api/admin/assistant/chat/stream` (SSE) · `GET /api/admin/assistant/health`

**SSE events** — the adapter emits them via `onEvent`, the route forwards each as
an event of the same name, `chatStream()` hands them to the panel:

| Event | Payload | UI |
|---|---|---|
| `text` | `delta` | appended to the answer |
| `reasoning` | `delta` | **ignored on purpose** — see §7 |
| `tool_start` / `tool_end` | `name` | status label ("Checking revenue…") |
| `done` | `reply`, `toolsUsed`, `usage` | replaces accumulated text |
| `error` | `error` | error line |

Adding an event type needs no route change — the bridge forwards whatever the
adapter emits.

---

## 6. Phases

### Phase 1 — prove the loop  ☑ (code done; live API call untested — needs a key)
- ☑ `@anthropic-ai/sdk` v0.115.0 installed in `admin-service`
- ☑ 3 tools: `query_orders`, `get_revenue_stats`, `find_customer`
- ☑ Non-streaming JSON response
- ☑ Chat panel (FAB bottom-right, Ctrl+K), no persistence
- ☑ **Done.** Verified against live data on Groq + `qwen/qwen3.6-27b`:
  totals (42 / £6,177), top customers, orders on a given date (5), paid (2),
  rejected (4), recent-order listing — all match the DB exactly.

### Phase 2 — streaming  ☑ (built; browser verification outstanding)
- ☑ Route is SSE; client reads `ReadableStream` via `fetch` (not `EventSource`)
- ☑ UI shows tool-call activity ("Checking revenue…") and a Stop button
- ☑ Non-streaming route deleted — SSE is the only chat path

### Phase 3 — coverage + persistence  ☐
- Grow to ~15 tools: products/inventory, affiliates, wholesale, newsletter,
  payments, address-change requests
- Table `assistant_conversations (id, domain_id, admin_username, messages jsonb, created_at, updated_at)`
- Load/resume conversations

### Phase 4 — cost + polish  ☐
- Prompt caching on system prompt + tool defs (`cache_control: {type:'ephemeral'}`)
- Log `usage` per turn (input/output/cache tokens) for cost tracking
- Suggested-question chips

### Phase 5 — gated writes (optional)  ☐
- Tools like `resend_order_email`, `approve_address_change`
- Tool returns `"awaiting confirmation"`; UI shows approve/deny; only then execute

---

## 7. Design notes & gotchas

- **~15 broad tools, not 100 thin ones.** Do not wrap each REST endpoint 1:1 — tool
  selection degrades and every schema costs tokens on every request. Prefer fewer
  tools with rich filter params. If it ever exceeds ~40, use the tool-search tool.
- **Tool `description` is the biggest quality lever.** Be prescriptive about *when*
  to call it, not just what it does.
- **Put schema semantics in the system prompt**, not in code comments: which column
  is money, what `status` values mean, that wholesale is a separate order flow,
  that `orders.total` is in `orders.currency` so cross-currency sums need care.
- **Reasoning events are received and ignored on purpose.** `qwen3` streams ~200
  thinking tokens per answer as `delta.reasoning` (ollama's field name;
  OpenAI-style hosts use `reasoning_content`). It is forwarded to the UI as a
  `reasoning` event but only ever shown as a generic "Thinking…" — a small
  model's self-correcting monologue restates customer data and reads as *less*
  trustworthy. It must never be appended to `content` or pushed into `convo`.
- **Answers with no rows:** instruct the model to say "none found", never to guess.
- **History is resent every turn** — token cost grows with conversation length.
  This is why phase 4 caching matters.
- Streaming avoids HTTP timeouts on long tool chains; set `max_tokens: 64000`.

---

## 8. Status

| # | Task | Status | Notes |
|---|---|---|---|
| 0 | Pluggable provider layer | ☑ | `assistant/providers/`. Switch via `ASSISTANT_PROVIDER`. ⚠️ **The "15 checks / fake OpenAI server" smoke test no longer exists in the repo** — there is no automated test for this feature. Verification is manual, against live data. |
| 1 | Install SDKs, provider config in `.env` | ☑ | `@anthropic-ai/sdk` 0.115.0 + `openai` 7.4.0. **`ASSISTANT_API_KEY` left EMPTY — user must paste one.** No `.env.example` exists in this service. |
| 2 | `assistant/prompt.js` | ☑ | ~2.8k chars. Encodes status vocabulary + the two revenue definitions. |
| 3 | `assistant/tools.js` — 3 tools | ☑ | All 5 SQL statements verified against the live Supabase DB. |
| 4 | `assistant/index.js` — chat route | ☑ | Validates history (≤40 msgs, ≤8k chars each), `max_iterations: 12`, logs usage. |
| 5 | Wire into `index.js` | ☑ | Import L14; `registerAssistant(...)` after `requireAuth`. Server boots clean. |
| 6 | `AssistantPanel.jsx` + `api/assistant.js` + CSS | ☑ | `npm run build` passes. |
| 6b | Fix bugs found by live testing | ☑ | `find_customer` now ranks top spenders (`search` optional); wrong `payment_status` vocabulary corrected; enums + `integer` params removed; `DEFAULT_ROWS` 50→10 for TPM (**since raised to 25**); error handler surfaces upstream detail instead of an opaque 500. |
| 6c | Fix `paid_orders` always 0 | ☑ | 2026-08-14. The 6b vocabulary fix missed two **hardcoded** aggregates that still filtered `payment_status = 'paid'`. Now `= ANY(RECEIVED_STATUSES)`, matching the payments query. Verified live: 2 paid orders, correctly attributed. |
| 7 | Convert to SSE streaming | ☑ | `onEvent` in both adapters, `POST /chat/stream`, `chatStream()`, panel streams + Stop. Old JSON route deleted. Dead air on "how many orders in total?" 4.3s → 0.58s. ⚠️ **Verified at the adapter layer only** (node harness against live ollama) — the browser path has not been exercised. |
| 8 | Expand to ~15 tools | ☐ | Products/inventory, affiliates, wholesale, newsletter, payments, address changes. |
| 9 | `assistant_conversations` table + persistence | ☐ | |
| 10 | Prompt caching + usage logging to DB | ☐ | Prompt+tools ≈ 3–4k tokens, above the 512-token cache minimum, so worth doing. |

Legend: ☐ todo · ◐ in progress · ☑ done

**`qwen3:14b` on ollama — verified 2026-08-14** on: total orders (42), top-3
customers (exact), and the "orders today" hallucination trap (correctly "0"). It
needed the prompt hardening in the changelog below to stop it echoing raw tool JSON;
with that in place a 14B local model is good enough. Still unchecked: paid count (2),
the no-tool refusal (wholesale), country filter, and the two revenue definitions.

Known cosmetic artifact: it sometimes writes "the list above shows…" when no list was
shown to the admin. Add a prompt line about tool output being invisible if it persists.

**Ground truth for spot-checks** (as of 2026-08-08): 42 orders · £6,177 total ·
5 orders on 7 Aug · payment_status: 36 pending / 2 received / 4 rejected ·
top customer soumyasoumya901@gmail.com £3,375 across 22 orders.

Switching providers is env-only — no code change. `GET /api/admin/assistant/health`
reports the active provider, model, and a hint when it is misconfigured.

---

## 9. Changelog

Append one line per completed task. Newest last. Keep it to one line each.

- 2026-08-07 — Doc created. Architecture decided: tool calling over Postgres, no RAG.
- 2026-08-07 — Corrected two wrong assumptions in this doc: `dbQuery` returns `[rows]` not `{rows}`, and admin scoping is `resolveAdminDomainFilter(req)` from `?domain=` query params, not `req.domainId`.
- 2026-08-07 — Phase 1 built: SDK installed, 3 read-only tools, chat route, chat panel, styles. Frontend builds; backend boots; all tool SQL verified against the live DB. Live Claude call still untested (no API key).
- 2026-08-08 — **Phase 1 verified end-to-end on Groq.** Live testing found four real bugs: (1) `find_customer` could not rank top spenders and every model correctly refused the question — `search` is now optional; (2) `payment_status` vocabulary was documented wrong (`paid` does not exist; success is `received`), which silently answered "0 orders paid"; (3) `enum` + `integer` params broke schema validation on several models; (4) 50-row default blew Groq's 8k TPM limit. Model bake-off picked `qwen/qwen3.6-27b` (3/3); `llama-3.3-70b-versatile` is unusable (emits tool calls as raw text). Error handler now surfaces upstream detail instead of an opaque 500.
- 2026-08-14 — Tried to move off Groq (8k TPM limit throttling real use). **Cerebras rejected: `payment_required` on chat/completions** despite `/v1/models` returning a healthy list — the free tier needs billing enabled. Reverted to Groq + `qwen/qwen3.6-27b`. Remaining free-and-unlimited option is `ollama` (local), which also solves the PII/GDPR question in §3.
- 2026-08-14 — Switched to `ollama` + `qwen3:14b`. Closes the PII/GDPR question in §3 — customer data no longer leaves the machine. Local model's tool-calling accuracy is **not yet spot-checked**.
- 2026-08-14 — **Fixed `paid_orders` silently returning 0** in `get_revenue_stats` and `find_customer`. The 2026-08-08 vocabulary fix corrected the model-supplied filter path but missed two hardcoded `payment_status = 'paid'` aggregates — and `'paid'` does not exist in this database. Verified against live data (2 received). Lesson: when a value vocabulary is wrong, grep for **every** occurrence, not just the one that surfaced the bug.
- 2026-08-14 — First live test on ollama/`qwen3:14b`. Hallucination trap passed ("0 orders today"), but "how many orders in total" made it call `query_orders` and **echo the raw tool JSON as its reply** instead of reading `total_matching`. That oversized assistant message then failed the 8k-char history check on the *next* turn, bricking the conversation permanently. Fixes: assistant messages over the limit are now truncated rather than rejected (only admin input hard-errors); `DEFAULT_ROWS` 25→10, back in step with the tool description; system prompt now explicitly forbids emitting raw JSON/tool output and spells out the count-vs-list rule. Lesson: a validation limit meant for user input must not apply identically to model output — the model can lock the user out.
- 2026-08-14 — Tightened answer style in `prompt.js`. `qwen3:14b` was padding every correct answer with closing offers ("Let me know if you'd like…"), restated scope ("across all stores, all-time"), and **references to tool internals the admin cannot see** ("the list above shows the first 10", "the `total_matching` field confirms"). Prompt now bans all three explicitly and states one sentence is the whole answer unless a caveat changes the number's meaning. Prompt is now ~5.0k chars (~1.26k tokens) — if answer *quality* drops rather than just length, suspect prompt bloat on a small model and trim back.
- 2026-08-17 — Phase 2 step 1: provider adapters now stream. `run()` takes an optional `onEvent` (defaults to no-op, so the existing JSON route is untouched); the OpenAI-compatible adapter uses `stream: true` + `stream_options.include_usage` and reassembles the assistant turn from deltas — tool-call fragments are keyed by `tc.index` and **concatenated**, since name and arguments both arrive split. Anthropic gets `tool_start` only (token deltas need the runner's streaming mode; unimplemented while ollama is the deployed provider). Verified live on ollama/`qwen3:14b` with a fake tool: tool args reassembled correctly, 12 text deltas, usage summed across both iterations.
- 2026-08-18 — Phase 2 steps 2–3: `POST /api/admin/assistant/chat/stream` (SSE) added **alongside** the JSON route, which stays as a fallback until the UI is converted; `chatStream()` in `admin-dashboard/src/api/assistant.js` reads it with a `fetch` + `ReadableStream` reader (not `EventSource` — no auth headers). Error mapping extracted to `describeFailure()` so both routes word failures identically; validation must run **before** `writeHead`, since after that only an `error` event is possible. 15s `: ping` heartbeat guards against idle-timeout proxies during silent tool iterations.
- 2026-08-18 — Phase 2 step 1c + **reasoning passthrough**. Measured the real problem: streaming alone barely helped, because ~90% of the wait is *before* the first visible token (tool round trip + the model thinking), and a typical count answer is only ~9 tokens. Probing ollama showed qwen3 streams its thinking as **`delta.reasoning`** (not `reasoning_content`) — 198 tokens per answer that we were discarding. Now forwarded as a `reasoning` event, plus `tool_start`/`tool_end`. **Reasoning is never appended to `content` and never enters `convo`** — it is UI progress only, not the answer and not history. Dead air on "how many orders in total?" fell 4.3s → 0.58s with the reply unchanged.
- 2026-08-19 — Phase 2 step 4: `AssistantPanel` streams. Tokens append to a placeholder assistant message via a **functional** `setMessages` (a direct read of `messages` inside `onEvent` sees a stale snapshot and drops most tokens). Progress is a **generic** label beside the dots — `reasoning` events are received and ignored on purpose: 200 tokens of a 14B model's self-correcting monologue restates customer data and reads as less trustworthy, not more. `tool_start` maps to friendly text via `TOOL_LABELS` (keep in step with `tools.js`; unmapped names fall back). Added a Stop button (`AbortController`), and auto-scroll now uses `auto` while streaming and skips entirely if the admin has scrolled up.
- 2026-08-19 — Phase 2 step 5: deleted the non-streaming `POST /chat` route and `assistantApi.chat`; SSE is now the only chat path. `describeFailure()` returns just the event payload (the `httpStatus` half died with the JSON route). Phase 2 is code-complete — but **verified only through a node harness against the adapter**; nobody has run the browser path end to end.
- 2026-08-19 — First browser test of streaming found two bugs. (1) **Pressing Stop before the first token bricked the conversation.** The empty placeholder assistant message stayed in state, was sent as history on the next question, and the server rejected it — so every later question failed with "each message needs non-empty string content" while the UI just showed unanswered questions. The panel now drops a trailing empty assistant turn and filters empty turns out of history. Same lesson as 2026-08-14: a validation rule aimed at user input must not be able to lock the user out. (2) **The assistant refused to list records** ("individual records cannot be listed here") — the 2026-08-14 anti-raw-JSON rule said "if you find yourself about to paste a list of records, stop and report the count instead", which the model read as a ban on listing at all. Reworded to constrain *format* (no JSON, rewrite as your own lines) while explicitly requiring it to list when asked. Verified on ollama: listing works, and the count answer is unchanged.
- 2026-08-07 — Claude API is paid, so added a pluggable provider layer. `tools.js` is now provider-neutral; adapters live in `assistant/providers/`. One OpenAI-compatible adapter covers Groq/Cerebras/OpenRouter/Ollama/OpenAI; Anthropic keeps its own. Default switched to `groq` (free). Weaker models are handled defensively — unknown tool names and malformed JSON args are fed back as tool errors so the model self-corrects instead of 500ing.
