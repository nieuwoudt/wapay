# Adumo production run, from 2026-10-23

*The live R5 tests that decide whether Adumo becomes WaPay's primary card rail. The run
sheet is section 2; results go in section 3 as they come in. Background: `docs/ADUMO.md`
sections 5 and 8; the staging proof this repeats is `docs/testing/adumo-staging-2026-09-29.md`.
No credential value appears in this file: credentials live in Vercel only.*

## 1. State before the run (2026-10-23 09:41 UTC)

- Production build `71a77f6`; `GET /api/internal/adumo-status`: `enabled false`, `configured false`,
  `primaryCardRail PAYFAST`, `sandbox false`, reporting base `https://apiv3.adumoonline.com`,
  no hosted-page or reporting credentials. Every card payment goes through PayFast.
- Merchant approved 2026-10-23 (merchant WAPAY, no 4741443, terminal 00424992, MCC 4814).
- Code changes before the run (this commit): the pay page offers Adumo only when it is the
  primary rail, so enabling Adumo with `WAPAY_PRIMARY_CARD_RAIL=PAYFAST` changes nothing a
  payer sees; Adumo's receiver fee defaults to PayFast's (R2.30 + 4.20%, one price on every
  rail, founder 2026-10-23).

## 2. Run sheet

**A. Portal (founder).** The Lesaka Client Portal pages in `docs/ADUMO.md` section 8: read
the three hosted-page values, create the reporting client (status, details and list only),
set the webhook URL, every payment notification Off, the hosted page in WaPay green with the
W-mark.

**B. Vercel (founder), one Redeploy.** Production envs for `wapay-api`:

| Name | Value |
|---|---|
| `ADUMO_MERCHANT_ID` | Merchant UID from the portal |
| `ADUMO_APPLICATION_ID` | Application UID from the portal |
| `ADUMO_JWT_SECRET` | JWT secret from the portal |
| `ADUMO_CLIENT_ID` | the reporting client's id |
| `ADUMO_CLIENT_SECRET` | the reporting client's secret |
| `WAPAY_ADUMO_ENABLED` | `true` |
| `WAPAY_PRIMARY_CARD_RAIL` | `PAYFAST` |
| `ADUMO_SANDBOX` | absent (or `false`) |
| `WAPAY_ADUMO_FEE_BPS`, `WAPAY_ADUMO_FEE_FIXED_CENTS` | absent: the code default is already the PayFast price |

Then Deployments → the latest Ready production deployment → Redeploy.

**C. Verify (thread).** `GET /api/internal/adumo-status` must show `enabled true`,
`configured true`, `primaryCardRail PAYFAST`, `sandbox false`, `reporting.tokenOk true`. A
pay link's page must still show only the PayFast button.

**D. One R5 per enabled method (founder, in a browser).** Create five R5 pay links (chat or
https://app.wapay.co.za → Get paid; R5 is under R50, so no fee). For each, open
`https://pleasepayme.co.za/api/pay/checkout?code=<CODE>&rail=adumo` and pay on Adumo's page
with the method in the table. Note the time. The browser should land on the pay page showing
paid. Optional sixth: one R60 debit card to see a fee booked on the Adumo rail (R4.90 fee,
R55.10 credited).

**E. Reconcile each (thread).** `node --env-file=.env scripts/adumo-live-check.mjs <CODE> …`
(read-only) compares the payment request, the intent (`adumoOutcome`: method, class, masked
card, 3-D Secure, bank code), the `LOAD_ADUMO` journal entry (`CLEARING:ADUMO` = gross,
wallet = credit, fee line) and Adumo's `getState` through the production probe. The founder
reads the same transaction in the Adumo portal (status, amount, method, reference
`<CODE>-1`).

**F. Next business day.** Re-run E: every test must read `SETTLED` (auto-settlement ON). A
test still `AUTHORISED` after Adumo's batch means auto-settlement is off: stop and ask Adumo.

**G. T+2.** The settlement to the Capitec business account: gross minus fees per
transaction. The fee taken per method is the rate actually charged (EMAIL_TO_SHB_12 item 1).

**Switch criteria (the founder decides):** every method PASS in E and SETTLED in F; the
settlement in G matches the expected costs; SHB's written acceptance of Please Pay Me
(EMAIL_TO_SHB_12 item 3) before any customer pay link goes to Adumo. The switch is
`WAPAY_PRIMARY_CARD_RAIL=ADUMO` (or unset) + Redeploy; the rollback is `PAYFAST` + Redeploy.

## 3. Results

| # | Method | Code | Paid at (UTC) | Page | Our books (E) | getState (E) | Portal | Next day (F) | Settled (G) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Debit card | | | | | | | | |
| 2 | Credit card | | | | | | | | |
| 3 | Apple Pay or Google Pay | | | | | | | | |
| 4 | Ozow Instant EFT | | | | | | | | |
| 5 | Capitec Pay | | | | | | | | |
| 6 | Optional: R60 debit (fee) | | | | | | | | |

Methods that must NOT appear on Adumo's page (EMAIL_TO_SHB_12 item 4b): American Express,
Zapper, Mobicred, OTT. Seen on the page: _to fill_.

## 4. Findings

_None yet._
