# Lisa's timed-out withdrawal (2026-10-15) and the golden thread (2026-10-16)

*Written by the payouts thread from production `conversation_turns`, audit and provider records for the account of Lisa (bank account in the name Ruth Mahlangu). Times SAST. No number of hers appears here.*

## A. What happened

| Time | Lisa | WaPay |
|---|---|---|
| 15 Oct 11:31 | (PIN reset finished) | "✅ Your new PIN is set…" |
| 11:36 | I want to withdraw cash in my account | the PayShap opener: R8 fee, up to R342 |
| 12:12 | 342 PayShap | "What is the bank account number…" |
| 12:14 to 12:15 | (account), Capitec bank, Ruth Mahlangu | "…Type your 13-digit South African ID number, or your passport or foreign ID number." |
| 16:32 | (her ID, four hours later; the flow had expired at 30 minutes) | the AI: "Thanks. Now enter your WaPay PIN to confirm the payout 💰" |
| 16:37 | (her PIN) | the AI: "Thanks 💰 Your payout is being confirmed now." |

Nothing reached OTT (no provider request since 13 October), her R350 is in her balance with nothing held, her PIN works (0 failed attempts). Her ID and her PIN went to the two-tier model as the text of those two turns. The PIN-reset cool-off did not stop the 11:36 start although her reset had no ID check; the code reads it correctly against her real account (simulated: active until 16 Oct 11:31), so production most likely has `WAPAY_PIN_RESET_COOLOFF_HOURS=0`; `/api/internal/payout-status` now reports it (`switches.pinResetCoolOffHours`).

## B. What changed

See `docs/GOLDEN_THREAD.md` (the rules, where each is enforced, the test for each) and BUGLOG #111 to #114. In short:

- a late answer to a withdrawal step carries it on, a late YES or PIN is confirmed again and never used, a day-old flow says it stopped;
- nothing personal reaches a model on any path: one boundary tokenises names, phones and e-mails and refuses a call carrying an ID, passport, account number or PIN;
- a model can no longer ask for the PIN or claim a pay-out that the record does not have;
- money leaves only with a PIN proof bound to the account, the intent and the amount, demanded at the rail itself;
- bank and ID numbers typed mid-flow are sealed at rest (when `WAPAY_PII_KEY` is set);
- a forged card callback cannot mint money with an empty or public secret.

## C. Tests

- Unit: `tests/model-boundary.test.mjs`, `tests/money-out-safeguards.test.mjs`, `tests/payout-timeout.test.mjs` (new); the full suite and the build green before the push.
- Harness scenario 6f, through the real processor: see §E.
- A read-only scan of every production account's AI context (record plus the last 12 turns) through the boundary: 8 of 8 with no refusal; 9 names and 6 payment references tokenised.

## D. Founder's run sheet (your phone, after the deploy)

| # | Say | Expect |
|---|---|---|
| 1 | "withdraw 50 to my bank account", go to the ID question, wait 35 minutes, then type your ID | the withdrawal carries on: the confirmation, everything shown, "Reply YES to continue to your PIN" |
| 2 | wait 35 minutes, then "yes" | "This withdrawal waited a while, so I am checking it with you again before your PIN…" and the confirmation again |
| 3 | "yes", wait 35 minutes, then your PIN | "I did not use the PIN you just sent. Nothing has been sent yet." and the confirmation; nothing is paid |
| 4 | "cancel", then your PIN on its own | "🔐 Nothing is waiting for a PIN right now, so I did not use that number…" |
| 5 | your ID number on its own | "🪪 Nothing is waiting for an ID or passport number right now, so I did not use it or keep it…" |
| 6 | a withdrawal start, then nothing for a day, then your ID | "⏱️ Your withdrawal of R50 stopped because it waited too long… Nothing was sent…" |

For Lisa: she can withdraw now. "withdraw 342 to my bank account", then answer each question as it comes (the bank account, Capitec, her name, her passport or ID and the country), YES, her PIN. The payout float is R545.56, enough for R350.

## E. Harness run (2026-10-16, real processor, mocked WhatsApp and OTT)

**38 pass, 0 warn, 0 fail** (`docs/testing/chat-qa-report-2026-10-16.md`). Scenario 6f, **Lisa 9, PASS** on all twelve checks:

- her ID four hours late carries the withdrawal on (the country is asked), then the confirmation;
- a late YES is confirmed again, not sent to the PIN;
- a late PIN is not used, and nothing reaches the rail;
- a PIN after an early step timed out is told so;
- a bare PIN and a bare ID outside a flow get the deterministic answers on the two-tier path and on the agent path;
- a day-old withdrawal says it stopped;
- no reply asks for a PIN out of turn or claims a pay-out.

The existing scenarios, Lisa 1 to 8 included, all passed with the PIN proof on the real money path ("Withdraw end to end … paid with PIN, balance moves").

After the run, two narrowings of the boundary landed. They are covered by unit tests, not by this run:

- everyday words are never treated as names;
- only person fields in tool results are tokenised, so product and merchant names stay visible.
