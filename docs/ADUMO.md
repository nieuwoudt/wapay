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
| Our merchant | ✅ **approved 2026-10-23**: merchant WAPAY, merchant no 4741443, terminal 00424992, e-commerce "ADUMO ONLINE 246", MCC 4814, American Express merchant no on file (section 8). These are acquiring identifiers; the API credentials come from the Lesaka Client Portal (section 8) and go into Vercel only, never into chat, a commit or a doc |
| The model question | ⚠️ open: the signed form declares no third-party processing and MCC 4814 is telecoms, while Please Pay Me collects for WaPay users. Written acceptance (EMAIL_TO_SHB_12 item 3) is required before any customer pay-link traffic on Adumo. The founder's own R5 tests are WaPay paying WaPay and do not need it |
| Live switch | Two steps, both env changes plus a Redeploy. **Test:** `WAPAY_ADUMO_ENABLED=true`, the three `ADUMO_*` hosted-page values, `ADUMO_CLIENT_ID` + `ADUMO_CLIENT_SECRET`, `WAPAY_PRIMARY_CARD_RAIL=PAYFAST`, no `ADUMO_SANDBOX`: payers still see PayFast only (the pay page offers Adumo only when it is the primary rail, 2026-10-23) and a test reaches Adumo through `/api/pay/checkout?code=<CODE>&rail=adumo`. **Switch (founder's decision):** `WAPAY_PRIMARY_CARD_RAIL=ADUMO` (or unset) + Redeploy |

Nothing changes for anyone until the switch is on: with it off the pay page and checkout behave exactly as before (PayFast only).

## 2. How it works

1. Once Adumo is the primary rail, the pay page shows **Pay by card, Instant EFT or Capitec Pay** (Adumo) and **Other ways to pay (PayFast)**; before that it shows PayFast only, even with Adumo enabled. Both post to `/api/pay/checkout` with `rail=adumo|payfast` (a submit button's own name/value; the payer's number still travels in the POST body, never a query string).
2. Checkout books ONE intent per request as before (`idemKey wapay-payreq-<code>`), records the chosen rail and **that rail's fee** (`paymentRequestFeeCents(amount, rail)`), and, for Adumo, answers with a self-submitting form (a button without JavaScript) to `…/product/payment/v1/initialisevirtual` carrying `MerchantID`, `ApplicationID`, `MerchantReference` (`<code>-<attempt>`, a fresh one per try), `Amount`, redirect URLs and a **JWT** (HS256 over our secret; claims `cuid`, `auid`, `mref`, `amount`, `iat`, `exp` 15 min).
3. Adumo hosts the card / Instant EFT / Capitec Pay / Apple Pay / Google Pay step and 3-D Secure, then sends the browser to `/api/pay/adumo-return` with `_RESPONSE_TOKEN`.
4. The return route trusts **only** that token: signature, `cuid`, `auid`, `mref` and the GROSS amount from our intent must match and the `result` claim must say success. Approved → `settleCardPayment` (the PayFast ITN's sequence: `ensureWallet` → `postEntry(buildLoad, idemKey)` → `markDeposit` → `markRequestPaid` → notifications), then `/pay/<code>?r=1`. Declined / cancelled → `/pay/<code>?e=<status>` and the page says so; nothing credited. Unverifiable → the raw fields are stored for forensics and the page comes back plain.
5. The webhook does the same for asynchronous methods; both are idempotent through the intent's idemKey, so a webhook after a return credits nothing twice.

## 3. Money

- The PAYER pays exactly the request amount on every rail (no surcharging, `docs/PAYFAST_FEES.md` note). The RECEIVER pays the **same fee on every rail: R2.30 + 4.20%**, rounded up to 10c, free under R50 with the taper (founder ruling 2026-10-23, at go-live). `cardRailFee('ADUMO')` defaults to the PayFast fee, so one price holds without any Vercel value; `WAPAY_ADUMO_FEE_BPS` / `WAPAY_ADUMO_FEE_FIXED_CENTS` still override it and should stay unset. One price for every method is not a surcharge; a higher price for card would be (memory no-card-surcharging-sa). The R1 + 2.5% default of 2026-09-10 is retired.
- True cost incl. the VAT we cannot recover (WaPay is not VAT-registered): debit R0.92 + 1.6675% (SHB 1.35% + gateway R0.80 + 0.10%), credit R0.92 + 2.8175%, international R0.92 + 3.335%, Ozow R1.38 + 1.725%, Capitec Pay R1.38 + 2.30%. PayFast for comparison: credit R2.30 + 3.68%, debit R2.30 + 4.025%, Instant EFT 2.30%.
- What WaPay keeps more on Adumo at the same price (debit / credit / Instant EFT): R100 +R3.74 / +R2.24 / −R0.81; R500 +R13.17 / +R5.69 / +R1.50; R3,000 +R72.11 / +R27.25 / +R15.87. On the last 30 days of production card payments (101 payments, R65,696: 90 pay links averaging R720, 11 deposits) card margin goes from about R388 to about R1,564 on a 55/30/15 debit/credit/EFT blend (+R1,176, about 4x); the range is +R706 (all credit) to +R1,688 (all debit). Every enabled method is margin-positive from R60 up (`tests/adumo.test.mjs`). Per-row margins at the reference amounts: the Money Map (`docs/COMMERCIALS.md`, rows `in.adumo.*`).
- PayFast's Instant EFT is cheaper than Ozow below about R240. Option for the founder: Instant EFT through PayFast and cards through Adumo on the pay page.
- Amex, Zapper, Mobicred and OTT lose money at this price (application rows: Zapper R1.20 + 2.95%, OTT R1.20 + 6.00%, Mobicred R1.20 + 3.50%, Amex not quoted): enabled methods are Visa, Mastercard, Apple Pay, Google Pay, Ozow and Capitec Pay only (EMAIL_TO_SHB_12 item 4b).
- **Status of the numbers:** the SHB MSC (2.35% credit / 1.35% debit / 2.80% international) exists only in SHB's e-mail of 2026-09-10; the signed application carries only Adumo's gateway fees. The Money Map keeps `in.adumo.*` costs PROPOSED until SHB confirms in writing; then SIGNED with the document as the source, and the commercials consistency test re-run. The first settlement statement (T+2 to the Capitec business account) also shows the rates actually charged.
- The intent records `feeCents` for the rail that actually settles, so dashboards, receipts and reconciliation read the booked truth. A payer who switches rails before paying re-books the intent to the new rail (with one price, the fee is the same).
- Ledger: `RAIL.ADUMO` with the PayFast load shape (face credited, fee booked as `REVENUE:FEE:DEPOSIT`, gross in `CLEARING:ADUMO`), journal type `LOAD_ADUMO`.

## 4. Sandbox facts (public, from Adumo's docs)

Staging `https://staging-apiv3.adumoonline.com`; test MerchantID `9BA5008C-08EE-4286-A349-54AF91A621B0`; ApplicationIDs `23ADADC0-…` (3DS) and `904A34AF-…` (no 3DS); JWT secret `yglTxLCSMm7PEsfaMszAKf2LSRvM2qVW`; cards 4111 1111 1111 1111 (approved), 4242 4242 4242 4242 (declined), 4000 0000 0000 1091 (3DS approved), OTP `1234`. Our JWT with a numeric `amount` (38) was accepted. The staging test merchant lists card + Apple Pay + Google Pay only; Instant EFT / Capitec Pay appear once enabled on the live merchant.

To repeat the run: create a scratch schema (`?schema=wapay_qa_adumo_…`, `prisma db push`), seed a request, start `next dev` with the sandbox envs and `APP_BASE_URL=http://localhost:3010`, pay on the hosted page. The 3-D Secure challenge iframe does not accept the in-app browser's synthetic input; use the non-3DS application for automated runs and a real browser for 3DS.

## 5. Going live (2026-10-23 on)

Done: the integration (sections 2, 6), the approval (section 8), our signed application, the code in production since de305c4, the pay-page gate and the one-price default (2026-10-23).

1. **Portal (founder):** the Lesaka Client Portal pages in section 8. API credentials into Vercel only.
2. **Vercel (founder), one Redeploy:** `ADUMO_MERCHANT_ID`, `ADUMO_APPLICATION_ID`, `ADUMO_JWT_SECRET`, `ADUMO_CLIENT_ID`, `ADUMO_CLIENT_SECRET`, `WAPAY_ADUMO_ENABLED=true`, `WAPAY_PRIMARY_CARD_RAIL=PAYFAST`. `ADUMO_SANDBOX` must be absent (or `false`). `ADUMO_ENTERPRISE_BASE_URL` only if Adumo names a production host other than `https://apiv3.adumoonline.com`. No `WAPAY_ADUMO_FEE_*`. Then Redeploy the latest Ready deployment (a function sees only the envs of its own deployment).
3. **Verify:** `GET /api/internal/adumo-status` (internal key) answers `switches.enabled true`, `configured true`, `primaryCardRail PAYFAST`, `sandbox false`, `reporting.tokenOk true`, `reporting.base https://apiv3.adumoonline.com`. A pay link's page still shows the PayFast button only.
4. **Live R5 per enabled method** (debit card, credit card, Apple Pay or Google Pay, Ozow, Capitec Pay; one fresh R5 link each), through `https://pleasepayme.co.za/api/pay/checkout?code=<CODE>&rail=adumo` in a browser. Reconcile each against the Adumo portal, `getState` (`/api/internal/adumo-status?mref=<CODE>-1`), the intent (`adumoOutcome`) and the journal (`LOAD_ADUMO`, `CLEARING:ADUMO` = gross). Next business day: `getState` must read SETTLED (auto-settlement ON, EMAIL_TO_SHB_12 item 4c); still AUTHORISED after the batch = stop. At T+2: the settlement to the Capitec business account per transaction (the rates actually charged). Record: `docs/testing/adumo-production-2026-10-23.md`.
5. **Before customer traffic:** SHB's written acceptance of Please Pay Me (item 3) and the MSC in writing (item 1). Without item 3, no customer pay link goes to Adumo.
6. **The switch (founder):** `WAPAY_PRIMARY_CARD_RAIL=ADUMO` (or unset) + Redeploy. PayFast stays as "Other ways to pay" on the pay page and as the rail for wallet top-ups (hard-wired to PayFast in `handleCardDepositLink`, 11 of 101 card payments in the last 30 days; moving them is separate work). Rollback: `WAPAY_PRIMARY_CARD_RAIL=PAYFAST` + Redeploy.

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

## 8. Production (approved 2026-10-23)

**Acquiring identifiers (from the founder, 2026-10-23; not API credentials):** merchant name WAPAY; merchant no 4741443; terminal 00424992; e-commerce "ADUMO ONLINE 246"; MCC 4814; an American Express merchant number is on file with the founder (Amex stays off). Acquirer Nedbank via SHB Financial Services (Lesaka group); settlement T+2 to the Capitec business account.

**Lesaka Client Portal, what to set (founder):**

| Page | Setting |
|---|---|
| E-commerce → JWT and API Authentication | read the Merchant UID, Application UID and JWT secret (GUID shapes, as on staging) → Vercel `ADUMO_MERCHANT_ID`, `ADUMO_APPLICATION_ID`, `ADUMO_JWT_SECRET` |
| E-commerce → Create Client Credentials | a client for the reporting API; validity 3600 s (the client caches the token); tick ONLY "Get the status of a transaction", "View details of a transaction", "Retrieve a list of transactions"; never refund, reverse, settle or card-on-file → Vercel `ADUMO_CLIENT_ID`, `ADUMO_CLIENT_SECRET` |
| E-commerce → Webhooks | `https://pleasepayme.co.za/api/webhooks/adumo` (every checkout also passes it as `notificationURL`) |
| Payment Notifications | every state Off (customers hear from WaPay on WhatsApp) |
| Configure Hosted Payment Page | header and button colour `#359853`; Company Name Label "WaPay"; logo the Lovable W-mark PNG, 250 KB or less: `public/brand/wapay-mark-256.png` (green, 42 KB) where the logo sits on white, `marketing/brand/wapay-mark-256-white.png` (white, 16 KB) if the preview puts it on the green header (never the rejected bubble kit); Allow Budget off; default template |

**Open with SHB/Adumo (EMAIL_TO_SHB_12):** (a) the MSC in writing, Amex included; (b) chargeback and refund fees and any reserve; (c) written acceptance of Please Pay Me under the facility (the form declares no third-party processing; MCC 4814 is telecoms); (d) auto-settlement ON for the application; (e) only Visa, Mastercard, Apple Pay, Google Pay, Ozow and Capitec Pay enabled. Which of these the approval already answers is for the founder to confirm from its text; (d) and (e) are also visible in the portal and in the R5 run (a method that should be off appears on the hosted page; a test stays AUTHORISED after the batch).

