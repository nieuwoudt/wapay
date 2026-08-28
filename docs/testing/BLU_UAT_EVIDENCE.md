# WaPay — Blue Label (Blu Telecoms) Trade API: UAT test evidence

**Prepared for:** Phuti Maphoto, Branded Voucher Coordinator, Blue Label Telecoms
**From:** WaPay (Pty) Ltd — registration 2025/759220/07
**Date:** 28 August 2026
**Purpose:** supporting evidence for production enablement sign-off

Every transaction listed below is drawn from WaPay's production double-entry ledger and
provider-request log. Blue Label reference numbers are reproduced exactly as returned by your
API, so each line can be matched against your own records.

---

## 1. Summary

| Service | Status | Successful transactions | Evidence |
|---|---|---|---|
| **Voucher redemption** (Blu Voucher) | ✅ Verified end-to-end in production | **8** | Blu references `BLU-…`, §2 |
| **Airtime vending** (pinless) | ✅ Verified end-to-end | **6** | Blu references `8296…`–`8297…`, §3 |
| **Data vending** | ✅ Verified in Blu QA | QA environment | §4 |
| **Electricity vending** | ✅ QA vend confirmed on your compliance meter | QA environment | §4 |

**In scope of this pack:** transactions recorded in WaPay's production environment.
**Not in this pack:** data and electricity vends, which were executed against the **Blu QA
(Trade QA) environment** during integration and were therefore not written to our production
ledger. We can re-run a fresh, fully logged UAT round for any service on request — see §6.

---

## 2. Voucher redemption — 8 successful production transactions

Flow: customer sends the 16-digit Blu Voucher PIN in WhatsApp → we call
`GET /voucher/variable/vouchers` (status check) → `POST /voucher/variable/redemptions`
(redeem) → wallet credited → receipt returned to the customer.

| # | Date (UTC) | Amount | Blue Label reference | Ledger posting (double-entry) |
|---|---|---|---|---|
| 1 | 2025-11-24 08:08:34 | R10.00 | `BLU-1763971714144` | Dr Clearing:Blu 1000 / Cr Wallet 1000 |
| 2 | 2025-11-24 11:56:41 | R10.00 | `BLU-1763985401598` | Dr Clearing:Blu 1000 / Cr Wallet 1000 |
| 3 | 2025-12-20 14:15:58 | R10.00 | `BLU-1766240157962` | Dr Clearing:Blu 1000 / Cr Wallet 1000 |
| 4 | 2025-12-29 05:27:45 | R10.00 | `BLU-1766986065022` | Dr Clearing:Blu 1000 / Cr Wallet 1000 |
| 5 | 2025-12-29 05:30:05 | R10.00 | `BLU-1766986204855` | Dr Clearing:Blu 1000 / Cr Wallet 1000 |
| 6 | 2026-01-02 17:03:35 | R10.00 | `BLU-1767373415727` | Dr Clearing:Blu 1000 / Cr Wallet 1000 |
| 7 | 2026-01-02 17:05:27 | R10.00 | `BLU-1767373527263` | Dr Clearing:Blu 1000 / Cr Wallet 1000 |
| 8 | 2026-01-06 06:14:07 | R10.00 | `BLU-1767680046795` | Dr Clearing:Blu 1000 / Cr Wallet 1000 |

**First live redemption** (24 Nov 2025) used test voucher `3608644555612212`, returned
R10.00 and reference `BLU-1763971714144`, and credited the customer wallet to R10.00 — the
customer-visible receipt and the ledger entry agree exactly.

**Negative paths exercised:** already-USED voucher, EXPIRED voucher and INVALID PIN each
return a distinct, correctly-handled customer message rather than a failure. Redemption is
idempotent: replaying the same PIN returns the original result and never double-credits
(idempotency key derived from a hash of the PIN, never the PIN itself).

---

## 3. Airtime vending — 6 successful production transactions

Flow: customer requests airtime in WhatsApp → network auto-detected from the MSISDN →
priced preview → customer confirms and enters their wallet PIN → funds reserved → Blu vend →
funds settled and receipt delivered. A failed vend releases the reservation, so the customer
is never charged for a vend that did not happen.

| # | Date (UTC) | Blue Label reference | Result |
|---|---|---|---|
| 1 | 2025-12-20 18:56:00 | `829666075` | SUCCESS |
| 2 | 2025-12-22 05:22:51 | `829673309` | SUCCESS |
| 3 | 2026-01-01 17:35:34 | `829717452` | SUCCESS |
| 4 | 2026-01-02 16:56:17 | `829720901` | SUCCESS |
| 5 | 2026-01-02 16:59:28 | `829720907` | SUCCESS |
| 6 | 2026-01-02 17:50:01 | `829720922` | SUCCESS |

The same log also records 4 declined attempts and 7 abandoned/expired previews from the same
integration period. We have retained these deliberately: they evidence correct handling of
the unhappy paths (decline surfaced to the customer, funds released, no orphaned ledger
postings).

---

## 4. Data and electricity — verified in Blu QA

- **Data vending:** verified end-to-end against Trade QA (bundle catalogue lookup, priced
  preview, vend, receipt). Runs on the identical code path as airtime — the same reserve →
  vend → settle/release pattern.
- **Electricity:** vend confirmed against **Blu's compliance test meter `000001020001`**
  (R200 generic vend), returning a valid token reference. Entitlement/permission issue found
  during testing was resolved with your team. Note for production planning: electricity vends
  can take up to ~90 seconds to return, which our platform accommodates.

These ran in the QA environment, so the transaction logs sit on your QA side rather than in
our production ledger. If your sign-off requires them in the same format as §2 and §3, we
will re-run a fresh UAT round and supply them (§6).

---

## 5. Platform controls relevant to sign-off

- **Double-entry ledger.** Every transaction posts a balanced journal entry; stored balances
  are continuously reconciled against journal-derived truth. Money math is in integer cents
  throughout — no floating point.
- **Two-phase vending.** Funds are reserved before the provider call and only settled after a
  confirmed vend; every failure path releases the reservation. A customer cannot be charged
  for an undelivered product.
- **Idempotency.** Every provider call carries a deterministic idempotency key, so a retry or
  a duplicated webhook can never vend or charge twice.
- **Audit trail.** Full request/response logging per provider call, with PINs and other
  bearer secrets never written to logs.
- **Automated regression suite.** 429 automated tests run before every deployment, including
  money-safety invariants and provider error taxonomies.

---

## 6. What we can produce on request

We can schedule and run a **fresh UAT round** in whichever environment you prefer, covering
airtime, data, electricity and voucher redemption, and deliver:

1. a timestamped transaction log per test case, with your reference numbers;
2. the matching customer-visible WhatsApp receipts (screenshots);
3. the corresponding ledger postings;
4. negative-path evidence (declines, invalid inputs, timeouts).

**Please confirm the format and environment you need for sign-off**, and whether there is a
production UAT allowance or test-vend budget we should use. If a specific template or
checklist exists on your side, we will complete it directly.

---

## 7. Outstanding requests to Blue Label (from 18 August 2026)

1. **Production credentials** — Trade API basic auth + API keys for voucher redemption and
   VAS vending, plus the production base URL and your go-live checklist.
2. **IP whitelisting** — whether production requires caller IP whitelisting and, if so,
   whether a shared static egress IP is acceptable or a dedicated IP is required. (This
   determines our network setup, so a definitive answer either way unblocks us.)
3. **Additional VAS categories** — enablement on our trade account for: lifestyle vouchers,
   bill payments, gaming top-ups and remittance. See `docs/BLU_VAS_CATEGORY_REQUEST.md` for
   the itemised list, intended use and the commercial questions attached to each.
4. **Production UAT process** — we currently see only the QA whitelist for test MSISDNs.

*Prepared by WaPay engineering. Every figure above is reproduced from source records; nothing
is estimated or rounded.*
