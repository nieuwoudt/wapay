# Adversarial review — WaPay for Business (2026-09-05)

Read-only workflow over the whole business change (22 files): **7 lens finders**
(money, security, cross-user, conversation, Prisma/data, React/UI, policy/copy)
→ dedup → **3 independent refuters per finding** (code-path trace; production
impact given env gating; existing-guard check), majority rules → **3 completeness
critics** → their fresh findings verified the same way. Reviewers never edited
a file; every fix below was made by the lead and pinned by a test.

**Counts (205 agents, 50 minutes):** 80 raw findings → 65 after dedup (45 from the
lenses, 20 from the critics) → **28 confirmed** (18 + 10; ≈16 distinct issues once the
same hole reported through several lenses is merged), 37 refuted on impact. Most of
the refuted items were fixed anyway because the fix was cheap and made a number or a
message more honest; they are listed separately so the record stays truthful about
what was actually broken.

Verification after fixes: 551/551 unit tests (42 in `tests/business-portal.test.mjs`),
8/8 real-database E2E on an isolated schema (`tests/e2e/business-e2e.mjs`), build
green. The real-DB run caught one bug the unit stub had hidden (BUGLOG #38).

## Confirmed and fixed

| Sev | Finding | Fix | Guard |
|---|---|---|---|
| HIGH | **Nudge consent could be manufactured.** The WaPay-originated push was allowed for any customer with a prior PAID link; a card payer's number is whatever was typed at checkout, so a business could pay its own R5 walk-in link and type a victim's number, or pay its own ticket from its own wallet under a victim's customer row. (Reported by 3 lenses.) | `customerEligibleForNudge` now requires a WaPay-account payer (`payerRef WAPAY:*`) **whose number is the customer's number**, or a customer row bound to such an account. Card payments never count. BUGLOG #39. | `nudge: … manufactured consent` drives both attacks → NOT_ELIGIBLE |
| HIGH | Business link without items wrote a JS `null` into the `Json?` column (`items: null`). | Conditional spread: the key is omitted when there are no items. | `createPaymentRequest business branch` asserts `p.items` absent/null-safe; real-DB E2E creates a walk-in link |
| MED→HIGH | **Once-per-link and per-day nudge caps reset by a later "sent" click** (`markLinkSent` overwrote `channel`). (2 lenses.) | `markLinkSent` refuses to downgrade a `WAPAY` mark (`NOT: { channel: 'WAPAY' }`). | `markLinkSent(... 'COPY')` returns false after a nudge; ALREADY_SENT holds |
| MED | Public OTP `request` messaged ANY wallet holder (paid authentication templates, spam surface, pollutes the owner's OTP throttle). (2 lenses.) | Same gate as the in-session path: no business and not invited → no message, still generic `{ok:true}`. Suspended businesses get nothing either. | `review: OTP request refuses wallets…` |
| MED | Dashboard/CSV card fee recomputed from **today's env**, not the fee the ledger booked. | `loadIntents` + `classifyPaid`: fee and method come from the PayFast intent's booked `feeCents`; banded fallback only for legacy rows. | `review: fees and method come from the BOOKED intent` |
| MED | Composer silently dropped an incomplete item row (e.g. price `1,500` unparsed) and billed the customer for less than typed; qty 0/blank billed as 1. | Incomplete rows are flagged red and block creation; `toCents` accepts thousands separators and decimal commas; qty must be 1–999. | page statics `incomplete.length > 0`; `toCents` covered by the composer state |
| LOW | Name impersonation filter bypassed by spacing, zero-width/bidi characters, confusables; short brand list. | `sanitizeLabel` strips zero-width/bidi; names are NFKD-folded, confusables mapped, spaces squeezed for platform brands; list extended (banks, telcos, SASSA, retailers). | `labels: …` with 9 bypass strings and 4 legitimate names |
| LOW | No per-business customer cap; Overview fetched every customer row; linker re-ran per GET. | `MAX_CUSTOMERS_PER_BUSINESS = 5000` (429 `CUSTOMER_LIMIT`); Overview fetches names only for referenced ids; linker stays bounded (`take: 50`, idempotent). | `review: import is batched and capped` |
| LOW | `upsertCustomer` find-then-create raced (P2002 aborted the linker batch / 500 on create). | Create catches P2002 and adopts the winner; import is one read + one `createMany(skipDuplicates)`. | `review: import … a concurrent create adopts the winner` |
| LOW | `composeLinkMessage` hard-sliced at 700 chars and could cut the pay URL. | Mandatory tail (URL + footer) built first; optional detail fitted into the remaining budget. | `message + wa.me deep link` worst-case assertion |
| LOW | Overview kept the previous range's numbers under the new label; stale quote shown for a different total. | `setM(null)` on range change, label derived from `rangeDays`; quote fetch cancelled and matched on `amountCents`. | page statics |

## Refuted on impact, fixed anyway (cheap, and each made a number or message more honest)

- SAST bucketing for months/days (`monthKey`, `dayKey`, `lastMonths`, `monthStartUtc`).
- Lifetime, outstanding and conversion figures from aggregates over every row; profile flags `truncated`/`feesTruncated`.
- CSV export ends with an explicit marker row when it would be short; `X-WaPay-Truncated` header; formula-injection neutralised.
- `REPAIR:replayed` rows classified as card when a successful intent exists.
- References sanitised at creation; `recentItems` write awaited (Vercel freezes after the response).
- The in-chat pay flow, the receipt ask, the payer's receipt and the balance-rail owner notification name the **business** (and customer + reference) like the pay page.
- A suspended business's pay page renders "no longer active" and `checkout.js` refuses it (single 410 path preserved).
- Per-source lockouts for OTP and password (a stranger at a public shop number locks their own connection, never the owner; a locked-out source cannot consume the owner's fresh code); timing-equal password refusals via a dummy argon2 hash.
- Out-of-window rails first for the nudge (Direct Send → template → text): Meta accepts and later drops free-form text, so text "ok" is not delivery.
- `business login` matcher anchored on both ends; a throttled owner is told to wait; "change my amount" with only business tickets open points to the portal instead of minting a personal link.
- Overview `Cache-Control: private, no-store`; owner number masked in 0-form; fee-threshold copy from the server; blocked WhatsApp popup never recorded as sent; honest copy-to-clipboard; expired session returns to sign-in; keyboard access for the customer picker and clickable rows; error messages styled as errors; iOS-safe 16px inputs on phones.

## Refuted and left as is

- "Payer-bound OTP challenge id" — the per-source lockout closes the practical DoS; binding verify to a request cookie would break the in-session `business login` path. Accepted.
- "Membership timing oracle on the request path" — the request path now returns after the same DB work for every number (no send for uninvited numbers), and the send itself is not awaited by the browser's outcome. Accepted residual: template send latency differs for invited numbers.

## Found by the real-database E2E, not by reviewers

- BUGLOG #38: the Overview's paid-row query selected columns without `status`; `classifyPaid` read `undefined` and treated every card payment as a balance payment. The in-memory stub ignored `select`; it now projects `select` exactly like Prisma, so the unit suite catches this class.

## Completeness critics (3 agents, 20 fresh findings, verified the same way)

The critics started from files the lens reviewers had treated as "unchanged" and found the load-bearing gap of the round:

| Sev | Finding | Fix | Guard |
|---|---|---|---|
| HIGH | **A suspended business's tickets were still payable from a WaPay balance in chat** (the pay page and checkout had been fixed, the in-chat confirm and PIN-settle path had not). (3 critics.) | Shared `businessRequestPayable` used by the pay page, checkout, the in-chat confirm AND the PIN settle; fails closed when the business row is unreadable. | `critics: a suspended business is not payable on ANY rail` |
| MED | Nudge once-per-link guard was check-then-act: two concurrent taps sent two messages and over-consumed the daily cap. (3 critics.) | Atomic claim (`updateMany … NOT channel WAPAY → channel WAPAY`) BEFORE sending; a failed send releases the claim. | `critics: nudge claims the link atomically`; concurrent run asserts one send |
| MED | `set-password` needed only the 24h cookie: a briefly borrowed session became permanent password access, silently. (3 critics.) | `verifyStepUp`: the current password when one exists, else a fresh one-time code; `clear-password` added under the same rule; the owner gets a WhatsApp notice; `via` logged. | `critics: password set/clear needs a fresh factor` |
| MED | `action:'sent'` accepted `channel:'WAPAY'` from the browser, forging a "sent by WaPay" mark and consuming the nudge budget. | Route accepts only the two owner-side channels; `markLinkSent` can no longer write `WAPAY`. | same test: a WAPAY channel from a caller is recorded as COPY |
| MED | CSV export windowed on `createdAt` while the Overview windows on `paidAt`, so a 30-day ticket paid this month was missing from this month's export. | Export window = created OR paid in the window. | `critics: … CSV window is created-or-paid` |
| MED | E2E scratch-schema guard was a substring match; a URL with an existing query string would have passed the guard while Prisma used `public`. | `new URL(...).searchParams.get('schema')` + `SELECT current_schema()` before the first write. | static assertions on the E2E file |
| MED | Password guessing had no per-account ceiling (rotating IPs). | Looser cross-source ceiling (30 fails / 15 min) on top of the per-source lockout, for codes and passwords. | `BUSINESS_ACCOUNT_MAX_FAILS` |
| MED | Walk-in balance payers' full numbers reach the business with no disclosure (the personal rail masks them). | One disclosure line where the payer commits: pay page fine print and the in-chat confirm, business links only. | `critics: …` copy assertions |
| LOW | `?range=constructor` made the Overview 500. | `Object.hasOwn` lookup. | static |
| LOW | Identical `WAPAY_ADMIN_HOST` / `WAPAY_BUSINESS_HOST` silently sent the business root to `/admin`. | Collision logged once; business host gating disabled in that misconfiguration; documented. | static |
| LOW | `ownerAccount` admitted a first-contact account (said "hi", never set a PIN) as a business owner. | Owners must be onboarded (`S5_COMPLETED`); same generic answers, nothing leaks. | `critics: … owners must be onboarded wallets` |
