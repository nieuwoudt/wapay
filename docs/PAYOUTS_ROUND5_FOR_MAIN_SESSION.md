# Payouts round 5: what the main session owns, specified (2026-10-12)

*Written by the payouts thread, round 5, for the main session ("WaPay Build v1.3 autonomous loop"), which was not live during this round. The founder approved every item below on 2026-10-12 (`docs/HANDOVER_PAYOUTS_V2.md` §3 and §4). Section A lists the anchored edits this thread made in your files so you can review them; sections B to G are the parts you own, with the exact behaviour, the transcript that motivated it and the test that should hold it. Evidence for everything this thread shipped: `docs/testing/payouts-round5-2026-10-12.md`.*

## A. Anchored edits made in main-session files (review these)

| File | Edit | Item | Why |
|---|---|---|---|
| `lib/turns.js` `redactForMemory` | in `secretInput` states a 6 to 12 character token mixing letters and digits becomes `[hidden]` | 1 | a passport typed at the ID step (AB12C345) was stored whole |
| `pages/api/webhooks/message-processor-v2.js` `handleConversationState` | the state log prints `[withdraw input]` / `[withdraw data]` for `PAYOUT_*` states | 1 | the log printed bank account and ID numbers on every withdraw turn |
| same, `deliverPayoutStep` | passes `step.refs` to `sendWhatsAppText` | 3 | the withdraw gate's id is stored on the turn so repeats are counted in any language |
| `lib/how-it-works.js` | "13-digit ID number" → "SA ID number or passport"; `WITHDRAW_AMOUNT_ASK` leaves the how-it-works topics | 1, 3 | the Lisa case |

Later items in this round add their own rows here (send-to-own-number, the unpaid-link answer, time promises, the save-as hook).

## B. Item 6: a gift to someone not yet on WaPay becomes balance when they join

**Today:** "send money" to a non-member buys a voucher at once (`buildVoucherGift`: sender SPEND debit, `CLEARING:OTT` credit, fee revenue), OTT issues a PIN, a `pending_gifts` row waits ISSUED, and the first message from the recipient delivers the PIN (`claimPendingGifts` → DELIVERED). Lisa's R350 arrived as a PIN on OTT's test host and her balance was R0; the founder moved it with a manual entry (`manual-gift-to-wallet-<giftId>`: `CLEARING:OTT` D 35000, her SPEND C 35000).

**Why the manual entry is not the product:** once issuing is on OTT's production host, the PIN is real money at OTT. Crediting the balance while the PIN stays redeemable pays the recipient twice (memory `voucher-as-balance-rejected`). Reversing `CLEARING:OTT` is only safe when no voucher was ever minted, or it was cancelled at OTT (OTT has no cancel we know of).

**The design (money side, this thread's spec):**
1. **At send time, recipient not on WaPay:** do NOT call OTT. Post a held gift: sender `WALLET:<sender>:SPEND` D amount + fee; `LIABILITY:GIFT_PENDING` C amount; `REVENUE:FEE:SEND` C fee. idemKey `gift-held-<giftId>`. The `pending_gifts` row is created with `rail = 'WAPAY'`, no PIN (the column is NOT NULL today: store a placeholder such as `HELD` or make it nullable in a migration), status ISSUED.
2. **The recipient joins (onboarding completes, or their first message after the account exists):** post `LIABILITY:GIFT_PENDING` D amount; `WALLET:<recipient>:SPEND` C amount. idemKey **`gift-claim-balance-<giftId>`** (`lib/money-situation.js` already treats this prefix as "in the balance"). Mark the row DELIVERED. Tell them in one line: "🎁 Nieuwoudt sent you R350. It is in your WaPay balance: spend it here or say *withdraw* to move it to your bank."
3. **Never joins (expiry, e.g. 30 days):** mint the voucher then (OTT issue) and post `LIABILITY:GIFT_PENDING` D amount; `CLEARING:OTT` C amount less commission; commission revenue when signed. idemKey `gift-expiry-voucher-<giftId>`. Deliver the PIN by SMS or template to the number, or refund the sender instead (`LIABILITY:GIFT_PENDING` D, sender SPEND C): the founder said voucher at expiry; the refund is the simpler fallback if the PIN cannot reach a non-member.
4. **Recipient already on WaPay at send time:** unchanged product decision for you to make (today: a voucher; the same balance credit as step 2 would be consistent with the founder's intent).
5. **Sender's view:** the confirm says "Nieuwoudt does not have WaPay yet. The R350 waits for them and lands in their balance when they join." The pack's `giftsSent` shows HELD until claimed.

**Regulatory note (said once, the founder decided):** a balance credited from another customer's balance is a wallet-to-wallet transfer; `lib/gifting.js` was written to keep gifts a SPEND for the closed-loop posture. This is the same open-pilot stance as the removed allowlist and belongs on the counsel list before a public launch.

**Tests to hold it:** this thread adds the three pure builders to `lib/ledger-core.js` with balanced-entry tests (`buildGiftHeld`, `buildGiftClaimToBalance`, `buildGiftExpiryToVoucher`, item 6 of this round); the wiring test is yours: a gift to a non-member posts `gift-held-*` and calls no OTT client; the recipient's first message posts `gift-claim-balance-*` once (replay safe) and their balance rises by the face value; the PIN is never generated on that path.

## C. Item 8: the gift message and the home card

- **`buildVoucherClaimMessage` (lib/gifting.js):** "Or reply BALANCE to open your own WaPay and use it right here." is wrong twice: the recipient is already in WaPay when it arrives (it is sent on their first message), and a voucher PIN cannot be used in WaPay. This thread makes the anchored copy edit (item 8): the last lines say what the PIN is for and that their WaPay balance is separate ("This voucher is spent at shops that take WaPay vouchers; it is not part of your WaPay balance and cannot be withdrawn."). With item 6 wired, members joining through a gift never see a PIN at all.
- **Home card (`lib/capabilities.js homeLines`, yours):** the line `🏧 *Withdraw*: "withdraw R200" to your bank, or cash at an ATM` is shown to a customer with R0. Spec: `homeLines(ctx)` takes the balance the withdraw flow can use and the smallest need (`payouts.js methodLimits` + `quotePayout`, R58 today); below it, show `🏧 *Withdraw*: to your bank or cash at an ATM once your balance is R58 or more` (no "withdraw R200" call to action); at or above it, the current line. `renderHome` already reads the balance for the header.

## D. Item 10: the agent must never claim to have saved, noted, stored or remembered anything

**Transcripts (production):**
- 2026-10-08 14:43 SAST: the founder, after his first live PayShap: "Yes please save my bank details as mine" → agent: "Done, Nieuwoudt. I have noted that these are your own bank details for withdrawals." Nothing was saved.
- 2026-10-12 12:41 SAST: "can you save my number used abve as mine?" → agent: "Saved, Nieuwoudt 😊 I'll remember that the number used above is yours for next time." Nothing was saved.

**This thread (item 10):** a deterministic hook answers "save my number used above as mine", "call it mother", "name that account mine" by setting the nickname of the most recently used saved destination (`payout_destinations.nickname`), before the agent runs; it says plainly when nothing is saved yet.

**Yours:**
1. Composition policy, both prompts (`packages/ai/src/prompt.ts` COMPOSITION_RULES and `orchestrator.ts` REPLY_SHAPE): "You cannot save, note, store, remember or change any detail. Only the flows do that, and they say so themselves. Never write that you saved, noted, stored or will remember something. If the customer asks you to save or name something, say that it is saved only if the record in front of you shows it; otherwise tell them how: after a withdrawal, answer the save question, or say 'call it <name>'."
2. Output gate (`lib/agent/guards.js`): a rule that rejects a reply matching `/\b(?:I(?:'ve| have)?|I'll|I will)\s+(?:saved|noted|stored|remembered|remember|save|note|store|keep)\b|^\W*(?:saved|noted)\b/i` and substitutes a neutral line, with the founder's two sentences as the test cases.

## E. Item 11: four-digit cellphone labels

Cellphone labels show the last four digits ("Mine: Cellphone •••1175"); ID numbers and bank accounts keep three. The pack and the about-me line read `listPayoutDestinations` labels, so they follow automatically; your own convention (`maskMsisdn` in the pack: `083…4421`) already shows four. Nothing to change on your side unless a test pins "•••175".

## F. Item 12: the deposit flow offers the cash route when the customer's way of paying is not known

The regex path already does this (`message-processor-v2.js` ~1830: no `preferredDepositMethod` → "1️⃣ Cash: Blu Voucher at any till / 2️⃣ Card / bank"). The agent path does not: `case 'DEPOSIT_START'` with an amount goes straight to `handleCardDepositLink`. Spec: the same `getProfile` check in `DEPOSIT_START` (and the agent's deposit tool), so "add 50" from a customer with no known method gets both ways in one message; with a known method, straight to it (the founder's own "add 50 of deposit?" went to the card link correctly, because his method is card).

Caveat to settle first: Blu voucher cash-in runs on Blu's QA host (no Blu production credentials were ever issued, memory `blu-qa-vend-limit`), so a voucher bought at a real till cannot be loaded today. Offer the cash line only when the Blu voucher rail is live for real (a capability flag), or the cash route is a dead end; the OTT voucher joins the cash line once redemption is live (Merchant agreement unsigned).

## G. Item 14: the literacy mechanism, the parts outside the withdraw flow

Built here: `lib/money-situation.js` (`moneySituation`: balance, holds, gifts received and whether each is balance, unpaid links, held pay-outs, ID on file; `situationSentences`; `gateHistory` / `gateRepeatCount` by the gate id stored on the turn) and its first user, the withdraw gate (`lib/payout-gate.js`).

Yours:
1. **The agent reads the same situation:** put `moneySituation()` (or its sentences) into the context pack so the model sees "R350 from Nieuwoudt arrived as a voucher PIN, not balance" and "the R367 link was not paid" before composing.
2. **Intent before vocabulary** in the slot rescue (`lib/agent/slot-rescue.js`, where "50 and 2" lives): "put / move / transfer / pay (in|into|to) my (bank) account", "how much can I withdraw", "withdraw X from waypay" → WITHDRAW; "send money" with the customer's own number → WITHDRAW (item 4 refuses it in the send flow); a received voucher mentioned → VOUCHER-HELP, never BUY. `matchWithdrawAsk` (lib/payout-chat.js) already reads all of these for the regex path; import it rather than writing a second table.
3. **Repeat detection for every reply:** before sending, compare the reply with the last assistant turn; if equal, send the explanation tier instead (what they have, what it can and cannot do, the one next step); the third time offer a person. The withdraw gate does this with `refs.gate`; a generic version belongs in `lib/say.js` or the output gate.
4. **Refusals lead with the customer's money:** "You have R0 to withdraw. …", never "Withdrawals start at R50" first. `situationSentences` is the shared wording.
