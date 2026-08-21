# WaPay — Changelog

*One dated section per meaningful commit, newest first. This local working copy has no `.git`, so history is reconstructed from `WAPAY_BUILD_TRACKER.md` and the known deploy commits; dates marked ~ are approximate (the commit hash is exact, the day is the tracker's). Keep this file updated per commit going forward — that is the version-control discipline the repo is held to.*

---

## 2026-08-21 — 🙏 Payment requests ("please pay me") — shareable links, two payment legs

"Please pay me R150" / "payme link" (any language — REQUEST_MONEY orchestrator action, live-verified incl. isiZulu) creates a shareable request (`payment_requests`, prod-applied: PR-prefixed letters-only codes, R5–R3000, 7-day lazy expiry, PENDING→PAID exactly once). The user gets a forwardable message + `wapay.co.za/pay/<code>`. The public page (`pages/pay/[code].js`) offers both legs:

- **Pay from a WaPay balance — free**: deep-links back into WhatsApp ("Pay request <code>") → confirm → wallet PIN → `buildSend` (free spend→spend) posted with the request code as idemKey, so exactly ONE payer can ever pay it (a racing payer replays harmlessly and is told). Both sides get instant receipts; the requester is notified with their new balance.
- **Pay by card/EFT — no WaPay account needed**: `/api/pay/checkout` mints a PayFast intent (route `payrequest`, payer covers the banded payment fee, requester credited FACE) and the ITN marks the request PAID atomically. Every non-WaPay payer sees the get-your-own-WaPay hook.

Insufficient balance on the in-chat leg becomes the standard top-up checkout moment. `tests/payment-requests.test.mjs` (+11, suite 269/269). Also: OTT negotiation email drafted (`EMAIL_TO_OTT_NEGOTIATION.txt` — Payout asymmetries, Merchant 6% fee, ops annexure, Collect parked).

## 2026-08-20 (2) — User memory, GPT-5.5 brain, fee-free self vouchers, voucher history

- **Root cause of every live voucher failure found: `OTT_BASE_URL` (and the OTT credentials) were never set in Vercel** — the OTT client crashes at construction in production. USER ACTION: copy the four `OTT_*` vars from local `.env` into Vercel and redeploy. (The crash-release guard worked: the stranded hold auto-released with `execute_crashed:Missing env OTT_BASE_URL` — that log line was the diagnosis.)
- **User memory system** (`Account.profile` JSONB, prod-applied; `lib/user-profile.js`): language (evidence-counted — one foreign test line can't flip it), preferred deposit method (written by ITN success=CARD, redemption success=VOUCHER), last electricity meter, product interests. Injected into the orchestrator every turn as `KNOWN USER PROFILE`; deposit-with-amount offers BOTH load methods until the preference is known (then straight to their rail).
- **Language bug fixed** (bot answered "Okay" in isiZulu after one zu test line): reply language = the CURRENT message's language, history is context only, neutral messages fall back to the profile language. Live-verified.
- **Model upgrade: gpt-5.5 orchestrator + gpt-5.4-mini agents** (probed live; GPT-5-family params adapted — `max_completion_tokens`, `reasoning_effort: none`, no temperature). **Golden eval: 132/132 = 100%** across all 11 languages (up from 99.2% on gpt-4o), ~1s per call. Env-tunable as before.
- **Self OTT vouchers are fee-free** (fees belong on money-IN and on sending to others; WaPay still earns the OTT issuing commission). Copy: "⏳ Generating your OTT voucher..." for self ("sending" is reserved for sending to people).
- **Broke checkout**: insufficient balance for a voucher now quotes the shortfall, sends a PayFast button for exactly that top-up, and **resumes the purchase automatically** on the next message after the money lands (`RESUME_VOUCHER_PURCHASE`).
- **Voucher history + retrieval**: "my vouchers" lists date/value/serial/status from `pending_gifts`; "voucher pin <serial tail>" re-sends a PIN **behind the wallet PIN** (verifyPIN with lockout).
- Suite 258/258.

## 2026-08-20 — Deposit fee, OTT self-purchase, state escapes, policy sweep, ledger repair

Founder live-testing batch (first fully auto-credited deposit confirmed: R30 → "✅ Deposit received", closing the deposit E2E objective):

- **Deposit payment fee**: card/EFT deposits now charge gross = credit + fee (`depositFeeCents`: 4.2% + R2.30 rounded up to a rand — env-tunable `WAPAY_DEPOSIT_FEE_BPS`/`_FIXED_CENTS` until PayFast's real rate card is read). Quoted before the tap ("R30 deposit + R4 payment fee = *R34*", button pays gross); ITN verifies gross, credits face, books the fee to `REVENUE:FEE:DEPOSIT` (`buildLoad` gained `customerFeeCents`). Deposits are no longer loss-making.
- **OTT voucher self-purchase**: "buy an OTT voucher" (any phrasing/language — deterministic short-circuit + orchestrator `self=true`) → confirm (amount+fee) → wallet PIN → OTT issue → **PIN delivered in-session immediately** via the atomic claim flow. Insufficient balance becomes a checkout moment (shortfall + both load options). The stale "🎮 Lifestyle & OTT Vouchers" (Netflix/Uber) menu can no longer swallow OTT-voucher asks.
- **Trap-state escapes**: real sentences/questions inside `AWAITING_VOUCHER_PIN` and `DEPOSIT_CARD_AMOUNT` now escape to the full router (orchestrator included) instead of looping "Invalid Voucher PIN" (live sighting: "I want to use my bank account").
- **Policy/stale-content sweep (3-agent workflow, all fix-now findings applied)**: `showCategoryProducts` + context-aware follow-ups now coming-soon gated; "what can I buy" advertises live categories only; **every betting word scrubbed from WhatsApp-facing copy** (menus, gates, errors, keyword maps — Meta policy); 'ott'/'voucher'/'send money' keywords reserved for the money rail; no-API-key fallback menu cleaned; orchestrator HELP no longer teases cash-out. Dead code deleted: legacy `message-processor.js` (V1), `chat.ts`/`chatWithAI`, orphan AI states, `renderHome` dead vars.
- **Ledger repair + crash-proof holds** (BUGLOG #15/#16): R36 of stuck ACTIVE holds released, R20 unbacked double-credit removed — founder balance now R50.00 = exactly the journal. Voucher execute releases its hold in the outer catch on any crash.
- Suite 247/247.

## 2026-08-19 — 🎉 OTT float landed (R100k) + comma-amount parser fix — send-money UNBLOCKED

OTT IT Support loaded the R100,000 test float — and the very first balance check found a real bug: OTT formats large amounts with comma thousands separators (`"100,000.00"`) and `randToCents` rejected them, failing GetBalance. Fixed: well-formed comma grouping (and only that) is stripped before exact string-math parsing; malformed comma patterns still throw. This also protects voucher issuing at the R1000 cap (`"1,000.00"`). Live-verified: balance R100,000.00. New `tests/ott-rand-parsing.test.mjs`; suite 238/238. **The voucher-gift ("send money") live test is now unblocked.** Test vouchers for merchant redemption received from OTT (stored locally, gitignored — redemption client still needs OTT's Merchant API docs + credentials). Deposit cash-in copy expanded to the founder's step-by-step wording.

## 2026-08-19 — Contact-card sends, remembered beneficiaries, cash-vs-bank copy

Founder asks from live testing, all shipped:

- **Share a contact to send money**: the webhook now handles `contacts`-type messages (previously silently dropped). Mid-flow, a shared card fills the number the flow was asking for; fresh, it starts a send-money ask with the recipient prefilled ("💸 Send money to Philly (0798743910) — how much?"). Invalid/foreign numbers get a polite fallback.
- **Remembered beneficiaries** (`beneficiaries` table, applied to prod; `lib/beneficiaries.js`): every successful gift recipient and every shared contact is upserted per (account, msisdn) — names come from contact cards and are never overwritten with null. "send R50 to Philly" now resolves by name: new `recipientName` slot in the orchestrator (verified live: "send R50 to Philly" → SEND_VOUCHER + name), dispatch looks it up (unique hit proceeds, ambiguity lists options, miss asks for the number), and the `VOUCHER_GIFT_RECIPIENT` state accepts names too. The full number at confirm remains the human gate on every resolved name.
- **Deposit prompt rewritten — cash vs card/bank**: option 1 CASH (pay the cashier at any major retailer, get a Blu Voucher code, send it in); option 2 CARD/BANK (PayFast: cards, Apple Pay, Google Pay, Samsung Pay, Capitec Pay, Instant EFT, SnapScan, Zapper). The orchestrator's product truth carries the same framing.
- **Withdrawals explained**: the balance is spend-only; cash-out runs through WaPay vouchers two ways — cash at participating retail partners, or paid into a bank account via PayShap (voucher-partner rails, rolling out). Withdrawal questions no longer fast-path to the generic help menu (verified live in en + af).
- **Deposit-status PENDING carries a retry line** — prompted by a live FNB decline (2026-08-19): the bank declined the charge on PayFast's page, so no ITN ever fires and the intent stays PENDING forever; the status answer now says nothing left the account and how to retry. (Server side was verified clean — the decline happened between FNB and PayFast.)
- Suite 233/233.

## 2026-08-18 — AI orchestration engine: two tiers, 11 languages, structured outputs

The single temperature-0.7 gpt-4o call (bare `JSON.parse` of free text) is replaced by a two-tier engine in `packages/ai/src/orchestrator.ts`:

- **Tier 1 — orchestrator (gpt-4o)**: detects language (all 11 official SA languages) + domain (MONEY/AIRTIME/DATA/ELECTRICITY/SEND/DISCOVER/CHAT), and completes trivially-clear intents in one call (fast path: balance, deposit status, help, home).
- **Tier 2 — category agents (gpt-4o-mini)**: per-domain slot extraction + a reply in the user's language.
- Every call uses OpenAI **strict structured outputs** at temperature 0 with 15s fail-fast timeouts. Models env-tunable (`WAPAY_ORCHESTRATOR_MODEL`, `WAPAY_CATEGORY_AGENT_MODEL`) for the later Claude migration.
- The processor's free-text path (`handleAIChat`) now dispatches through `dispatchOrchestratorAction`: model output is treated as **untrusted input** — msisdn re-validated (`normaliseMsisdn`+`isValidSaMsisdn`), amounts integer-checked, the model's meter slot deliberately never used (the flow collects meters). Actions map onto the SAME deterministic preview→PIN flows as the keyword router; `SEND_VOUCHER` reuses `resolveGift`. The engine proposes; it never executes.
- Prompts carry the money-truth rules (never state balances/status — return the action; the ledger answers) and the honest product list (no betting/Netflix claims).
- **Live eval: 132-case golden corpus** across all 11 languages with realistic typos/code-switching (`tests/fixtures/orchestrator-golden.json`, generated by 11 parallel language agents; harness `scripts/eval-orchestrator.mjs`): 99.2% first run, the single miss (EN redeem-voucher phrasing) fixed by a prompt sharpening and re-verified. Slot extraction (amounts to the cent, msisdns) 100% on hits.
- Wiring tests `tests/orchestrator-routing.test.mjs` lock the invariants (re-validation, no direct money movement in dispatch, strict schema, temp 0).
- **Adversarial review (4-dimension multi-agent workflow) found 9 issues, all fixed pre-ship**: worst-case latency cut from ~60s to ≤20s (10s timeouts, no provider retries inside the webhook budget); `productQuery` now routes to the smart product pipeline instead of dying in an unread entities key; coming-soon categories keep their gate on the AI path; a model-carried airtime recipient survives the amount ask; deposit ask joins conversation history; provider errors are logged before normalization. Plus three money-safety hardenings: **the voucher confirm + PIN prompt now show the FULL recipient number** (a model-proposed destination must be verifiable by the sender before a bearer voucher goes out — masking stays in logs); **receipt-shaped AI replies are deterministically blocked** (`looksLikeReceipt` — the official thread can no longer be tricked into minting fake proof-of-payment via "repeat after me" / translation attacks); **13+ digit runs are redacted** from logs and stored conversation history (`redactBearerDigits` — a 16-digit voucher PIN is money; phone numbers survive for slot-filling). Suite 222/222.

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
