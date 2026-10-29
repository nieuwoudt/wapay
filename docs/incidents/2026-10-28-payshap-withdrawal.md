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

## What was fixed (CHANGELOG 134, branch `claude/incident-2026-10-28-payshap-withdrawal`)

| Incident fix | Bug | Where it lives | Build rule |
|---|---|---|---|
| P1 missing-money intent, before the Pay agent and the withdraw matcher | #145 | `lib/missing-money.js`, processor `handleMissingMoney` / `handlePayoutStatus` | 4 |
| P1 every rejection code has a reason and a next step, as data; unknown codes alert ops | #146 | `lib/payout-reasons.js`, `payoutOutcomeMessage`, `opsPayoutFailed` | 5 |
| P1 one open withdrawal per account, in the code and in the database; cancel while waiting | #147 | `requestPayoutCore` `OPEN_PAYOUT`, migration `20261028_one_open_payout`, `rejectPayout` by the customer | 1, 2, 3 |
| P1 PIN: interim line at the PIN step (the structural move is below, not built) | #149 | `PIN_PRIVACY_LINE` | 6 |
| P2 what is set aside, shown beside what is available | #147 | `balanceLine`, `openPayoutCopy`, `moneySituation` sees AWAITING_APPROVAL | 2 |
| P2 one status vocabulary, never ✅ before the bank confirms | #148 | `lib/payout-status-copy.js`, `approvedCopy` | 4 |
| P2 after a ❌, a way to a person | #146 | "Reply *person*" in every failure, `handlePersonAsk` | |
| P2 ops told of every rail failure | #146 | `opsPayoutFailed` from `railAndSettle` and `finalisePayout` | 5 |
| Rule 7: this incident is a test | all | `tests/payout-incident-chat.test.mjs` (real processor), `tests/payout-incident-2026-10-28.test.mjs` | 7 |

Not built here (left for later, each still open in the Permanent fixes list): the alert for a pay-out reserved more than 10 minutes before it reaches the rail (P2; in approval mode the wait is the founder's own queue), the own-number send going straight into withdraw (P3), the express fee explained before the amount is chosen (P3), the unanswered-message alert (P3, #150). The rail's state machine is the existing row lifecycle (INIT, AWAITING_APPROVAL, PENDING, SUCCESS / FAILED, REJECTING, NEEDS_OPERATOR) with every transition stamped on the row. Rule 1 asks for "created, reserved, submitted, paid, failed, reversed" names. Renaming states is a migration of every pay-out row and every reader, and it was not needed to fix this incident, so it is proposed here, not done.

## PIN entry off chat (Build rule 6): the design, not built

Today the PIN step is a chat message. WaPay never stores it, but the customer's own phone keeps it. Two ways off chat, both ending at the same proof (`verifyPIN` → `issuePinProof`, golden thread 2.1):

1. **One-time signed link (recommended).** At the confirmation, the chat sends a link to an app.wapay.co.za page. The link is HMAC-signed, names this account, intent and amount, lasts 5 minutes and works once. The page shows the withdrawal and asks for the PIN. The existing `/api/app/pin` step issues the proof, and the server runs the same `executeWithdraw` from the sealed flow state (golden thread 3.2). The chat then says the outcome. It reuses the web portal's lockouts and proof (2.13), and Meta needs nothing approved.
2. **WhatsApp Flows.** A native form, but the Flow JSON must be approved by Meta and needs an encrypted endpoint, while the number's quality rating is RED. Later.

Either is a new money path under 2.1 and 2.13 and needs the founder's go-ahead. Until then the PIN step carries the interim line.

## Deploy (the founder; nothing here has touched production)

1. Read-only pre-check (must return no rows), then apply the migration: see the header of `packages/domain/prisma/migrations/20261028_one_open_payout/migration.sql`. The code is safe with or without it.
2. Merge the branch to `main` (push to `main` deploys Vercel). Suite 1456/1456 and `pnpm build` pass on the branch.
3. Optional: set `WAPAY_SUPPORT_WHATSAPP` (the number a customer is given when no ops alert can be sent), and make sure `WAPAY_OPS_ALERT_MSISDNS` and `ALERT_EMAIL` are set so "person" and the failure alerts reach you.

## Founder test script (production, from your own phone; approval mode on)

1. "Nothing is coming in to my bank account" → "🔎 I checked your withdrawals" with your recent ones, or "I can't see a withdrawal … in the last 7 days". It must never be the "🏦 PayShap to your bank account … How much?" opener.
2. "withdraw R50", PayShap, your own account, YES. The PIN step shows the "WaPay never keeps your PIN" line. Enter your PIN → "⏳ Waiting for approval".
3. "withdraw R50" again → "⏳ You already have a withdrawal waiting for approval … R58 is set aside … Say *cancel withdrawal* …" and nothing new in Mission Control.
4. "did my withdrawal go through" → the waiting line with the balance split ("R… available and R58 set aside").
5. "cancel withdrawal" → "↩️ *Cancelled.* … are back in your WaPay balance"; Mission Control's queue no longer shows it.
6. Repeat step 2 and approve it in Mission Control → "⏳ *Approved and on its way.*" (never a ✅), then "✅ … has been paid" from the webhook, or "❌ *Didn't go through.* … because …" with the balance. You get a "❌ Pay-out failed" alert for any failure.
7. "person" → your ops number and e-mail get "🙋 … asked to talk to a person"; the phone gets "🙋 I have asked a person from the WaPay team …".

## Message to the customer (draft for the founder to send from the WaPay business inbox)

Her last message was at 22:13 on the incident evening, so a free-form message reaches her until 22:13 SAST the next day. After that only an approved template does (golden thread 4.6). Fill in the reason once the code is read (first open question):

> Hi Lisa, this is Nieuwoudt from WaPay. I'm sorry about last night, and I have checked everything myself. Your R100 withdrawal at 21:40 did not go through because [reason], and the R100 and the R16 fee came straight back to your WaPay balance. Nothing was lost: you have R420 in WaPay right now and nothing else is waiting. The R228 you saw at 21:20 was never sent, because it was not confirmed. We have fixed the messages that made this confusing. Your next withdrawal is free, and I'm happy to do it with you now: just reply here.
>
> For your safety, please also change your WaPay PIN (say *forgot PIN*) and delete the earlier chat message that has your old PIN in it (press and hold the message, then *Delete for me*). And you asked for an invite link on 21 October and our reply never reached you: say *invite* and it comes straight away.

## Consultation record

On 29 October the client issue-resolution thread messaged three sessions with the findings, the plan and the read-only questions above: the valuation and main build thread (session `…LNarxf94S47d6vszJ1mKSh`), the v1.3 orchestration loop that built the Pay Agent Architecture (`…ResSjWQPpiutd4qVAcTRTX`, unarchived for this), and the pay-outs end-to-end thread (`…Gi9XuVRURWLkNFETUCQdk4`). All three messages were delivered. When this was written none had answered: the first was idle with the message waiting, and the other two were disconnected because their computer side was not running. The design follows the code those threads wrote and keeps every test they left green. Their answers, and the production facts in the open questions, are to be added here when they arrive.
