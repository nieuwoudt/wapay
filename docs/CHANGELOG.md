# WaPay — Changelog

*One dated section per meaningful commit, newest first. This local working copy has no `.git`, so history is reconstructed from `WAPAY_BUILD_TRACKER.md` and the known deploy commits; dates marked ~ are approximate (the commit hash is exact, the day is the tracker's). Keep this file updated per commit going forward — that is the version-control discipline the repo is held to.*

---

## 2026-08-18 — Deterministic deposit-status intent

"Did my payment go through?" / "where is my money" / "payment status" now short-circuit **before the AI path** to `handleDepositStatus`, which reads the account's newest PayFast intent (`getLatestDepositIntent`, newest-first by `requestTs`) and answers factually: SUCCESS → amount + live balance; PENDING → "PayFast is still confirming your R… — I'll message you here the moment it clears" (the ITN confirmation is that message); FAILED → plain statement + retry hint. Every reply carries the live balance, closing the founder's stale-balance complaint. The matcher (`matchDepositStatusRequest` in `lib/deposits.js`, pure) is deliberately narrower than the deposit-link pattern — "I want to deposit money" still routes to the deposit prompt. Tests: `tests/deposit-status.test.mjs` (+8, suite 209/209).

## 2026-08-18 — PayFast deposit UX: preamble + tappable button

The card-deposit reply is no longer a raw URL. `handleCardDepositLink` now sends a WhatsApp interactive **CTA-URL** message: a preamble that explains the round trip ("I'll take you to PayFast … pay by card or Instant EFT … you'll be brought straight back to this chat"), a *Secured by PayFast* footer, and a `Pay R<amount> now` button that opens the checkout. New `sendWhatsAppCtaUrl` / `buildCtaUrlPayload` in `@wapay/whatsapp` (pure payload builder, Meta limits enforced — 20-char button cap verified against the worst-case deposit amount). If the interactive send is rejected the handler logs `deposit_cta_fallback` and falls back to the old plain-text link — presentation can never block a payment. Tests: `tests/deposit-cta.test.mjs` (+8, suite 201/201).

## 2026-08-18 — `0253633` — PayFast modern ITN source range; wa.me return

The first real R20 deposit's ITN was rejected `SOURCE_IP_REJECTED`: PayFast's modern network (observed 102.216.36.1) postdates the documented 2019-era CIDR list. The range was added and the source-IP check demoted to warn-only unless `PAYFAST_ENFORCE_SOURCE_IP=true` (signature + server POST-back remain the strong checks). The R20 was credited manually with the intent's idemKey (replay-safe). Return/cancel URLs now deep-link to `wa.me/27760497624` so "Back to WaPay" reopens the chat instead of stranding the payer on the API landing page.

## 2026-08-18 — `8b19401` — Deposit option 2 collects an amount; single-screen bank home

Choosing card/EFT from the deposit menu now asks for the amount (new `DEPOSIT_CARD_AMOUNT` conversation state, accepts "20" / "R20" / "deposit R20", cancellable) instead of dead-ending. "hello"/"home" renders the single-screen bank-style home the founder approved.

## 2026-08-18 — `75370ba` — AI knows the real deposit options; typo-tolerant deposit routing

The AI prompt was answering deposit questions from stale knowledge (inventing options). Prompt now reflects the two real options (Blu voucher, card/EFT). Deposit intent matching made typo-tolerant; "home" escapes the voucher-PIN state.

## 2026-08-18 — `667b3a7` — PayFast money on-ramp

"deposit R100" in chat mints a signed PayFast checkout link (card/Instant EFT). `@wapay/providers-payfast` builds the checkout URL and verifies ITNs 5-step (signature over raw fields **including empty ones** and the merchant passphrase — review caught the passphrase omission that would have silently failed every live payment — plus source IP, amount, status, server confirmation). `lib/deposits.js` stores deposit intents whose row id is `m_payment_id` and whose derived idemKey makes ITN redeliveries credit exactly once. Verified ITN → ledger credit at FACE → WhatsApp confirmation with new balance. Caps R10–R3000. Root `pnpm test` fixed for Node 24 glob form. 193/193 tests.

## 2026-08-18 — `9c27da7` — Voucher gift: send money as an OTT-issued voucher

"Send R50 to 084…" became a real feature: preview (R3 flat fee) → YES → PIN → `reserveHold` → OTT `GetVoucher` (deterministic reference from the idemKey) → `ConfirmVoucher` → `settleHold` (category VOUCHER, rail OTT) → row in `pending_gifts`. The recipient gets the `wapay_voucher_received` template (no PIN in it); the voucher PIN is delivered when they reply — the claim **is** the onboarding loop. Timeout recovery per the OTT spec (`CheckVoucher` then confirm/reject); `RejectVoucher` + `releaseHold` when delivery is impossible. Voucher PINs never logged (static-test enforced). `pending_gifts` migration applied to prod. Docs (`CAPABILITIES.md`, `CHANGELOG.md`, `BUGLOG.md`) brought in-repo. 168/168 tests. Live E2E blocked on OTT float + Reseller agreement.

## 2026-08-18 — `6096585` — Mute-bot fix: await processing before ACK

The deployed webhook ACKed 200 to Meta and then processed the message in a fire-and-forget async block. Vercel serverless kills work after the response, so processing never ran and the bot went silent after the `44b51c9` deploy. This commit restores the correct ordering — verify signature → process the message (awaited) → ACK — and hardens it: the static wiring test now enforces the ordering and bans void-async in the webhook. Also gives the user-manager prisma import a `.js` extension so local simulation matches production module resolution. Bot confirmed working by the founder the same evening.

## ~2026-08-17 — `44b51c9` — Semantic search layer + OTT issuing client

Two additions (deployed to Vercel 2026-08-18):

- **Semantic search**: pgvector migration, `lib/vas-embeddings.js`, and `hybridProductSearch` in `lib/vas-search.js` — semantic-first product search with lexical fallback. 854/854 products were subsequently embedded (text-embedding-3-small) and live-verified. Not yet wired into the chat free-text path.
- **OTT client** (`@wapay/providers-ott`): voucher issuing client with `getVoucher / checkVoucher / confirmVoucher / rejectVoucher`, deterministic references, enforced timeout recovery (`TIMEOUT_CHECK_REQUIRED`), AUTH/USER_INPUT/RETRYABLE error taxonomy, and `GetAPIKey` protected (it rotates the live key). Sandbox GetBalance verified live.

## ~2026-08-16 — `83a68fe` — Voucher template rename

Recipient-notification template aligned to `wapay_voucher_received` (created in Meta, category Utility, pending approval). This is the template that lets gift/voucher notifications reach numbers that have never messaged the bot.

## ~2026-08-16 — `f9b52eb` — Catalog endpoint fix

The VAS catalog sync was calling a dead Blu endpoint and silently importing only 20 products. Fixed the endpoint; catalog went from 20 to 831 products. Account reset tooling added alongside.

## 2026-08-15 — `2360f18` — Money-safe ledger, webhook security, gifting

The foundation commit:

- **Ledger**: `lib/ledger-core.js` (chart of accounts, fee model, balanced-entry builders) + `lib/ledger-post.js` (atomic idempotent `postEntry`, `reserveHold/settleHold/releaseHold`, `claimMessage` dedupe, reconciliation) + Prisma migration `20260810_ledger_core` (two-tier wallets, unique idemKey, holds, processed_messages, CHECK constraints). Later verified 21/21 against the live DB.
- **Webhook security**: HMAC signature verification over the raw body wired into `pages/api/webhooks/whatsapp.js` (401 before ACK), leaked fallback verify-token removed, per-message dedupe.
- **Money-safe refactor**: airtime (reference pattern), then data and electricity execute routes moved onto ensureWallet → reserveHold → provider → settleHold/releaseHold; balance endpoint fixed (SPEND wallet, 503 on DB failure); preview routes gated behind internal auth.
- **Gifting** (`lib/gifting.js`): the V1 wedge — send airtime/data to another number as a SPEND (goods), never a transfer; bare cash-send refused and redirected; recipient notification template-aware.

## Before 2026-08-15 — pre-history (January baseline)

The original V1.01 build: WhatsApp onboarding (OTP, PIN, consent templates), Blu voucher redemption for wallet load, Blu VAS vending (airtime/data/electricity), single gpt-4o chat, Vercel deployment. Stable but money-unsafe (non-atomic flows, unsigned webhook) — the problems the 2026-08-15 commit exists to fix. See `docs/BUGLOG.md` for the specific defects found and closed.
