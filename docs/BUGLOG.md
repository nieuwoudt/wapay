# WaPay — Bug Register

*Every caught bug, with its root cause and the guard that stops it coming back. Format: **symptom → root cause → fix → guard**. Add new entries at the top. A bug without a regression guard is not closed.*

---

## 26. Paid-request notifications were one-shot — a lost invocation lost them forever

- **Symptom (founder live test `PRMDCUQA`, R20 card payment, 2026-08-25):** the payment was captured perfectly — payer number stored, request marked PAID, requester credited — but NEITHER the requester's "you've been paid" nor the payer's receipt ever arrived on WhatsApp.
- **Root cause:** both sends were gated on `wonRequestTransition` — winning the atomic PENDING→PAID check-and-set, which by design succeeds exactly once. The ITN route had no `maxDuration` (Vercel default cap) while doing a PayFast server-verify POST-back, ledger posting, and two WhatsApp sends; when the invocation died mid-sends, PayFast's redelivery could not win the transition again, so the notification branch never re-ran. Exactly-once *notification* was implemented as exactly-once *attempt*.
- **Fix:** notifications moved to `lib/request-notify.js` — durable and idempotent: `requesterNotifiedAt`/`payerNotifiedAt` flags in the intent metadata, set ONLY after a send resolves ok; the ITN now runs the helper on EVERY delivery (replayed or not), so redeliveries repair lost sends; `POST /api/admin/notify-request` (internal-key-guarded) repairs manually; `vercel.json` gives the ITN 30s and the WhatsApp webhook 60s.
- **Guard:** behavioral tests drive the helper through send-fails-then-template-rescues and redelivery-never-double-sends paths; statics pin every-delivery invocation (never transition-gated), flags-only-on-ok, and metadata MERGE on flag persist.

## 25. Parallel-session rsync swept another thread's PRE-review code into a push

- **Symptom:** commit `619a285` (amount-change swap) also shipped the in-flight payer-registration feature BEFORE its adversarial-review fixes — prod briefly ran a GET form (payer msisdn into query-string request logs), a hijackable last-click-wins receipt destination, a dead-code template fallback, and a fail-open health config block.
- **Root cause:** two sessions share one git-less fast copy; rsync is tree-wide, so "commit my work" swept every mid-flight file the other session had touched — the commit message described none of it.
- **Fix:** the review-fixed versions pushed the same evening (this commit); window ≈ one deploy cycle.
- **Guard:** process rule — before rsync+commit, run `rsync -rcn --itemize-changes` and inventory every differing path against the tracker; a file you didn't author in THIS session either ships with its author's sign-off visible in the tracker or stays out of the commit (`git add` is selective even when rsync isn't).

## 24. Payer-registration review batch (41-agent adversarial review, 2026-08-22)

- **Symptom (batch, all fixed pre-launch bar the #25 window):** (a) `@wapay/whatsapp` send functions RESOLVE `{ok:false}` — never throw — so a catch-based template fallback was dead code and out-of-window payers silently got no receipt, with zero log evidence; (b) the receipt destination was last-click-wins metadata — anyone holding the link could redirect a paying payer's receipt + PayFast reference to their own number during the whole card-entry + ITN-latency window; (c) the payer's msisdn rode a GET query string into platform request logs; (d) `RECEIPT_CODE_PATTERN` un-anchored under `/i` matched ordinary sentences ("receipt problems" → PROBLEMS, "is my receipt prepared" → PREPARED); (e) `/api/health?config=1` was world-readable until the key existed and leaked two env VALUES its own doc called presence-only; (f) a payer whose card payment landed after the requester cancelled was told "no payment was taken on it".
- **Root cause:** single-session blind spots — assumed exceptions on send failure, trusted mutable shared metadata for a money-adjacent artifact, defaulted fail-open by analogy with internal-auth, pattern-matched user text too loosely.
- **Fix:** branch on the resolved `.ok` with an env-gated template fallback; receipt destination bound to signed `custom_str1` (the ITN persists the true payer back into metadata for the in-chat ref gate); number travels in the POST body only; patterns anchored + restricted to the code alphabet (PAY_REQUEST tightened too); health fails closed with presence-booleans only; intent-status consulted before ever denying a payment.
- **Guard:** `tests/payer-registration.test.mjs` (26 tests) pins every fix: `.ok` branches, `custom_str1` wiring, POST-only payer, the false-positive corpus, fail-closed health, metadata MERGE spreads (mutation-tested), gross-cents receipts, upsell-free push receipts, and the betting/cash-out word ban.

## 17. Every VAS settle idemKey was timestamp-poisoned — vend delivered, customer never charged

- **Symptom:** (latent, would hit every airtime/data/electricity purchase on the new ledger) the provider vends, then `settleHold(buildSpend(...))` throws — the customer keeps the product AND the money.
- **Root cause:** preview ids embedded raw `Date.now()` (`preview-air-1787…`); the derived settle idemKey then trips ledger-core's own timestamp-lookalike guard. Blu voucher redemption had the same class of bug: the SHA-256 PIN-hash prefix looks like an epoch for ~1 in 481 vouchers — after Blu consumed the voucher, stranding the cash.
- **Fix:** preview stamps are base36 (`Date.now().toString(36)`), the redemption idemKey interleaves `x` every 8 hex chars — both provably immune to the guard.
- **Guard:** the guard itself still rejects any regression; found by the 45-agent QA audit 2026-08-21.

## 18. Payment-request card leg was not exactly-once

- **Symptom:** double card charges and double credits were possible (fresh intent + fresh idemKey per checkout click; ITN credited without consulting the request; a crash between credit and mark-paid stranded the request PENDING-and-repayable forever).
- **Root cause:** the two rails used different idemKeys, and mark-paid was gated on `!posted.replayed` and swallowed errors.
- **Fix:** ONE idemKey per request code shared by BOTH rails (`wapay-payreq-<code>`) with one reusable intent — postEntry can only ever credit once across all rails and clicks; mark-paid runs on every delivery (atomic PENDING→PAID); confirmations gate on winning the transition; a replayed entry with a different PayFast ref logs `payfast_overpayment_detected` (CRITICAL_REFUND_NEEDED).
- **Guard:** `tests/payment-requests.test.mjs` locks the unified key, the intent reuse, the absence of the replay gate, and the overpayment scream.

## 19. PAYREQ_PIN burned wallet-PIN attempts on chatty replies

- **Symptom:** five conversational replies at the PIN prompt soft-locked the wallet PIN; ten hard-locked it.
- **Root cause:** every non-cancel message was fed to `verifyPIN`.
- **Fix:** only `\d{4,6}` reaches verifyPIN; sentences escape to the router; anything else re-prompts without burning attempts.
- **Guard:** QA audit finding; PIN-shape gate now mirrors VOUCHER_GIFT_PIN.

## 20. Fee-free self voucher was quoted free but booked the R3 fee

- **Symptom:** self OTT-voucher purchases were silently overcharged R3 (or failed at settle on an exact balance) — the preview quoted 0, `buildVoucherGift` hardcoded the flat fee.
- **Fix:** `buildVoucherGift` takes `flatFeeCentsOverride`; execute passes the preview's quoted fee — the preview is the quote of record.

## 21. Broke-checkout resume was unreachable

- **Symptom:** the pay-the-difference + auto-resume flow never triggered — the processor matched `INSUFFICIENT_FUNDS` but execute returned `USER_INPUT`, and the preview blocked short balances with a generic error first.
- **Fix:** preview and execute both return a distinct `INSUFFICIENT_FUNDS`; the preview path now ALSO enters the checkout flow (shortfall + PayFast link + `RESUME_VOUCHER_PURCHASE`).

## 22. Claiming marked gifts DELIVERED before the send

- **Symptom:** one failed WhatsApp send permanently stranded the recipient's bearer voucher PIN (row DELIVERED, PIN never received).
- **Fix:** `revertGiftDelivery` flips DELIVERED→ISSUED when the send definitively fails (`ok:false`) so the next inbound message retries; applied to the claim flow AND self-purchase delivery.

## 23. Routing/state batch (QA audit 2026-08-21)

One sweep, all fixed: phone-number replies re-parsed as rand amounts in AIRTIME_MSISDN (R7.8m airtime "amounts"); "me" cancelling despite the prompt offering it; "Yebo/Ewe/Ja/Ee" cancelling every confirm state (7 regexes extended); deposit-status questions with amounts minting fresh payment links (status now checked first); a dashed 16-digit voucher PIN minting a R1,234 card checkout; "pay request <word>" matching ordinary words (codes now strictly `PR[A-Z]{6}`); "send an OTT voucher to <name>" hijacked into self-purchase; contact cards shared mid-flow hijacking into send-money; 9+ digit context follow-ups read as rands; "cancel … request" creating a NEW request (cancel now wired: "cancel request PRXXXXXX"); BUY_DATA discarding the agent's English productQuery.

**Known-open (logged, deliberate):** profile write races (last-write-wins acceptable at current volume); language-evidence echo on neutral turns; voucher-history intercept answers recipients with sender-only history; a crash between settleHold and createPendingGift (idempotent retry design exists, no caller retries yet); redemption replay tells the losing account in a same-PIN race "Redeemed Successfully".

## 15. Voucher-execute crash stranded R36 in ACTIVE holds

- **Symptom:** failed voucher sends ("An error occurred while executing purchase") left the reserved money missing from the balance — two ACTIVE holds (R23 + R13) found in prod, wallet R36 lighter than the journal (founder-reported balance confusion, 2026-08-20).
- **Root cause:** an exception between `reserveHold` and the taxonomy failure paths (which do call `releaseHold`) fell through to the outer catch, which returned 500 without releasing the hold.
- **Fix:** `holdIdemKey` is hoisted; the outer catch best-effort releases it (`execute_crashed:` reason). `releaseHold` is status-guarded, so the safety release is a no-op after settle/normal release. Stuck prod holds released with the library function; wallet reconciled.
- **Guard:** `tests/voucher-execute-crash-release.test.mjs`-style static assertion lives in `tests/ott-voucher-self.test.mjs` (crash-release path present); `reconcileWallets()` detects any stored-vs-derived drift.

## 16. Manual credit applied twice — R20 of unbacked balance

- **Symptom:** stored wallet balance exceeded the journal-derived truth by exactly R20 ("real money vs fake money", founder, 2026-08-20).
- **Root cause:** the 2026-08-18 manual R20 credit (PayFast IP-reject recovery) hit the wallet twice: once as a direct wallet update and once properly via `postEntry` (which also increments the wallet). The journal was correct; the stored cache wasn't.
- **Fix:** wallet reconciled to journal truth (R50.00) after releasing the stuck holds; logged as `wallet_reconcile_fix`.
- **Guard:** manual credits are banned as direct wallet updates — `postEntry` only (it is replay-safe by idemKey). `reconcileWallets()` catches drift; run it after any manual intervention.

## 1. Zero-cent commission line crash

- **Symptom:** small vends crashed at posting time; the journal entry was rejected.
- **Root cause:** the fee model rounded commission to 0 cents on small amounts, and the spend builder still emitted the commission posting — a zero-amount line, which the balanced-entry validation (and DB constraints) rightly refuse.
- **Fix:** builders in `lib/ledger-core.js` omit zero-amount postings entirely; the entry stays balanced without them.
- **Guard:** `tests/ledger-core.test.mjs` covers minimum-amount vends; `validateBalanced` rejects zero/invalid lines on every posting, so a regression fails loudly, not silently.

## 2. Electricity execute wrote nonexistent Prisma fields

- **Symptom:** electricity purchases failed at runtime with Prisma validation errors.
- **Root cause:** `pages/api/vas/electricity/execute.js` was written against fields that don't exist in `schema.prisma` — untested code shipped on the old non-atomic pattern.
- **Fix:** rebuilt on the reference hold pattern (ensureWallet → reserveHold → Blu → settleHold/releaseHold), response shape preserved; the phantom fields are gone.
- **Guard:** `tests/vas-electricity-flow.test.mjs` + `tests/vas-execute-ledger-pattern.test.mjs` (statically asserts every execute route follows the hold pattern).

## 3. Balance endpoint: wrong relation + 200-on-error

- **Symptom:** users could be shown R0.00 when the DB was down, and the endpoint queried a Yoyo wallet relation nobody used.
- **Root cause:** `pages/api/wallet/balance.js` swallowed DB errors into a 200-with-zero response — indistinguishable from a genuinely empty wallet — and carried a dead `yoyo` include.
- **Fix:** queries the SPEND wallet; DB failure returns **503 `BALANCE_UNAVAILABLE`**, never a fabricated zero; dead include removed.
- **Guard:** the "never 200-with-zero" rule is asserted in tests; principle recorded here: an error must never look like a balance.

## 4. `Date.now()` idempotency keys (double-vend risk)

- **Symptom:** none observed — caught in review. A provider timeout + retry would have vended twice and debited twice.
- **Root cause:** execute routes built idemKeys from `Date.now()`, so every retry was a "new" operation; idempotency existed in name only.
- **Fix:** idemKeys are deterministic from stable inputs (WhatsApp message id, voucher PIN hash) so a retry replays the same entry; `postEntry` returns the original result.
- **Guard:** DB-unique constraint on idemKey; live-DB verification replays every flow (`scripts/verify-ledger-db.mjs`, 21/21); pattern test bans timestamp-derived keys.

## 5. Webhook accepted unsigned POSTs, no dedupe

- **Symptom:** none observed — caught in review. Anyone who learned the webhook URL could POST a forged message and drive a real money flow; Meta's retries could double-process real ones.
- **Root cause:** signature verification was never implemented; a fallback verify-token had leaked into the repo; no processed-message tracking.
- **Fix:** HMAC (`X-Hub-Signature-256`) verified over the exact raw bytes before anything else — 401 on failure; leaked token removed; `claimMessage` per-message dedupe (availability-over-dedupe on DB error).
- **Guard:** `tests/webhook-security.test.mjs` + `tests/webhook-wiring.test.mjs` (statically enforces verify-before-ACK in the route source).

## 6. Catalog sync: dead endpoint (20 vs 821+ products)

- **Symptom:** the bot only knew ~20 products; most searches found nothing.
- **Root cause:** the sync job called a dead/legacy Blu catalog endpoint that returned a tiny subset, and nothing flagged the shortfall.
- **Fix:** corrected endpoint (`f9b52eb`); catalog now 831 products.
- **Guard:** sync logs product counts as structured JSON; an implausibly small sync is visible in logs. (No automated floor-count alert yet — worth adding.)

## 7. Mute bot: ACK-before-processing on serverless

- **Symptom:** bot went completely silent after the `44b51c9` deploy — webhook returned 200, no replies ever sent.
- **Root cause:** the handler ACKed 200 to Meta, then processed the message in a fire-and-forget async block. Vercel serverless freezes/kills execution after the response, so processing never ran. (The stable January deploy had awaited processing; the regression came in with the refactor.)
- **Fix:** `6096585` — verify → process (awaited) → ACK, which also matches Meta's timeout budget.
- **Guard:** `tests/webhook-wiring.test.mjs` enforces the ordering and bans void-async blocks in the webhook. If the project later needs post-ACK work, use the platform's `waitUntil`, never a bare async block.

## 8. OTT `GetAPIKey` rotates the live key

- **Symptom:** near-miss — discovered in the API docs before it burned us. Calling `GetAPIKey` doesn't *read* the key, it **rotates** it, instantly invalidating the credential every deployed environment is using.
- **Root cause:** an API whose "get" is a destructive write.
- **Fix:** the method is deliberately fenced off in `@wapay/providers-ott`; nothing in the codebase calls it.
- **Guard:** standing rule (tracker + package docs): never call GetAPIKey — in tests, OTT is only ever exercised through undici MockAgent, never the live API.

## 9. iCloud `node_modules` + trailing-space path

- **Symptom:** glacial installs, phantom file changes, and scripts breaking with "no such file or directory" on a path that clearly exists.
- **Root cause:** the working tree lived in iCloud Drive (which syncs/evicts `node_modules` and fights file watchers) inside a directory named `WaPay ` — with a **trailing space** — which silently breaks any unquoted shell path.
- **Fix:** canonical dev copy at `~/Projects/wapay` (fast local disk, no sync); the iCloud folder is documents/strategy only. All scripts quote paths.
- **Guard:** convention recorded here and in the tracker: build and test only in `~/Projects/wapay`; always quote the iCloud path exactly, trailing space included.
