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
Zapper, Mobicred, OTT. Seen on the page (2026-11-06, attempts PRAHSUHH-12 desktop and -13 phone): debit/credit card (Visa, Mastercard, Maestro), Apple Pay, Google Pay; none of the four, and no Ozow or Capitec Pay yet.

## 4. Findings

**2026-11-03 (the founder and the valuation thread).** The founder put the portal values into
Vercel (probe: `enabled`, `configured`, `primaryCardRail PAYFAST`, `sandbox false`,
`tokenOk true`) and made his own R5 link `PRAHSUHH` ("Yes test", valid to 10 Nov). Eleven
checkout attempts, several from the valuation thread's probe: `-2`, `-3`, `-5`, `-6` FAILED at
Adumo with "Security token cannot be validated" (the first paste of the JWT secret was wrong; the
gateway accepted from about 14:35 UTC after the re-paste); `-7` to `-11` loaded with the amount
and TIMED_OUT ("changes in the transaction state"), none reached card entry; `-1` and `-4` are
unknown to Adumo. The webhook for `-11` (15:11 UTC) arrived and verified, so the secret, the
per-transaction `notificationURL` and `/api/webhooks/adumo` work in production. Nothing was paid.
The live application was card only that day; the founder's decision: stay on PayFast until Adumo
enables the other methods.

**2026-11-06 13:10 UTC (this thread, build `9da2068`).** The founder switched the hosted page to
version 2 with card, Apple Pay and Google Pay. `PRAHSUHH-12` (desktop) and `-13` (phone, 375 px)
opened through `/api/pay/checkout?code=PRAHSUHH&rail=adumo`: the token validated, "Ref
PRAHSUHH-12", "ZAR 5.00", the green WaPay logo on a white header, company label "WaPay".
Screenshots: `docs/testing/adumo-2026-11-06/`. No card details were entered; both attempts will
time out unpaid.

- **Methods:** card, Apple Pay, Google Pay only (above). On a phone the card form fills the first
  screen and Apple Pay / Google Pay sit below it.
- **Pay Now colour:** the portal's colour (`#FFFFFF`) is applied to the page card behind the header,
  not to the card form's Pay Now button, which stays grey until the form is valid and then shows
  Adumo's own default, coral `#FF666E` with white text (read from the page's stylesheet and its
  `ngStyle` bindings; the binding that would carry the merchant colour is empty on this page).
  Readable, so no white-on-white; not WaPay green, and the portal does not appear to control it.
- **Contract (valuation thread, from the signed documents):** the agreement describes WaPay as an
  airtime-voucher business (clauses 3.1 and 3.3), the Nedlink form answers e-commerce "No", the Amex
  rate is blank and chargeback fees are unspecified. Pay links still need SHB's written OK before
  customer traffic.
