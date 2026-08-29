# WaPay — Capability Matrix

*What the platform can actually do today. Sourced from the code (`lib/vas-config.js`, `pages/api/*`, `packages/*`) and the build tracker. Last verified 2026-08-18. Update this file when a capability changes state — it ships with the code and is the single honest answer to "what works?".*

Deployed baseline: 2026-08-18 evening (deposit UX + deposit-status + orchestration engine). Bot confirmed replying end-to-end by the founder on 2026-08-18.

---

## 1. Conversation

| Capability | State | Notes |
|---|---|---|
| Onboarding (new number → wallet) | **Live** | State machine S1→S4 in `packages/auth/src/onboarding.ts`: OTP verify → PIN set → consent template → SPEND wallet created. Re-onboarding verified on the new engine 2026-08-18. |
| AI chat (free text) | **Live** | Two-tier orchestration engine (`@wapay/ai` `orchestrate`): gpt-4o orchestrator (language + domain + fast path) → gpt-4o-mini category agents, strict structured outputs, temp 0. All 11 official languages + typo tolerance — 132-case golden corpus evals ≥99% (`scripts/eval-orchestrator.mjs`). Actions dispatch onto the deterministic flows with slots re-validated (`dispatchOrchestratorAction`); the AI proposes, never executes. Models env-tunable for the Claude migration. |
| Slot parsing | **Live** | `lib/slot-parser.js`. Invariant: an explicit product ("send R20 **airtime** to…") beats a bare send-to. Covered by `tests/gifting-routing.test.mjs`. |
| Gifting (airtime/data to another number) | **Live** | `lib/gifting.js`; `GIFTABLE_PRODUCTS = {AIRTIME, DATA}`. Gift resolves gift/self/blocked; bare cash-send ("send R30 to 084…") is refused and redirected to gifting (regulatory guard — WaPay never does money transfer). Recipient notification: approved template first, text fallback, fire-and-forget. Caveats: notification to *new* numbers needs the `wapay_voucher_received` template approved in the WABA; DATA gifts vend but do not notify yet. |
| Voucher redemption (load via Blu voucher) | **Live** | In `message-processor-v2.js`: PIN-hash-derived idemKey, NET amount credited, honest receipt. |
| PIN entry | **Live, in plain chat** | Moving PIN entry to a WhatsApp Flow (secure input) is on the backlog. |
| Contact-card sends + beneficiaries | **Live** | Sharing a WhatsApp contact starts a send-money ask (or fills the number a flow is waiting for). Every successful gift recipient / shared contact is remembered (`beneficiaries`, prod); "send R50 to Philly" resolves by name via the orchestrator's `recipientName` slot. Full number always shown at confirm. |
| Payment requests ("please pay me") | **Live** | "please pay me R150" → shareable short link (R5–R3000, 7-day expiry, PAID exactly once; pleasepayme.co.za). Creation is abuse-capped: max 10 live links + 20 creations/24h per requester (`WAPAY_PAYREQ_MAX_OPEN` / `WAPAY_PAYREQ_MAX_PER_DAY`, 0 disables; expired-PENDING links never count toward the open cap). Payer pays free from a WaPay balance (deep-link → confirm → PIN → `buildSend`, request code = idemKey) or by card via PayFast — payer pays the exact amount, the card fee comes off the requester's credit. Requester notified instantly on both legs. "Change my amount to R1000" swaps the newest pending request in one step. |
| Get paid — small requests FREE | **Live** | Requests under R50 carry **no fee** — a deliberate, bounded subsidy (PayFast's fixed R2.30 floor makes any margin-positive fee on R20 >15%). `WAPAY_PAYREQ_FREE_BELOW_CENTS` tunes it; the fee is tapered above the threshold so NET is strictly monotonic (asking more never pays less). |
| Get paid — compose-time quote | **Live** | The creation message states what you'll NET before the link goes out and offers the whole-rand ask that nets what you wanted ("make it R55"), routed through the amount-change swap. The requester picks the displayed price; **the payer always pays exactly what is displayed** — charging more for card is a prohibited surcharge in SA (PayFast T&Cs cl. 5.3, SARB/PASA/schemes). |
| Localised deterministic surfaces | **Live** | ALL deterministic prompts, confirmations, receipts, product lists and flow errors translate to the user's profile language (money/codes/links frozen, fail-open to English) — full sweep 2026-08-27; bearer voucher claim messages stay verbatim by design. "Speak Xhosa" sets and LOCKS the language, confirmed natively in all 11 official languages. Coverage locked by `tests/localize-coverage.test.mjs`. |
| Conversational QA harness | **Live (dev tool)** | `pnpm qa:chat` chats with the real brain end-to-end (live DB + OpenAI, sends captured, zero-cent QA account seeded/torn down): intent-switch fluidity, dedupe, AI memory incl. across flows, language switch + live localization. Writes `docs/testing/chat-qa-report-<date>.md` like a bug reporter. Found BUGLOG #30/#31 on its first run. |
| Universal intent-switch escape | **Live** | A clearly-stated new intent breaks out of ANY waiting state (family-aware — in-flow answers never escape; PIN digits are never intents), the switch is ACKNOWLEDGED out loud ("No problem, switching over…"), and "payment link" phrasings count as get-paid intents. Slot-collector states additionally escape any conversational sentence to the router instead of a validation error (BUGLOG #29). |
| WaPay-to-WaPay directed requests | **Live** | "please pay me R50 from &lt;name/number&gt;" reaches ONLY someone you have actually sent money to before, as an **informational** nudge they opt into by typing "pay request &lt;code&gt;". Never writes another user's state; label sanitised; membership-neutral. |
| Money out (payout rail) | **Built, not live** | `lib/ott-payout.js` — all 9 OTT Payout endpoints + webhook verification, crypto proven against OTT's published golden vectors, money-safe status→settlement map (never releases a hold on PENDING). Blocked on OTT test credentials + sandbox verification, and **counsel clearance on cash-out** before any customer sees it. |
| Card-payer auto-registration | **Live** | The card leg is a POST form capturing the payer's WhatsApp number (payment never blocked on it). Receipt destination is bound to the SIGNED PayFast session (`custom_str1`) — hijack-proof; the ITN pushes a purely-transactional receipt (free-form in-window, env-gated template fallback). `Receipt PRXXXXXX` (wa.me button, anchored pattern) is answered for any sender BEFORE onboarding; brand-new numbers fall straight into onboarding — every payer becomes a lead. `?r=1` return state blocks double-pay. |
| OTT voucher self-purchase | **Live** | "buy an OTT voucher" (any language) → confirm → wallet PIN → OTT issues → PIN delivered in-session via the atomic claim flow. Fee-free (founder decision). Insufficient balance → pay-the-difference PayFast link + auto-resume (`RESUME_VOUCHER_PURCHASE`). |
| User memory (profile) | **Live** | `Account.profile` (prod): preferred language by evidence (one foreign message can't flip the bot), preferred deposit method (skips the options menu for known card users), last electricity meter, product interests. Injected into the orchestrator each turn as KNOWN USER PROFILE; written deterministically at success points only. |
| Voucher history | **Live** | "show my vouchers" — bought vouchers with values, dates, active/used status; OTT and fuel (wiCode) vouchers listed under their own network sections. |
| Conversational spend knowledge | **Live** | Every AI turn carries the data-driven, claim-gated spend catalogue (`lib/spend-catalogue.js`): "where can I spend my money" gets a warm, specific answer (never the bare menu — BUGLOG #34a); cash-out asks get the honest coming-soon script (no dates, partner unnamed); fuel/retail presented as coming soon until `WAPAY_WICODE_LIVE`. |
| Fuel vouchers (wiCode via UniFuel/Yoyo) | **Built end-to-end on the Yoyo TEST env; customer-gated OFF** | "buy fuel" → amount → confirm → wallet PIN → UniFuel issues a Yoyo wiCode → code + redemption guide delivered in-chat; ledger `SPEND_FUEL` (wallet → CLEARING:YOYO, commission 0 bps until signed). Full-money E2E green (`pnpm qa:fuel` on a scratch schema + `qa:chat`-style chat E2E). Go-live = Yoyo production credentials in UniFuel + `WAPAY_WICODE_LIVE=true` (docs/UNIFUEL_INTEGRATION.md). Until then customers see coming-soon; test wiCodes do NOT redeem at pumps. |

| Admin console (Mission Control) | **Built, env-gated** | `/admin`: WhatsApp-OTP login (allowlist `WAPAY_ADMIN_MSISDNS` + `WAPAY_ADMIN_SESSION_SECRET`, fails closed), live dashboard from the journal (`/api/admin/metrics`), customer CRM lookup (`/api/admin/customer` — never exposes voucher PINs). KYC: **Didit integrated end-to-end** (hosted link over WhatsApp, signed webhook, decision-endpoint truth, masked-PII storage) — needs `DIDIT_API_KEY`/`DIDIT_WORKFLOW_ID`/`DIDIT_WEBHOOK_SECRET`. Funnel, acquisition-source split and retention cohorts live on real data. Activate console: the two admin envs; activate KYC: the three Didit envs. |
| Supplier floats (Mission Control) | **Live** | `/api/admin/floats` + dashboard card: both OTT balances pulled server-side (issuance verified live against the sandbox; payout awaits credentials), ledger CLEARING:* positions per rail (incl. YOYO), drift where both views exist, env-tunable low-float alarms (`WAPAY_FLOAT_WARN_CENTS*`). Blu: no balance API (spec asked of Phuti); PayFast: acquirer, history-only API (verified 2026-08-29). Credentials never leave the server; errors reduce to short codes. |
| UniFuel / wiCode panel (Mission Control) | **Live, env-gated** | `/api/admin/unifuel`: WaPay-originated issuance + redemption stats and the live product catalogue over the authenticated service link (`UNIFUEL_API_BASE_URL` + `UNIFUEL_PARTNER_SECRET`); `SPEND_FUEL`/`SPEND_RETAIL` in "what's being sold". |
| Email (Resend, WaPay identity) | **Built, env-gated** | `lib/email.js` — UniFuel's proven pattern on WaPay branding; first consumer is ops alerts (fuel reconcile-required). Needs WaPay's own `RESEND_API_KEY` + verified wapay.co.za domain + `ALERT_EMAIL`. |

## 2. Money core (the ledger)

All flows share one engine: `lib/ledger-core.js` (pure math) + `lib/ledger-post.js` (single DB writer). Guarantees:

- **Integer cents only.** No floats anywhere in money math.
- **Double-entry, always balanced.** `validateBalanced` on every entry; `trialBalance()` and `reconcileWallets()` (stored vs derived) for audit.
- **Atomic, idempotent posting.** `postEntry` is one transaction keyed by a unique `idemKey`; replays return the original entry instead of double-posting.
- **Two-phase spend.** `ensureWallet → reserveHold → provider call → settleHold` on success / `releaseHold` on failure. Insufficient funds throws a typed `INSUFFICIENT_FUNDS` — no money moves.
- **Per-message dedupe.** `claimMessage` (DB-unique on WhatsApp message id) makes replayed webhooks no-ops.
- **Two-tier balances.** SPEND vs cash balance types per wallet (spend-only product today).
- **Verified against the live DB**: `scripts/verify-ledger-db.mjs` — 21/21 (replay safety, concurrent-spend race, holds, dedupe, reconciliation). Test suite: 129/129.

The reference pattern is `pages/api/vas/airtime/execute.js`; data and electricity now follow it.

## 3. VAS categories

Gates live in `lib/vas-config.js` (`VAS_LIVE_*` env overrides; per-user `VAS_ALLOWLIST_*` for sensitive categories).

| Category | Provider | Default | State today | Caveats |
|---|---|---|---|---|
| AIRTIME | Blu | on | **Live, QA-proven** | Reference implementation. Giftable. |
| DATA | Blu | on | **Live, QA-proven** | On the hold pattern. Giftable (no recipient notification yet). |
| ELECTRICITY | Blu | on, allowlist-gated | **Live-gated; QA vend confirmed** | Entitlement fixed; real reference returned on Blu compliance test meter (R200 generic vend). Full phone-E2E unvalidated; vends can take ~90s; pilot waId must be added to `VAS_ALLOWLIST_ELECTRICITY` in Vercel. |
| LIFESTYLE (OTT vouchers etc.) | Blu | **off** | Not live | Needs Blu account enablement; endpoints untested. |
| BILLPAY (DStv) | Blu | **off** | Not live | Needs Blu account enablement; endpoints untested. |
| GAMING (betting) | Blu | **off** | Not live | Needs Blu account enablement; endpoints untested. |
| REMITTANCE | Blu | **off** | Not live | Needs Blu account enablement; also regulatory-sensitive — do not enable without sign-off. |

## 4. Providers

| Provider | Package | State |
|---|---|---|
| Blu Telecoms | `@wapay/providers-blu` | QA verified for airtime/data/electricity vending and voucher **redemption**. **Production API credentials issued** (2026-08-18); production move completes after Blu receives user-journey screenshots. Voucher **issuing** enabled in Blu QA but the issuing client is not built yet (mirror the OTT client). |
| OTT | `@wapay/providers-ott` | Issuing client built and sandbox-verified (live GetBalance). `getVoucher / checkVoucher / confirmVoucher / rejectVoucher` with enforced timeout recovery (`TIMEOUT_CHECK_REQUIRED` → check then confirm/reject) and an AUTH / USER_INPUT / RETRYABLE error taxonomy. Live issuing blocked on the signed Reseller agreement + test float. `GetAPIKey` is deliberately protected — calling it **rotates the live key**. |
| Yoyo | `@wapay/providers-yoyo` | Dormant. Code present, no active integration; the last reader of its wallet relation was removed from the balance endpoint. |

## 5. Security

- **Webhook HMAC** (`lib/webhook-security.js` + `pages/api/webhooks/whatsapp.js`): Meta's `X-Hub-Signature-256` verified over the exact raw body, constant-time compare, **before** any processing or ACK — unsigned POSTs get 401. Leaked fallback verify-token removed. Requires `META_APP_SECRET` + `WHATSAPP_VERIFY_TOKEN` in the deployment env.
- **Ordering guard**: verify → process (awaited) → ACK. Enforced by a static wiring test that also bans fire-and-forget async in the webhook (the "mute bot" regression, see BUGLOG #7).
- **Internal auth** (`lib/internal-auth.js`): VAS preview/execute routes require `x-internal-api-key` matching `WAPAY_INTERNAL_API_KEY`. Fail-open **by explicit design** until the env var is set (logged once per cold start), so the guard can deploy before the secret.
- **Config presence probe**: `GET /api/health?config=1` with the `x-internal-api-key` header reports presence booleans (OTT/PayFast/OpenAI/Meta secrets) + the public link-base URLs — never values. **Fails closed** until `WAPAY_INTERNAL_API_KEY` is set (unlike internal-auth: nothing depends on this block, so it gets the strict default).
- **PIN hashing**: user PINs are argon2id with a server pepper (`packages/auth/src/pin.ts`) — never stored or logged in clear. Voucher PINs are bearer secrets: never logged in full, masked like `maskMsisdn`; redemption idempotency uses a SHA-256 hash prefix of the PIN, not the PIN.
- **Outstanding**: some provider credentials that transited insecure channels are still scheduled for rotation before public launch (supplier coordination in progress).

## 6. Search

- **Semantic product search live at the data layer**: pgvector migration applied; **854/854 products embedded** (text-embedding-3-small, 0 failures). Verified with meaning-based queries ("cheap TikTok weekly" → Weekly TikTok 1GB R20).
- `hybridProductSearch` (`lib/vas-search.js`) is semantic-first with automatic **lexical fallback** to `rankProducts` (token/app-tag/period/value scoring) when embeddings or the API are unavailable.
- Caveats: the chat free-text path still uses lexical `searchProducts` — wiring `hybridProductSearch` into the message processor is next in queue. The daily cron (`pages/api/cron/daily-vas-sync.js`) exceeds Vercel's 60s function budget and needs restructuring; the embeddings backfill was run locally instead.

## 7. Money in / money out

- **PayFast card/EFT deposit — LIVE**: "deposit R100" → preamble + tappable **Pay now** CTA button (raw-link fallback) → signed PayFast checkout → 5-step-verified ITN → idempotent ledger credit at FACE → WhatsApp confirmation with new balance. Caps R10–R3000. First real deposit processed 2026-08-18 (R20, the ITN source-IP fix shipped after it).
- **Deposit status — deterministic**: "did my payment go through" is answered from the intent table + ledger (`handleDepositStatus`), never by the AI.
- **Voucher gift ("send money by number") — BUILT, blocked on OTT float + Reseller signature**: "Send R50 to 084…" issues a real voucher to the recipient:

`reserveHold(SPEND)` → `OttClient.getVoucher` (deterministic uniqueReference from the idemKey) → `confirmVoucher` → `settleHold(buildSpend, category VOUCHER, rail OTT)` → PIN delivered to the **recipient** via template; sender gets a receipt. Timeout → `checkVoucher` then confirm/reject; delivery-impossible → `rejectVoucher` + `releaseHold`.

Design decisions: **rail-agnostic** (backend may issue via Blu or OTT; recipient sees only "WaPay voucher" + PIN; ledger attributes rail via `CLEARING:BLU` / `CLEARING:OTT`); flat facilitation fee per the locked fee model; regulatory framing is a **goods voucher purchase**, never money transfer — same classification as airtime gifting. Sandbox build proceeds now; live test blocked on the OTT test float + signed Reseller agreement.
