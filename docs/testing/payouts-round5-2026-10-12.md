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
| 1 | Passport / foreign ID at the ID step, issuing country, wire fields; migration `20261012_payout_passport_and_last4` (applied to production 2026-10-12 14:28 SAST, before the deploy) | `d3c3cef` (live 14:37 SAST) | §C, §D.1 |
| 2 | "To my bank account" opens PayShap with the price and the numbers (BUGLOG #101) | `11e4485` (live 15:00 SAST) | §D.2 |
| 3 | The R0 gate reads the situation, tiers, a person on the third ask; "how much can I withdraw" (BUGLOG #102) | `7dfed12` (pushed 15:18 SAST; Vercel build failed, see §D.3) | §D.3 |
| 4, 5 | "Send money" to your own number refused, received voucher answered; an unpaid link is "not paid" (BUGLOG #103, #104) | (this push) | §D.4 |

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

### D.1 Item 1 (2026-10-12)

- Suite 1019/1019; harness: every scenario PASS including the new 6d part 1 (a passport through the real processor: country asked, confirmation "Passport / foreign ID: •••456 (Zimbabwe)", one PerformPayout carrying `id_type` PASSPORT, `country_of_issue` ZW, `nationality` ZW); one WARN on the agent's withdrawals-off answer (six bullets, a model-length check on a path this change does not touch). Build green.
- Production after the push: `/api/internal/payout-status` build `d3c3cef`, host `payoutapi.ott-mobile.com`, providers PayShap 66, CashSend 67, Nedbank 4; WhatsApp webhook bare GET 403.
- `?countries=1` on production: OTT's GetCountryCodes answers `{ countryName, countryCode }` with ISO alpha-2 codes ("AF", "AX", "AL", …), the same shape the chat sends.
- **The production payout float was R45.56** at 12:37 UTC, after the founder's three pay-outs at 12:37 to 12:52 SAST (Nedbank R50 `WP1966FA7D6C7290`, Absa R50 `WP892962CD5C83ED`, PayShap R78 `WPC5A564DCADE067`, all paid). One R50 PayShap needs about R52.50 of float: the founder must top it up before Lisa's run (§C).
- Lisa's run: waiting on the float top-up and on the founder asking her to say "withdraw 50".

### D.2 Item 2 (2026-10-12)

- Suite 1021/1021; harness 31 PASS including 6d part 2 ("lets do a withdrawal to my bank account" → "🏦 PayShap to your bank account: R8 fee, the cheapest way into your bank. You have R…, so up to R…. No bank account? Cash at an Absa, Nedbank or FNB ATM costs from R18. How much?"; "I don't have a bank account" → the cash methods; "all my money to my bank account" → the ceiling and the account question), the same unrelated agent-length WARN; build green.
- Production: build `11e4485`, webhook bare GET 403, float still R45.56.

### D.3 Item 3 (2026-10-12)

- Harness run 1 (real processor, QA account at R0 with a delivered R350 voucher gift and a R367 link unpaid for 20 minutes): "I want you to put in my bank account" → "💸 You have R0 to withdraw. The R350 … sent you today came as a voucher PIN, not as money in your balance, so it cannot be withdrawn. Your R367 payment link from today was not paid, so nothing came in from it and nothing was taken. A withdrawal needs at least R58 …"; "How can you transfer in my bank account" → "Let me explain where your money is …" with the bullets, what she can do and the passport line; "Put in my bank account" → "Here it is once more, step by step …" (no alert channel on the harness); "How much can I withdraw" → **"🙋 A person from the WaPay team has been asked to help you" although no alert had been sent**. Defect in the new code, fixed before any push: a person is named only when an alert really went (`refs.personAsked`), a failed alert is retried, and the harness now checks it.
- Suite 1026/1026 after the fix; harness run 2: 33 PASS, no WARN, no FAIL (Lisa 3 now checks that no person is claimed without an alert: the fourth reply reads "💸 In short: you have R0 to withdraw, and a withdrawal needs at least R58 …").
- **Deploy (2026-10-12 15:18 SAST):** the Vercel production build of `7dfed12` failed after about 100 s, and an empty re-trigger (`b954d88`) failed after 10 s (the sibling project `wapay-api-vcel` also failed on it). A clean clone of `b954d88` builds green on the Mac (`pnpm install --frozen-lockfile`, `pnpm build`, also with `CI=true VERCEL=1`); Vercel's status page shows no incident. The build log needs the founder's Vercel access (asked). Production stays on `11e4485`: items 1 and 2 live, item 3 not yet.

### D.4 Items 4 and 5 (2026-10-12)

- Suite 1029/1029; harness 34 PASS, no WARN, no FAIL. 6d part 4: "Send money" → "R350" → her own number → "📵 That is your own number, so there is nobody to send it to. To move your WaPay money into your bank account, say *withdraw*. …" (no voucher, no link). 6d part 5: "Did my payment go through" with the R367 link unpaid for 20 minutes → "You have not paid your R367 payment link from today: no payment came in for it, so nothing was taken. Ignore it if you did not mean to buy. …" Build green.

