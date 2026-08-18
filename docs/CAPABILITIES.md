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
