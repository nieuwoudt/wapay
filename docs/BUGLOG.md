# WaPay — Bug Register

*Every caught bug, with its root cause and the guard that stops it coming back. Format: **symptom → root cause → fix → guard**. Add new entries at the top. A bug without a regression guard is not closed.*

---

## 73. The pilot list matched one spelling of a number, and a list that matches nobody looks exactly like a quiet week

- **Symptom:** 2026-09-18, the first check of the shadow week. `GET /api/admin/conversations?days=7` reported 19 customer messages, 20 replies, the pilot list live with one number on it, and **zero agent turns**. `agent_turns` had never received a single row since the table was created. Everything else was healthy: the messages were landing (`wamid` rows and `status-sent` pulses in `processed_messages`), the founder's account was answering, and all 19 inbound turns in the window were his. Nothing on the card could say whether the number on the list was wrong or whether he simply had not messaged since it was set, and the difference is a week of calendar.
- **Root cause:** two faults with one shape. (1) `agentV3For` compared the list entry to the wa_id as raw strings: `list.includes(String(waId).trim())`. Meta sends `27787051175`; a human setting the variable in the Vercel dashboard will as readily write `+27787051175`, `0787051175` or `+27 78 705 1175`, and three of those four matched nobody. The failure is silent by construction, because a number that is not on the list is served by the old engine and answers perfectly well. (2) The Mission Control card reported only how many entries the list had, never whether any of them could be read as a number or belonged to an account, so an empty week could not be told apart from a broken one without the founder's phone in hand.
- **Fix:** the list moves to `lib/shadow-list.js` and matches on the canonical digits through `normaliseMsisdn`, the same normalisation every other number in the product goes through, so every spelling of one number is that number. Normalisation never widens the list to a different number: a prefix, a superstring and a neighbouring number still do not match. The card now reports each entry by its last four digits with whether the product can read it and whether an account has ever written from it, plus whole clean days so far against the seven the promotion gate needs, with the clock reset by the newest money gate rather than by hand.
- **Guard:** `tests/shadow-list.test.mjs`, a behaviour test that imports the module and runs it: an unset list is nobody, all four spellings of one number match, and prefix, superstring and neighbouring numbers do not. `tests/phase2.test.mjs` keeps the two assertions only the source can make, that the processor uses that gate and never grows a looser one of its own or reads the variable directly.
- **Also fixed here:** the same test file used to slice `agentV3For` out of the processor's source text and `eval` it, which asserted the shape of a line of code rather than what it does, and would have passed unchanged while the pilot matched nobody. It is the first of the source-text locks rewritten as behaviour (docs/HANDOVER_V1.5.md section 4 item 5).

## 72. A pay-out that settled overnight was never reported to the customer

- **Symptom:** found while building C21 (2026-09-18). `sweepPayoutsAndNotify` sent the outcome with a plain free-form text. The sweep runs at 02:00 and from a cron route, so the customer it is telling is usually far outside their 24 hour window, and Meta ACCEPTS a free-form send there before dropping it silently (the same trap as BUGLOG #33). The sweep counted those as notified.
- **Root cause:** no rail choice. The one message WaPay starts on its own used the rail that only works when the customer has just written.
- **Fix:** `lib/notify.js` `notifyCustomer`: the window is read from the customer's last inbound turn, and when it is closed the message goes by Direct Send, then an approved UTILITY template, then free-form as a last resort. Whatever goes out is recorded as an assistant turn so the agent sees what the customer was told while away. The window check fails OPEN, because an unnecessary template costs a little and a dropped pay-out notice costs a customer.
- **Guard:** `tests/notify.test.mjs` (5 cases: the window boundary, the rail order, the memory row on every rail, never throws, and that the template parameters mirror the message).
- **To switch the template rail on:** set `WAPAY_TEMPLATE_PAYOUT_OUTCOME` to an approved UTILITY template whose body takes amount, method and reference in that order (`payoutOutcomeParams` in `lib/payouts.js` is the contract). Until it is set the other two rails are used.

## 71. "Forget my data" answered with a full disclosure of that data

- **Symptom:** shipped in `cf39b87` and caught the same afternoon by the streamlining review, before any customer used it. The loose memory matcher added that morning (BUGLOG #70) sat ABOVE the forget-me hook and its `my data` alternative matched "forget my data" and "erase my memory", so an erasure request rendered the customer's whole record instead of erasing it. "Delete my data" and "forget me" still erased, so casual testing would not have found it. The same matcher also stole "did my payments go through" from the handler that asks the rail live, and read "is my data still valid" and "my data bundle is finished" as memory questions.
- **Root cause:** a disclosure hook placed above an erasure hook, and an over-broad alternative ("my data") for a phrase that in this product usually means a data bundle.
- **Fix:** the hook moves below `matchForgetMe`; `forget`, `erase`, `wipe`, `clear` and `remove` disqualify a memory ask; the bare "my data" alternative is gone ("my profile", "my information", "my memory" stay); a deposit-status question returns null so the live rail check keeps it.
- **Guard:** `tests/review-2026-09-18.test.mjs` asserts the route for seven erasure phrasings, four data-bundle and status phrasings, and the three that must still be answered, plus the hook order in the router.

## 70. "Tell me a full history of what you know about me and all my past transactions" got the canned how-it-works line, twice

- **Symptom:** founder review 2026-09-18, on build 9bc355e. The sentence fell past every memory hook and landed on the how-it-works answer ("Say \"balance\" any time to see what you have..."), so the one question WaPay is built to answer, what it knows about this customer, was the one it would not answer. He asked twice and got the same line twice.
- **Root cause:** `ABOUT_ME_ASK` and `TRANSACTIONS_ASK` are anchored to short exact phrases ("what do you know about me", "my transactions"). A natural sentence matched neither.
- **Fix:** a loose layer beside the exact matchers. The memory half needs "about me", "on me" or "my data/profile/information/memory"; the history half needs a plural noun after "my" ("my past transactions", "my purchases"); a money verb anywhere in the message disqualifies both. When both halves match, one combined answer carries the record and the last ten movements in a single message (Meta bills every reply from 1 October 2026).
- **Guard:** `tests/review-2026-09-18.test.mjs` locks the founder's exact sentence, the memory-only and history-only forms, and nine phrasings that must never match (a product question, a money command, a status ask).

## 69. Fuel and voucher-gift execute routes still spent a PIN attempt before proving ownership; a voucher crash after issue refunded the sender

- **Symptom:** found by the architecture verification pass (2026-09-17). BUGLOG #56 closed the PIN-before-ownership order for airtime, data and electricity only. Fuel and voucher gifts still called `verifyPIN` before loading the preview and checking that the caller owns it, so an internal caller with someone else's preview id could burn that customer's PIN attempts and lock the account. The voucher route's crash guard also released the hold on any crash, including one after OTT had issued the voucher: the recipient would hold a live PIN and the sender would have the money back (a float leak).
- **Root cause:** the Phase 0 fix and its test lock covered three of the five execute routes.
- **Fix:** both routes prove ownership before the PIN; the voucher route carries a `providerDelivered` flag set the moment OTT confirms the voucher (issue or the timeout recovery) and, once set, a crash marks the row RECONCILE instead of releasing the hold.
- **Guard:** `tests/vas-execute-ledger-pattern.test.mjs` now covers the voucher route with the full pattern and the fuel route's ownership order.

## 68. The withdraw flow offered a method the balance could not cover, then bounced between two limits

- **Symptom:** founder test 2026-09-17 07:25 UTC, R66 in the wallet: "Where can I withdraw money?" → YES → *2* (cash at an Absa ATM, R50 minimum, R18 fee) → "How much? Between R50 and R3000" → "50" → "That is more than you have once the R18 fee is added. You can withdraw up to R48" → "48" → "R48 is below the R50 minimum". A dead end with no way out but "back".
- **Root cause:** the menu and the amount question used the method's limits and the balance separately; nothing asked whether the minimum plus its fee fits the balance. The "up to R48" ceiling was balance minus fee, which can sit below the minimum.
- **Fix:** `affordableMaxCents` in `lib/payout-chat.js` (the largest whole rand inside the limits whose amount plus fee fits; null when even the minimum does not). The menu line says "(needs R68 with the fee)" for such a method; picking it, or the agent proposing it, is refused with the reason and the methods the balance does cover; the amount question states the real ceiling; "more than you have" names a ceiling inside the limits or the same refusal; the entry gate counts the fee ("Withdrawals start at R20 plus the fee, so the smallest one needs R…").
- **Guard:** `tests/payout-affordability.test.mjs` replays the founder's exact numbers and checks that every ceiling the flow states is accepted when typed.
- **Also in the same test:** told to "reply *back* and choose *3*", the founder typed "3" at the amount step and got "R3 is below the R50 minimum". A bare 1 to 5 at the amount step now picks that menu option (no method allows an amount under R6, so the reading is never ambiguous).

## 67. The bot was mute for 14 hours: the webhook used `runWithSendScope` without importing it

- **Symptom:** founder report 2026-09-17 morning: "they just stopped responding today". Every text message since the Phase 0 deploy (`3915d81`, 2026-09-16 evening) showed "typing" and then nothing. `processed_messages` had only `webhook-ok` pulses and no claimed `wamid` rows since 06:36 UTC on the 16th, no delivery-status pulses, and `conversation_turns` had never received a production row. Meta's retries (three pulses a minute apart, then four minutes) were the same message dying the same way.
- **Root cause:** Phase 0 added the send-scope wrapper to the webhook's turn (`runWithSendScope(...)` in `pages/api/webhooks/whatsapp.js`) and imported only `sendTypingIndicator` and `outboundSendCount` from `@wapay/whatsapp`. The `ReferenceError` was thrown inside the turn's try, caught as "threw before sending", the claim released, the response 500, and Meta redelivered into the same error. `node --check` and `next build` both accept an identifier that is never imported; every webhook test read the route as text; the chat harness calls `processMessage` directly and never loads the route.
- **Fix:** the missing name in the import (one line). Verified on the shipped build by a runtime test that fails on the broken file (500, nothing processed, typing shown) and passes on the fixed one.
- **Guard:** `tests/webhook-route-runtime.test.mjs` loads and RUNS the route in a child process with its collaborators mocked and a real HMAC signature: a signed text message must reach `processMessage` and be acknowledged 200; a turn that throws before sending must release the claim and answer 500. A TypeScript `checkJs` sweep of every JS file changed since the last known-good build found no other undeclared identifier. Standing rule: a webhook change ships only with the route test green, and the first production message after any deploy that touches the webhook is watched in `processed_messages` (a claimed `wamid` row plus a `status-sent` pulse) before the deploy is called done.

## 66. "my pin is 1234" in prose reached the model and stayed in memory for seven days

- **Symptom:** found by the Phase 2 pre-ship review (2026-09-16). Outside a PIN state, a sentence like "my pin is 1234", "wallet pin 4321 please" or "the wicode is 12345678" passed every guard: the redactor only labelled `code`/`otp` phrases, bare 4-6 digit messages and 12+ digit runs. The line went to OpenAI as typed, was stored as typed in `conversation_turns`, and was re-fed on every turn until retention deleted it.
- **Root cause:** the redactor's labelled-secret pattern did not know the words "pin" and "wicode"; the agent sent the raw text rather than the memory form.
- **Fix:** `LOGIN_CODE_RE` covers `pin` and `wicode`; the agent's current line is the redacted form (amounts and phone numbers survive, so slot filling is unaffected); a bare 12-digit OTT PIN (twelve digits or three groups of four) is a guard like the 16-digit Blu PIN.
- **Guard:** `tests/phase2-review.test.mjs` (H1).

## 65. Raw inbound text (a voucher PIN included) was written to the Vercel logs before any guard ran

- **Symptom:** found by the same review. The webhook logged the whole Meta payload, and the processor logged the inbound text twice, before the voucher-PIN guard or the redactor saw it. A customer pasting a 16-digit Blu PIN or "voucher pin 1234567890123456" put a bearer secret in the log retention.
- **Root cause:** debugging logs from the first build, never revisited when the bearer rules were written.
- **Fix:** every inbound log line passes `redactForMemory` (the webhook body as a JSON string, the processor's two lines).
- **Guard:** `tests/phase2-review.test.mjs` (H2); the standing rule stays: voucher PINs, wiCodes and STS tokens are never logged.

## 64. "my pin is 1234" in a PIN state would have escaped to the model, PIN included

- **Symptom (found 2026-09-16 by the pre-ship review of Phase 0, never live):** after #58 made every PIN state strict, a sentence that failed the shape check fell to `isConversationalEscape`, which is true for any two-word sentence; "my pin is 1234" would have cleared the state silently and been routed to the AI with the clear-text PIN, and stored in memory.
- **Root cause:** the escape check did not consider that the sentence might be carrying the secret it was waiting for.
- **Fix:** in all eight PIN states a message that contains a 4 to 6 digit run never escapes; the customer is asked for just the digits. `redactForMemory` also treats a message that is nothing but 4 to 6 digits as a PIN wherever it lands (a lockout clears the state, then the customer sends the PIN again), and login codes in outbound copy are masked.
- **Guard:** `tests/phase0-review.test.mjs` (redaction cases; every PIN state's escape is guarded), `tests/turns.test.mjs`.

## 63. GetPaymentStatus request errors would have released every parked pay-out

- **Symptom (found 2026-09-16 by the pre-ship review of Phase 0, never live):** `classifyPayoutStatus` maps OTT status -1 (auth), 1 (invalid logon) and 2 (invalid hash) to RELEASE, which is right for PerformPayout (nothing was paid) and wrong for GetPaymentStatus (our query failed; the pay-out may be in flight or paid). The new automatic sweeps (cron route, daily floor, on-inbound reconcile) and `reconcileInitPayout` fed those codes into the release path: a rotated or mistyped API key at 03:00 would have released every held pay-out and told every customer the money was back while the bank rail paid them.
- **Root cause:** one status table shared by two endpoints with different semantics for request-level errors.
- **Fix:** `reconcilePayout` and `reconcileInitPayout` treat -1, 1 and 2 as indeterminate (`checked: false`, `REQUEST_ERROR`), touch nothing and log `payout_reconcile_request_error`. The INIT grace period is clamped to at least five minutes inside `reconcilePendingPayouts` and in the cron route (PerformPayout can take 20 s). The sweep also has a deadline (35 s default, 20 s and five rows inside the daily cron) so a slow rail can never push the function past its 60 s cap, and a failed customer notification is counted as `notifyFailed`, not as told.
- **Guard:** `tests/phase0-review.test.mjs` (deadline; notify accounting), `tests/payout-reconcile.test.mjs`; the request-error rule is exercised by the sweep tests' status stubs and locked by the constant `REQUEST_ERROR_STATUSES`.

## 62. The model never saw the customer's side of the conversation, and the current message was in its prompt twice

- **Symptom (founder review 4, 2026-09-16; recon §3):** only 3 code paths stored the customer's own words (the AI path, the fee hook, the how-it-works hook) against 59 that stored the bot's, so the five history lines the model saw were mostly its own earlier replies; the current message was written to the ring before the ring was read, so it appeared in the prompt twice and effective recall was four turns; every write was a non-atomic rewrite of the whole `conversationData` JSON column.
- **Root cause:** history lived in a 10-entry JSON ring written ad hoc at each call site.
- **Fix:** an append-only `conversation_turns` table (migration `20260916_conversation_turns`, applied to production 2026-09-16), `lib/turns.js` (redaction before storage, recent turns oldest-first with the current message excluded by its WhatsApp message id, age markers, 30-day purge in the daily cron, erase), and `lib/say.js`, a drop-in for `sendWhatsAppText` that records the assistant side by construction; the processor and every out-of-band sender (OTT pay-out webhook, reconcile route, ITN, card settlement, Didit, request notify) import it. The customer's side is recorded once per inbound in `handlePostOnboarding` (onboarding turns never; PIN-state turns with digits hidden). The model now gets the last 12 turns of both sides.
- **Guard:** `tests/turns.test.mjs` (22 cases: every redaction pattern including the withdraw confirm text with an account and ID number, exclusion of the current message, oldest-first order, say records only on a successful send and splits over 4,000 chars); `tests/orchestrator-routing.test.mjs` wiring locks.

## 61. A pay-out that crashed between the balance upgrade and the rail call sat at INIT forever with the customer's money held

- **Symptom (found 2026-09-16 by the architecture review):** `requestPayout` creates the row as INIT, posts SPEND to CASH, reserves the CASH hold, then calls `performPayout`; a function death or throw anywhere in between left an INIT row that `reconcilePendingPayouts` (PENDING only) never looked at, and a replay of the same intent returned `{ ok: true, status: 'FAILED' }`.
- **Root cause:** the reconcile sweep was written for the PENDING case (BUGLOG #53) only.
- **Fix:** `reconcileInitPayout` in `lib/payouts.js`: asks OTT GetPaymentStatus by our reference (never a second PerformPayout); a settle answer with a hold present finalises through `finalisePayout`; a pending answer moves the row to PENDING for the normal sweep; no record or a failure answer releases the hold only if it exists and is ACTIVE, posts the downgrade only if the upgrade entry exists, and marks the row FAILED `INIT_ABANDONED_<status>`; anything inconsistent (settle without a hold, hold already settled but the rail says release) is parked as `NEEDS_OPERATOR` and nothing moves. `reconcilePendingPayouts` now sweeps PENDING and INIT rows older than their grace periods and isolates a throwing row. `sweepPayoutsAndNotify` tells each finalised customer with the shared wording; it runs from `GET /api/cron/payout-reconcile` (cron header, CRON_SECRET or the internal key), as a daily floor inside `daily-vas-sync`, and opportunistically on a customer's next inbound message when a PENDING pay-out is older than two minutes.
- **Guard:** `tests/payout-reconcile.test.mjs` (10 new cases over a stub ledger that mirrors journal and hold state; the sweep never calls performPayout); `tests/truth-per-user.test.mjs` (the inbound hook uses GetPaymentStatus only).

## 60. A turn that threw before replying lost the message for good

- **Symptom (found 2026-09-16 by the architecture review):** the webhook claimed the WhatsApp message id BEFORE processing, never released the claim, and acknowledged every error to Meta with 200, so a turn that threw (or was killed at the 60-second cap) was never redelivered and the customer got silence.
- **Root cause:** the dedupe claim (BUGLOG #7, #5) had no failure path; "errors still ACK 200 so Meta does not retry-storm" was the deliberate rule.
- **Fix:** `releaseClaim` in `lib/ledger-post.js`; the webhook wraps each turn, and when a turn throws with the outbound send counter unchanged it releases the claim and answers 500 so Meta redelivers; a throw after something was sent keeps the claim (200) so the customer is never answered twice. The typing indicator (`sendTypingIndicator`, read receipt plus typing for up to 25 s) is sent right after the claim for text messages, so the customer sees activity within half a second.
- **Guard:** `tests/webhook-wiring.test.mjs` (ordering claim < typing < process, the 500 branch before the intact 200 ACK, no fire-and-forget) and `tests/typing-indicator.test.mjs` (payload fields, abort timeout, counter increments only on customer sends).

## 56. Three VAS execute routes were public and verified the PIN before checking who owned the preview

- **Symptom (found 2026-09-16 by the architecture review, no incident known):** `/api/vas/airtime|data|electricity/execute` never called `requireInternalAuth` (only the voucher and fuel routes and the five previews did), so anyone with a customer's account id could POST to them; they called `verifyPIN` before loading the preview and checking ownership, so ten wrong guesses hard-locked a victim's PIN; and their outer catch had no `releaseHold`, so a crash between `reserveHold` and the provider call stranded the customer's money (the BUGLOG #15 discipline had been applied only to the two newest routes). `docs/CAPABILITIES.md` claimed all execute routes required the key.
- **Root cause:** the internal-auth guard and the crash-release pattern were retrofitted route by route and the three oldest were missed.
- **Fix:** all three routes require the internal key, load and validate the preview and its owner before `verifyPIN`, hoist the hold idemKey and release it in the outer catch when the provider did not deliver; when the provider delivered and the settle failed the hold is left in place and `vas_<route>_settle_failed_after_delivery` is logged for an operator (money is never returned for a delivered product).
- **Guard:** `tests/vas-execute-ledger-pattern.test.mjs` (internal-only, ownership before PIN, crash release present in all three).

## 59. "Balance" could show the CASH wallet once a customer had tried to withdraw

- **Symptom (found 2026-09-16 by the architecture review, not yet seen live):** `getUserBalance` and the airtime, data and electricity preview routes read `account.wallets[0]` with no `balanceType` filter. The first withdrawal attempt creates a CASH wallet (`lib/payouts.js` ensureWallet CASH), after which Prisma returns the two wallets in undefined order, so "balance" and the preview's balance check could silently use the wrong wallet.
- **Root cause:** the readers predate the two-wallet model; the schema comment on `Wallet` names this exact bug as the reason for the `(accountId, balanceType)` unique constraint, but the readers were never updated.
- **Fix:** `getUserBalance` includes wallets `where: { balanceType: 'SPEND' }`; the three preview routes pick the SPEND wallet explicitly.
- **Guard:** `tests/truth-per-user.test.mjs` ("balance readers select the SPEND wallet").

## 58. Six of nine wallet-PIN states fed stripped digits to verifyPIN, so a sentence with incidental digits burned an attempt

- **Symptom (found 2026-09-16 by the architecture review):** `DATA_PIN`, `AIRTIME_PIN`, `ELECTRICITY_PIN`, `FUEL_PIN`, `VOUCHER_GIFT_PIN` did `text.replace(/[^\d]/g, '')` and accepted any 4 to 6 digit residue; `VOUCHER_PIN_RESEND_AUTH` accepted any 4+ digit residue. "send R50 to 0831" inside a PIN state became the attempt "500831" and counted toward the lockout (invariant 9, BUGLOG #19 fixed only `PAYOUT_PIN` and `PAYREQ_PIN`).
- **Root cause:** the fix for #19 was applied to the two newest states, not to the seven older ones.
- **Fix:** every PIN state now requires `/^\d{4,6}$/` on the trimmed text before `verifyPIN`; a real sentence escapes to the router through `isConversationalEscape`, a bare word re-prompts, and the existing "no digits at all cancels the purchase" behaviour is kept.
- **Guard:** `tests/truth-per-user.test.mjs` ("every wallet-PIN state accepts only PIN-shaped input") asserts the strict regex in all eight states and that `const pin = digitsOnly` no longer exists; `tests/fuel-flow.test.mjs` lock updated.

## 57. The AI told non-pilot customers withdrawals were live while the home card said "coming soon"

- **Symptom (found 2026-09-16 by the architecture review; live exposure since `3a40272` set `WAPAY_PAYOUT_ALLOWLIST`):** `renderHome`, the withdraw matcher gate and `howItWorksContext` use the per-customer `payoutAllowedFor(from)`, but `handleAIChat` called `buildBrainKnowledge({ wicodeLive })` without `withdrawLive`, so the knowledge block defaulted to the GLOBAL `payoutLive()` ("WITHDRAWALS ARE LIVE ... tell them to type withdraw R<amount> ... NEVER say coming soon"), and `PRODUCT_TRUTH` in the orchestrator read `process.env.WAPAY_PAYOUT_ENABLED` raw. `handleFeeAsk`, `buildSpendDestinationsReply` (the HELP fallback) and `handleListVasProducts` had the same gap. A non-pilot customer typing "withdraw R200" skipped the gated matcher and landed in the AI again, which repeated the instruction.
- **Root cause:** the pilot gate (`3a40272`) was retrofitted at the flow entry and the home card only; the guard test grepped for `payoutEnabled()` and passed.
- **Fix:** `withdrawLive: payoutAllowedFor(from)` threaded into `buildBrainKnowledge`, `buildSpendDestinationsReply`, `spendDestinationLines`, `feeAnswer` and `feeFacts`; `orchestrate()` takes `withdrawLive` in its options and `PRODUCT_TRUTH(withdrawLive)` and the MONEY/SEND domain prompts render from the argument (default: the global switch, so nothing else changes).
- **Guard:** `tests/truth-per-user.test.mjs` (knowledge, fee answer, spend reply and prompt follow the per-customer flag; no prompt string reads the env); locks in `tests/fee-facts.test.mjs`, `tests/help-conversational.test.mjs`, `tests/orchestrator-routing.test.mjs` updated to the gated call shapes. The structural fix is the registry (`docs/AGENT_ARCHITECTURE_V2.md` C7): one `liveFor(waId)` per capability that every surface and the tool list read.

## 55. A syntax error in the message processor passed the whole unit suite

- **Symptom (2026-09-16, caught by the build and the live harness, never by `node --test`):** a new parameter named `text` collided with an existing `let text` inside `handleDepositStatus`; 633 unit tests stayed green.
- **Root cause:** every lock on the processor reads the file as a string and asserts on regexes. Nothing in the suite ever imported the module, so a file that could not parse was invisible to it.
- **Fix:** parameter renamed (`rawText`).
- **Guard:** `tests/processor-loads.test.mjs` imports `pages/api/webhooks/message-processor-v2.js`; a file that does not evaluate now fails the suite, not the deploy.

## 54. "Did my payment go through?" answered a question about last night's R50 withdrawal with a weeks-old R20 deposit, twice

- **Symptom (founder screenshots, 2026-09-16 08:35):** "Did my payment to tbh go through" and then "No my payment to my fnb account I did last night?" were both answered "✅ Your R20 deposit was received. 💰 Balance: R8.00". The R50 PayShap from 21:52 the night before was never mentioned.
- **Root cause:** the deterministic status matcher and the AI's `DEPOSIT_STATUS` action both land in `handleDepositStatus`, which only ever read the newest PAYFAST deposit intent. No pay-out lookup existed anywhere in the chat (recon §3: "did my withdrawal go through" cannot be answered), so the words "to my fnb account" changed nothing.
- **Fix:** the handler reads the newest deposit AND the newest pay-out (`getLatestPayout`), answers about the one the customer's words point at (bank / account / FNB / withdraw / PayShap → pay-out; deposit / card / PayFast → deposit) or the newest of the two, and a PENDING pay-out is reconciled with OTT live before the answer is composed (`handlePayoutStatus`); the balance is read after the reconcile. Withdrawal phrasings ("did my withdrawal go through", "withdrawal status") now reach the deterministic lookup too.
- **Guard:** `tests/payout-reconcile.test.mjs` (matcher phrasings; static: both call sites pass the words, the pay-out branch exists, PENDING calls `reconcilePayout` before `getUserBalance`, every reply carries the live balance).

## 53. A pay-out OTT answered with a code we do not know sat PENDING forever: nothing recorded, no webhook, nothing to reconcile from

- **Symptom (founder's first live PayShap, 2026-09-15 21:52, reference WPC15800A7BD6637, R50 + R8):** the chat said "Sent … I'll message you the moment the bank confirms it, usually within minutes". Fourteen hours later the row was still `PENDING`, `outcome: UNKNOWN`, `reconcileRequired: false`, `responseJson: null`, R58 held in CASH, and no message had gone out.
- **Root cause:** three gaps. (1) `classifyPayoutStatus` maps an unknown code to PENDING (correct: we may have paid) but `requestPayout` recorded only the outcome word, never OTT's status code or body, so nobody could see what the sandbox said. (2) `reconcileRequired` was set only for transport failures and status 3, so UNKNOWN was not even flagged. (3) `getPaymentStatus` existed in the client with no caller: the webhook was the only finaliser, and OTT's sandbox does not send one.
- **Fix:** the PENDING record keeps `providerStatus`, `httpStatus` and a masked 300-char `providerBody`, and UNKNOWN sets `reconcileRequired`. `reconcilePayout(reference)` asks `GetPaymentStatus` and applies only a KNOWN terminal answer through `finalisePayout` (100 settles; a failure code releases and returns the money); 98/99/unknown stamp `lastProviderStatus`/`lastCheckedAt` and leave the hold; a transport failure changes nothing; never a second `PerformPayout`. `reconcilePendingPayouts` sweeps rows older than a grace period. `GET /api/internal/payout-reconcile[?reference=…]` (internal key) runs either and tells the customer with the same wording as the webhook (`payoutOutcomeMessage`, now the single source for both). The chat's status answer uses the same reconcile (BUGLOG #54).
- **Guard:** `tests/payout-reconcile.test.mjs` (unknown code recorded masked + flagged; 100 settles; 97 releases and the money is back; 98/unknown/transport leave the hold ACTIVE; sweep honours the grace period; route gated and unable to start a pay-out; webhook uses the shared wording).
- **Resolution for the parked row (2026-09-16 13:02 SAST):** the reconcile route asked OTT; `GetPaymentStatus` answered `status 0, "Failed to retrieve record"` (no payout on their side) → hold released, R58 back in the founder's SPEND (R66.00), row `FAILED / PROVIDER_0`, founder messaged. Confirm with OTT that status 0 there always means "no record".
- **Still open:** no scheduler calls the sweep (Vercel Hobby crons are daily); the internal route is the operator's tool until a cron or the customer's own question triggers it.

## 52. Below the minimum, the same line three times: "Please enter an amount between R50 and R3000"

- **Symptom (founder screenshots, 2026-09-15 evening):** "Withdraw 30", Absa, then "20" three times, each answered with the same line. Absa's minimum is R50 while Nedbank and FNB start at R20, and nothing said so or offered a way to change method ("Home" cancelled the whole withdrawal).
- **Fix:** the message names the amount, the minimum and the method, lists the methods that DO allow the amount with their menu numbers, and offers *back* to return to the method menu keeping the amount (`validateAmount`, `back|change|options` words in `handleWithdrawReply`, checked before the cancel words). Over-maximum gets its own message. Locked by the payout-chat below-minimum test and the funded harness scenario.

## 51. "Can I withdraw money?" and "Can I withdraw at an Absa ATM?" got the same four-step wall of text

- **Symptom:** the knowledge-base answer (BUGLOG #48) was the full walkthrough for every phrasing. The founder: "it should be specific to my question, then say I can take you through it step by step".
- **Fix:** every topic has a short, question-aware `brief` (the method named, its fee, its minimum, what is needed; for OTT: a yes/no by merchant, the no-cash answer, or where it works) followed by an offer; "how do I / instructions / once I get the PIN / at the ATM" gets the walkthrough with the collection steps for the named bank (`wantsSteps`, `detectMethod`, `collectionSteps`). A `HOWTO_OFFER` state makes *YES* start the flow (with the named method pre-selected) and *more* give the walkthrough; anything else is routed normally. Locked by `tests/how-it-works.test.mjs` and the harness scenario "Can I withdraw at an Absa ATM?" → YES.

## 50. A withdrawal parked at 08:49 still answered "Just the amount" to "Hello" at 20:33

- **Symptom:** conversation states never expired, and greetings inside a flow were treated as flow input; "Home" only cancelled, a second "Home" was needed to see the home screen.
- **Fix:** `updateConversationState` stamps `stateSetAt`; the processor expires any state older than `WAPAY_STATE_IDLE_MINUTES` (default 30, and any unstamped legacy state) before routing, and *hi / hello / hey / home / menu / start* (plus common SA greetings) go straight to the home screen from inside any flow, like a banking app's home button. Locked by the harness idle scenario (a state parked 12 hours ago, then "Hello").

## 49. "Are OTT vouchers accepted?" deflected to a website; "Is it accepted at Checkers?" could not be answered

- **Symptom (founder screenshots, 2026-09-15):** "Yes… check ottvoucher.com for the full list" and "I can't confirm Checkers specifically right now". The founder: "we have to be able to give an answer, not direct the user to the website".
- **Root cause:** `ottAcceptedFacts()` named categories only, by design (policy safety: most OTT partners are betting operators), and no merchant data existed anywhere in the codebase.
- **Fix:** `lib/ott-acceptance.js`, researched 2026-09-15 from ottvoucher.com (partner wall, FAQ, Voucher and App Terms of 26 Jan 2026) and merchant sites: eleven named non-betting partners (Talk360, fibertime, ikeja, Capitec Connect, megsApp, Simplex, Pay@, Xash, FoondaMate, LAYAWAY, ShopCover), twenty-five named non-acceptors customers ask about (every supermarket till, Takealot, Netflix, Showmax, Spotify, DStv direct, the networks' own sites), the 12-digit PIN (not 16), single-use, change to an OTT Wallet only with some partners, 36-month expiry, no cash-out, partner caps, OTT support WhatsApp. `lookupOttMerchant` answers yes/no by name; the AI knowledge carries the same facts; betting operators are deliberately absent (Meta policy). Locked by `tests/ott-acceptance.test.mjs`; generated reference in `docs/CONVERSATION_KNOWLEDGE_BASE.md`.

## 48. Questions started flows: "Can I buy electricity?" opened the meter ask, "Can they withdraw the OTT voucher for money?" started a withdrawal, a mid-flow question was read as a menu choice

- **Symptom (founder screenshots, 2026-09-15):** capability questions were treated as commands; inside the withdraw flow "If I send someone money, can they withdraw it?" got "Reply 1, 2 or 3", and "Does it work when I send cash to an ATM? How do I withdraw the money?" was parsed as method 3 because it contained "ATM".
- **Root cause:** nothing in the router distinguished a question from an imperative. `productQueryIndicators` explicitly routed "can I buy…" to the product flow, the withdraw matcher fired on the word "withdraw" in any sentence, and the `PAYOUT_*` states parsed every reply as step input.
- **Fix:** `lib/how-it-works.js`, a per-transaction knowledge base (withdraw, send, OTT voucher, electricity, airtime, data, deposit, request, fuel, balance, business) with steps, real limits and fees from the same functions the flows use, and the exact words to start. `matchHowItWorksAsk` fires only on question-shaped text without an amount or a number, and runs after the fee hook and before the withdraw command matcher. Inside the withdraw flow a question is answered and the step repeated (`stepInputParses`, `answerAside`, `reprompt`); a name match inside a sentence is no longer a menu choice. The AI knowledge carries the same HOW IT WORKS block. Locked by `tests/how-it-works.test.mjs` and the payout-chat aside test; chat QA scenario "How it works".

## 47. Every OTT payout provider requires the recipient's ID number, and PayShap requires account number + branch code; the chat flow collected neither for PayShap

- **Symptom (probe 2026-09-15, after the providers were activated):** `GetActiveProvidersLimits` marks `id_number` and `mobile` Required for all four providers and `account_Number` + `branch_Code` Required for PayShap Account; the portal shows system minimums of R50 (PayShap, ABSA CashSend) the API omits when the merchant override is 0. Our chat asked PayShap customers for a cellphone number only and allowed R20.
- **Fix:** `cleanRecipient` enforces the live provider's required fields (with `RECIPIENT_FIELDS` passthrough for the extra OTT fields); `methodLimits` narrows the product limits by the provider's, with `SYSTEM_LIMITS_CENTS` as the fallback for the portal's system minimums; `requestPayout` resolves the provider before validating and refuses below-minimum or incomplete requests before any ledger call; the chat offers only methods with a live provider (no RTC on the test merchant), quotes each method's minimum, collects account number + bank for PayShap, and asks for the 13-digit ID number when the provider requires it (`PAYOUT_ID`). CashSend copy now says Absa ATM or Pick n Pay / Boxer till (the mapped provider is ABSA CashSend).

## 46. OTT's live provider list mapped to nothing because the limits endpoint answers in a different shape

- **Symptom:** with four providers active in the OTT portal, `/api/internal/payout-status` showed `mapped: []`, so every pay-out would have been refused `NO_PROVIDER`.
- **Root cause:** `resolveProviders` preferred `GetActiveProvidersLimits` and read `body.providers`; that endpoint returns the provider array under `requiredFields`, each entry carrying `providerMinLimit`, `providerMaxLimit` and a `requiredFields` array holding one `{ field: 'Required' | 'Optional' }` object with OTT's own casing (`account_Number`, `branch_Code`, `iD_type`).
- **Fix:** accept both shapes, normalise field names (`normaliseFieldName`), parse Required entries (`requiredFieldNames`), rand limits to cents. Locked by the OTT-shape test in `tests/payouts.test.mjs`; verified in production: PayShap Account 127 and ABSA CashSend 112 map with R50 to R3,000 and their field lists.

## 45. "What can I buy with this?" answered with a hard-coded three-item list

- **Symptom (founder screenshots, 2026-09-13):** after a R20 deposit the founder asked "What can I buy with this?" and got "WaPay VAS Products: Mobile Airtime, Data Bundles, Prepaid Electricity" with a Read more fold. No vouchers, no send money, no get paid, no withdrawals, no fuel, while "where can I spend my money" gets the warm catalogue answer.
- **Root cause:** `detectExplicitIntent` routes "what can I buy" to `LIST_VAS_PRODUCTS`, and `handleListVasProducts` rendered a static `categoryNames` map with three keys over a `prisma.vasProduct.groupBy` whose rows are all Blu. It never read `lib/spend-catalogue.js`, the module that declares itself the single source of "where WaPay money works". Fuel can never appear there for two independent reasons: no FUEL key in the map and no Yoyo rows in the table.
- **Fix:** the handler opens with `spendDestinationLines()` (vouchers, send, get paid, withdraw when live, fuel when live) and then lists the live prepaid categories. Locked by `tests/fee-facts.test.mjs`; covered in the chat QA harness.
- **Wider lesson (recon 2026-09-13):** product truth was hand-written in at least six places (PRODUCT_TRUTH in the AI prompt, the home menu's Buy line, the Help Menu, the no-OpenAI fallback, the onboarding welcome, this list). See `docs/AGENT_ARCHITECTURE_RECON.md`.

## 44. "How much does it cost to deposit money?" got the Add Money menu, then a refusal to quote

- **Symptom (founder screenshots, 2026-09-13):** the price question returned the two-option Add Money menu; "But how much does it cost?" returned "I can't quote a cash-out fee yet"; "how much do cash deposits cost?" returned "the till may charge its own fee, so I can't quote that part"; "and online card deposits?" described the link without a number.
- **Root cause (two, stacked):** (1) the deposit keyword trap in `detectExplicitIntent` (`/(deposit|add|load|put)\s+(money|…)/` and `includes('deposit money')`) classified the question as `REDEEM_VOUCHER` at confidence 1.0 and parked the customer in `AWAITING_VOUCHER_PIN`; (2) no fee existed anywhere the bot could read: `depositFeeCents` (4.2% + R2.30, rounded up) was only ever stated after a checkout intent was minted, PRODUCT_TRUTH carried no deposit fee, the knowledge block carried no fee at all, and MONEY_TRUTH_RULES forbids inventing numbers. The Blu voucher load keeps 6% (R100 credits R94) and that was disclosed only in the success message.
- **Fix:** `lib/fee-facts.js` computes every customer-facing fee from the charging functions (`depositFeeCents`, `paymentRequestFeeCents`, `FEES.load`, `FEES.voucherGift`, `cashoutFeeCents`); `matchFeeAsk` + `handleFeeAsk` answer price questions deterministically BEFORE the keyword router and the withdraw matcher (with an exact quote when an amount is named), the deposit trap ignores cost words, and `feeFacts()` is injected into the AI's knowledge every turn as "FEES YOU CAN QUOTE". Locked by `tests/fee-facts.test.mjs`; the exact founder exchange is a chat QA scenario.

## 43. With payouts switched ON the AI still told customers cash-out was "coming soon"

- **Symptom (founder screenshots, 2026-09-13, `WAPAY_PAYOUT_ENABLED=true` in production since 2026-09-11):** "Not yet, but cash-out is coming soon through our payouts partner…" and "I can't quote a cash-out fee yet because withdrawals are not live".
- **Root cause:** the cash-out truth existed in five places and only two followed the switch. `buildBrainKnowledge()` in `lib/spend-catalogue.js` pushed an UNGATED "withdrawals are not available YET but are COMING SOON through our payouts partner" paragraph into every tier-2 prompt, labelled as authoritative and placed after PRODUCT_TRUTH; the MONEY and SEND specialist prompts hard-coded "spend-only, no cash-out"; `spendDestinationLines()` had no withdraw line; `cashoutScript()`, the one function written to flip, had no caller; and PRODUCT_TRUTH itself was a module-level constant, so the flag was read once at import. The test suite pinned the coming-soon text and never exercised the knowledge block with the flag on. A phrasing the withdraw matcher missed ("cash-out" with a hyphen, "take my money out") went straight to that prompt.
- **Fix:** the knowledge block, the spend lines, the MONEY/SEND prompt lines and PRODUCT_TRUTH (now a function) all read `WAPAY_PAYOUT_ENABLED` per call; the live branch tells the model to send the customer to "withdraw R<amount>" and quote the flat fees; the matcher accepts the hyphenated and colloquial phrasings; the AI fallback keeps the customer's real words instead of the literal "withdraw". `packages/ai` rebuilt. Locked by `tests/fee-facts.test.mjs` (flag on and off); the chat QA cash-out scenario is now flag-aware.
- **Guard:** any product truth that depends on a switch must be computed at call time from the same function the flow uses (`payoutEnabled()`, `isCategoryLive()`, `isWicodeLive()`), never copied into a prompt string.

## 42. Portal and admin code pushes never used the approved authentication template (en_US fallback + missing button parameter)

- **Symptom (2026-09-06, while closing #41):** with the internal key on the portal's code request, `diag.tried` showed both template candidates failing with `(#132001) Template name does not exist in the translation`, then `textOk: true`, and two seconds later Meta reported `status-failed-131047` (free-form message outside the 24-hour window). So the portal's "Send me a code" could only ever reach an owner who had chatted with WaPay in the last 24 hours, although `otp_register_step_2` is an APPROVED AUTHENTICATION template in `en`.
- **Root cause (two, stacked):** `sendWhatsAppTemplate` resolves the language from an in-memory catalog that only the webhook path builds; API routes (portal, admin) run with an empty catalog, and the fallback was `en_US`, a language our templates do not have → 132001 on every push. Had the language been right, the send would still have failed: the template carries a copy-code URL button with `{{1}}`, so the send must include a button parameter as well as the body parameter, and every caller sent the body only.
- **Fix:** the sender trusts the caller's language before defaulting to `en_US`; `authTemplateComponents(code)` (in `@wapay/whatsapp`) builds the body + button parameters and is used by the onboarding/PIN-reset OTP, the business portal push and the admin console push. Verified live: a portal code sent to the founder outside the window went `templateOk: true` and Meta reported it sent.
- **Follow-through (2026-09-07 morning):** the founder still had no code because yesterday's sign-in page led with "I have my code from WhatsApp", which requests nothing; they reached the code box and waited. With the template push working, "Send my code" is the primary action again on both consoles and "I already have a code" only opens the box (safe since #40). A code sent at 07:51:54Z was delivered at 07:52:17Z and read at 07:53:39Z (`status-*` pulse rows), which also shows last night's undelivered one was a phone offline overnight, not a number problem.
- **Guard:** `diag` on the internal-key code request shows the rail per attempt; the runbook's step 3 reads it. Any template configured via `WAPAY_TEMPLATE_BUSINESS_OTP` / `WAPAY_TEMPLATE_ADMIN_OTP` must be an authentication template with the copy-code button (Meta's standard shape).

## 41. "Not receiving the OTP": three days without one inbound message, and it was not the webhook

- **Symptom (founder, 2026-09-06 evening):** no code from the business portal, on either path. The database showed **zero inbound WhatsApp messages from anyone since 2026-09-03 18:23Z** (daily traffic before that), so the in-chat `business login` route could not answer, and the portal's free-form push is dropped by Meta outside the 24-hour window.
- **Investigation (all read-only):** `wapay.co.za` now points at the Lovable marketing site (Cloudflare), so a first hypothesis was a dead callback host. The new `GET /api/internal/meta-status` probe (internal key) showed Meta's callback is `https://wapay-api.vercel.app/api/webhooks/whatsapp`, which serves the SAME build as `business.wapay.co.za` (an alias of the one Vercel project); the app is subscribed to the WABA; the phone number is CONNECTED, GREEN; `otp_register_step_2` is an approved AUTHENTICATION template. New **pulse rows** in `processed_messages` (`webhook-ok` / `webhook-401` / `status-*`) then proved the pipe end to end: a portal code sent at 20:35:41Z produced a signed Meta webhook processed at 20:35:43Z.
- **Root cause:** not infrastructure. Nothing was posted to the number for three days: the founder was pressing the portal's "Send my code" (Meta accepts the free-form text and drops it when the owner has not chatted within 24h) and had not messaged WaPay from the phone. The remaining possibility, Meta not forwarding user messages (app in Development mode forwards only test numbers), is settled by the founder's next `hi`: a `wamid` row appears, or it does not.
- **Fix / guards:** the probe and the pulse rows (`docs/runbooks/whatsapp-inbound-silent.md`), so "no code" is diagnosed from the database in minutes instead of guessed; the admin verifier got the BUGLOG #40 treatment too; both consoles say plainly that the push only delivers inside 24h and lead with the chat command.
- **Found on the way:** the webhook's delivery-status branch tested `change.field === 'message_status'`, a field the Cloud API never sends (statuses arrive under `messages` as `value.statuses`), so sent/delivered/failed callbacks had been ignored since the January build. Fixed the same evening; statuses now log with their error codes and write `status-*` pulse rows. Operators presenting the internal key on the portal's code request also get the send diagnostics (which template failed with which error, whether the free-form fallback carried it).
- **Lesson:** `processed_messages` recency alone cannot distinguish "Meta stopped sending" from "nobody wrote". Always produce traffic you control (an outbound send → status webhook) before touching Meta settings.

## 40. A sign-in code already in the owner's chat stopped working once the portal minted a newer one

- **Symptom (founder test round, 2026-09-06):** "No code yet." The portal's "Send my code" created a `biz:` row at 09:43Z that Meta accepted as free-form text and dropped (the founder's last chat with WaPay was 3 Sept, outside the 24-hour window, the BUGLOG #33 shape). The rebuilt sign-in page then led with the chat command `business login`, but its primary button ("I have my code from WhatsApp") still POSTed a code request first, so pressing it after reading a code in the chat minted a NEWER code, which was the only one the verifier compared against: the code in hand failed on the first try, the page said "did not work", and every retry repeated the trap while counting towards the per-source lockout.
- **Root cause:** two things stacked. The verifier consumed and compared only the newest live `biz:` code (`findFirst … orderBy createdAt desc`), and the page conflated "open the code box" with "request a code".
- **Fix:** the primary button only opens the code box (no request); "Send me a code instead" is the only portal push. `verifyBusinessOtp` now consumes EVERY live code in the one attempt and succeeds if the submitted code matches any of them. One attempt per code still holds (a wrong guess burns all of them), the per-source lockout is unchanged, and a code consumed by a racing attempt is never compared.
- **Guard:** `tests/business-portal.test.mjs` "verify: a code already in hand keeps working after a newer one is minted" (chat code, then a newer portal code: the older signs in, both are burned, the newer then fails) and the page assertion that the primary button is `haveCode`, never `requestCode`.
- **Also learned:** `processed_messages.accountId` is never populated in production (0 of 174 rows), so "is this account inside the 24-hour window" cannot be answered from that table without a processor change; the portal push therefore stays best-effort and the chat command stays primary.

## 39. Business nudge "consent" could be manufactured with a typed card-checkout number

- **Symptom (adversarial review 2026-09-05, HIGH, caught pre-ship):** the WaPay-originated "Also send from WaPay" push was allowed for any customer with a prior PAID link. A business could pay its own R5 walk-in link by card, type a VICTIM's number into the pay page's receipt field, let the walk-in linker file that number as a "customer who paid", and then have WaPay message the victim. A business paying its own ticket from its own wallet under a victim's customer row worked the same way.
- **Root cause:** eligibility keyed on `customerId` + a PAID row, and the customer row's number was whatever a card payer typed (`custom_str1` is signed against the PayFast session, not against a person).
- **Fix:** `customerEligibleForNudge` requires a PAID row whose payer is a WaPay account (`payerRef WAPAY:*`) WHOSE NUMBER IS the customer's number, or a customer row bound to such an account. Card payments never count. `markLinkSent` can no longer downgrade a `WAPAY` mark (the once-per-link and per-day caps read that column). The flag stays off by default.
- **Guard:** `tests/business-portal.test.mjs` "nudge: … manufactured consent" drives both attacks and asserts NOT_ELIGIBLE; the downgrade test asserts a later COPY click leaves ALREADY_SENT in force.

## 38. Overview classified card payments as balance payments on the real database (stub hid a missing `select`)

- **Symptom (isolated-schema E2E, 2026-09-05):** `businessOverview` reported card count 0 and fees R0 for a link paid by card, while unit tests were green.
- **Root cause:** the paid-rows query used an explicit Prisma `select` that omitted `status`; `classifyPaid` reads `r.status` and treated `undefined` as not-PAID → balance. The in-memory Prisma stub ignored `select` and returned whole rows, so the unit tests could not see it.
- **Fix:** `status: true` added to the select; fees and method now come from the booked intent (`loadIntents` + `classifyPaid`), never recomputed from today's env.
- **Guard:** the test stub now projects `select` exactly like Prisma (a column not selected is absent), so any code that reads an unselected column fails in unit tests; `tests/e2e/business-e2e.mjs` step "dashboard" asserts card count, fee and net against the real DB.

## 37. "Where is OTT vouchers accepted?" started the voucher PURCHASE flow

- **Symptom (Tasha/founder screenshot, 2026-08-31):** asking where OTT vouchers are
  accepted got "🎟️ OTT Voucher — How much would you like your voucher for?" — a question
  answered with a checkout.
- **Root cause:** `matchOttVoucherSelfRequest` excluded redemption-ish words
  (redeem/load/have/my/…) but had NO interrogative guard, so any sentence containing
  "ott voucher" that wasn't a gift or redemption read as a self-purchase — including
  pure information questions. Same class as BUGLOG #34a, different matcher.
- **Fix:** where/what/why/who/accepted (and "how", except "how much") now fall through
  to the AI, which carries a dedicated policy-safe accepted-at answer
  (`ottAcceptedFacts()` in lib/spend-catalogue.js: categories + ottvoucher.com, betting
  never named). "can I buy an ott voucher?" still purchases.
- **Guard:** `tests/ott-voucher-self.test.mjs` drives five question phrasings against the
  shipped matcher; `pnpm qa:chat` scenario asserts the live brain answers the question
  and never opens the buy flow (11/11).

## 36. PayFast asked known depositors "How can we get hold of you?"

- **Symptom (founder screenshot, 2026-08-31):** loading your own wallet by card, the PayFast page asks for an email/cellphone before showing payment methods — even though the depositor is a signed-in WaPay customer whose number we obviously have.
- **Root cause:** the deposit checkout never passed `cell_number` to PayFast. (The pay-link flow did pass it, but as a raw value — a 27-format number silently fails PayFast's prefill, which expects local 0-format.)
- **Fix:** the deposit checkout now passes the depositor's number, and `@wapay/providers-payfast` normalizes any cell number to local 0-format (27-format converted; invalid input dropped rather than sent broken). `cell_number` was already part of the signed field set, so signatures stay correct.
- **Guard:** `tests/payfast-contact-prefill.test.mjs` — normalization, drop-on-garbage, and static assertions that both flows pass a cell number.

## 35. Yoyo userRef over ~45 chars fails issuance with "General System Error" (caught pre-ship)

- **Symptom (fuel E2E first run, 2026-08-29):** every wiCode issuance through the new
  WaPay→UniFuel pipeline failed at Yoyo with `General System Error` — while the identical
  call with a shorter reference succeeded. Probed on the test env: userRef ≤ 45 chars
  issues, ≥ 47 fails. The WaPay reference `wapay-fuel-preview-fuel-<uuid>` produced a
  66-char userRef.
- **Root cause:** an undocumented Yoyo userRef length limit; UniFuel's own refs
  (`fuel:guest:<uuid>` ≈ 47) sit close to the same cliff, unnoticed because Yoyo's error is
  generic.
- **Fix:** the WaPay execute route builds a COMPACT deterministic reference —
  `wapay-fuel-` + 27 hex chars of the preview UUID, 38 chars total (userRef 44) — and the
  webhook receiver maps references back via `ProviderRequest.providerRef`, never string
  surgery. UniFuel's partner route enforces max 38 (`REFERENCE_SHAPE`).
- **Guard:** `tests/fuel-flow.test.mjs` pins the `.slice(0, 38)` + prefix-strip; the
  fuel E2E (`pnpm qa:fuel`) exercises the real issuance end-to-end.

## 34a. "Where can I spend my WaPay money!" answered with the bare Help Menu (founder screenshot)

- **Symptom (live customer, 2026-08-29):** the exact question got the static
  `📋 WaPay Help Menu` twice. No deterministic matcher was at fault: the tier-1
  orchestrator's fast path defined HELP as "asking what WaPay can do", so a capability
  QUESTION short-circuited to the HELP action — and the dispatch `case 'HELP'` rendered
  every HELP as the same static menu, discarding conversation entirely. The sibling trap:
  "Where can I spend my voucher?" was eaten by the voucher-HISTORY regex, and "Can I buy
  petrol?" by the product-query indicators (generic VAS dump).
- **Fix (three layers):** (1) prompts — fast-path HELP narrowed to bare menu asks, the
  CHAT agent told a subject question is NEVER HELP, and a data-driven claim-gated
  knowledge block (lib/spend-catalogue.js) now rides every tier-2 call; (2) dispatch —
  `case 'HELP'` answers question-shaped input with the warm spend-destinations reply
  (menu only for explicit asks); (3) adjacent matchers — voucher-history excludes how-to
  phrasings, and a no-match product query with concrete residue falls to the AI instead
  of the product dump (recursion-guarded via `viaAi`).
- **Guard:** `tests/help-conversational.test.mjs` (prompt pins, gate regex drives,
  residue behavior) + four `pnpm qa:chat` scenarios asserting question-shaped input never
  gets a bare menu (the founder phrasing verbatim among them).

## 33. Admin login code never arrived — free-form send outside WhatsApp's 24-hour window

- **Symptom (founder's first login, 2026-08-28):** entered the correct number on
  admin.wapay.co.za, never received the 6-digit code. The console gave no error (by design —
  the request endpoint is deliberately not an allowlist oracle).
- **Diagnosis:** two `adm:`-prefixed rows existed in `otp_codes` for the founder's account, so
  the allowlist matched, the account resolved and the code was generated — only DELIVERY
  failed. The last inbound WhatsApp message was 28.6 hours old, so Meta's 24-hour customer
  service window was CLOSED and a free-form text is undeliverable.
- **Root cause:** `requestAdminOtp` sent the code with `sendWhatsAppText` (free-form). That is
  precisely wrong for a login flow: an admin signs in FROM A COMPUTER, so the window is
  normally closed. The onboarding OTP had it right all along — template first
  (`otp_register_step_2`, APPROVED/AUTHENTICATION, delivers outside the window), text as
  fallback.
- **Fix:** admin OTP now sends the approved AUTHENTICATION template first (name overridable
  via `WAPAY_TEMPLATE_ADMIN_OTP`), falling back to free-form only if the template fails. If
  BOTH fail the code row is DELETED, so the admin retries immediately instead of being
  throttled behind a code that never arrived; logged as `admin_otp_undeliverable`. The two
  stranded rows were cleared from prod.
- **Guard:** `tests/admin-console.test.mjs` — template-attempted-first, free-form-not-used-on-
  success, fallback-on-template-failure, undeliverable-row-deleted-and-retry-not-throttled,
  plus a static check that the route wires the template sender.
- **SECOND ROUND — the template path was a dead end.** With an internal-key delivery
  diagnosis added to the request endpoint, production said: `(#132001) Template name does not
  exist in the translation` for BOTH `otp_register` and `otp_register_step_2`, while the
  free-form fallback returned `ok:true` with a message id and still never arrived (Meta
  accepts an out-of-window free-form send, then silently drops it — `ok` means *accepted*,
  not *delivered*). Root cause of the template failure: **templates are approved per WABA**,
  and our catalogue mixes two business accounts (`otp_register_step_2` is approved on
  647978251504290; we send from 801970852418258) — and neither resolved in the requested
  language on the sending account.
- **DURABLE FIX — invert the flow.** Pushing a login code to a closed window is inherently
  fragile, so the admin now REQUESTS it from their phone: messaging **"admin login"** to the
  WaPay number issues the code and replies in-session, where free-form delivery is guaranteed
  and no template is involved. `requestAdminOtpInSession` reuses the same allowlist, throttle,
  daily cap and hashed storage; non-admins get no acknowledgement that the command exists.
  The console's push button still works whenever the window happens to be open, and the login
  screen now tells the user the phone path. Guards: matcher precision against a customer-
  sentence corpus, allowlist gating, throttle parity, hashed-at-rest.
- **Wider lesson:** onboarding has the same latent template failure — it has simply never
  surfaced because onboarding always runs inside an open window, so its free-form fallback
  always carries it. Worth fixing when the WABA/template catalogue is next reconciled.
- **Lesson (applies to every future outbound):** anything the customer/admin has not just
  messaged us about needs a TEMPLATE, not free-form text. Free-form is only safe as a reply
  inside an open session.

## 34. admin.wapay.co.za sits behind Vercel's bot challenge; login button failed silently

- **Symptom (2026-08-28):** with the login code still not arriving, verification of the admin
  host produced a second, independent problem — every automated request to
  `admin.wapay.co.za` returned **403 with `x-vercel-mitigated: challenge`**, while
  `pleasepayme.co.za` returned 200 for the identical path at the same second. Vercel's bot
  protection is enabled on the admin domain and not on the app domain.
- **Impact:** low for humans, high for tooling. A real browser solves the challenge and then
  the APIs answer normally (verified: `/api/admin/auth` returns 200 and a live POST returns
  `{"ok":true}` once the challenge cookie is held). But the FIRST request of a session — the
  page's own auth probe — can be 403'd, and any curl/monitor/uptime check against that host
  fails permanently. It also made every remote verification of the deploy misleading.
- **Second defect found while proving it:** the login button's handler had no error handling —
  `await post(...)` then `setStage('code')`, with nothing catching a rejection and no check of
  the response. A blocked or failed request therefore left the screen visibly unchanged with
  no message, which is indistinguishable from "the app is broken". Now: the number is
  validated before sending, a non-ok response says so, and a network rejection says so.
- **Fix/actions:** UI error handling shipped. The Vercel challenge is a dashboard setting, not
  code: Project → Firewall / Attack Challenge Mode, either disable it for this project or
  exempt `admin.wapay.co.za`. Until then the console still works in a normal browser (solve
  the challenge once), and clearing `WAPAY_ADMIN_HOST` re-opens `/admin` on the app domain as
  an immediate fallback.
- **Verification lesson:** `curl` against a challenged host proves nothing. Confirm a deploy
  by inspecting the served JS bundle from a real browser (that is how the login copy was
  finally verified) or by an authenticated version endpoint.

## 32. Admin console + Didit KYC — 27-agent adversarial review (caught pre-ship 2026-08-28)

The whole admin/KYC surface was reviewed by a 27-finding adversarial workflow BEFORE it saw
prod traffic. The load-bearing catches, all fixed in the same push:

- **CRITICAL — admin allowlist matched last-9-digits only.** `isAdminMsisdn`/`adminAccount`
  reduced numbers to a 9-digit tail, so a foreign/VoIP WhatsApp number sharing an admin's
  last 9 digits could receive the admin OTP and mint a session. **Fix:** normalise to the
  full SA 27-form (`normSa`), resolve the account by exact full-number match, and fail closed
  when 0 or >1 accounts match. Guard: a UK-number-collision test.
- **HIGH — admin OTP shared the `otp_codes` table with customer money-flow OTPs.** Admin
  verify consumed the newest live row of EITHER flow, burning a customer's onboarding code.
  **Fix:** admin codes are namespaced `adm:`+hash and every admin query filters on the
  prefix; the customer flow already matched exact plaintext so it never touched admin rows.
  Plus a daily issuance cap + burn-based lockout against slow brute-force / lockout DoS.
- **HIGH — profile JSON lost-update race.** Every profile writer did read-modify-write on the
  whole column; a KYC merge and a language write on the next message clobbered each other.
  **Fix:** `lib/profile-merge.js` merges in Postgres with jsonb `||` / `jsonb_set`; the KYC
  webhook, `updateProfile`, and the acquisition backfill all use it now.
- **HIGH — KYC webhook could permanently lose the customer notification** (gated on a
  one-shot `changed`) and could regress VERIFIED via a stale decision. **Fix:** notify gated
  only on `notifiedStatus`, 5xx-on-send-fail so Didit retries; a VERIFIED account is never
  downgraded by a different/older session; the decision's `vendor_data` must match the
  account or the write is refused.
- **MEDIUM batch:** metrics truncated at 5000 rows (silent GMV understatement) → aggregated
  in SQL, reversal-correct, counted by account id not wallet code; internal-key compare made
  constant-time; declineReason free text redacted (POPIA); `getOrCreateUser` fabricated-
  account fallback (split-brain) replaced with an upsert + rethrow; dashboard stale-response
  guard; customer balances render all wallets.

**Guard:** `tests/admin-console.test.mjs` + `tests/didit-kyc.test.mjs` (24 base + 8 regression
tests pin every fix above). This is the review-before-ship discipline working as intended —
none of these reached prod.

## 31. Every "what ..." question answered with the products menu

- **Symptom (chat QA harness, first run 2026-08-27):** "What did I tell you my name was?" and "What is my favourite colour?" both got the 🛒 VAS products menu. The third product-query indicator was `/\b(show|list|what|which)\s+(me\s+)?(your\s+)?(the\s+)?/i` — every group after the first word optional, so ANY sentence containing "what " (or which/show/list) read as a product ask at 0.8 confidence and never reached the AI.
- **Root cause:** an intent indicator with no required object — it encoded "starts like a browse ask" instead of "asks about something buyable".
- **Fix:** the indicator now requires a commerce noun within 40 chars: `(airtime|data|bundles?|electricity|vouchers?|products?|deals?|prices?|buy|sell|top up)`. "what can I buy" and "show me Vodacom bundles" still route to products; personal and general questions fall through to the AI (which, with #30 fixed, actually remembers).
- **Guard:** `tests/chat-qa-findings.test.mjs` extracts the REAL indicator array and drives 5 personal questions (must not match) and 7 commerce asks (must match); a second test pins that the bare pattern never returns. The conversational proof lives in `pnpm qa:chat` (memory scenarios).

## 30. Conversation history amnesia on every flow transition

- **Symptom (spotted in code review while building the chat QA harness, confirmed live by its first run 2026-08-27):** tell the bot "my favourite colour is green", start ANY flow ("buy electricity"), cancel it, ask "what is my favourite colour?" — the AI had no idea. `mergeConversationData` rebuilds `conversationData` from `{}` whenever the conversation state changes and re-attached only `processedMessageIds` and `sentErrorKeys` — `history` (the AI's 10-message context window) silently died on every flow entry, exit, and step.
- **Root cause:** history is cross-cutting like the idempotency keys, but the merge treated it as a state slot.
- **Fix:** `lib/conversation-data.js` now carries `history` across state transitions (an explicit `nextData.history` still wins; junk non-array values are dropped, not resurrected).
- **Guard:** `tests/conversation-data.test.mjs` pins history through flow entry, flow exit, explicit override, and junk input; `pnpm qa:chat` scenario "a flow in between does not amnesia the AI" proves it against the live brain and DB.

## 29. "Payment link" ask was invisible to intent detection — meter state ate it

- **Symptom (founder live test 2026-08-27):** mid-electricity-flow (waiting for a meter number), the founder typed "Please create a payment link for R20" and got "❌ That doesn't look like a valid meter number." The universal intent-switch escape (BUGLOG-era fix, founder feedback 2026-08-25) WAS wired globally, but it saw no intent: `matchRequestMoneyAsk` knew "pay me / get paid / payment request / request money" and not the **payment LINK** phrasing customers actually use. With no strong intent detected, the meter state's validator answered — and ELECTRICITY_METER (unlike the request/deposit/voucher states) had no conversational-sentence backstop either. Founder had flagged flow-trapping before; this was the residual phrasing gap.
- **Root cause:** two independent layers each had a hole and the holes lined up: (1) the deterministic intent matcher lacked the most natural phrasing for its own feature; (2) eight slot-collector states (electricity amount/meter, airtime amount/msisdn, data msisdn/network/period, voucher-gift amount) answered unparseable SENTENCES with validation errors instead of escaping to the router.
- **Fix:** `matchRequestMoneyAsk` now matches link asks (create-verb + "pay(ment) link", or "pay(ment) link" + amount) while complaints/questions about a link ("the payment link doesn't work") still fall to the router; all eight collector states got the `isConversationalEscape` → clear state → `handlePostOnboarding` backstop (the REQUEST_MONEY_AMOUNT idiom); and the universal escape now ACKNOWLEDGES the switch ("👍 No problem, switching over. We can come back to the electricity purchase any time.") before the new intent's reply, so the parked flow is parked out loud.
- **Guard:** `tests/intent-switch-payment-link.test.mjs` extracts the REAL matcher + switch detector (no stubs): the founder's exact message must return `REQUEST_MONEY` from `ELECTRICITY_METER`, meter numbers and in-family answers must never escape, all eight states must carry the backstop, and the ack copy is pinned em-dash-free.

## 28. OTT Payout client: amount hash/wire mismatch + two double-spend paths (caught pre-launch)

- **Symptom (adversarial review 2026-08-26, before any live credential existed):** three defects in the new payout client. (a) **BLOCKER** — the hash was computed over the 2dp string `"50.00"` but the body sent `Number("50.00")` → `50`, so OTT would recompute its hash over `"50"` and **every round-rand withdrawal** would fail with status 2 Invalid Hash. My own test asserted `amount === 50`, i.e. it *locked the bug in* and made a green suite meaningless. (b) a transport failure/timeout **threw**, giving the caller no settlement class — if a caller treated "threw" as failure and released the hold, the customer could respend money OTT had already paid. (c) status `3` (duplicate reference) mapped to RELEASE, but with our deterministic epoch-free reference a duplicate means an **earlier attempt already reached OTT and may have succeeded** — releasing double-spends.
- **Root cause:** (a) serialising the amount twice, once for the hash and once for the wire, in different types; (b)/(c) treating "no/negative answer" as "nothing happened" — the classic indeterminate-payment fallacy.
- **Fix:** the wire amount is now the exact hashed 2dp string; transport failures RETURN `{outcome:'TRANSPORT_INDETERMINATE', settlement:'PENDING', reconcileRequired:true}` instead of throwing; status `3` is PENDING+reconcile. The caller contract ("never release on PENDING; after reconcileRequired call getPaymentStatus, never re-issue performPayout") is documented in the module header and `docs/OTT_PAYOUT_API.md`.
- **Guard:** `tests/ott-payout.test.mjs` asserts the wire amount equals the hashed amount as a STRING across 5 amount shapes incl. round rands, drives a real transport error to prove the PENDING outcome, and pins `3` → reconcile. The two OTT golden vectors remain pinned so the crypto can't drift.

## 27. Directed-request relationship gate was self-populatable (phishing surface)

- **Symptom (re-review 2026-08-25, pre-deploy):** the rebuilt directed-request gate ("please pay me R50 from <name/number>") required the target to be the requester's saved beneficiary — but a beneficiary is created UNCONDITIONALLY by sharing a WhatsApp contact card (`rememberBeneficiary`, no money, no target consent). So an attacker could save any victim's number via a contact-card share, then push an unsolicited (label-spoofable) "pay request" nudge into that stranger's WaPay chat and read the requester-side response as a membership-enumeration oracle. The CORE harm (cross-user state plant / auto-pay) was already closed; this was the residual delivery+oracle surface.
- **Fix:** the gate is now a real PRIOR MONEY MOVEMENT — `hasPriorSendTo` (a `PendingGift` from the requester to that recipient exists), applied on BOTH the number and name branches. A prior send is money-backed and cannot be forged for free, and the recipient already received value from the sender (benign). Plus: `safeRequesterLabel` gained a system/authority denylist (wapay/support/admin/…→ neutral label), and the informational nudge is no longer written into the payer's conversation history (kept out of their AI-context window).
- **Guard:** `tests/founder-feedback-0825.test.mjs` requires ≥2 `hasPriorSendTo` gates in the resolver, asserts `isSavedBeneficiary` is gone from it, and locks the denylist + no-history + no-state + no-money properties of delivery.

## 26. Paid-request notifications were one-shot — a lost invocation lost them forever

- **Symptom (founder live test `PRMDCUQA`, R20 card payment, 2026-08-25):** the payment was captured perfectly — payer number stored, request marked PAID, requester credited — but NEITHER the requester's "you've been paid" nor the payer's receipt ever arrived on WhatsApp.
- **Root cause:** both sends were gated on `wonRequestTransition` — winning the atomic PENDING→PAID check-and-set, which by design succeeds exactly once. The ITN route had no `maxDuration` (Vercel default cap) while doing a PayFast server-verify POST-back, ledger posting, and two WhatsApp sends; when the invocation died mid-sends, PayFast's redelivery could not win the transition again, so the notification branch never re-ran. Exactly-once *notification* was implemented as exactly-once *attempt*.
- **Fix:** notifications moved to `lib/request-notify.js` — durable and idempotent: `requesterNotifiedAt`/`payerNotifiedAt` flags in the intent metadata, set ONLY after a send resolves ok; the ITN now runs the helper on EVERY delivery (replayed or not), so redeliveries repair lost sends; `POST /api/admin/notify-request` (internal-key-guarded) repairs manually; `vercel.json` gives the ITN 30s and the WhatsApp webhook 60s.
- **Guard:** behavioral tests drive the helper through send-fails-then-template-rescues and redelivery-never-double-sends paths; statics pin every-delivery invocation (never transition-gated), flags-only-on-ok, and metadata MERGE on flag persist.

## 25. Parallel-session rsync swept another thread's PRE-review code into a push

- **Symptom:** commit `619a285` (amount-change swap) also shipped the in-flight payer-registration feature BEFORE its adversarial-review fixes — prod briefly ran a GET form (payer msisdn into query-string request logs), a hijackable last-click-wins receipt destination, a dead-code template fallback, and a fail-open health config block.
- **Root cause:** two sessions share one git-less fast copy; rsync is tree-wide, so "commit my work" swept every mid-flight file the other session had touched — the commit message described none of it.
- **Fix:** the review-fixed versions pushed the same evening (this commit); window ≈ one deploy cycle.
- **Guard:** process rule — before rsync+commit, run `rsync -rcn --itemize-changes` and inventory every differing path against the tracker; a file you didn't author in THIS session either ships with its author's sign-off visible in the tracker or stays out of the commit (`git add` is selective even when rsync isn't).

## 24. Payer-registration review batch (41-agent adversarial review, 2026-08-22)

- **Symptom (batch, all fixed pre-launch bar the #25 window):** (a) `@wapay/whatsapp` send functions RESOLVE `{ok:false}` — never throw — so a catch-based template fallback was dead code and out-of-window payers silently got no receipt, with zero log evidence; (b) the receipt destination was last-click-wins metadata — anyone holding the link could redirect a paying payer's receipt + PayFast reference to their own number during the whole card-entry + ITN-latency window; (c) the payer's msisdn rode a GET query string into platform request logs; (d) `RECEIPT_CODE_PATTERN` un-anchored under `/i` matched ordinary sentences ("receipt problems" → PROBLEMS, "is my receipt prepared" → PREPARED); (e) `/api/health?config=1` was world-readable until the key existed and leaked two env VALUES its own doc called presence-only; (f) a payer whose card payment landed after the requester cancelled was told "no payment was taken on it".
- **Root cause:** single-session blind spots — assumed exceptions on send failure, trusted mutable shared metadata for a money-adjacent artifact, defaulted fail-open by analogy with internal-auth, pattern-matched user text too loosely.
- **Fix:** branch on the resolved `.ok` with an env-gated template fallback; receipt destination bound to signed `custom_str1` (the ITN persists the true payer back into metadata for the in-chat ref gate); number travels in the POST body only; patterns anchored + restricted to the code alphabet (PAY_REQUEST tightened too); health fails closed with presence-booleans only; intent-status consulted before ever denying a payment.
- **Guard:** `tests/payer-registration.test.mjs` (26 tests) pins every fix: `.ok` branches, `custom_str1` wiring, POST-only payer, the false-positive corpus, fail-closed health, metadata MERGE spreads (mutation-tested), gross-cents receipts, upsell-free push receipts, and the betting/cash-out word ban.

## 17. Every VAS settle idemKey was timestamp-poisoned — vend delivered, customer never charged

- **Symptom:** (latent, would hit every airtime/data/electricity purchase on the new ledger) the provider vends, then `settleHold(buildSpend(...))` throws — the customer keeps the product AND the money.
- **Root cause:** preview ids embedded raw `Date.now()` (`preview-air-1787…`); the derived settle idemKey then trips ledger-core's own timestamp-lookalike guard. Blu voucher redemption had the same class of bug: the SHA-256 PIN-hash prefix looks like an epoch for ~1 in 481 vouchers — after Blu consumed the voucher, stranding the cash.
- **Fix:** preview stamps are base36 (`Date.now().toString(36)`), the redemption idemKey interleaves `x` every 8 hex chars — both provably immune to the guard.
- **Guard:** the guard itself still rejects any regression; found by the 45-agent QA audit 2026-08-21.

## 18. Payment-request card leg was not exactly-once

- **Symptom:** double card charges and double credits were possible (fresh intent + fresh idemKey per checkout click; ITN credited without consulting the request; a crash between credit and mark-paid stranded the request PENDING-and-repayable forever).
- **Root cause:** the two rails used different idemKeys, and mark-paid was gated on `!posted.replayed` and swallowed errors.
- **Fix:** ONE idemKey per request code shared by BOTH rails (`wapay-payreq-<code>`) with one reusable intent — postEntry can only ever credit once across all rails and clicks; mark-paid runs on every delivery (atomic PENDING→PAID); confirmations gate on winning the transition; a replayed entry with a different PayFast ref logs `payfast_overpayment_detected` (CRITICAL_REFUND_NEEDED).
- **Guard:** `tests/payment-requests.test.mjs` locks the unified key, the intent reuse, the absence of the replay gate, and the overpayment scream.

## 19. PAYREQ_PIN burned wallet-PIN attempts on chatty replies

- **Symptom:** five conversational replies at the PIN prompt soft-locked the wallet PIN; ten hard-locked it.
- **Root cause:** every non-cancel message was fed to `verifyPIN`.
- **Fix:** only `\d{4,6}` reaches verifyPIN; sentences escape to the router; anything else re-prompts without burning attempts.
- **Guard:** QA audit finding; PIN-shape gate now mirrors VOUCHER_GIFT_PIN.

## 20. Fee-free self voucher was quoted free but booked the R3 fee

- **Symptom:** self OTT-voucher purchases were silently overcharged R3 (or failed at settle on an exact balance) — the preview quoted 0, `buildVoucherGift` hardcoded the flat fee.
- **Fix:** `buildVoucherGift` takes `flatFeeCentsOverride`; execute passes the preview's quoted fee — the preview is the quote of record.

## 21. Broke-checkout resume was unreachable

- **Symptom:** the pay-the-difference + auto-resume flow never triggered — the processor matched `INSUFFICIENT_FUNDS` but execute returned `USER_INPUT`, and the preview blocked short balances with a generic error first.
- **Fix:** preview and execute both return a distinct `INSUFFICIENT_FUNDS`; the preview path now ALSO enters the checkout flow (shortfall + PayFast link + `RESUME_VOUCHER_PURCHASE`).

## 22. Claiming marked gifts DELIVERED before the send

- **Symptom:** one failed WhatsApp send permanently stranded the recipient's bearer voucher PIN (row DELIVERED, PIN never received).
- **Fix:** `revertGiftDelivery` flips DELIVERED→ISSUED when the send definitively fails (`ok:false`) so the next inbound message retries; applied to the claim flow AND self-purchase delivery.

## 23. Routing/state batch (QA audit 2026-08-21)

One sweep, all fixed: phone-number replies re-parsed as rand amounts in AIRTIME_MSISDN (R7.8m airtime "amounts"); "me" cancelling despite the prompt offering it; "Yebo/Ewe/Ja/Ee" cancelling every confirm state (7 regexes extended); deposit-status questions with amounts minting fresh payment links (status now checked first); a dashed 16-digit voucher PIN minting a R1,234 card checkout; "pay request <word>" matching ordinary words (codes now strictly `PR[A-Z]{6}`); "send an OTT voucher to <name>" hijacked into self-purchase; contact cards shared mid-flow hijacking into send-money; 9+ digit context follow-ups read as rands; "cancel … request" creating a NEW request (cancel now wired: "cancel request PRXXXXXX"); BUY_DATA discarding the agent's English productQuery.

**Known-open (logged, deliberate):** profile write races (last-write-wins acceptable at current volume); language-evidence echo on neutral turns; voucher-history intercept answers recipients with sender-only history; a crash between settleHold and createPendingGift (idempotent retry design exists, no caller retries yet); redemption replay tells the losing account in a same-PIN race "Redeemed Successfully".

## 15. Voucher-execute crash stranded R36 in ACTIVE holds

- **Symptom:** failed voucher sends ("An error occurred while executing purchase") left the reserved money missing from the balance — two ACTIVE holds (R23 + R13) found in prod, wallet R36 lighter than the journal (founder-reported balance confusion, 2026-08-20).
- **Root cause:** an exception between `reserveHold` and the taxonomy failure paths (which do call `releaseHold`) fell through to the outer catch, which returned 500 without releasing the hold.
- **Fix:** `holdIdemKey` is hoisted; the outer catch best-effort releases it (`execute_crashed:` reason). `releaseHold` is status-guarded, so the safety release is a no-op after settle/normal release. Stuck prod holds released with the library function; wallet reconciled.
- **Guard:** `tests/voucher-execute-crash-release.test.mjs`-style static assertion lives in `tests/ott-voucher-self.test.mjs` (crash-release path present); `reconcileWallets()` detects any stored-vs-derived drift.

## 16. Manual credit applied twice — R20 of unbacked balance

- **Symptom:** stored wallet balance exceeded the journal-derived truth by exactly R20 ("real money vs fake money", founder, 2026-08-20).
- **Root cause:** the 2026-08-18 manual R20 credit (PayFast IP-reject recovery) hit the wallet twice: once as a direct wallet update and once properly via `postEntry` (which also increments the wallet). The journal was correct; the stored cache wasn't.
- **Fix:** wallet reconciled to journal truth (R50.00) after releasing the stuck holds; logged as `wallet_reconcile_fix`.
- **Guard:** manual credits are banned as direct wallet updates — `postEntry` only (it is replay-safe by idemKey). `reconcileWallets()` catches drift; run it after any manual intervention.

## 1. Zero-cent commission line crash

- **Symptom:** small vends crashed at posting time; the journal entry was rejected.
- **Root cause:** the fee model rounded commission to 0 cents on small amounts, and the spend builder still emitted the commission posting — a zero-amount line, which the balanced-entry validation (and DB constraints) rightly refuse.
- **Fix:** builders in `lib/ledger-core.js` omit zero-amount postings entirely; the entry stays balanced without them.
- **Guard:** `tests/ledger-core.test.mjs` covers minimum-amount vends; `validateBalanced` rejects zero/invalid lines on every posting, so a regression fails loudly, not silently.

## 2. Electricity execute wrote nonexistent Prisma fields

- **Symptom:** electricity purchases failed at runtime with Prisma validation errors.
- **Root cause:** `pages/api/vas/electricity/execute.js` was written against fields that don't exist in `schema.prisma` — untested code shipped on the old non-atomic pattern.
- **Fix:** rebuilt on the reference hold pattern (ensureWallet → reserveHold → Blu → settleHold/releaseHold), response shape preserved; the phantom fields are gone.
- **Guard:** `tests/vas-electricity-flow.test.mjs` + `tests/vas-execute-ledger-pattern.test.mjs` (statically asserts every execute route follows the hold pattern).

## 3. Balance endpoint: wrong relation + 200-on-error

- **Symptom:** users could be shown R0.00 when the DB was down, and the endpoint queried a Yoyo wallet relation nobody used.
- **Root cause:** `pages/api/wallet/balance.js` swallowed DB errors into a 200-with-zero response — indistinguishable from a genuinely empty wallet — and carried a dead `yoyo` include.
- **Fix:** queries the SPEND wallet; DB failure returns **503 `BALANCE_UNAVAILABLE`**, never a fabricated zero; dead include removed.
- **Guard:** the "never 200-with-zero" rule is asserted in tests; principle recorded here: an error must never look like a balance.

## 4. `Date.now()` idempotency keys (double-vend risk)

- **Symptom:** none observed — caught in review. A provider timeout + retry would have vended twice and debited twice.
- **Root cause:** execute routes built idemKeys from `Date.now()`, so every retry was a "new" operation; idempotency existed in name only.
- **Fix:** idemKeys are deterministic from stable inputs (WhatsApp message id, voucher PIN hash) so a retry replays the same entry; `postEntry` returns the original result.
- **Guard:** DB-unique constraint on idemKey; live-DB verification replays every flow (`scripts/verify-ledger-db.mjs`, 21/21); pattern test bans timestamp-derived keys.

## 5. Webhook accepted unsigned POSTs, no dedupe

- **Symptom:** none observed — caught in review. Anyone who learned the webhook URL could POST a forged message and drive a real money flow; Meta's retries could double-process real ones.
- **Root cause:** signature verification was never implemented; a fallback verify-token had leaked into the repo; no processed-message tracking.
- **Fix:** HMAC (`X-Hub-Signature-256`) verified over the exact raw bytes before anything else — 401 on failure; leaked token removed; `claimMessage` per-message dedupe (availability-over-dedupe on DB error).
- **Guard:** `tests/webhook-security.test.mjs` + `tests/webhook-wiring.test.mjs` (statically enforces verify-before-ACK in the route source).

## 6. Catalog sync: dead endpoint (20 vs 821+ products)

- **Symptom:** the bot only knew ~20 products; most searches found nothing.
- **Root cause:** the sync job called a dead/legacy Blu catalog endpoint that returned a tiny subset, and nothing flagged the shortfall.
- **Fix:** corrected endpoint (`f9b52eb`); catalog now 831 products.
- **Guard:** sync logs product counts as structured JSON; an implausibly small sync is visible in logs. (No automated floor-count alert yet — worth adding.)

## 7. Mute bot: ACK-before-processing on serverless

- **Symptom:** bot went completely silent after the `44b51c9` deploy — webhook returned 200, no replies ever sent.
- **Root cause:** the handler ACKed 200 to Meta, then processed the message in a fire-and-forget async block. Vercel serverless freezes/kills execution after the response, so processing never ran. (The stable January deploy had awaited processing; the regression came in with the refactor.)
- **Fix:** `6096585` — verify → process (awaited) → ACK, which also matches Meta's timeout budget.
- **Guard:** `tests/webhook-wiring.test.mjs` enforces the ordering and bans void-async blocks in the webhook. If the project later needs post-ACK work, use the platform's `waitUntil`, never a bare async block.

## 8. OTT `GetAPIKey` rotates the live key

- **Symptom:** near-miss — discovered in the API docs before it burned us. Calling `GetAPIKey` doesn't *read* the key, it **rotates** it, instantly invalidating the credential every deployed environment is using.
- **Root cause:** an API whose "get" is a destructive write.
- **Fix:** the method is deliberately fenced off in `@wapay/providers-ott`; nothing in the codebase calls it.
- **Guard:** standing rule (tracker + package docs): never call GetAPIKey — in tests, OTT is only ever exercised through undici MockAgent, never the live API.

## 9. iCloud `node_modules` + trailing-space path

- **Symptom:** glacial installs, phantom file changes, and scripts breaking with "no such file or directory" on a path that clearly exists.
- **Root cause:** the working tree lived in iCloud Drive (which syncs/evicts `node_modules` and fights file watchers) inside a directory named `WaPay ` — with a **trailing space** — which silently breaks any unquoted shell path.
- **Fix:** canonical dev copy at `~/Projects/wapay` (fast local disk, no sync); the iCloud folder is documents/strategy only. All scripts quote paths.
- **Guard:** convention recorded here and in the tracker: build and test only in `~/Projects/wapay`; always quote the iCloud path exactly, trailing space included.
