# Incident 2026-10-28: Lisa's failed PayShap withdrawal

*Opened 2026-10-28 by the client issue-resolution thread, from the founder's write-up and the customer's screenshots. Bugs: BUGLOG #145 to #150. This file is the repository's record; the shared incident doc is the founder's.*

## Summary

No money was lost, but the customer had every reason to think it was. Lisa (a returning customer, BUGLOG #111, docs/testing/payouts-round5-2026-10-12.md) tried to move her WaPay balance to her own Capitec account (•••918). A R100 PayShap withdrawal (reference `WP161EF3F64B2374`) waited for the founder's approval with R116 set aside. It was approved at 21:40 and rejected by the bank in the same minute, and the R116 came back. A R228 withdrawal she was shown at 21:20 was never confirmed. When she wrote "Nothing is coming in to my bank account" at 22:13, the bot answered with the withdraw opener.

- **Customer impact:** nothing arrived at Capitec, R420 sat in her balance, she got no reason for the failure, and no route to a person was offered.
- **Security exposure:** her WaPay PIN, typed at the PIN step of an earlier withdrawal, is in her WhatsApp history and in the screenshots (BUGLOG #149).
- **Severity:** high for trust (a payments product that "lost" money), low for funds (the ledger balances).

## Timeline (SAST, from the screenshots; the code path is named where the repository settles it)

| Time | What happened | What the code did |
|---|---|---|
| earlier day, 18:04 to 18:05 | R325 PayShap withdrawal, PIN typed at the PIN step, paid at 18:05 (`WPED6D478285A1E9`) | normal chat flow; the PIN stays in her WhatsApp history (#149) |
| 21 Oct, 09:13 | "I want an invite link" | `matchInviteAsk` → `handleInviteAsk` replied; 07:13 UTC is inside Meta's restriction (#136), so the reply failed on the phone (#150, to confirm) |
| about 19:45 (inferred) | money reaches her balance | starts the 2-hour express fee window (CHANGELOG 125) |
| before 21:06 (inferred) | a R100 PayShap withdrawal is requested and approved with her PIN | approval mode (CHANGELOG 129): `requestPayoutCore` moves R116 to CASH, holds it, row `AWAITING_APPROVAL`, the customer is told "⏳ Waiting for approval" (to confirm: the `PAYOUT_REQUEST` audit row's time) |
| 21:06 | "Send R360" to her own number; the bot points her to withdraw | `sendToSelfText` (#117 family) |
| 21:18 to 21:20 | withdraw flow: Capitec •••918, R228 + R16 fee = R244, "Balance after R0" | `startWithdraw` has no open-pay-out check; balance = available only (#147) |
| 21:20 to 21:40 | no YES or PIN from the customer | the R228 intent was never authorised, so no row exists (to confirm) |
| 21:40 | "✅ Your pay-out of R100 by PayShap was approved and has been handed to the bank rail" | founder approves; `railAndSettle` → PerformPayout answers PENDING → `approvedCopy` (#148) |
| 21:40 | "❌ Your withdrawal of R100 by PayShap could not be completed by the bank rail"; R116 back | OTT webhook with a failure status → `finalisePayout` FAILED → `payoutOutcomeMessage` without the reason (#146) |
| 22:08 | Nieuwoudt sends her R60 | a send from a member: fresh money, so the express fee applies again |
| 22:13 | "Nothing is coming in to my bank account" | `matchWithdrawAsk` reads "to my bank" as a withdraw word and runs before the status lookup (#145) |
| 22:14 | "🏦 PayShap to your bank account: R16 fee … You have R420, so up to R404 … How much?" | `bankOpener` |

## Reconciliation

At 22:14 the balance is R420. Take away Nieuwoudt's R60 and it was R360 before 22:08, which is the R360 she tried to send at 21:06. At 21:20 the flow showed R244 available. The gap is R116, exactly R100 plus the R16 express fee: the R100 withdrawal was already set aside when she was shown the R228 offer, and its R116 came back at 21:40. The books balance; the customer's view of them did not.

## Root causes

1. **The complaint was not heard (#145).** The withdraw matcher claims "to my bank" and runs before the status lookup; complaints without a question word match neither.
2. **The failure had no reason and no next step (#146).** OTT's code is stored on the row and never translated.
3. **Two withdrawals could be open at once, and the held money was invisible (#147).** There is no one-open rule, the confirmation shows the available balance only, and `moneySituation` misses AWAITING_APPROVAL.
4. **The status messages contradict each other (#148).** Five places write pay-out status, and a ✅ is used before the bank has confirmed.
5. **The PIN is typed in chat and stays on the phone (#149).**
6. **An unanswered message (#150)**, explained by Meta's restriction of 20 to 21 October.

Contributing: the express fee (R16 rather than R8 within 2 hours of money arriving) pushes people to retry or split withdrawals, and the obvious way to move money to herself was "send" to her own number, not "withdraw".

## Open questions (answer from production before closing)

- [ ] The rail's status code and message for `WP161EF3F64B2374` (row: `metadata.outcome`, `providerStatus`, `lastMessage`, `providerBody`).
- [ ] When the R100 was requested (`PAYOUT_REQUEST` audit row, `approval.requestedAt`), and confirmation that it came from her own PIN.
- [ ] Why it waited until 21:40: approval mode means it waited for the founder. The approval alert's time against the approval time.
- [ ] Whether a row was ever created for the R228 (if one was, where it went).
- [ ] Whether the R325's destination and name match the R100's (`destKey`, `recipient.name`). If they match, the name is not the cause.
- [ ] `status-failed-131031` for the 21 October reply.
- [ ] How many other customers had a ❌ withdrawal in the last 30 days with no follow-up.

## Fix it for the customer today (the founder)

- [ ] Read the rejection code above and record it here.
- [ ] Confirm in the ledger: R116 released at 21:40, no R228 row, balance R420, no active hold.
- [ ] Message her personally (draft in the fix section below, once the code is known).
- [ ] Waive the fee on her next withdrawal and process it with her once the cause is understood.
- [ ] Ask her to change her WaPay PIN and delete the message with the old one.
- [ ] Reply to her invite-link request.
