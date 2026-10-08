# Withdrawals on production: the first live run (founder's phone, real money)

*Prepared 2026-10-08 by the payouts thread for the switch from OTT's sandbox to the production payout host. Every pay-out on this sheet moves real money from the WaPay wallet to the founder's own accounts and real rands from the OTT float, and every one costs OTT's fee (R2.88 PayShap, R11.46 plus 0.3% cash, inc VAT). The thread fills the evidence columns from the database and OTT afterwards. Rules unchanged: nothing is released on an indeterminate answer, one PerformPayout per intent, the customer is told once.*

## Before the first message

| # | Who | Step | Done when |
|---|---|---|---|
| 1 | Founder | OTT production payout portal: Administration > Payout Providers > Add All; Administration > API Settings > Webhook URL `https://pleasepayme.co.za/api/webhooks/ott-payout` (secondary empty); the API key (the one issued 23 September, or a freshly generated one, which is shown once). | the providers list shows PayShap Account, ABSA CashSend, Nedbank Cardless Withdrawal (and FNB e-wallet if OTT has it live) |
| 2 | Founder | Fund the production float with OTT (amount your call; R500 covers this whole sheet). | GetBalance will show it in step 5 |
| 3 | Founder | Vercel > project > Settings > Environment Variables > Production: `OTT_PAYOUT_BASE_URL=https://payoutapi.ott-mobile.com`, `OTT_PAYOUT_USERNAME=WAPAYPOL`, `OTT_PAYOUT_PASSWORD=<production password>`, `OTT_PAYOUT_API_KEY=<production key>`; add `WAPAY_PII_KEY=<64 hex characters, e.g. openssl rand -hex 32>` so "save for next time" works. Leave `WAPAY_PAYOUT_ENABLED=true`, `WAPAY_PAYOUT_ALLOWLIST` (your five numbers) and `WAPAY_PAYOUT_KYC=off` exactly as they are. | saved |
| 4 | Founder | Vercel > Deployments > latest > Redeploy (environment changes apply only on a redeploy). Then tell the thread "flipped". | the deployment is Ready |
| 5 | Thread | `GET /api/internal/payout-status`: host `payoutapi.ott-mobile.com`, your float as the balance, the providers mapped. Then reconcile Saturday's sandbox PayShap `WP88A417B750FC36`: production answers "no record", the R58 hold is released and the money returns to your balance (nothing was ever paid on the sandbox). | balance shown; R58 back; you are told once |
| 6 | Founder | Wallet balance for the whole sheet: about R260 (PayShap R58, Nedbank R38, CashSend R68, FNB R38, a second PayShap R58). After the R58 return you hold about R98; deposit R200 by card ("deposit 200") to run everything, or run lines 7 to 9 only on R98. | balance shows |

## Switch-on record (2026-10-08, 11:04 to 11:20 UTC)

- Vercel now points at `https://payoutapi.ott-mobile.com` with username WAPAYPOL; GetBalance answered **R500.00** (the founder's funding) at 11:04 UTC.
- The sandbox PayShap `WP88A417B750FC36` was reconciled against the production host: "Failed to retrieve record" (status 0) → released, R58 back, the founder told once; wallet SPEND R98.00.
- Production merchant providers after "Add All": **Nedbank Cardless Withdrawal 4, PayShap Account 66, ABSA CashSend 67, Standard Bank Instant Money 2**. Codes differ from the sandbox (127/112), which is why they are resolved at runtime. Instant Money is unmapped (no method yet; a candidate for a Standard Bank / Spar cash method, unpriced). FNB e-wallet is NOT on the production merchant, so line 19 does not apply.
- Required fields unchanged (name, ID number, mobile for all; account number + branch code for PayShap). The API reports no merchant limits (0), so the portal's system minimums apply (R50 PayShap and ABSA, R20 Nedbank) under WaPay's R20 to R3,000 cap; the portal's system maximum is R5,000 for the cash methods and R150,000 for PayShap.
- Webhook URL saved on the production merchant (founder, 11:10 UTC).

## The run (say exactly this; screenshot every reply)

| # | Say | Expect | Evidence the thread adds |
|---|---|---|---|
| 7 | "withdraw 50", then "1" | PayShap; account number ask (or the saved list if one exists) | |
| 8 | your account number, then your bank ("FNB"), then your full name as on the account (asked once), then your ID number, then "yes", then your PIN | "✅ Done … by PayShap. Reference WP…" with "your bank's own app or SMS will show the credit", OR "⏳ In progress … handed to the bank rail" followed by one message when the bank confirms. Then "💾 Save these details for next time? … Reply YES or NO" | our reference, OTT paymentReference, status 100 or 99, the webhook arrival time, the journal (upgrade, cash-out, fee R8, rail cost R2.88), the float before and after (OTT's applied fee) |
| 9 | "yes" (to save) | "✅ Saved, encrypted: FNB account •••xxx and your name and ID number ending xxx" | the two rows, masked |
| 10 | your bank app | the R50 credit from the rail (screenshot the bank's notification: that is the "will my bank notify me" answer with a real one) | |
| 11 | "did my withdrawal go through" | the live status with the reference and your balance, once | |
| 12 | "withdraw 20", then "the Nedbank one", then "mine" | straight to the confirmation (name and ID on file): "Name on the account: …", "ID number: •••xxx (saved)" | |
| 13 | "yes", PIN | "✅ Done … Reference WP…", then "📲 The withdrawal code is sent by SMS to •••175" and the Nedbank ATM steps | reference, OTT reference, status, journal (fee R18, rail cost R11.53) |
| 14 | the SMS on your phone | the sender name and the text, with a real withdrawal code this time (photograph it) | the exact SMS text goes into the OTT file |
| 15 | optional: a Nedbank ATM, Cardless services | R20 in hand; keep the slip | a collected cash send is never reversed; an uncollected one is reversed with an R11.50 OTT fee |
| 16 | "withdraw 50", "1", then "1" (the saved FNB account), "yes", PIN | the second PayShap from the saved destination, no name or ID asked | reference, status, the destination's use count |
| 17 | "withdraw", then "50 and 2" | "Got it: R50 by cash at an Absa ATM. Is that right? Reply YES…" | |
| 18 | "yes", "mine", "yes", PIN | "Done" with the collection code SMS to •••175 and the Absa steps (on the sandbox this failed at the provider; production is the real test) | reference, OTT reference, status |
| 19 | "withdraw 20", "4" (FNB eWallet), "mine", "yes", PIN | either a real eWallet SMS or an honest failure with nothing charged (OTT said e-wallet is not live yet) | reference, status |
| 20 | "what do you know about me" | the line "Saved withdrawal details (encrypted): FNB account •••xxx, plus your name and ID number ending xxx" | |
| 21 | "forget my bank details" | "🧹 Done. Your saved bank details, cellphone numbers and ID number for withdrawals are erased…" | both tables empty for your account |
| 22 | "withdraw 10" | below every minimum: the honest refusal naming the smallest withdrawal | |
| 23 | "withdraw 50", "1", then "cancel" at the confirmation | "Cancelled. Your money stays in your balance." | nothing moved |
| 24 | "withdraw 20", "3", "mine", "yes", then a wrong PIN once, then "cancel" | "Incorrect PIN. Try again", then cancelled; nothing moved | nothing moved |

## D. What happened (founder's phone, 14:40 to 15:25 SAST, build 0988b49, real money)

**Three production withdrawals, three paid. Money in and money out proven end to end.**

| Line | PayShap R50 | Nedbank cardless R20 | ABSA CashSend R50 |
|---|---|---|---|
| Our reference | `WPC92BDD9664297F` | `WP116F9A7A53A126` | `WPE0DCF1008AA961` |
| OTT paymentReference | •••307 | •••495 | •••623 |
| PerformPayout answer | status 99 (HTTP 200), 12:41:17 UTC: "In progress" | status 100 at once, 13:00:06 UTC: "Done" | status 99 (HTTP 200), 13:12:50 UTC: "In progress" |
| Finalised by | **OTT's production webhook**, message "Completed", 12:42:46 UTC (95 s) | settled on the answer | **OTT's production webhook**, message "Completed", 13:13:48 UTC (61 s) |
| Customer told | once: "Your withdrawal of R50 by PayShap has been paid" + the bank line | once: "Done" + the Nedbank steps | once: "has been paid" + the Absa steps |
| On the phone | FNB app: R50 from "Private Cheq Acc … @ Payshap Ref: OTT…" | SMS from the rail with the withdrawal code | two SMSes from Absa: a 10-digit reference and a 6-digit PIN |
| Hold | R58 SETTLED | R38 SETTLED | R68 SETTLED |
| Journal | upgrade 5800; CASHOUT_PAYSHAP CASH D5800 / CLEARING:OTT C5000 / FEE C800; rail cost 288 | upgrade 3800; CASHOUT_NEDCASH C2000 / FEE C1800; rail cost 1153 | upgrade 6800; CASHOUT_CASHSEND C5000 / FEE C1800; rail cost 1164 |

Wallet: R98 → R40 (PayShap) → R140 (R100 card deposit) → R102 (Nedbank) → R34 (CashSend). Float: **R500.00 → R356.98**: R143.02 out for R120.00 of pay-outs, so OTT's applied fees for the three were **R23.02** against our modelled R26.05 inc VAT (R22.63 ex VAT): the float is debited close to the ex-VAT rates, which suggests VAT is invoiced separately; the per-transaction split is still a question for OTT's statement (email 11, question 5). Saved after the run: identity (Nieuwoudt Gresse, ID •••083) and one cash destination for •••175 (the Nedbank and Absa saves are one row: same cellphone, same family).

**What the sandbox could never show and production did:** the webhook fires and finalises within about a minute; PayShap and CashSend both complete; the Absa SMS carries real codes (two messages); the provider codes differ (PayShap 66, CashSend 67) and the runtime mapping handled it; the Standard Bank Instant Money provider appears on the merchant.

**Round-3 defects seen in the transcript (all fixed in the next build):**
1. "Yes please save my bank details as mine" after the PayShap was not read as a YES (the save step accepted a bare YES only); the message passed through to the agent, which answered "Done, Nieuwoudt. I have noted that these are your own bank details" while nothing was saved. The next PayShap therefore asked for the account again, and "My bank account" / "You have it stored" / "Don't you have any account info stored for payouts?" got "type the account number only" and the generic aside.
2. "Add money" and "I want to load money to WaPay" inside the method step, after the flow's own reply had suggested "say add money", were answered with the method menu twice.
3. With R40 the menu listed PayShap and Absa with "(needs R58 with the fee)" but gave no plain line on what to do.
4. The Absa steps did not mention the two SMSes (reference and PIN) and were prose, not a list.
5. "Mine" typed beside the saved list offered to save the same cellphone again.

## What the thread checks after the run

1. Every row's status at OTT by GetPaymentStatus, and whether the production webhook arrived for each (the sandbox sent none).
2. The float before and after: the applied OTT fee per transaction, which closes the R82.69 question from the sandbox.
3. The journal for every settled row: the customer's fee, the rail cost, CLEARING:OTT balanced.
4. The exact SMS text per provider, into the OTT questions.
5. Then: regenerate the production API key in the portal (the one in use was pasted in chat on 23 September) and rotate it into Vercel; redeploy; the status route confirms.

## Still closed after this run

Withdrawals for anyone outside the five allowlisted numbers stay off until counsel clears cash-out and identity checks are switched on (`WAPAY_PAYOUT_KYC` unset, Didit configured).
