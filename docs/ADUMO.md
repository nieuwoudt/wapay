# Adumo Online (Nedbank via SHB) — the second card rail

*Built and sandbox-proven 2026-09-10 after SHB Financial Services' offer (credit 2.35%, debit 1.35%, foreign 2.80%, plus Adumo Online gateway R0.80 + 0.10%, all ex VAT; no monthly or set-up fee; settlement T+1 with Nedbank, T+2 elsewhere). Code: `lib/adumo.js`, `lib/card-settlement.js`, `pages/api/pay/checkout.js` (rail choice), `pages/api/pay/adumo-return.js`, `pages/api/webhooks/adumo.js`, `pages/pay/[code].js` (buttons). Tests: `tests/adumo.test.mjs`. Docs used: developers.adumoonline.com (Virtual + Enterprise guides).*

## 1. Status

| Piece | State |
|---|---|
| Hosted-page ("Virtual") integration: signed request, redirect, signed response, settlement | ✅ built, **proven on Adumo's staging** with the published test merchant: a R38 request was paid with test card 4111… (non-3DS application), the browser returned a signed token, the request went PAID and the ledger posted `LOAD_ADUMO`; a declined 3DS attempt came back as `TDS_AUTH_REQUIRED` and showed the "did not go through" notice with nothing credited |
| Webhook for asynchronous methods (Instant EFT / Capitec Pay) | ✅ built (`/api/webhooks/adumo`), same verification and idempotent settlement; **enable with support@adumoonline.com** once we have a live application |
| Our merchant credentials | ⛔ waiting on the SHB / Adumo onboarding (MerchantID, ApplicationID, JWT secret) |
| The model question | ⛔ the merchant application form's declaration ("not to process transactions on behalf of any third party") describes WaPay's collect-on-behalf model exactly; written confirmation that Nedbank/Adumo accept it (payment facilitator / TPPP with Nedbank as sponsor) is required before going live |
| Live switch | `WAPAY_ADUMO_ENABLED=true` + the three `ADUMO_*` envs (+ `ADUMO_SANDBOX=true` for staging) |

Nothing changes for anyone until the switch is on: with it off the pay page and checkout behave exactly as before (PayFast only).

## 2. How it works

1. The pay page shows **Pay by card, Instant EFT or Capitec Pay** (Adumo) and **Other ways to pay (PayFast)**. Both post to `/api/pay/checkout` with `rail=adumo|payfast` (a submit button's own name/value; the payer's number still travels in the POST body, never a query string).
2. Checkout books ONE intent per request as before (`idemKey wapay-payreq-<code>`), records the chosen rail and **that rail's fee** (`paymentRequestFeeCents(amount, rail)`), and, for Adumo, answers with a self-submitting form (a button without JavaScript) to `…/product/payment/v1/initialisevirtual` carrying `MerchantID`, `ApplicationID`, `MerchantReference` (`<code>-<attempt>`, a fresh one per try), `Amount`, redirect URLs and a **JWT** (HS256 over our secret; claims `cuid`, `auid`, `mref`, `amount`, `iat`, `exp` 15 min).
3. Adumo hosts the card / Instant EFT / Capitec Pay / Apple Pay / Google Pay step and 3-D Secure, then sends the browser to `/api/pay/adumo-return` with `_RESPONSE_TOKEN`.
4. The return route trusts **only** that token: signature, `cuid`, `auid`, `mref` and the GROSS amount from our intent must match and the `result` claim must say success. Approved → `settleCardPayment` (the PayFast ITN's sequence: `ensureWallet` → `postEntry(buildLoad, idemKey)` → `markDeposit` → `markRequestPaid` → notifications), then `/pay/<code>?r=1`. Declined / cancelled → `/pay/<code>?e=<status>` and the page says so; nothing credited. Unverifiable → the raw fields are stored for forensics and the page comes back plain.
5. The webhook does the same for asynchronous methods; both are idempotent through the intent's idemKey, so a webhook after a return credits nothing twice.

## 3. Money

- The PAYER pays exactly the request amount on every rail (no surcharging, `docs/PAYFAST_FEES.md` note). The RECEIVER's fee is per rail, quoted before creation from the primary rail: PayFast R2.30 + 4.20% (unchanged), Adumo **R1 + 2.8% by default** (`WAPAY_ADUMO_FEE_BPS`, `WAPAY_ADUMO_FEE_FIXED_CENTS`), both rounded up to 10c, both free under R50 with the same taper.
- True Adumo cost incl. the VAT we cannot recover: debit R0.92 + 1.67%, credit R0.92 + 2.82%. Margin at R1 + 2.8%: about 0.7% blended (60/40 debit/credit), strong on debit, break-even on credit; the R1 covers the R0.80 + VAT gateway fee. Against iKhokha (2.85% ex VAT online) and Yoco (≈2.8% ex VAT online) we are level on a R100 ticket and cheaper above ≈R200; against PayFast always; against FNB eWallet (sender pays R10–R30) at every amount. The founder sets the final numbers before enabling the rail.
- The intent records `feeCents` for the rail that actually settles, so dashboards, receipts and reconciliation read the booked truth. A payer who switches rails before paying re-books the intent to the new rail.
- Ledger: `RAIL.ADUMO` with the PayFast load shape (face credited, fee booked as `REVENUE:FEE:DEPOSIT`, gross in `CLEARING:ADUMO`).

## 4. Sandbox facts (public, from Adumo's docs)

Staging `https://staging-apiv3.adumoonline.com`; test MerchantID `9BA5008C-08EE-4286-A349-54AF91A621B0`; ApplicationIDs `23ADADC0-…` (3DS) and `904A34AF-…` (no 3DS); JWT secret `yglTxLCSMm7PEsfaMszAKf2LSRvM2qVW`; cards 4111 1111 1111 1111 (approved), 4242 4242 4242 4242 (declined), 4000 0000 0000 1091 (3DS approved), OTP `1234`. Our JWT with a numeric `amount` (38) was accepted. The staging test merchant lists card + Apple Pay + Google Pay only; Instant EFT / Capitec Pay appear once enabled on the live merchant.

To repeat the run: create a scratch schema (`?schema=wapay_qa_adumo_…`, `prisma db push`), seed a request, start `next dev` with the sandbox envs and `APP_BASE_URL=http://localhost:3010`, pay on the hosted page. The 3-D Secure challenge iframe does not accept the in-app browser's synthetic input; use the non-3DS application for automated runs and a real browser for 3DS.

## 5. Before going live

1. Written answer from SHB/Nedbank on the third-party-processing declaration (facilitator / TPPP, Nedbank as sponsor). Without it, do not enable.
2. Our own MerchantID / ApplicationID / JWT secret from Adumo; webhook enablement (support@adumoonline.com) pointing at `https://pleasepayme.co.za/api/webhooks/adumo`.
3. One real R5 payment on the live merchant per method, reconciled against the Adumo console and our journal.
4. Decide the receiver fee (§3) and set the two env values; then `WAPAY_ADUMO_ENABLED=true` and redeploy. PayFast stays on for everything Adumo does not carry.
