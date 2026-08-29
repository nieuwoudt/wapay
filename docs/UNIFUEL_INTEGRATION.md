# WaPay ↔ UniFuel integration — design (v1.3 Task 3)

*Written 2026-08-29. Status: built against the Yoyo TEST environment end-to-end
(v1.3.1 amendment 1); production go-live is a credentials/flag flip, not a build.*

## Shape

Two repos, one system. **WaPay** stays the wallet + conversation front;
**UniFuel** (same company, repo `Desktop/UniFuel.co`, live unifuel.co) is the
wiCode issuance service with the working Yoyo/WiGroup pipeline, Supabase
store, cron retry queue and Resend email. They talk over a tight,
authenticated, server-to-server API. Neither repo imports the other's code.

```
customer ──WhatsApp──▶ WaPay processor ──preview→confirm→PIN──▶ reserveHold
                                                                   │
                              lib/unifuel-client.js  ──Bearer──▶  UniFuel
                                                                   │
                                              /api/partner/wapay/issue
                                                                   │
                                                    Yoyo TEST (za-vsp-int)
                                                                   │
                       settleHold(buildSpend rail YOYO) ◀── wiCode returned
                                                                   │
                       wiCode + redemption guide delivered in the SAME chat
```

## Auth

- UniFuel exposes `/api/partner/wapay/*`, guarded by `verifyPartnerAuth`
  (same fail-closed idiom as its `verifyCronAuth`, hardened with a
  constant-time compare): missing `WAPAY_PARTNER_SECRET` env ⇒ **503**
  (never fails open), `Authorization: Bearer <secret>` ⇒ pass, else **401**.
- WaPay calls it via `lib/unifuel-client.js` with envs
  `UNIFUEL_API_BASE_URL` + `UNIFUEL_PARTNER_SECRET`.
- The secret is a dedicated random value (not shared with any other guard),
  set in both Vercel projects. Rotation = set new value both sides.

## Endpoints (UniFuel)

### `POST /api/partner/wapay/issue`
Body: `{ reference, amountCents, productType: 'FUEL'|'RETAIL', metadata? }`.

- `reference` is WaPay's deterministic, epoch-free key
  (`wapay-fuel-<previewId>`). **Idempotent**: an order already carrying
  `metadata.wapay_reference === reference` returns its current state —
  never a second Yoyo issue (Yoyo's issue call has no idempotency of its
  own; the order state machine provides it, same as UniFuel's ITN).
- Yoyo `userRef` = `wapay:<reference>` — deterministic, so a lost response
  can always be reconciled by asking Yoyo who owns that userRef.
- Creates order (`customer_id` NULL — guest-style; `site_id` seed site;
  `metadata.type='wapay_issue'`; **`recipient_phone`/`recipient_email`
  empty** so UniFuel's own delivery and redemption notifications stay
  silent — WaPay owns all customer comms) → `issueGiftCard` on the
  product's campaign → voucher + `voucher_events` rows → order `issued`.
- Response: `{ ok, status: 'issued', orderId, orderNumber, giftcardId,
  wicode, expiryDate, balanceCents, campaignId, testMode }`.
  The wiCode is a **bearer secret**: neither side logs it in full.
- Yoyo business failure → order `failed`, `{ ok: false, status: 'failed' }`
  (WaPay releases its hold). Transport failure to Yoyo → order stays
  `issuing`, HTTP 502 `{ status: 'unknown' }` (WaPay keeps the hold and
  reconciles — the indeterminate-payment discipline from BUGLOG #28).

### `GET /api/partner/wapay/order?reference=`
Returns the order + voucher state. If the order is stuck `issuing`, it
**settles the truth against Yoyo** via `getUserGiftCards('wapay:<ref>')`:
card found → adopt it, complete the rows, return `issued`; not found →
mark `failed`, return `failed`. This makes WaPay-side recovery
deterministic: UNKNOWN never has to be guessed at.

### `GET /api/partner/wapay/catalog`
Active products (partner, price bounds, campaign, `testMode`) — feeds
WaPay's data-driven merchant catalogue and Mission Control. Grows as the
founder gets Yoyo to enable more merchants, with zero WaPay code changes.

### `GET /api/partner/wapay/stats`
WaPay-originated issuance and redemption aggregates (count + cents, by
day) for the Mission Control UniFuel panel. Filters on
`orders.metadata->>'type' = 'wapay_issue'`.

## Ledger postings (WaPay)

Every movement through `lib/ledger-core.js` + `postEntry`, integer cents:

| Step | Entry |
|---|---|
| Confirm + PIN | `reserveHold` idemKey `wapay-fuel-exec-<previewId>` |
| Issued | `settleHold(buildSpend({ category: 'FUEL', rail: RAIL.YOYO, saleCents, commissionBpsOverride }))` → idemKey `wapay-fuel-spend-<previewId>`, source `SPEND_FUEL`: Dr `WALLET:{acct}:SPEND` · Cr `CLEARING:YOYO` (net) · Cr `REVENUE:COMMISSION:FUEL` (commission > 0 only) |
| Failed | `releaseHold` |
| Unknown | hold KEPT; reconcile via the order endpoint; alert if still unknown |

- Commission default **0 bps** until the inter-company/Yoyo rate is agreed
  in writing (`WAPAY_WICODE_COMMISSION_BPS` env overrides) — same
  discipline as `voucherGift.commissionBps`. Never book revenue we have no
  signed rate for; the same override applies to RETAIL (the 300 bps in
  `FEES.commissionBps.RETAIL` is a planning estimate, not a signed rate).
- `SPEND_FUEL` / `SPEND_RETAIL` join `SELLING_LABELS` (Mission Control
  "what's being sold") and the `SPEND_` GMV bucket automatically.
- `CLEARING:YOYO` appears in the Supplier floats card (Task 1).

## Hardening (adversarial review round, 2026-08-29 — 34 confirmed findings, all fixed)

- **One owner per purchase**: execute atomically flips the preview
  PENDING/RECONCILE → EXECUTING (`executingAt` stamped); a second PIN tap
  gets "already in progress"; a crashed owner's row is taken over after
  120s. UniFuel-side, the order id is DETERMINISTIC from the reference, so
  even truly-simultaneous issue POSTs dedupe at the primary key — Yoyo is
  asked at most once per reference (verified live with racing curls).
- **Reconcile age gate** (the CRITICAL catch): UniFuel's order endpoint only
  declares not-found-at-Yoyo → failed once the order is >120s old; younger
  orders return `ISSUANCE_IN_FLIGHT`, so a reconcile racing a slow mint can
  never trigger a release while the card still lands.
- **ISSUED disarms the crash guard before settling**: a settle failure marks
  RECONCILE (idempotent retry), never a refund of an existing voucher.
- **Reachable reconciliation**: `lib/fuel-settlement.js
  reconcileFuelPurchases` runs on the customer's next message (before the
  claim block, so a freshly confirmed code delivers same-turn); failures
  release the hold with an honest note. No hold can leak by construction.
- **Real Yoyo shapes**: `getUserGiftCards` returns `data.giftcardList` with
  FLAT card objects incl. `wicode` (probed live); adoption uses it, and an
  issued order with a null wicode retries the mint on every status read.
- **UniFuel-side retries fenced**: the admin retryIssuance action and the
  `issue_voucher` cron both refuse `wapay_issue` orders — WaPay drives all
  retries under its own reference/userRef.
- **Webhook**: replay/out-of-order guard (a redemption can only shrink the
  balance), targeted single-gift claim (never the account's queue),
  optional dedicated secrets (`UNIFUEL_WEBHOOK_SECRET` /
  `WAPAY_WEBHOOK_SECRET`) with the shared one as fallback, and a
  no-fresh-code partial alerts ops while telling the customer the truth.
- **issue metadata** capped at 2KB plain-object.
- **Known accepted risk**: Yoyo's callback to UniFuel is unauthenticated
  (no signature in their spec). An attacker knowing a giftcard_id could
  trigger code-regeneration churn. Balances are always provider-confirmed
  before forwarding; ask Yoyo for callback auth in the next exchange.

## Failure / refund paths

- **Issue fails cleanly** → hold released, warm retryable message. No money
  moved, no voucher exists.
- **Issue transport-unknown** → hold stays; one immediate reconcile via the
  order endpoint; still unknown → customer told we are confirming, ops
  alert email, next customer message retries the reconcile. Never re-issue
  on a fresh reference for the same purchase.
- **Issued but chat delivery fails** → the voucher row stays ISSUED (not
  DELIVERED) and the next inbound message retries delivery — the BUGLOG
  #22 revert discipline. The customer was charged for a voucher that
  exists; delivery, not issuance, is retried.
- **Partial redemption (production only)** → Yoyo callback hits UniFuel,
  which regenerates the wiCode; for `wapay_issue` orders UniFuel forwards
  `{ reference, event, balanceCents, newWicode }` to WaPay's
  `POST /api/webhooks/unifuel` (Bearer `UNIFUEL_PARTNER_SECRET`), and
  WaPay delivers the fresh code in chat. Test vouchers cannot be redeemed
  at pumps, so this leg is verified with synthetic events until production.
- **Refunds**: no Yoyo void API in the client; an issued-in-error card is
  an ops action through UniFuel admin. WaPay never auto-refunds a wallet
  for an issued voucher.

## Customer-facing gating

- `VAS_LIVE.FUEL` reads **`WAPAY_WICODE_LIVE`** (the production-live flag).
  Until `true`: "buy fuel/petrol" gets the warm coming-soon reply; the AI
  brain (fed by `lib/spend-catalogue.js`) presents fuel/retail as coming
  soon and never claims real redemption. Flip = env change, no build.
- When live: claims always say **participating** Shell (~85%, pump + store)
  and Engen (forecourt till); TotalEnergies is never advertised.
- Betting: zero references in chat, ever (Meta policy).

## Email (Resend, WaPay identity)

`lib/email.js` reuses UniFuel's proven Resend pattern (lazy singleton,
`{success,error}` result, inline HTML) — on **WaPay branding and a WaPay
domain**: envs `RESEND_API_KEY` (WaPay's own key) + `WAPAY_EMAIL_FROM`
(default `WaPay <noreply@wapay.co.za>`). First consumers: ops alerts
(low float, reconcile-required). FOUNDER ACTION: create the WaPay Resend
account and verify wapay.co.za before any customer-facing email.

## Go-live checklist (the "flip")

1. Yoyo production credentials into UniFuel Vercel env (`YOYO_API_BASE_URL`,
   id/password, per-brand `campaign_id` on the product rows) + redeploy
   (env changes need a redeploy — UniFuel's 33-day cron lesson).
2. `WAPAY_WICODE_LIVE=true` in WaPay Vercel + redeploy.
3. Confirm one real redemption at a pump before any marketing.
4. Agree + set `WAPAY_WICODE_COMMISSION_BPS`.
