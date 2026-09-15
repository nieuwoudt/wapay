# Payouts: getting money OUT of WaPay

*Written 2026-09-11, the day OTT issued the payout test credentials. The rail (docs/OTT_PAYOUT_API.md), the service (`lib/payouts.js`), the business dashboard (Payouts tab) and the in-chat withdraw flow (`lib/payout-chat.js`) are built and unit-tested; the sandbox run and the compliance sign-off are the two gates before the switch (`WAPAY_PAYOUT_ENABLED=true`).*

## 1. What it enables

WaPay balances stop being spend-only. A customer or a business can move money from their WaPay balance to real money, three ways, all on OTT's payout rail:

| Method | What the customer gets | Speed | Customer fee (flat, locked model) | Needs |
|---|---|---|---|---|
| **PayShap** | money in their own bank account, instant | minutes, 24/7 | R8 | account number + bank (universal branch code); OTT processes PayShap on account details, not a ShapID (OTT, 2026-09-14) |
| **Bank transfer (RTC)** | money in a bank account by account number | usually within the hour | R10 | account number + bank (universal branch code) |
| **Cash at an ATM (CashSend)** | cash from an Absa ATM or a Pick n Pay / Boxer till (ABSA CashSend), no bank account needed | minutes | R18 up to R700, R23 to R1,500, R30 above | a cellphone number to receive the collection code by SMS |

Limits: R20 to R3,000 per pay-out (`WAPAY_PAYOUT_MIN_CENTS` / `WAPAY_PAYOUT_MAX_CENTS`). Identity check (Didit KYC) once, before the first pay-out. Recipient is the customer themselves: the verified KYC name goes to the bank rail, never a typed name. What OTT charges us (ex VAT): PayShap R2.50, RTC R4.50, CashSend R9.96 + 0.3%; after VAT that is R2.88 / R5.18 / R11.45 + 0.35%, so the margin per pay-out is about R5.12 (PayShap), R4.82 (RTC) and R4 to R8 (CashSend). Fees carry the founder's +R2 of 2026-09-11 over the 2026-08-10 numbers (`lib/ledger-core.js`, locked by tests).

## 2. How it works for a WaPay customer on WhatsApp

1. They say **"withdraw R200"** (or "cash out", "payshap", "money to my bank"). Not verified yet → *"Withdrawals need a once-off identity check. Reply VERIFY"* → the Didit link arrives; once approved, "withdraw" again.
2. **How:** 1 PayShap · 2 bank transfer · 3 cash at an ATM, with the fee on each line and their available balance.
3. **How much:** R20 to R3,000, checked against balance + fee.
4. **Where:** PayShap and bank transfer ask for the account number and the bank (name or universal branch code); ATM cash asks for the cellphone number ("mine" = this WhatsApp number). For PayShap the customer's own WhatsApp number is attached for the SMS notification.
5. **Confirm:** amount, destination, fee, total leaving the balance → YES.
6. **PIN.** Then the one money call: SPEND → CASH upgrade, hold, OTT PerformPayout, settle (or keep the hold on PENDING, release on failure). Reply: *Done* (instant), *Sent* (pending; the webhook message follows when the bank confirms), or an honest failure with nothing charged.
7. A mid-flow "buy airtime" parks the withdrawal like every other flow; "cancel" stops it.

While the switch is off the menu says "Withdraw: coming soon" and the AI keeps the honest script; the moment it is on, the menu, the script and the AI's product truth all flip.

## 3. How it works for a business on the portal

The **Payouts** tab shows the balance (SPEND plus any cleared CASH), the three methods with their fees, a form for the amount and the recipient details the method needs, a live quote (fee, total leaving the balance), and a fresh factor on every request (portal password, or a one-time code from `business login`). Every request carries its own intent id, so a double click can never pay twice. History lists every pay-out with a masked recipient and its status; PENDING rows resolve from the OTT webhook. The owner's WhatsApp gets the outcome too.

## 4. Switching it on

1. OTT test portal (done 2026-09-11): API key generated; **webhook URL** `https://pleasepayme.co.za/api/webhooks/ott-payout` (leave the secondary webhook empty); proof-of-payment logo uploaded.
2. Vercel env: `OTT_PAYOUT_BASE_URL=https://test-payoutapi.ott-mobile.com` (test) → `https://payoutapi.ott-mobile.com` (live), `OTT_PAYOUT_USERNAME`, `OTT_PAYOUT_PASSWORD`, `OTT_PAYOUT_API_KEY`.
3. Sandbox run on an isolated schema (never production balances): GetBalance → GetActiveProviders/Limits (settles the provider codes and the recipient fields per method) → one PayShap, one RTC, one CashSend test pay-out → webhook round trip. Any status-2 (invalid hash) answer means the amount/empty-field formatting needs the alternative described in docs/OTT_PAYOUT_API.md §6.
4. Compliance: counsel's sign-off on cash-out (this ends the no-cash-out posture: docs and memory), and KYC on for withdrawals (`WAPAY_PAYOUT_KYC` unset).
5. `WAPAY_PAYOUT_ENABLED=true`, redeploy. Rotate the API key that was shared in chat before the production key is issued.

## 5. Files

`lib/payouts.js` (service), `lib/payout-chat.js` (WhatsApp flow), `lib/ott-payout.js` (client), `pages/api/business/payout.js`, `pages/api/webhooks/ott-payout.js`, the Payouts tab in `pages/business/index.js`, states `PAYOUT_*` in `pages/api/webhooks/message-processor-v2.js`. Tests: `tests/payouts.test.mjs`, `tests/payout-chat.test.mjs`, `tests/ott-payout.test.mjs`.

## Status 2026-09-11 (production probe)

`GET /api/internal/payout-status` (header `x-internal-api-key`) is the operator's
read-only view of the rail: switches, masked credential presence, and OTT's
GetBalance / GetActiveProviders / GetActiveProvidersLimits responses. It cannot
start a pay-out. First production run: `payoutEnabled: true`, `payoutConfigured:
true`, `kycRequired: true`, `diditConfigured: false`; OTT TEST account balance
R0.00, providers `[]`, requiredFields `[]`. Consequences: the WhatsApp and portal
flows run up to the confirmation step and then answer "that pay-out method is not
available right now" (`NO_PROVIDER`, no ledger movement) until OTT enables the
providers on the test account and loads a test float. Ask OTT for: providers
PayShap + RTC + CashSend active on the TEST account, a test float (R500 is
plenty), and confirmation that the webhook URL above is registered.
