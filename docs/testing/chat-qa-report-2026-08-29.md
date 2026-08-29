# WaPay chat QA report · 2026-08-29

Conversational end-to-end run against the REAL message processor (live DB, live OpenAI, outbound WhatsApp captured, no money moved). QA account: `27600000901` (seeded and torn down by the run).

**10 pass · 0 warn · 0 fail**

## ✅ Founder repro: "payment link" escapes the meter ask

- ✅ electricity flow opens with an amount ask
- ✅ R50 moves to the meter ask
- ✅ the link ask is NOT answered with a meter error
- ✅ the switch is acknowledged out loud
- ✅ a real R20 pay link comes back (free band creates in one step)

<details><summary>Transcript</summary>

**User:** Buy electricity

```
💡 *Buy Electricity*

How much electricity would you like to buy?

Reply with an amount (e.g., R50, R100, R500)
(Min R10, Max R5000)
```

**User:** 50

```
💡 *Buy R50 Electricity*

Please enter your meter number:
```

**User:** Please create a payment link for R20

```
👍 No problem, switching over. We can come back to the electricity purchase any time.
···
🙏 *R20 requested*

Forward the next message to whoever owes you. I'll tell you the moment it's paid.

You'll receive the full *R20* however they pay. No fees on this one. 🎉
[button:View my payment page -> https://pleasepayme.co.za/PRDRMAKJ]
···
🙏 *Pay WaPay QA Harness now* · R20 on WaPay

Tap the link to pay. Free from a WaPay balance, or pay by card:
https://pleasepayme.co.za/PRDRMAKJ
```

</details>

## ✅ Fluidity: electricity → airtime → home → get-paid link

- ✅ electricity flow opens
- ✅ airtime ask mid-electricity acknowledges and switches
- ✅ "cancel" ends the airtime flow
- ✅ "hi" lands on the home screen
- ✅ R250 request offers the fee choice before creating
- ✅ choosing 1 mints exactly one link

<details><summary>Transcript</summary>

**User:** buy electricity

```
💡 *Buy Electricity*

How much electricity would you like to buy?

Reply with an amount (e.g., R50, R100, R500)
(Min R10, Max R5000)
```

**User:** I want to buy airtime

```
👍 No problem, switching over. We can come back to the electricity purchase any time.
···
📱 *Buy Airtime*

How much airtime would you like to buy?

Reply with an amount (e.g., R10, R50, R100)
```

**User:** cancel

```
👍 Airtime purchase cancelled.
···
👋 *Hi WaPay QA Harness!*
💰 Balance: *R0.00*
━━━━━━━━━━━━━━━

🛒 *Buy*: airtime, data, electricity
💸 *Send*: "send R10 airtime to 083..."
🙏 *Get Paid*: "please pay me R50" → share your link
💳 *Deposit*: "deposit R100" or a Blu voucher
🏧 *Withdraw*: coming soon
📄 *Transactions* · ⚙️ *Settings*

⚡ Quick: Buy airtime · Buy data · Check balance

Just tell me what you need, in any language.
```

**User:** hi

```
👋 *Hi WaPay QA Harness!*
💰 Balance: *R0.00*
━━━━━━━━━━━━━━━

🛒 *Buy*: airtime, data, electricity
💸 *Send*: "send R10 airtime to 083..."
🙏 *Get Paid*: "please pay me R50" → share your link
💳 *Deposit*: "deposit R100" or a Blu voucher
🏧 *Withdraw*: coming soon
📄 *Transactions* · ⚙️ *Settings*

⚡ Quick: Buy airtime · Buy data · Check balance

Just tell me what you need, in any language.
```

**User:** please pay me R250

```
🙏 *Get paid R250*

Quick choice before I make your link:

1️⃣ Link for *R250*. You receive the full amount from a WaPay balance (free), or R237.20 if they pay by card (R12.80 card cost).

2️⃣ Link for *R264*. You receive at least R250 however they pay.

Reply *1* or *2*, or "cancel".
```

**User:** 1

```
🙏 *R250 requested*

Forward the next message to whoever owes you. I'll tell you the moment it's paid.

You'll get the full *R250* if they pay from their WaPay (free), or R237.20 if they pay by card.
[button:View my payment page -> https://pleasepayme.co.za/PRHRRDWW]
···
🙏 *Pay WaPay QA Harness now* · R250 on WaPay

Tap the link to pay. Free from a WaPay balance, or pay by card:
https://pleasepayme.co.za/PRHRRDWW
```

</details>

## ✅ Dedupe: replayed messageId produces no second reply

- ✅ first delivery replies
- ✅ replay is swallowed with zero sends

<details><summary>Transcript</summary>

**User:** hi

```
👋 *Hi WaPay QA Harness!*
💰 Balance: *R0.00*
━━━━━━━━━━━━━━━

🛒 *Buy*: airtime, data, electricity
💸 *Send*: "send R10 airtime to 083..."
🙏 *Get Paid*: "please pay me R50" → share your link
💳 *Deposit*: "deposit R100" or a Blu voucher
🏧 *Withdraw*: coming soon
📄 *Transactions* · ⚙️ *Settings*

⚡ Quick: Buy airtime · Buy data · Check balance

Just tell me what you need, in any language.
```

**User:** hi

```
(no reply)
```

</details>

## ✅ Memory: AI recalls a fact from earlier in the chat

- ✅ the name comes back on request

<details><summary>Transcript</summary>

**User:** My name is Thabo and I run a spaza shop in Soweto.

```
Nice to meet you, Thabo 😊 That sounds like a proper hustle. I’m here whenever you want to buy, send, deposit, or check balance 💡
```

**User:** What did I tell you my name was?

```
You said your name was Thabo 😊
```

</details>

## ✅ Memory: a flow in between does not amnesia the AI (BUGLOG #30)

- ✅ the fact survives entering AND leaving a flow

<details><summary>Transcript</summary>

**User:** Please remember that my favourite colour is green.

```
Got it, Thabo 😊 I’ll remember that your favourite colour is green 💚
```

**User:** buy electricity

```
💡 *Buy Electricity*

How much electricity would you like to buy?

Reply with an amount (e.g., R50, R100, R500)
(Min R10, Max R5000)
```

**User:** cancel

```
👍 Electricity purchase cancelled. Let me know if you need anything else.
```

**User:** What is my favourite colour?

```
Green 💚
```

</details>

## ✅ Questions: the founder repro gets a real spend answer, never the menu

- ✅ no bare menu for the exact founder phrasing
- ✅ the answer names real spend destinations
- ✅ the reply carries warmth (emoji)

<details><summary>Transcript</summary>

**User:** Where can I spend my WaPay money!

```
You can use your WaPay money for airtime, data, prepaid electricity, sending money to friends and family, getting paid with a request link, and buying WaPay vouchers for online stores that accept OTT vouchers 💰📱
```

</details>

## ✅ Questions: cash-out ask gets the coming-soon script, then spend guidance

- ✅ no bare menu for a cash-out question
- ✅ honest coming-soon position
- ✅ no date is promised
- ✅ redirects to what the money CAN do

<details><summary>Transcript</summary>

**User:** How do I withdraw my money to my bank account?

```
Cash-out is coming soon, but it is not available yet. Right now your WaPay money is spend-only, so you can use it for airtime, data, prepaid electricity, sending money, getting paid with a request link, or online voucher spend 💰✨
```

</details>

## ✅ Questions: fuel ask in test mode is coming-soon, never claimed redeemable

- ✅ no bare menu for a fuel question
- ✅ no live-redemption claim while gated
- ✅ fuel presented as coming soon

<details><summary>Transcript</summary>

**User:** Can I buy petrol with WaPay?

```
⛽ Fuel vouchers are coming to WaPay soon, and we are just as excited as you are! 🎉

You will be able to buy a fuel voucher right here in chat and use it at participating stations.

While we get that ready, here is what your WaPay money can do today:
📱 *Airtime and data* for your number or any other SA number
💡 *Prepaid electricity* for any meter
🎟️ *WaPay vouchers* to spend online at any store that accepts OTT vouchers
💸 *Send money* to friends and family on WhatsApp
🙏 *Get paid* with a "please pay me" link you can share anywhere
💳 *Add money* by card or EFT ("deposit R100"), or with a Blu voucher bought for cash at any till
💰 And just say "balance" any time to see where you stand

What would you like to do? 😊
```

</details>

## ✅ Questions: a question mid-flow is answered, not menued or meter-errored

- ✅ no bare menu mid-flow
- ✅ no validation insult for a real question
- ✅ the fees question is acknowledged

<details><summary>Transcript</summary>

**User:** buy electricity

```
💡 *Buy Electricity*

How much electricity would you like to buy?

Reply with an amount (e.g., R50, R100, R500)
(Min R10, Max R5000)
```

**User:** how do fees work on WaPay?

```
Most things are free to use. Sending money has a flat R3 fee, and when someone pays a money request by card, a small card fee is taken from what the requester receives, not from the payer 💰😊
```

**User:** cancel

```
All good, canceled 💡 What would you like to do next?
```

</details>

## ✅ Language: switch to isiZulu, localized replies, Afrikaans inbound

- ✅ "speak zulu" locks the preference
- ✅ balance reply is localized (English here = localizer failed open, worth eyes)
- ✅ money figures survive localization untranslated
- ✅ Afrikaans "wat is my balans" still reads as a balance ask
- ✅ "speak english" switches back

<details><summary>Transcript</summary>

**User:** speak zulu

```
👍 Kulungile, sesikhuluma isiZulu manje!
```

**User:** balance

```
💰 *Ibhalansi yakho yeWaPay*

Sawubona WaPay QA Harness!

💵 Ibhalansi Yamanje: R 0.00

Ufunani okunye? Ngicela ungibuze!
```

**User:** wat is my balans

```
💰 *Your WaPay Balance*

Hi WaPay QA Harness!
Your current balance is R 0.00

What would you like to do next?
```

**User:** speak english

```
👍 English it is!
```

</details>
