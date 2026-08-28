# WaPay Mission Control — Admin Dashboard Design

*Design doc, 2026-08-28. Status: **v1 BUILT** (founder green-light same day) — live at
`/admin` behind WhatsApp-OTP login. The mockup artifact ("WaPay Mission Control", v2) now
also carries the customer-profile and sign-in screen designs. This doc remains the contract;
§5 architecture below matches what shipped.*

## v1 shipped scope (2026-08-28)
- **Auth** (`lib/admin-auth.js` + `POST /api/admin/auth`): allowlisted msisdns
  (`WAPAY_ADMIN_MSISDNS`), 6-digit OTP over WhatsApp reusing the `otp_codes` table (hashed
  at rest, 1 send/min, ONE verify attempt per code), stateless HMAC session
  (`WAPAY_ADMIN_SESSION_SECRET`, 12h) in an HttpOnly/Secure/SameSite=Strict cookie;
  allowlist re-checked per request so env removal revokes live sessions. FAILS CLOSED.
- **`GET /api/admin/metrics`**: vitals + flows + revenue-by-line + weekly series from the
  journal (verified against prod: accounts 3, funded 2, GMV R197/30d at build time).
- **`GET /api/admin/customer?q=`**: the CRM profile — identity, KYC (Didit-planned),
  balances, holds, last 40 postings, vouchers sent/received (voucherPin NEVER selected —
  bearer secret, statically tested), requests, deposits.
- **`/admin` page**: login → Dashboard + Customers tabs, mockup visual system.
- **Not yet built** (unchanged in the contract): acquisition-source stamping (funnel
  contacts row), retention cohorts, ops strip beyond holds, revenue subsidy netting.

---

## 1. What it is

One internal page that answers, at a glance and truthfully, the questions the founder and an
investor will ask: **how many, how fast, from where, spending on what, and what do we earn.**
Conversion-funnel first — the business IS the funnel (contact → account → funded → transacting
→ repeat), and every other number hangs off a stage of it.

Non-goals for v1: realtime streaming, per-user drill-down (privacy + scope), write actions of
any kind. It is a read-only instrument panel.

## 2. The funnel (spine of the page)

| Stage | Definition (exact, from live data) | Source |
|---|---|---|
| **1. Contacts** | Distinct waIds ever seen inbound + payer numbers captured on pay links that never onboarded | `processed_messages` distinct sender · request metadata `payerMsisdn` |
| **2. Accounts** | Onboarding completed (PIN set, wallet exists) | `Account` joined to `Wallet` (SPEND) |
| **3. Funded** | ≥1 credit posting into the user's SPEND wallet (deposit, voucher redemption, or request paid to them) | journal postings, account `WALLET:{id}:SPEND`, side = credit |
| **4. Transacting** | ≥1 spend/send debit (airtime, data, electricity, voucher, request paid BY them) | journal postings, side = debit, category ≠ fee |
| **5. Repeat (active)** | ≥2 money events in trailing 30 days | same, windowed |

Each stage shows: count · conversion % from previous stage · Δ vs prior period. The
stage-to-stage conversion percentages ARE the company's vital signs; the funnel renders as
horizontal bars with the conversion labels between bars.

## 3. Page layout (top to bottom)

1. **Header** — "WaPay Mission Control", period switcher (7d / 30d / 90d / all), data
   freshness stamp.
2. **Vitals row** (6 stat tiles, every one with a Δ-vs-prior-period chip):
   Accounts · Funded rate % · 30d actives (MAU) · GMV (period) · Net revenue (period) ·
   Wallet float (liability, point-in-time).
3. **The funnel** (section 2 above).
4. **Growth & source** — weekly new accounts as stacked bars by acquisition source
   (Organic / Pay-link capture / Referral / Ads-when-live), cumulative line overlaid.
   Source attribution: an account whose first contact was a `Receipt PRXXXXXX` claim or
   captured payer number = **Pay-link capture** (the free-acquisition loop); everything else
   organic until UTM-style tagging exists. Companion tile: **the loop** — payers captured,
   payer→account conversion %, payers per active requester (the K-factor inputs).
5. **Revenue** — stacked bars by line, one bar per week: VAS commission (airtime/data/
   electricity) · OTT voucher issuing commission (4%) · voucher flat fees · pay-request card
   fees · deposit fees · (future) payout margin; **free-band subsidy** shown as a negative
   segment so net take is honest. Take-rate line (net revenue ÷ GMV) on the right axis.
6. **What's selling** — category split (rand + count) for the period: airtime, data,
   electricity, OTT vouchers, requests paid; top-5 product list (from vas products joined to
   spend postings).
7. **Money movement** — three-series area: money IN (deposits + redemptions), money SPENT
   (VAS + vouchers), value TRANSFERRED person-to-person (requests paid + voucher sends);
   float line = cumulative in − out (must equal summed wallet balances — a built-in
   reconciliation tripwire: if the two diverge, the tile turns red).
8. **Retention** — weekly signup cohorts × weeks-since-signup heat strip, % with a money
   event. The investor chart.
9. **Ops strip** (small, bottom) — ledger `trialBalance()` ok? `reconcileWallets()` drift =
   R0? Outstanding ACTIVE holds · notification repairs run · webhook failures (24h). Green
   row = the money engine is healthy; any red links to the runbook.

## 4. Metrics contract (build-binding definitions)

- **GMV (period)** = Σ wallet credits (loads + received transfers) + Σ VAS/voucher purchase
  amounts, deduplicated by journal entry (a request paid = ONE event: payer→payee transfer).
  State the formula on the page footer — investors ask.
- **Net revenue** = Σ postings into `FEES`/commission accounts − free-band subsidy (PayFast
  cost on R0-fee card requests) − promo credits. Gross also shown on hover.
- **Float** = Σ `Wallet.availableCents + pendingCents` across SPEND wallets (our liability).
- **Funded rate** = funded accounts ÷ accounts (cohort-consistent when a period is selected).
- **MAU** = distinct accounts with ≥1 money event in trailing 30d (money event = any journal
  posting touching their wallet, either side).
- All money in integer cents at query time; rand formatting only at render.

## 5. Architecture (for the build phase — NOT now)

- **Route:** `GET /admin` (Next page) + `GET /api/admin/metrics?range=30d` returning one JSON
  payload of pre-aggregated series. No client-side DB access, no per-user data in the payload.
- **Auth v1:** `x-internal-api-key` = `WAPAY_INTERNAL_API_KEY` (same guard as existing admin
  routes) entered once on the page and kept in memory (not localStorage); fails closed.
  v2: proper admin login before anyone beyond the founders sees it.
- **Queries:** ~8 grouped SQL aggregates over `accounts`, `wallets`, journal postings,
  `payment_requests`, `pending_gifts`, `processed_messages`; all date-bucketed by week.
  Vercel 60s budget is fine at current volumes; add a 5-min cache header. Revisit with a
  nightly rollup table when postings > ~1M rows.
- **No new tracking needed for v1** except: stamp `acquisitionSource` into `Account.profile`
  at creation (derivable retroactively for existing accounts from receipt-claim history).
- Charts: same hand-rolled SVG-via-JS approach as the Money-Out Playbook (no chart library,
  CSP-safe, themed by CSS variables).

## 6. Build order (when green-lit)

1. `acquisitionSource` stamping + backfill script.
2. `/api/admin/metrics` with the contract above + unit tests on the SQL builders (integer
   cents, entry dedupe, float=Σwallets tripwire).
3. `/admin` page rendering the mockup design against real data.
4. Static tests: fails-closed auth, no per-user PII in payload, betting-word ban applies.
