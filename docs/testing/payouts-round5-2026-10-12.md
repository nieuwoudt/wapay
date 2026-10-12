# Withdrawals round 5 (from 2026-10-12): the Lisa case, and making a withdrawal work for her

*Written by the payouts thread, round 5, from `docs/HANDOVER_PAYOUTS_V2.md`. The founder's decisions of 2026-10-12 are built in the order he approved them; each item's commit, test and production evidence is recorded here as it lands. Lisa's cellphone is masked to its last four digits everywhere in this file.*

## A. What happened (production `conversation_turns`, account `cmv2g0tu4002jd6jcc3kq81wo`, times SAST)

The founder sent R350 by "send money" to a number that had no WaPay. That minted an OTT voucher on OTT's test host (`VOUCHER_GIFT_OTT`, gift `cmv2foj8f001fd6jcamn6pjld`, R350 + R3 fee from his wallet), delivered as a PIN when she joined on Saturday 10 October. Her balance was R0.

| Time | Lisa | WaPay |
|---|---|---|
| 10 Oct 18:44 | (joins; the gift is delivered as a voucher PIN) | "A R350 WaPay voucher was delivered" |
| 18:44 | Send Money | (onboarding question, personal or business) |
| 21:39 | I want you to put in my bank account | "💸 Withdrawals start at R50 plus the fee, so the smallest one needs R58, and you have R0 available right now…" |
| 21:40 | How can you transfer in my bank account | the same line |
| 22:13 | I want to put all my money to my bank account | the same line |
| 22:14 | Put in my bank account | the same line |
| 22:15 | Send money | "How much would you like to send?… a WaPay voucher" |
| 22:16 | R350 | "Which number should I send it to?" |
| 22:16 | 060•••9361 (her own number) | "You need R350 for this voucher but your balance is R0. Pay the R350 difference with the button below" (a R367 PayFast link; opened, never paid; the deposit row is still PENDING) |
| 22:42 | How much can I withdraw | "switching over…" then "✅ Yes. … PayShap (R8, minutes) … you need your 13-digit ID number" |
| 22:44 | Help me to move in my bank account | the gate line again |
| 23:24 | Yes | "I can't confirm payments or balances in chat…" |
| 23:25 | Did my payment go through | "⏳ PayFast is still confirming your R350. I'll message you here the moment it clears." (nobody had paid) |
| 23:27 | Deposit 350 | the deposit method question |
| 23:28 | Pay in my bank account | the gate line again |
| 11 Oct 06:23 | "Withdraw "350" from waypay to my account | the gate line again |
| 09:14 | Take back home screen | the home card (no withdraw line) |
| 12 Oct 13:26 | | (event) "R350 from Nieuwoudt is now in your WaPay balance…" after the founder's manual ledger entry `manual-gift-to-wallet-cmv2foj8f001fd6jcamn6pjld` |

Ten requests to move money to her bank, seven identical replies, no word about the R350 voucher she had just received, a near-sale of a R350 voucher to herself for R367, "still confirming" for a link nobody paid, a time promise, and an ID step that only takes a 13-digit South African ID. Her state on 2026-10-12: SPEND R350, no saved pay-out details, no identity on file, one PENDING PayFast deposit row (R367 gross, from the self-voucher shortfall link).

## B. Round 5, item by item

| # | Item | Commit | Evidence |
|---|---|---|---|
| 1 | Passport / foreign ID at the ID step, issuing country, wire fields; migration `20261012_payout_passport_and_last4` (applied to production 2026-10-12 14:28 SAST, before the deploy) | (this section is filled in at each push) | §C |

## C. Lisa's first withdrawal (item 1): the run sheet

She holds R350. PayShap to her own Capitec account first (the founder's instruction); if the rail refuses a passport for PayShap, cash at an Absa or Nedbank ATM (OTT told the founder both accept a foreign ID). The money is real: R50 to her account and R8 fee; OTT charges WaPay R2.88.

| # | Lisa says | WaPay should answer | The thread checks |
|---|---|---|---|
| 1 | "withdraw 50" | the method menu: PayShap R8, cash from R18, "You have R350 available" | |
| 2 | "1" | "What is the bank account number the money must go to?" | |
| 3 | her Capitec account number | "Which bank is that account with?" | |
| 4 | "Capitec" | "What is your full name, exactly as it appears on your bank account?" | |
| 5 | her full name as on the account | "…Type your 13-digit South African ID number, or your passport or foreign ID number." | |
| 6 | her passport number | "Which country issued that passport or ID?" | the number is not echoed and not stored in memory (`[hidden]` in `conversation_turns`) |
| 7 | the country, in her own words | the confirmation: "Withdraw R50 to account … at Capitec by PayShap", "Name on the account", "Passport / foreign ID: •••xxx (country)", fee R8, total R58, balance after R292 | |
| 8 | "yes", then her PIN | "⏳ In progress…" (PayShap answers 99 first) then, within about a minute, "✅ Your withdrawal of R50 by PayShap has been paid…"; or an honest failure with the money back | the `ProviderRequest` row (`idDoc` PASSPORT/xx), OTT status, the webhook, the journal (upgrade 5800, cash-out, fee 800, rail cost 288), the float |
| 9 | (save question) "yes" or a name | "✅ Saved, encrypted: Capitec account •••xxx and your name and passport or ID number ending xxx" | the identity row has `idType` PASSPORT and `countryOfIssue` |
| 10 | her Capitec app | the R50 credit | a screenshot from her, through the founder |

If line 8 fails at the provider for the passport: "withdraw 50 absa", "yes", "mine", "yes", PIN (her passport is then asked once more unless she saved it). Cash needs R68.

## D. Results

(filled in as the tests are run)
