# Payouts: getting money OUT of WaPay

*Written 2026-09-11, the day OTT issued the payout test credentials. The rail (docs/OTT_PAYOUT_API.md), the service (`lib/payouts.js`), the business dashboard (Payouts tab) and the in-chat withdraw flow (`lib/payout-chat.js`) are built and unit-tested; the sandbox run and the compliance sign-off are the two gates before the switch (`WAPAY_PAYOUT_ENABLED=true`).*

## 1. What it enables

WaPay balances stop being spend-only. A customer or a business can move money from their WaPay balance to real money, three ways, all on OTT's payout rail:

| Method | What the customer gets | Speed | Customer fee (flat, locked model) | Needs |
|---|---|---|---|---|
| **PayShap** | money in their own bank account, instant | minutes, 24/7 | R8 | account number + bank (universal branch code); OTT processes PayShap on account details, not a ShapID (OTT, 2026-09-14) |
| **Bank transfer (RTC)** | money in a bank account by account number | usually within the hour | R10 | account number + bank (universal branch code) |
| **Cash at a Nedbank ATM** (NEDCASH, OTT code 4) | Nedbank cardless withdrawal, code by SMS, no bank account needed | minutes | R18 up to R700, R23 to R1,500, R30 above (Annexure A: R9.96 + 0.3%) | cellphone number + SA ID number |
| **FNB eWallet** (EWALLET, OTT code 1) | eWallet code by SMS, cash at any FNB ATM (collection free), no bank account needed | minutes | R18 up to R700, R23 to R1,500, R30 above: **ASSUMED** equal to CashSend until OTT prices FNB e-wallet (asked 2026-09-15) | cellphone number + SA ID number |
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

## Status 2026-09-15 (OTT sandbox live)

The founder activated the providers in the OTT test portal (Administration > Payout Providers > Add All) and OTT loaded the float. `GET /api/internal/payout-status` now shows balance 100000 and maps **PayShap Account (code 127)** and **ABSA CashSend (code 112)**; Nedbank Cardless Withdrawal (4) and FNB e-wallet (1) are also active on the merchant but unmapped (no method yet). OTT's `GetActiveProvidersLimits` marks `firstname`, `surname`, `id_number` and `mobile` Required for every provider and `account_Number` + `branch_Code` Required for PayShap; merchant limits are 0 in the API, so the portal's system minimums apply (R50 PayShap and ABSA CashSend, R10 Nedbank; `SYSTEM_LIMITS_CENTS`). PayShap on OTT is addressed by account number and branch code, not a ShapID. There is no RTC provider on the test merchant, so the chat offers PayShap and ATM cash only. Test script: "withdraw R50", PayShap, a real account number (staging moves no money), the bank, the 13-digit ID, YES, PIN.

## Status 2026-09-16 (first live WhatsApp pay-out; reconcile built)

The founder ran the full chat flow on 2026-09-15 at 21:52: "withdraw", 1 (PayShap), R50, FNB account, 13-digit ID, YES, PIN. The ledger side worked exactly as designed (SPEND → CASH upgrade, R58 hold, one PerformPayout, reference `WPC15800A7BD6637`) and the chat said *Sent*. OTT's sandbox answered with a status code outside our table, so the intent parked as `PENDING / outcome UNKNOWN` and, because the sandbox sends no webhook, nothing would ever have finalised it (BUGLOG #53). Built the same day:

- **Recorded truth.** A PENDING record keeps `providerStatus`, `httpStatus` and a masked 300-character `providerBody`; `outcome: UNKNOWN` sets `reconcileRequired`.
- **`reconcilePayout({ reference })`** asks `GetPaymentStatus` and applies only a KNOWN terminal answer through `finalisePayout`: 100 settles the hold and books the rail cost; a failure code releases the hold and moves the money back to SPEND. 98/99 and unknown codes stamp `lastProviderStatus` / `lastCheckedAt` and leave the hold; a transport failure changes nothing. Never a second PerformPayout.
- **`reconcilePendingPayouts({ olderThanMs, limit })`** sweeps PENDING rows oldest first.
- **`GET /api/internal/payout-reconcile`** (header `x-internal-api-key`): `?reference=WP…` for one pay-out, no reference for a sweep (`olderThanMinutes`, default 2; `limit`, default 20). POST does the same for a scheduler. A finalised customer is messaged with `payoutOutcomeMessage`, the one wording the webhook also uses.
- **The chat asks the rail.** "Did my payment go through?" now looks at the newest deposit and the newest pay-out, answers about the one the words point at ("to my FNB account" is a pay-out), and a PENDING pay-out is reconciled live before the reply; the held amount is explained as held, not lost (BUGLOG #54).
- **Pilot gate.** `WAPAY_PAYOUT_ALLOWLIST=27787051175,27726252243,27833092433,27827877781,353877863507` (the five registered test numbers, founder decision 2026-09-16) keeps withdrawal to testers while `WAPAY_PAYOUT_KYC=off`; unset = every customer who passes the other gates. Env changes take effect on redeploy only.
- **Still open:** no scheduler calls the sweep (Vercel Hobby crons run daily); until one exists the operator route or the customer's own question triggers reconciliation. Ask OTT which status code the sandbox returns for a PayShap payout so the table can name it.
- **Outcome for WPC15800A7BD6637 (2026-09-16 13:02 SAST, build `6f449eb`):** `GET /api/internal/payout-reconcile?reference=WPC15800A7BD6637` → OTT `GetPaymentStatus` answered `status 0, "Failed to retrieve record"` (no payout exists on their side) → `finalisePayout` released the hold, R58 moved back to SPEND (founder balance R66.00), row `FAILED / PROVIDER_0`, customer messaged. Nothing was ever paid. Open with OTT (email 9): what the sandbox returns for PerformPayout, whether the test webhook fires, and whether status 0 on GetPaymentStatus always means "no record".

