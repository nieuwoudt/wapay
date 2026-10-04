# WaPay withdrawals (OTT pay-outs) — end-to-end test and commercial model thread, v1

Written 2026-10-04 by the main architecture session for a dedicated side thread named
**"WaPay payouts end-to-end"**. The founder's mandate, verbatim: *"Let's start a withdrawals
payout thread … test that end-to-end … what you also need to do is verify the cost, the
commercial model of all the different payout providers, what we are going to charge them,
and how that flow would work … let it run end to end, try to fix this and let it speak back
to you."* "You" is the main session (`WaPay Build v1.3 autonomous loop`, find it with
ListAgents and report with SendMessage). The Blu thread runs in parallel on VAS; do not touch
its files. The main session owns the agent architecture; this thread owns `lib/payouts.js`,
`lib/payout-chat.js`, `lib/ott-payout.js`, the pay-out routes, `docs/PAYOUTS.md`,
`docs/OTT_PAYOUT_API.md` and the new `docs/PAYOUT_COMMERCIALS.md`.

Read in order: `CLAUDE.md`, `WAPAY_STATUS.md` (iCloud root), this file, `docs/PAYOUTS.md`,
`docs/OTT_PAYOUT_API.md`, `docs/BUGLOG.md` entries #46, #47, #50 to #54, #61, #63, #68, #80,
#82, memory `ott-payout-payshap`, `EMAIL_TO_KEAMO_9_COMMERCIALS.txt`,
`EMAIL_TO_OTT_TECH_10_SANDBOX_RESOLVED.txt`.

---

## 1. Where the rail stands this morning (facts from production, 2026-10-04)

The founder ran three withdrawals from his phone (27787051175, on `WAPAY_PAYOUT_ALLOWLIST`,
OTT **sandbox**, `WAPAY_PAYOUT_KYC=off`). From `ProviderRequest` route `ott-payout`:

| SAST | Method | Amount + fee | Our reference | OTT reference | Result |
|---|---|---|---|---|---|
| 08:39 | Nedbank cardless (code 4) | R20 + R18 | `WPB4D27FAF672A7E` | 126382 | **SUCCESS. The first customer withdrawal ever to complete.** Chat said "Done. R20 is on its way to you by Cash at a Nedbank ATM." |
| 08:55 | PayShap Account (127) | R50 + R8 | `WP88A417B750FC36` | 126383 | PENDING at OTT: status 99 "pending finalisation". R58 is held in the customer's CASH wallet. Chat said "In progress…" then, on "how long does it usually take", answered honestly and offered to check; "Still pending" on the check |
| 09:01 | ABSA CashSend (112) | R50 + R18 | `WP4D1AD70A6B28B6` | none | FAILED at the provider: status 97 "Fail at Provider: Internal Server Error". Hold released, money back. OTT emailed a "Payout Failure" notice to the founder's inbox |

Founder wallet after: SPEND R70.00, CASH R0 available / R58 pending (the PayShap hold).

**What this proves:** the wire format and hash (BUGLOG #80) are right for every provider; the
ledger sequence (SPEND to CASH, hold, PerformPayout, settle or keep or release) is right; the
chat flow runs from "withdraw" to "Done". **What it does not prove:** PayShap and CashSend
completing; they ended at OTT's sandbox providers, not at us (the same PayShap 97 and the
Nedbank 100 were seen through the probe on 2026-09-23).

## 2. What the founder saw and asked for (screenshots 2026-10-04, his words)

1. **The OTT SMS is not ours and carries nothing.** "OTT: Nedbank Cardless Withdrawal sent
   from Payout. Amount: R20.00. Voucher Code: . PIN: . Need help? WhatsApp: 0843255632." He:
   "it has an OTT number to it … we keep the customer inside of WaPay and if we can't change
   that SMS structure … we need to make sure that it has clear instructions on how to
   actually withdraw the money." Actions: (a) ask OTT whether the SMS sender/text is
   configurable per merchant (our brand, our WhatsApp number, no OTT number) and why the
   voucher code and PIN were empty on the sandbox; (b) regardless, after a SUCCESS the chat
   must send the collection instructions itself (the per-bank steps already exist in
   `lib/how-it-works.js collectionSteps`), naming where the code arrives.
2. **"Please change this to 'minimum withdrawals from'."** The method menu's "(from R50)" is
   not clear. Reword the menu lines.
3. **Beneficiaries for pay-outs.** "When I'm entering a PayShap payout and a bank account, it
   should ask which bank it is and also ask if you should remember it for the next payment …
   saves the bank account number, your name, and the ID number … we only have to ask them
   once … list beneficiaries or payout people." Design with the main session (it owns the
   customer record / context pack) and implement in the flow: a `payoutDestinations` list on
   the account (label, method, masked fields, full fields encrypted or at least never shown
   whole, consent flag, createdAt), an explicit "Save this for next time? YES/NO" step, a
   "mine" shortcut for own-number methods, selection by number or name next time, and
   "forget my bank details" erasure. The recipient name must stop being
   "Nieuwoudt Nieuwoudt" (displayName used twice because KYC is off): ask once for the full
   name as on the bank account and remember it.
4. **"Will the user get notified by his bank?"** Add the line: PayShap credits show in the
   bank's own app/SMS; cash codes arrive by SMS to the number given.
5. **Intent pickup is not smart.** "Can I withdraw 20" then "50 and 2" was read as neither
   amount nor method; "No can you help me withdraw 50 at ABSA?" produced the long explainer;
   "50 at ABSA" produced "Just the amount". He wants: "If I say 50, 20, or 50 and 2, it
   should confirm 'Is this what you meant?' and then go through the sequence." Fix the state
   machine's compound answers (amount + method in one message, "50 at ABSA", "the Nedbank
   one") in `lib/payout-chat.js handleWithdrawReply` / `stepInputParses`, with one
   confirming line. The main session will fold the same lesson into the agent's clarify
   step; coordinate so the two do not diverge.
6. **PayShap pending:** the customer must be told the outcome when OTT finalises (webhook or
   sweep). Confirm that WP88A417B750FC36 finalises, what OTT finally says, and that the
   customer gets one message with the result (`notifyCustomer`, BUGLOG #72 template rail if
   outside the 24 h window).
7. **The CashSend failure.** 97 at the provider. Ask OTT whether ABSA CashSend on the sandbox
   is expected to fail; keep the honest copy; and check the OTT failure email: it carried the
   customer's full name, ID number, derived date of birth and mobile in clear text to a
   mailbox. Raise with OTT (POPIA): can they suppress PII in failure mails or send them to a
   restricted operations address only.

## 3. The commercial model task (the founder's second ask)

Produce `docs/PAYOUT_COMMERCIALS.md` with, per method: OTT's cost to us (the 2026 Addendum to
the Payout Agreement, memory `ott-payout-payshap`: PayShap R2.50, RTC R4.50, Nedbank
Cardless R9.96 + 0.3% switching, ABSA CashSend R9.96 + 0.3%, reversals R10, all excl VAT and
WaPay is not VAT-registered so multiply by 1.15; FNB e-wallet UNPRICED, asked in
`EMAIL_TO_KEAMO_9_COMMERCIALS.txt`), what we charge the customer today
(`lib/ledger-core.js cashoutFeeCents` and `cashoutRailCostCents`; `lib/fee-facts.js`; the
founder's +R2 decision of 2026-09-11: PayShap R8, RTC R10, CashSend R18 / R23 / R30 by band,
Nedbank and FNB priced like CashSend), the margin per method at R50, R200, R500, R1,000,
R3,000, the competitor benchmark (Absa CashSend R16, FNB eWallet R11, Capitec R10, Shoprite
R9.99, bank PayShap R0 to R2; the fee benchmark artifact in memory `wapay-artifacts-index`),
where we lose money (CashSend above about R738 under the 0.3% switching, the credit-card
case does not apply here) and a recommendation with the founder's open decision (keep or
drop the +R2 on PayShap/CashSend). Then make the code and the knowledge base agree with the
document: `lib/ledger-core.js`, `lib/fee-facts.js`, `lib/how-it-works.js` (the briefs quote
fees), `docs/PAYOUTS.md`, `docs/CONVERSATION_KNOWLEDGE_BASE.md` (generated). The customer
sees exactly one fee line per method, the same everywhere.

## 4. End-to-end test plan (after each fix, from the founder's phone; capture every line)

Each method, sandbox first: Nedbank cardless R20 (works), PayShap R50 (pending path), ABSA
CashSend R50 (failure path), FNB eWallet R20 (OTT says not live yet; expect the honest
refusal or a clean 97). For each: the chat transcript, our reference, OTT's reference,
`GET /api/internal/payout-reconcile?reference=WP…` output, the SMS received, the journal lines
(`CLEARING:*`, the hold, the fee), the final customer message. Negative paths: below the
minimum, an unaffordable amount (BUGLOG #68), cancel at confirm, wrong PIN, idle expiry.
Then the compound-answer cases from §2.5 as harness scenarios (`tests/e2e/chat-qa.mjs`) and
unit tests. Record in `docs/testing/payouts-e2e-<date>.md`.

Tools: `GET /api/internal/payout-status` (switches, float, providers), `GET
/api/internal/payout-reconcile[?reference=]`, `GET /api/cron/payout-reconcile`,
`POST /api/internal/payout-probe` (sandbox only, no ledger), the Mission Control pay-outs
card (`/api/admin/conversations?days=7` half), `pnpm qa:chat` (mocks the rail, drives the
flow), `pnpm test`, `pnpm build`. Internal key in `~/Projects/wapay/.env`.

## 5. Production flip (credentials are in hand; do not flip until §2.1, §2.5 and §3 are done)

OTT approved production pay-outs on 2026-09-23 (username `WAPAYPOL`; the founder holds the
key and password; FNB e-wallet not yet live on OTT's side, keep it mapped). Order: providers
activated on the PRODUCTION merchant (portal > Administration > Payout Providers > Add All),
webhook URL `https://pleasepayme.co.za/api/webhooks/ott-payout` set there, the float funded,
then in Vercel `OTT_PAYOUT_BASE_URL=https://payoutapi.ott-mobile.com` and the three
`OTT_PAYOUT_*` values, **redeploy**, `GET /api/internal/payout-status` shows the balance and
the four providers, `WAPAY_PAYOUT_ALLOWLIST` stays, one R50 PayShap to the founder's own
account with real money, then regenerate the key in the portal (it was pasted in chat). Cash-
out beyond the five test numbers stays closed until counsel and Didit (`WAPAY_PAYOUT_KYC`).

## 6. Standing rules

Never release a hold on an indeterminate answer; GetPaymentStatus request errors (-1, 1, 2)
never release (BUGLOG #63); one PerformPayout per intent, ever; the customer wording for a
finalised pay-out is `payoutOutcomeMessage`, one source; no "Sent" on a timeout (BUGLOG #82);
no partner named in customer copy while withdrawals are off; no time promises; no em dashes
in customer copy or emails; ID numbers, account numbers and cellphones masked everywhere
they are stored or logged; never push a red test; `pnpm test` + `pnpm build` before every
push, never `pnpm build` while the harness or `next dev` runs; stage by path, coordinate with
live peers (ListAgents / SendMessage), `git rm` in the iCloud repo for deletions. Report to
the main session after each milestone (fixes shipped, commercial doc, each live test) with
the commit hash and the evidence file.

## 7. Hard-to-reconstruct details

Provider codes: PayShap Account 127, ABSA CashSend 112, Nedbank Cardless Withdrawal 4, FNB
e-wallet 1; required fields per provider from `GetActiveProvidersLimits` (ID number + mobile
for all, account number + branch code for PayShap); minimums R50 PayShap/ABSA, R20 Nedbank/
FNB. OTT status codes: 100 paid, 99 pending finalisation, 98 pending, 97 failed at provider,
3 duplicate (reconcile), -1/1/2 auth. Sandbox behaviour: Nedbank completes (100), PayShap is
created then 97 or stays 99, CashSend 97 "Internal Server Error". OTT hashes an absent
`bank_id` as "0" and the amount as "20.00"; empty strings in integer fields are HTTP 400. OTT
SMS on the sandbox: sender "OTT", help WhatsApp 0843255632, empty voucher code and PIN. OTT
failure e-mail: from "Noreply Payout", subject "Payout Failure on OTT-Payout for <name>",
body carries Title, names, IdType RSAID, IdNumber, Nationality, DateOfBirth, Gender, Mobile,
Amount, Error. Contacts: Keamo (commercial), Yaku (technical). Test float: R99,939.96 on
2026-10-03 before today's three pay-outs.
