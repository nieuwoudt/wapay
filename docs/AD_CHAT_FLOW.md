# Ad chat flow: how the bot answers a person who tapped a WaPay ad

*Baked in 2026-10-18 from the founder's brief of the same day ("WaPay · Ad chat flow
brief", Niev, needed before the Click-to-WhatsApp ads go live; the 224-line revision
with the "what WaPay can do today" list). This document is the
spec of record for the Facebook onboarding journey. The founder expects it to change
after the first campaign; change the copy in `lib/ad-flow.js`, the rules here, and the
tests in `tests/ad-flow.test.mjs` in the same commit.*

## 1. What this covers

People who tap a WaPay ad land in our WhatsApp chat. Meta shows its greeting and four
suggested questions they can tap, or they type their own message. That first message
carries the ad click id, which `getOrCreateUser` stamps on the account before any reply
(`profile.attribution`, see `docs/GROWTH_DASHBOARD.md`). This flow is how the bot answers
each entry point.

**One rule above everything: answer the question briefly, then get the person to an
activated account.** Activated means their first payment link has been created. After
that, help them get paid.

## 2. What WaPay can do today (the bot's source of truth for ad arrivals)

Answers match this list exactly and never offer anything not on it (`CAN_DO` in
`lib/ad-flow.js`).

**Available now**
- Get paid with a payment link. The payer can use any credit, cheque or debit card (Visa,
  Mastercard, American Express, Maestro, Visa Electron), Apple Pay, Samsung Pay, Google
  Pay, Instant EFT, Capitec Pay, SnapScan, Zapper, Scan to Pay, bank QR code apps, RCS
  store cards or MobiCred.
- Top up the WaPay balance electronically, with the same methods.
- Pay other WaPay users, free at any amount.
- Pay out: to any South African bank account with PayShap; as cash at a Nedbank ATM, no
  card needed; as cash at an Absa ATM, no card needed.

**Coming soon** (the bot says "coming soon" and never a date): buying airtime, data,
electricity and fuel; topping up with cash through OTT and Blue Voucher. "Can I deposit
cash?" is answered: not yet, coming soon, top up electronically for now.

Since the launch scope of the same day (`docs/LAUNCH_SCOPE.md`, CHANGELOG 91) this is
true for every customer, not only ad arrivals: airtime, data, electricity, voucher cash
top-ups and the OTT self-purchase read "coming soon" by code default; "send money" stays
live (the round-5 build makes it a ledger transfer).

**Age.** No rule to build (founder, 2026-10-18): anyone with a WhatsApp account may open a
WaPay account; it is not a bank account; a nominal 16 and above, not enforced.

## 3. The path every ad conversation follows

1. **Answer** what they asked, in one short message (`lib/ad-flow.js` `adEntryReply`).
2. **Open the account** using the existing onboarding, without the generic welcome
   template (`startOnboardingFromAd` in `packages/auth`: S0 to S1 recorded silently, the
   OTP step runs at once). Completion fires `LeadSubmitted`.
3. **Create the first payment link straight away.** On completion an ad arrival is asked
   "Who owes you, and how much? Just type it like this: R250 from Thandi for the birthday
   gift." (conversation state `AD_FIRST_LINK`). The answer goes into the existing
   please-pay-me flow, which still shows the cost and asks 1 or 2 above R50, as the Q3
   answer promises. The link fires `QualifiedLead`. This is the activation moment.
4. **Forward and wait:** the link message tells them to forward it; first money in fires
   `Purchase` and the paid message for an ad arrival is the short shape (section 7).
5. **Next steps:** the next link, and the tips, one at a time.

Nothing is put in front of step 3 once onboarding is complete: the "for you, or for a
business?" question is skipped for ad arrivals.

## 4. What they have already seen (sent by Meta, not the bot)

> Hello, welcome to WaPay. Getting paid is as easy as sending a message. Tap below to get
> going.

So the bot never opens with another welcome. It uses the person's WhatsApp profile name,
first word only, when it reads as a name (`firstNameFrom`: letters only, 2 to 20
characters, not a word like "shop" or "official"); otherwise no name.

## 5. The four suggested questions

Matched exactly first, then loosely (case, punctuation, missing words) in case Meta
trims the texts (`classifyAdEntry`). Reply buttons: at most 3 per message, 20 characters
each (`sendWhatsAppReplyButtons`; when buttons cannot be delivered the same choice is
sent as a numbered text line).

| Entry | Reply | Then |
|---|---|---|
| Q1 "Open my WaPay account" | "Great, {first_name}. Let's open your WaPay account. You only need this phone, and it's three quick steps." | onboarding at once (OTP) |
| Q2 "How do I get paid with a link?" | the three steps, "They pay with any bank card, Instant EFT, Capitec Pay, SnapScan and more. They don't need WaPay." then "Want to open your account and try it?" | buttons **Open my account** · **What it costs** |
| Q3 "What does it cost?" | free under R50 for both sides, free between WaPay users at any amount; from R50 a small fee comes off what you receive, never off what they pay; the R100 example from the LIVE fee table; "We always show you the cost before you share a link." | buttons **Open my account** · **How it works** |
| Q4 "Turn my WhatsApp into a wallet" | "You're in the right place. Once your account is open, you can get paid by anyone, top up electronically, pay other WaPay users for free, and pay out to your bank account or as cash at Nedbank and Absa ATMs. Airtime, data, electricity and fuel are coming soon. Let's open your account first. You only need this phone." | onboarding at once |
| anything else | a brief holding answer and the next step | button **Open my account** |

The fee example is computed by `feeExample(paymentRequestFeeCents)` on the primary card
rail, never typed in. The person paying always pays exactly the amount on the link; the
fee is never quoted at exactly R50.

Buttons tapped later arrive as their titles ("Open my account", "What it costs", "How it
works") and are matched the same way while the conversation state is `AD_ENTRY`.

## 6. Other questions people will ask

Answered from section 2 for ad arrivals, before and after the account exists
(`classifyAdEntry` → `FAQ_*`, `adEntryReply`). Before the account, every answer ends with
"Let's open your account first. You only need this phone." and the **Open my account**
button.

| Question | Answer | After the account |
|---|---|---|
| How can people pay me? | "However suits them: any credit, cheque or debit card, Apple Pay, Samsung Pay, Google Pay, Instant EFT, Capitec Pay, SnapScan, Zapper, Scan to Pay, bank QR code apps, RCS store cards or MobiCred. They don't need WaPay." | same, no suffix |
| How do I get my money out? | "You can pay out to any South African bank account with PayShap, or collect cash at a Nedbank or Absa ATM, no card needed." | buttons **To my bank account** · **Nedbank cash** · **Absa cash**, each starting the pay-out flow at its first step |
| Can I top up with cash? / deposit cash? | "Not yet. Cash top-ups with OTT and Blue Voucher are coming soon. For now you can top up electronically with a card, Instant EFT, Capitec Pay, SnapScan and more." | same |
| Can I buy airtime, data, electricity or fuel? | "Not yet, those are coming soon. Right now you can get paid, top up electronically, pay other WaPay users and pay out." | same |
| Can I pay someone? | "Yes. You can pay anyone from your WaPay balance to any SA number, free, and it lands in their WaPay balance. If they're not on WaPay yet, it waits for them. Just tell me the amount and their number." (ledger send since 2026-10-18; audit 2026-10-19 fixed the old members-only line) <!-- was: If they're not on WaPay yet, they can open an account in their own WhatsApp." | same |

## 7. During onboarding (OTP, PIN, consent)

- One step per message. The PIN prompt says "Step 2 of 3", the consent prompt "Step 3 of
  3" (the OTP is step 1 and arrives as the authentication template).
- No email address is asked for. Nothing is added to what onboarding needs.
- A number that already has a completed account and taps the ad skips onboarding and is
  asked for its first link straight away.
- Not built yet: answering a question mid-flow in one line and returning to the step; the
  under-18 stop (the brief itself marks the age rule as "to confirm").

## 8. The moment onboarding completes: the first link

> You're all set, {first_name}. Let's get you paid. Who owes you, and how much? Just type
> it like this: R250 from Thandi for the birthday gift.

`parseFirstLinkAsk` reads the amount, the "from" name and the "for" note. The amount goes
to the existing please-pay-me creation (`handleCreatePaymentRequest`), which quotes the
cost above R50 and mints exactly one link; for an ad arrival the created-link message is
the short shape: "Here's your payment link for R250: <link>. Forward it to Thandi in your
chat with them. They can pay with any bank card, Instant EFT, Capitec Pay, SnapScan and
more, and they don't need WaPay. I'll message you the moment it's paid." A message in this
state without an amount gets one retry line; anything that reads as a different intent
leaves the state and is routed normally.

## 9. After the first link

When a link of an ad arrival is paid (`lib/request-notify.js`):

> Your payment link for R250 was paid. It's in your WaPay balance. Anyone else owe you?
> Send me the next one.

(The payer's name is not known on a card payment, so the brief's "Thandi paid you" shape
is used only when a name is known.) Tips, one at a time, are listed in `TIPS` (free under
R50; free between WaPay users; pay out to your bank account or collect cash at Nedbank
and Absa ATMs; the cost is shown before you share) and are not yet scheduled.

## 10. One reminder, and only one

Meta's automatic follow-up is switched off in the ad, so the bot owns this
(`lib/ad-reminders.js`).

- Only if they stopped mid-onboarding, or finished onboarding without creating a link.
- About 20 hours after their last message (20 to 23.5 hours): inside WhatsApp's 24-hour
  window, no template, and inside the 72-hour free window an ad conversation gets.
- Mid-onboarding: "Hi {first_name}, you're one step away from your WaPay account. Want to
  finish?" No link yet: "Ready for your first payment link? Just tell me who owes you and
  how much."
- Sent once, ever (`attribution.reminderSentAt` is written before the send). "stop" (or
  "unsubscribe", "no more") sets `attribution.reminderOptOut` and is answered once; the
  stop hook runs only for ad arrivals and never inside a PIN, PIN-reset or confirm step.
- Scheduling: the daily cron at 02:00 UTC sends what is due; the processor also runs the
  sweep best-effort at the end of a turn (one reminder, throttled to every ten minutes per
  instance) so quiet days are not missed. A Pro-plan cron every 15 minutes would make the
  timing exact; the Hobby plan allows one cron.

## 11. Style and compliance, for every message

Short, buttons over typing, fewest messages. **Coming soon means coming soon:** never say
a section 2 "coming soon" feature is available, never a launch date. **Words:** say "pay
other WaPay users", never "send money" or "transfer"; never "banking", "withdraw", "cash
out" (say "pay out" and "collect cash"); "bank" only in "any bank card", "bank QR code
apps" and "bank account"; "ATM" only beside Nedbank and Absa; no competitor comparisons,
no percentage savings claims, no em dashes. `copyViolations` in `lib/ad-flow.js` is the
checker; `tests/ad-flow.test.mjs` runs every string the module can produce through it.
Fees only from the live fee table. Plain English by default; the existing language rule
applies.

## 12. Tracking

- `attribution.entry` on the account: `Q1` to `Q4`, `OPEN` / `COST` / `HOW` for a tapped
  button, or `free_text`. Never the customer's own words (golden thread rule 1.5). The
  Growth tab shows which question converts ("Which question brought them in").
- Events stay as built: `LeadSubmitted` (onboarding complete), `QualifiedLead` (first
  link created), `Purchase` (first money in). Meta's answer to each is kept on the account
  (`attribution.capiLast`).
- `attribution.reminderSentAt`, `reminderOptOut`.

## 13. Test before launch

Unit: `tests/ad-flow.test.mjs` (classification, names, copy, banned words, fee example
from the table, parser, reminders due and once-only). Harness: `pnpm qa:chat` scenarios
"Ad arrival" run the four questions plus a free-text opener against the real brain with a
synthetic referral on a fresh QA number. From a real phone that has never messaged WaPay,
the founder runs each of the four questions and one free-text opener all the way to a
first link, then asks "Can I deposit cash?", "Can I buy airtime?", "How do I get my money
out?" and "How can people pay me?", checking that every reply is a few lines, the buttons
work, coming-soon features read as coming soon every time, the fee answer matches the fee
table, no banned word appears, the reminder fires once and stops on "stop", and
`LeadSubmitted` and `QualifiedLead` reach the Growth tab.

## 14. Golden-thread notes

No new model call is made anywhere in this flow (classification is regex). The hook runs
inside `processMessageInner` after `growthOnTurn`, inside the request's privacy scope. The
entry stored on the account is a question id, never text. The first-link state accepts a
late amount itself before the idle-expiry branch can treat it as a secret-shaped answer.
Nothing in this flow moves money: the link creation ends in the existing flow, and a
payment arrives through the card rails as before.

**2026-10-20 (CHANGELOG 102, BUGLOG #130):** the section-10 reminder is OFF by default after Meta's "sending spam" notice and a RED quality rating; `WAPAY_AD_REMINDERS=on` is the only way to send it. "Stop" now opts any customer out of everything WaPay would start, not only the reminder. See docs/WHATSAPP_POLICY_COMPLIANCE.md.

## Round two changes (creative review, 2026-10-20)

- **Q2 and Q3 open the account at once.** The "how it works" and "what it costs" answers end with
  "Let's open your account. You only need this phone, and it's three quick steps." and the PIN
  step follows in the same turn. No open-account button on these two answers any more. A member
  asking the same question later gets the answer alone.
- **The first-link prompt has no example sentence.** "You're all set, {name}. Let's get you paid.
  Who owes you, and how much? Type the amount and their name." The parser takes amount and name
  in either order ("250 Thandi", "Thandi R250", "Thandi owes me 250", "250 from Sipho for rent").
  The retry line: "Just the amount and the name of the person who owes you, the amount in rands
  first." The old example sentence is still recognised and answered with "That was just our
  example. Who really owes you, and how much? Type the amount and their name.", and no link is
  created from it.
- **Loans.** "WaPay doesn't offer loans. You can get paid, top up, pay other WaPay users and pay
  out. To get paid, tell me who owes you and how much, and I make the link you forward to them."
  Matched before the agent (`matchLoanAsk`), never a referral to a lender.
