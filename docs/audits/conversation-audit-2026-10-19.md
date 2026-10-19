# Conversation audit, 2026-10-19

Every customer conversation to date: 348 accounts, 2,498 turns, exported redacted (numbers masked, first names only, the full-name step masked by position) with `scripts/audit/export-conversations.mjs`, swept deterministically with `scripts/audit/scan-conversations.mjs`, then read in four shards by review agents against `docs/audits/REVIEW_BRIEF.md`. This file is the store of record for the findings; every fixed bug has a BUGLOG entry and a lock test. Names are not in this file.

**Findings: 93 (20 P1, 40 P2, 33 P3).** Fixed in this round: BUGLOG #118 to #128 across builds 4824cfa, 7b3f753, 0507946 and the audit build. Open items are listed with their queue note.

## 1. The deterministic sweep

- Bot lines naming an FNB eWallet: 10; quoting a R20 minimum: 16 (all before the 09:58 UTC fix on 19 October; the last three are the founder's own 8 October test and the two 19 October lines that triggered BUGLOG #119).
- Error lines that reached a customer: 7 (all on the founder's test account, September and early October). Betting words: 0. Internal names leaked: 0. Live products called coming soon: 0. Em dashes: 36 (data-bundle lists on the test account; the product is coming soon).
- Date-pattern hits: 5, all receipts carrying a transaction date, not promises.
- Last user turn with no recorded reply: 3 accounts, all after an add-money amount (BUGLOG #120: the button message was sent but never recorded).
- Repeated bot text three or more times: 26 cases (mostly the founder's and Lisa's test runs; the live ones are the get-paid prompt loop fixed as BUGLOG #121 and the ad FAQ buttons tapped repeatedly).
- Two clarifications in a row: 2. Third-tier withdraw gate reached: 1. Replies over 1,200 characters: 1.
- What customers asked for that is not live: airtime 46, data 43, voucher 11, instore 11, electricity 3, fuel 2, loan 2.

## 2. The findings

| Id | Sev | Category | Finding | Accounts | Status |
|---|---|---|---|---|---|
| S1-01 | P1 | wrong-fact | Send money still described and executed as an OTT voucher with a fee, including on 10-19 | 3 | Fixed in 4824cfa (BUGLOG #118). |
| S1-02 | P1 | wrong-fact | FNB eWallet offered as a withdrawal method (no such rail) | 3 | Fixed in 7b3f753 (BUGLOG #119) at 09:58 UTC; all hits are older than the fix. |
| S1-03 | P1 | wrong-fact | Withdrawal minimum stated as R20 for Nedbank cash until 10-09 (rule is R50 plus a customer fee) | 3 | Fixed in 7b3f753 (BUGLOG #119) at 09:58 UTC; all hits are older than the fix. |
| S1-04 | P1 | wrong-fact | a customer Pay agent sells coming-soon products (airtime, data, OTT self-purchase, Blu till deposit) as available and flips within a customer hour | 6 | Fixed in 4824cfa (BUGLOG #118). |
| S2-01 | P1 | money | Add-money flow goes silent after a customer amount: no payment link, no error (3 of 3 attempts) | 3 | Noted; not changed in this round. |
| S2-02 | P1 | wrong-fact | Send flow still describes send money as an OTT voucher and points to 'buy a voucher' which is coming soon | 3 | Fixed in 4824cfa (BUGLOG #118). |
| S2-03 | P1 | money | PIN-confirmed PayShap withdrawal acknowledged as 'being confirmed' then vanished; no result for 3 days, no fee/total confirm step | 1 | Fixed in 4824cfa (BUGLOG #118). |
| S2-04 | P1 | wrong-fact | HISTORIC (fixed copy seen 10-12): FNB eWallet offered as a cash-out method and '13-digit ID number' as a customer only ID | 1 | Fixed in 7b3f753 (BUGLOG #119) at 09:58 UTC; all hits are older than the fix. |
| S2-05 | P1 | wrong-fact | HISTORIC (a customer 18 Oct scope): sign-up, home card and R0 gate sold airtime, data and electricity as live | 4 | Fixed in 4824cfa (BUGLOG #118). |
| S3-01 | P1 | money | Re-request after a link exists uses a customer previous link's fee-inclusive gross as a customer new principal | 3 | Fixed in this build (BUGLOG #124). |
| S3-02 | P1 | wrong-fact | Old Add Money copy sells Blu voucher cash deposits with step-by-step instructions | 1 | Fixed in 4824cfa (BUGLOG #118). |
| S3-03 | P1 | wrong-fact | a customer number guard offers 'buy electricity' as something to do | 1 | Noted; not changed in this round. |
| S3-04 | P1 | wrong-fact | Customers told that tapping their own link, or WaPay, will pay them; nobody is told a customer link is unpaid | 4 | Noted; not changed in this round. |
| S3-05 | P1 | stuck-loop | 'Close account' loops seven times on a 'secure final step' that never comes | 2 | Fixed in this build (BUGLOG #125). |
| S3-13 | P1 | wrong-fact | a customer card cost quoted at exactly R50 (R1) does not follow a customer published fee rule | 1 | Fixed in this build (BUGLOG #123). |
| S4-01 | P1 | wrong-fact | FNB eWallet offered as a cash-out option | 2 | Fixed in 7b3f753 (BUGLOG #119) at 09:58 UTC; all hits are older than the fix. |
| S4-02 | P1 | wrong-fact | Withdrawal minimum given as R20 | 1 | Fixed in 7b3f753 (BUGLOG #119) at 09:58 UTC; all hits are older than the fix. |
| S4-03 | P1 | wrong-fact | R0 withdraw gate tiers 1 and 2 sell a cash voucher at a till as a way to add money | 2 | Fixed in 4824cfa (BUGLOG #118). |
| S4-04 | P1 | money | R3000 request: gross-up option promises R3000 but would net about R2933 by card | 1 | Fixed in this build (BUGLOG #123). |
| S4-05 | P1 | wrong-fact | Send-money flow still describes a send as an OTT voucher | 2 | Fixed in 4824cfa (BUGLOG #118). |
| S1-05 | P2 | contradiction | Home card advertises coming-soon products ('Quick: Buy airtime · Buy data') next to a customer agent's coming-soon answer | 2 | Fixed in 4824cfa (BUGLOG #118). |
| S1-06 | P2 | business | Business handling misfires: offer then refusal; personal/business question still asked on 10-19; 'set it up in two questions' promise | 3 | Fixed in 4824cfa (BUGLOG #118). |
| S1-07 | P2 | stuck-loop | 'Sorry, I'm not sure what you mean' three times in a row to a customer naming his business | 3 | Open: after two clarifications the chat should offer options or a person; queued. |
| S1-08 | P2 | stuck-loop | Ad arrivals with nobody to bill get a customer pay-link flow restarted instead of an answer (they think WaPay pays them) | 4 | Fixed in this build (BUGLOG #126). |
| S1-09 | P2 | contradiction | Own-number refusal points to 'buy a voucher', which a customer bot then says is coming soon (twice, identical text) | 3 | Noted; not changed in this round. |
| S1-10 | P2 | stuck-loop | Withdraw flow swallows a customer 'add money' escape it just offered | 2 | Open: flow prompts should expire after a few minutes; queued. |
| S1-11 | P2 | contradiction | a customer agent claims to have saved bank / withdrawal details it cannot save | 3 | Noted; not changed in this round. |
| S1-12 | P2 | stuck-loop | Data purchase flow never progresses: identical bundle list for every input, including a customer exact format it asks for; catalogue prices wrong | 4 | Noted; not changed in this round. |
| S1-13 | P2 | stuck-loop | Airtime flow validated a customer phone number as an amount and treated 'mine' as cancel | 2 | Noted; not changed in this round. |
| S1-14 | P2 | menu-dump | Specific questions answered with a flow restart, a full menu or a canned balance line | 5 | Noted; not changed in this round. |
| S1-15 | P2 | stuck-loop | Stale quick-choice and cross-flow state: '1' and '2' land in a customer wrong place | 4 | Noted; not changed in this round. |
| S1-16 | P2 | unanswered | Typed deposit amounts with no logged reply (likely untranscribed PayFast links; zero deposits landed) | 5 | Not silence: every amount created a PayFast button message the chat did not record; memory fixed in 0507946 (BUGLOG #120). Delivery itself to be confirmed by a live test (founder action). |
| S1-17 | P2 | wrong-fact | 'Samsung Pay' listed as a top-up method in every Add Money prompt; not on a customer methods of record (verify) | 12 | Verified: PayFast lists Samsung Pay; not a bug. |
| S2-06 | P2 | stuck-loop | HISTORIC (gate shipped 10-12): R0 withdraw gate repeated a customer identical line 7 times, no fuller picture, no person; 'Yes' mis-routed | 4 | Noted; not changed in this round. |
| S2-07 | P2 | stuck-loop | 'Reset pin' typed verbatim answered with 'Type reset PIN' four times; customer locked out of R350 for 3 days | 3 | Fixed in this build (BUGLOG #126). |
| S2-08 | P2 | money | 'Fresh link for a customer same amount' compounds a customer card padding (R1000 -> R1047 -> R1096) | 1 | Fixed in this build (BUGLOG #124). |
| S2-09 | P2 | unanswered | In a customer first-link prompt state, clear questions and complaints are swallowed into 'How much would you like to request?' | 6 | Not silence: every amount created a PayFast button message the chat did not record; memory fixed in 0507946 (BUGLOG #120). Delivery itself to be confirmed by a live test (founder action). |
| S2-10 | P2 | money | 'Send Money' tapped after sign-up returns an FAQ and starts no flow; a customer next amount becomes a 'please pay me' link | 3 | Fixed in this build (BUGLOG #126: the tap starts the flow; the FAQ line states the ledger truth). |
| S2-11 | P2 | onboarding | Free-text arrivals in S0 get 'Happy to help with that once your account is open' repeatedly (3x in a row) and a customer account never opens | 4 | Fixed in 4824cfa (BUGLOG #118). |
| S2-12 | P2 | business | HISTORIC (question removed 19 Oct): a customer business question swallowed normal messages and button taps | 2 | Historic: before the 09:58 UTC removal; since this build only the value "ask" asks it. |
| S2-13 | P2 | contradiction | 'PayFast is still confirming your R350' said about a payment that was never started | 1 | Fixed in 4824cfa (BUGLOG #118). |
| S2-14 | P2 | security | Export redaction gap: a customer's first name and surname appear in clear (USER and BOT lines, 10-12) | 2 | Fixed in the export script (the full-name step is redacted by position). |
| S3-06 | P2 | unanswered | Deposit amount replies get no visible bot reply; zero deposits completed | 5 | Not silence: every amount created a PayFast button message the chat did not record; memory fixed in 0507946 (BUGLOG #120). Delivery itself to be confirmed by a live test (founder action). |
| S3-07 | P2 | onboarding | a customer first-link example is typed back verbatim and treated as a real debt | 6 | Fixed in this build (BUGLOG #126). |
| S3-08 | P2 | onboarding | Starter buttons advertise coming-soon products (airtime/data/electricity, pay in-store) | 9 | Noted; not changed in this round. |
| S3-09 | P2 | money | 'Send Money' answers a FAQ and never starts a customer send flow | 8 | Fixed in this build (BUGLOG #126: the tap starts the flow; the FAQ line states the ledger truth). |
| S3-10 | P2 | other | 'Was my link paid?' questions are answered with a customer card-deposit status | 2 | Noted; not changed in this round. |
| S3-11 | P2 | stuck-loop | a customer bot asks a customer customer to retype an exact phrase instead of acting on a clear intent | 3 | Noted; not changed in this round. |
| S3-12 | P2 | menu-dump | 'Settings', listed on a customer home card, returns a customer home card | 1 | Noted; not changed in this round. |
| S3-14 | P2 | other | A receiver saying 'my bank is Capitec' is answered as a payer question, twice | 2 | Noted; not changed in this round. |
| S3-15 | P2 | wrong-fact | 'Samsung Pay' named as a top-up method although it is not on a customer live list | 8 | Verified: PayFast lists Samsung Pay; not a bug. |
| S4-06 | P2 | unanswered | Deposit-amount replies have no logged bot reply (link likely created, message not captured or not delivered) | 7 | Fixed in 7b3f753 (BUGLOG #119) at 09:58 UTC; all hits are older than the fix. |
| S4-07 | P2 | contradiction | Bot offers a step-by-step withdrawal at R0, then answers YES with a customer escalation | 1 | Open: the how-it-works offer should not be made at a R0 balance; small copy change, queued. |
| S4-08 | P2 | other | 'Send Money' tap is a dead end: FAQ answer, no flow, membership-biased copy | 8 | Fixed in this build (BUGLOG #126: the tap starts the flow; the FAQ line states the ledger truth). |
| S4-09 | P2 | stuck-loop | In-flow questions and out-of-range amounts get a customer same prompt repeated verbatim | 5 | Fixed in this build (BUGLOG #126). |
| S4-10 | P2 | language | Sesotho withdraw hint repeated three times with a raw R<amount> placeholder | 3 | Fixed in this build (BUGLOG #128). |
| S4-11 | P2 | stuck-loop | Idle send flow swallows a later sentence and hides a customer R3000 link cap | 1 | Fixed in 4824cfa (BUGLOG #118). |
| S4-12 | P2 | other | Clear statements misrouted: 'I did' gets a deposit answer, 'Capitec app' starts a deposit | 2 | Open: after two clarifications the chat should offer options or a person; queued. |
| S4-13 | P2 | contradiction | Withdraw gate calls a customer unpaid add-money link a 'payment link' and quotes a customer gross amount | 1 | Fixed in 7b3f753 (BUGLOG #119) at 09:58 UTC; all hits are older than the fix. |
| S4-14 | P2 | business | Business question still asked at sign-up on 19 Oct (organic path) | 1 | Fixed in 4824cfa (BUGLOG #118). |
| S1-18 | P3 | tone | a customer same bot text repeated two or three times (question taps, duplicate answers, 'go on') | 8 | Noted; not changed in this round. |
| S1-19 | P3 | onboarding | a customer first-link example is copied verbatim and a customer bot addresses a customer fictional Thandi | 4 | Fixed in this build (BUGLOG #126). |
| S1-20 | P3 | other | 'Send Money' tap answered with a fact and no next step (six customers, zero sends) | 6 | Fixed in this build (BUGLOG #126: the tap starts the flow; the FAQ line states the ledger truth). |
| S1-21 | P3 | tone | Internal strings and a generic 'Please try again later' suffix in customer text | 5 | Noted; not changed in this round. |
| S1-22 | P3 | tone | A self-bought OTT voucher is delivered as 'Someone sent you a R50 WaPay voucher!' after being routed through a customer send opener | 2 | Fixed in this build (BUGLOG #122). |
| S1-23 | P3 | tone | Balance card uses a customer full WhatsApp profile name and 'R 0.00' | 1 | Noted; not changed in this round. |
| S1-24 | P3 | promise | Time promise ('in minutes') and an unlisted product ('shopping vouchers for big-name stores') in a customer capabilities card | 3 | Fixed in 4824cfa (BUGLOG #118). |
| S1-25 | P3 | contradiction | Deposit fee explained in one place, contradicted by 'a customer full amount lands in your balance' in another (verify a customer fee) | 4 | Noted; not changed in this round. |
| S1-26 | P3 | wrong-fact | Foreign ID question answered vaguely; flow prompt asked only for a 13-digit SA ID (dated; passports shipped 10-12) | 2 | Noted; not changed in this round. |
| S1-27 | P3 | other | Supplier test-access failures blamed on a customer customer or presented as retryable (a customer coming-soon) | 3 | Noted; not changed in this round. |
| S1-28 | P3 | other | 'Airtime, Data, Elec' answered with airtime only on a customer flow path (ad path answers all three) | 2 | Noted; not changed in this round. |
| S1-29 | P3 | other | 'I need 5000' inside a customer deposit amount step is parsed as a malformed amount instead of a loan ask | 1 | Not silence: every amount created a PayFast button message the chat did not record; memory fixed in 0507946 (BUGLOG #120). Delivery itself to be confirmed by a live test (founder action). |
| S2-15 | P3 | other | Buttons offered for coming-soon products (airtime/data/electricity 6 taps, in-store 2) and two different 'Pay In-Store' answers | 8 | Noted; not changed in this round. |
| S2-16 | P3 | promise | Calendar date in customer text: 'a customer request just expires on 26 Oct 12:59' | 1 | Noted; not changed in this round. |
| S2-17 | P3 | tone | Payer-name parsing leaks a customer whole sentence into a customer share line or drops a customer name | 5 | Open: payer-name parsing; queued. |
| S2-18 | P3 | tone | Withdrawal account-number step rejects 'number + bank' and 'name, bank' and re-asks | 3 | Noted; not changed in this round. |
| S2-19 | P3 | other | Withdraw menu omits a customer bank-transfer (R10) option and repeats 'Minimum withdrawals from R50' three times | 2 | Noted; not changed in this round. |
| S2-20 | P3 | wrong-fact | Add-money card names 'Samsung Pay', not on a customer live-method list (verify before changing) | 8 | Verified: PayFast lists Samsung Pay; not a bug. |
| S2-21 | P3 | tone | Jargon ('top up electronically', 'pay out'), a flippant scam reply, stale 'switching over', and 'I will tell you a customer moment it is live' promises | 5 | Noted; not changed in this round. |
| S3-16 | P3 | tone | Payer-name capture swallows a customer trailing phrase, or drops a customer name entirely | 6 | Fixed in 7b3f753 (BUGLOG #119) at 09:58 UTC; all hits are older than the fix. |
| S3-17 | P3 | tone | a customer same line sent twice in a row | 3 | Fixed in this build (BUGLOG #126). |
| S3-18 | P3 | tone | Display names used raw: emojis, lowercase, possessives | 4 | Noted; not changed in this round. |
| S3-19 | P3 | contradiction | Two balance-card formats within minutes, and 'just say it in English' against 'in any language' | 3 | Noted; not changed in this round. |
| S3-20 | P3 | onboarding | a customer same ad FAQ block sent twice within a minute or two | 4 | Noted; not changed in this round. |
| S3-21 | P3 | other | Own-link taps answered without a customer one fact a customer customer needs | 6 | Noted; not changed in this round. |
| S4-15 | P3 | tone | Requesters tap a customer 'Pay request' button on their own link | 5 | Open: after two clarifications the chat should offer options or a person; queued. |
| S4-16 | P3 | tone | Payer-name parsing lifts a customer wrong words into 'Forward it to ...' | 3 | Open: payer-name parsing; queued. |
| S4-17 | P3 | onboarding | Customers type a customer example back verbatim and get a real R250 link | 4 | Fixed in this build (BUGLOG #126). |
| S4-18 | P3 | tone | 'Airtime, Data, Elec' answered with airtime only on a customer flow path | 3 | Noted; not changed in this round. |
| S4-19 | P3 | tone | Small copy slips and near-duplicate consecutive lines | 7 | Fixed in this build (BUGLOG #128). |
| S4-20 | P3 | wrong-fact | 'Samsung Pay' named as an add-money method (verify) | 7 | Verified: PayFast lists Samsung Pay; not a bug. |
| S4-21 | P3 | tone | Irrelevant OTT voucher explanation inside a 'Pay In-Store' refusal | 1 | Fixed in this build (BUGLOG #122). |
| S4-22 | P3 | other | Missed opportunities on two clear asks (account number, 'Wa payment link') | 2 | Not silence: every amount created a PayFast button message the chat did not record; memory fixed in 0507946 (BUGLOG #120). Delivery itself to be confirmed by a live test (founder action). |

## 3. Patterns worth the founder's attention

- **The ad brings people who think WaPay pays them.** Across the shards, customers wrote variants of "nobody owes me", "who must pay me", "I need money now" and typed the prompt's example word for word; at least ten links were made for nobody. The chat now answers these plainly (BUGLOG #126); the ad creative and the first-link prompt could say "money people owe you" more directly.
- **Sign-up drops concentrate on the "how it works" and "what it costs" entries (Q2 and Q3):** roughly a quarter to a third of those arrivals never start the code step, against far fewer on Q1 and Q4.
- **Airtime, data and electricity are the most-tapped things WaPay cannot do yet** (airtime 46, data 43 user turns), then vouchers and in-store payments.
- **Links are made, not paid:** 110 links, 7 paid, 89 open at the time of the audit. The one paid ad-sourced link is the founder's R10 test.
- **Deposits:** every typed amount produced a PayFast button message; none has been paid. A live test on the founder's phone will confirm the button arrives.

## 4. What changed because of this audit

- Memory: button messages are recorded (BUGLOG #120); the export masks the full-name step.
- Money truth: the send flow speaks balance (BUGLOG #122); add-money links are named as such (BUGLOG #127); the gross-up and the ceiling (BUGLOG #123); re-links (BUGLOG #124).
- Never a trap: the out-of-range amount says why (BUGLOG #121); the example and "nobody owes me" get answers (BUGLOG #126); "close my account" gets a person (BUGLOG #125); no placeholders in the model's mouth (BUGLOG #128); the eWallet and R20 (BUGLOG #119); the till voucher (BUGLOG #118).

## 5. Open, queued

- Flow prompts should expire after a few minutes so a later sentence is reclassified.
- After two clarifications in a row, offer three concrete options or a person.
- The how-it-works withdraw walkthrough should not be offered at a R0 balance.
- The requester's own card carries a "pay" button they tap themselves; relabel for the requester.
- Payer-name parsing in "Forward it to …".
- A follow-up on an open add-money link after a few minutes ("your R500 top-up link is still open").

## 6. How to run it again

`pnpm audit:export <outDir> 4` (outside the repo), `pnpm audit:scan <outDir>`, one reviewer per shard with `docs/audits/REVIEW_BRIEF.md`, findings as `findings-N.md/.json`, then a report like this one. Every confirmed bug: a BUGLOG entry and a lock test.
