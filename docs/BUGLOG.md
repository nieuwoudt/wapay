# WaPay — Bug Register

*Every caught bug, with its root cause and the guard that stops it coming back. Format: **symptom → root cause → fix → guard**. Add new entries at the top. A bug without a regression guard is not closed.*

---

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
