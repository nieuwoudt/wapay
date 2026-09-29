# Adumo Online (Nedbank via SHB) — the second card rail

*Built and sandbox-proven 2026-09-10 after SHB Financial Services' offer (credit 2.35%, debit 1.35%, foreign 2.80%, plus Adumo Online gateway R0.80 + 0.10%, all ex VAT; no monthly or set-up fee; settlement T+1 with Nedbank, T+2 elsewhere). Code: `lib/adumo.js`, `lib/card-settlement.js`, `pages/api/pay/checkout.js` (rail choice), `pages/api/pay/adumo-return.js`, `pages/api/webhooks/adumo.js`, `pages/pay/[code].js` (buttons). Tests: `tests/adumo.test.mjs`. Docs used: developers.adumoonline.com (Virtual + Enterprise guides).*

## 1. Status

| Piece | State |
|---|---|
| Hosted-page ("Virtual") integration: signed request, redirect, signed response, settlement | ✅ built, **proven on Adumo's staging** with the published test merchant: a R38 request was paid with test card 4111… (non-3DS application), the browser returned a signed token, the request went PAID and the ledger posted `LOAD_ADUMO`; a declined 3DS attempt came back as `TDS_AUTH_REQUIRED` and showed the "did not go through" notice with nothing credited |
| Webhook for asynchronous methods (Instant EFT / Capitec Pay) | ✅ built (`/api/webhooks/adumo`), same verification and idempotent settlement; since 2026-09-29 every checkout also carries `notificationURL` in its signed claims (a per-transaction webhook, virtual.php), so the portal-level enablement with support@adumoonline.com is belt and braces |
| Outcome on the intent (2026-09-29) | ✅ the return route and the webhook store `adumoOutcome` (method and its class, masked PAN `411111******1111`, card country, bank error code and message, 3-D Secure status, `puid`) on the intent whether or not it paid: the fee truth per method (debit vs credit vs EFT) and every decline reason live on the row, never in a log line |
| Direct method flows (2026-09-29) | ✅ `flow` (CARD, EFT_OZOW, CLICK_TO_PAY, OTT_VOUCHER, …) accepted by the checkout from an allowlist and passed to the hosted page; empty = Adumo's options page. Not yet surfaced as separate buttons on the pay page |
| Enterprise reporting + reconcile (2026-09-29) | ✅ `lib/adumo-reporting.js`: OAuth client credentials, `getState` by transaction id or by our merchant reference; `reconcileAdumoIntents` credits a PENDING pay-link intent once when Adumo reports AUTHORISED or SETTLED for the same gross; `GET /api/internal/adumo-status[?mref=\|?tx=]` (internal key) and `GET /api/cron/adumo-reconcile` (cron header / `CRON_SECRET` / internal key). **Proven live on staging** against a real hosted-page payment (section 6) |
| Our merchant credentials | ⛔ waiting on the SHB / Adumo onboarding (MerchantID, ApplicationID, JWT secret) |
| The model question | ⛔ the merchant application form's declaration ("not to process transactions on behalf of any third party") describes WaPay's collect-on-behalf model exactly; written confirmation that Nedbank/Adumo accept it (payment facilitator / TPPP with Nedbank as sponsor) is required before going live |
| Live switch | `WAPAY_ADUMO_ENABLED=true` + the three `ADUMO_*` envs (+ `ADUMO_SANDBOX=true` for staging); reporting needs `ADUMO_CLIENT_ID` + `ADUMO_CLIENT_SECRET` (merchant portal; the staging pair is published on enterprise.php) |

Nothing changes for anyone until the switch is on: with it off the pay page and checkout behave exactly as before (PayFast only).

## 2. How it works

1. The pay page shows **Pay by card, Instant EFT or Capitec Pay** (Adumo) and **Other ways to pay (PayFast)**. Both post to `/api/pay/checkout` with `rail=adumo|payfast` (a submit button's own name/value; the payer's number still travels in the POST body, never a query string).
2. Checkout books ONE intent per request as before (`idemKey wapay-payreq-<code>`), records the chosen rail and **that rail's fee** (`paymentRequestFeeCents(amount, rail)`), and, for Adumo, answers with a self-submitting form (a button without JavaScript) to `…/product/payment/v1/initialisevirtual` carrying `MerchantID`, `ApplicationID`, `MerchantReference` (`<code>-<attempt>`, a fresh one per try), `Amount`, redirect URLs and a **JWT** (HS256 over our secret; claims `cuid`, `auid`, `mref`, `amount`, `iat`, `exp` 15 min).
3. Adumo hosts the card / Instant EFT / Capitec Pay / Apple Pay / Google Pay step and 3-D Secure, then sends the browser to `/api/pay/adumo-return` with `_RESPONSE_TOKEN`.
4. The return route trusts **only** that token: signature, `cuid`, `auid`, `mref` and the GROSS amount from our intent must match and the `result` claim must say success. Approved → `settleCardPayment` (the PayFast ITN's sequence: `ensureWallet` → `postEntry(buildLoad, idemKey)` → `markDeposit` → `markRequestPaid` → notifications), then `/pay/<code>?r=1`. Declined / cancelled → `/pay/<code>?e=<status>` and the page says so; nothing credited. Unverifiable → the raw fields are stored for forensics and the page comes back plain.
5. The webhook does the same for asynchronous methods; both are idempotent through the intent's idemKey, so a webhook after a return credits nothing twice.

## 3. Money

- The PAYER pays exactly the request amount on every rail (no surcharging, `docs/PAYFAST_FEES.md` note). The RECEIVER's fee is per rail, quoted before creation from the primary rail: PayFast R2.30 + 4.20% (unchanged), Adumo **R1 + 2.5% by default** (founder 2026-09-10, "more competitive than iKhokha, Yoco and PayFast"; `WAPAY_ADUMO_FEE_BPS`, `WAPAY_ADUMO_FEE_FIXED_CENTS`), both rounded up to 10c, both free under R50 with the same taper.
- True Adumo cost incl. the VAT we cannot recover: debit R0.92 + 1.67%, credit R0.92 + 2.82%. At R1 + 2.5%: about 0.45% blended margin (60/40 debit/credit), healthy on debit and Instant EFT, a bounded small loss on a pure credit-card ticket (−R0.24 at R100, −R9.44 at R3000). This is the floor for a single blended fee. Headline 2.5% is the lowest in the market (iKhokha 2.85%, Yoco ≈2.8%, PayFast 3.2% + R2, all ex VAT, and we add no VAT); in real terms we are cheaper than iKhokha above ≈R130, cheaper than PayFast at every amount, and far cheaper than eWallet's R10–R30 sender fee. Revisit after three months of real debit/credit mix; the pay page lists Instant EFT and Capitec Pay first to steer volume onto the cheap rails.
- The intent records `feeCents` for the rail that actually settles, so dashboards, receipts and reconciliation read the booked truth. A payer who switches rails before paying re-books the intent to the new rail.
- Ledger: `RAIL.ADUMO` with the PayFast load shape (face credited, fee booked as `REVENUE:FEE:DEPOSIT`, gross in `CLEARING:ADUMO`).

## 4. Sandbox facts (public, from Adumo's docs)

Staging `https://staging-apiv3.adumoonline.com`; test MerchantID `9BA5008C-08EE-4286-A349-54AF91A621B0`; ApplicationIDs `23ADADC0-…` (3DS) and `904A34AF-…` (no 3DS); JWT secret `yglTxLCSMm7PEsfaMszAKf2LSRvM2qVW`; cards 4111 1111 1111 1111 (approved), 4242 4242 4242 4242 (declined), 4000 0000 0000 1091 (3DS approved), OTP `1234`. Our JWT with a numeric `amount` (38) was accepted. The staging test merchant lists card + Apple Pay + Google Pay only; Instant EFT / Capitec Pay appear once enabled on the live merchant.

To repeat the run: create a scratch schema (`?schema=wapay_qa_adumo_…`, `prisma db push`), seed a request, start `next dev` with the sandbox envs and `APP_BASE_URL=http://localhost:3010`, pay on the hosted page. The 3-D Secure challenge iframe does not accept the in-app browser's synthetic input; use the non-3DS application for automated runs and a real browser for 3DS.

## 5. Before going live

1. Written answer from SHB/Nedbank on the third-party-processing declaration (facilitator / TPPP, Nedbank as sponsor). Without it, do not enable.
2. Our own MerchantID / ApplicationID / JWT secret from Adumo; webhook enablement (support@adumoonline.com) pointing at `https://pleasepayme.co.za/api/webhooks/adumo`.
3. **Auto settlement ON for our live application** (Adumo onboarding option). The hosted page leaves an approved card AUTHORISED and Adumo captures it in its batch; we credit on the signed approval, so deferred settlement would mean money we credited that Adumo never captures unless we call Settle, which we never do.
4. Our OAuth client id + secret from the merchant portal into `ADUMO_CLIENT_ID` / `ADUMO_CLIENT_SECRET`, then `GET /api/internal/adumo-status` must show `reporting.tokenOk: true`.
5. One real R5 payment on the live merchant per method, reconciled against the Adumo console, `getState` and our journal.
6. Decide the receiver fee (§3) and set the two env values; then `WAPAY_ADUMO_ENABLED=true` and redeploy. PayFast stays on for everything Adumo does not carry.

## 6. Enterprise reporting and the staging proof (2026-09-29)

Sources read on 2026-09-29: the public Postman workspace "Adumo Online" (collections
*Enterprise (Rest API)* with folders Without/With Saving Card, Reporting, Tokenization; and
*Virtual (Hosted Payment Pages)*) and developers.adumoonline.com/enterprise.php + virtual.php.

| Call | Where | Auth |
|---|---|---|
| OAuth token | `POST {base}/oauth/token?grant_type=client_credentials&client_id=…&client_secret=…` → `{access_token, token_type: bearer, expires_in, scope: read}` | none |
| State by transaction id | `GET {base}/products/payments/v1/card/getState/{transactionId}` | Bearer |
| State by our reference | `GET {base}/products/payments/v1/card/getState?merchantReference=…&applicationUid=…` (or `&merchantUid=…`) | Bearer |
| Card lifecycle (Enterprise, we do not use it: PCI scope) | `…/card/initiate`, `/authorise`, `/settle`, `/reverse`, `/refund`; 3DS `…/product/authentication/v2/tds/authenticate/{id}`; tokens `…/product/security/tokenization/v1/{applicationUid}/profile/{puid}` | Bearer |

`{base}` = `https://staging-apiv3.adumoonline.com` (test) / `https://apiv3.adumoonline.com`
(the Postman links mention `staging-apiv2` for the swagger pages; the API calls documented on
enterprise.php are `apiv3`, and the client follows the document). `getState` answers a
well-formed 404 `{"errorCode":"404 NOT_FOUND","message":"Merchant reference not found."}` for
an unknown reference. States seen: `TDS_AUTH_NOT_REQUIRED`, `TDS_AUTH_REQUIRED`, `AUTHORISED`,
`SETTLED`, `REFUNDED`. Amounts are rand with two decimals (`amount`, `authorisedAmount`,
`settledAmount`, `refundedAmount`).

**Staging proof, 2026-09-29 (scratch schema, local dev server on port 3010, the published
test merchant with the non-3DS application):** pay link `PRBRJKGW`, R38 →
`/api/pay/checkout` (Adumo rail, JWT with `notificationURL`) → hosted page
`staging-gateway.adumoonline.com/virtual-v2/card/add` → card 4111 1111 1111 1111, 05/2028,
CVV 123, Joe Soap → Adumo returned the browser to `/api/pay/adumo-return` with the signed
token → `/pay/PRBRJKGW?r=1` **PAID**. On the intent: `status SUCCESS`, `providerRef
5825a3ef-a946-49e1-a066-e02cfd72d989` (Adumo's transaction id), `adumoOutcome { method CARD,
panMasked 411111******1111, cardCountry PL, threeDStatus 07, bankErrorCode 00 "Approved or
Completed Successfully", puid … }`; journal `LOAD_ADUMO`: `CLEARING:ADUMO` debit 3800,
wallet credit 3800. Reporting with the published test client credentials: `getState` by
merchant reference and by transaction id both return **`AUTHORISED`, amount 38, authorised
38, settled 0**: the hosted page's end state for an approved card is AUTHORISED; Adumo
captures in batch. The intent was then reset to PENDING to simulate a payer who never came
back and `GET /api/cron/adumo-reconcile?olderThanMinutes=0` reconciled it: `SETTLED`,
replayed, journal still one entry / 3800. `GET /api/internal/adumo-status?mref=PRBRJKGW-1`
reported `tokenOk: true` and the transaction.

## 7. Repeating the test cycle

`scripts/dev-adumo-staging.sh` starts `next dev -p 3010` on a scratch schema with the
published staging merchant, the non-3DS application and the published OAuth test client;
the workspace `.claude/launch.json` entry `adumo-staging` runs it (it reads the scratch
`DATABASE_URL` from `SCRATCH_URL_FILE`). Steps: create the schema (`prisma db push` with
`?schema=wapay_qa_adumo_<date>`), seed an account + `createPaymentRequest`, open
`/pay/<code>`, pay with a test card, then verify the intent, the journal, `getState`, the
probe and the cron; drop the schema afterwards. Never run `pnpm build` while the dev server
is up: they share `.next` and the running server breaks (seen 2026-09-29). The 3-D Secure
challenge does not accept the in-app browser's synthetic input; the non-3DS application is
the automated path. Record: `docs/testing/adumo-staging-2026-09-29.md`.

