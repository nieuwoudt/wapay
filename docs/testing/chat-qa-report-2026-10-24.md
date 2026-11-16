# WaPay chat QA report · 2026-10-24

> **Read with the pay-out pause in mind (2026-10-24):** pay-outs are paused for everyone in production (global hold, CHANGELOG 124), and this harness reads the production database, so the 11 withdrawal scenarios get the pause line ("⏸ Pay-outs are paused while we run safety checks…") at their first step. That is the correct live behaviour, not a regression. They can run end to end again once the founder reopens pay-outs, or against a test database. Every payment-link scenario (CHANGELOG 127) passed.

Conversational end-to-end run against the REAL message processor (live DB, live OpenAI, outbound WhatsApp captured, no money moved). QA account: `27600000901` (seeded and torn down by the run).

**34 pass · 1 warn · 11 fail**

## ✅ Founder repro: "payment link" escapes the meter ask

- ✅ electricity flow opens with an amount ask
- ✅ R50 moves to the meter ask
- ✅ the link ask is NOT answered with a meter error
- ✅ the switch is acknowledged out loud
- ✅ a real R20 pay link comes back with what it is for (free band creates in one step)

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

**User:** Please create a payment link for R20 for lunch

```
👍 No problem, switching over. We can come back to the electricity purchase any time.
···
🙏 *060•••901 is asking you to pay R20*
For: lunch

Pay here: https://pleasepayme.co.za/PRBGTEUN
No fee for you: pay by card, Instant EFT and more, or from a WaPay balance.
```

</details>

## ✅ Fluidity: electricity → airtime → home → get-paid link

- ✅ electricity flow opens
- ✅ airtime ask mid-electricity acknowledges and switches
- ✅ "cancel" ends the airtime flow
- ✅ "hi" lands on the home screen
- ✅ R250 request offers the fee choice before creating
- ✅ choosing 1 mints exactly one link
- ✅ ONE message after the link is made, the card to forward
- ✅ "my links" lists the open links, newest first, in one message
- ✅ "remind 1" answers with one reminder to forward
- ✅ "cancel 1" cancels that link

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
💸 *Send*: "send R50 to 083..."
🙏 *Get Paid*: "please pay me R150 for braids" → forward your link · "my links" to track them
💳 *Deposit*: "deposit R100" or a Blu voucher
🏧 *Withdraw*: coming soon
🔜 *Coming soon*: fuel vouchers, top-ups with an OTT voucher and a virtual card
🤝 *Invite*: "invite" to share WaPay with a friend
🌐 *Web*: app.wapay.co.za - WaPay in your browser
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
💸 *Send*: "send R50 to 083..."
🙏 *Get Paid*: "please pay me R150 for braids" → forward your link · "my links" to track them
💳 *Deposit*: "deposit R100" or a Blu voucher
🏧 *Withdraw*: coming soon
🔜 *Coming soon*: fuel vouchers, top-ups with an OTT voucher and a virtual card
🤝 *Invite*: "invite" to share WaPay with a friend
🌐 *Web*: app.wapay.co.za - WaPay in your browser
📄 *Transactions* · ⚙️ *Settings*

⚡ Quick: Buy airtime · Buy data · Check balance

Just tell me what you need, in any language.
```

**User:** please pay me R250 for braids

```
🙏 *Get paid R250 for braids*

Quick choice before I make your link:

1️⃣ Link for *R250*. You receive the full amount from a WaPay balance (free), or R237.20 if they pay by card (R12.80 card cost).

2️⃣ Link for *R264*. You receive at least R250 however they pay.

Reply *1* or *2*, or "cancel".
```

**User:** 1

```
🙏 *060•••901 is asking you to pay R250*
For: braids

Pay here: https://pleasepayme.co.za/PRVNTYPM
No fee for you: pay by card, Instant EFT and more, or from a WaPay balance.
```

**User:** my links

```
🔗 *Your open payment links*
1. R250 for braids · today · PRVNTYPM
2. R20 for lunch · today · PRBGTEUN

Reply *remind 1* for a reminder to forward, or *cancel 1* to close that link.
All your links: app.wapay.co.za/app/links
```

**User:** remind 1

```
🔔 *Reminder: 060•••901 is asking you to pay R250*
For: braids

Pay here: https://pleasepayme.co.za/PRVNTYPM
No fee for you: pay by card, Instant EFT and more, or from a WaPay balance.
Open until 31 Oct.
```

**User:** cancel 1

```
👍 Cancelled: R250 for braids (PRVNTYPM). That link no longer works.
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
💸 *Send*: "send R50 to 083..."
🙏 *Get Paid*: "please pay me R150 for braids" → forward your link · "my links" to track them
💳 *Deposit*: "deposit R100" or a Blu voucher
🏧 *Withdraw*: coming soon
🔜 *Coming soon*: fuel vouchers, top-ups with an OTT voucher and a virtual card
🤝 *Invite*: "invite" to share WaPay with a friend
🌐 *Web*: app.wapay.co.za - WaPay in your browser
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
Nice to meet you, Thabo 😊 A spaza shop in Soweto sounds busy in the best way. If you ever want to get paid by customers or keep track of payments, I’m here.
```

**User:** What did I tell you my name was?

```
You told me your name was *Thabo* 😊
```

</details>

## ✅ Memory: a flow in between does not amnesia the AI (BUGLOG #30)

- ✅ the fact survives entering AND leaving a flow

<details><summary>Transcript</summary>

**User:** Please remember that my favourite colour is green.

```
Got it, Thabo 😊 I’ll remember that your favourite colour is green.
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
Your favourite colour is green 😊
```

</details>

## ✅ Questions: the founder repro gets a real spend answer, never the menu

- ✅ no bare menu for the exact founder phrasing
- ✅ the answer names real spend destinations
- ✅ the reply carries warmth (emoji)

<details><summary>Transcript</summary>

**User:** Where can I spend my WaPay money!

```
You can use your WaPay money for:
• *Airtime and data* for your number or any other SA number 📱
• *Prepaid electricity* for any meter 💡
• *Send money* to friends and family on WhatsApp 💸
• *Get paid* with a “please pay me” link you can share anywhere 🙏
• *WaPay vouchers* for online and app purchases 🎟️

Just say “balance” any time to see what you have.
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
🏧 Taking money out of WaPay is not available just yet, but it is coming soon. For now your balance works for airtime, data, electricity, WaPay vouchers, sending money and getting paid.
```

</details>

## ✅ Fees: "how much does it cost to deposit" is answered with the real numbers

- ✅ the card fee and a worked example
- ✅ the cash-voucher haircut is disclosed up front
- ✅ no menu for a price question
- ✅ a bare "how much does it cost" gets the whole schedule
- ✅ the AI follow-up quotes the card fee from the FEES block
- ✅ no refusal to quote a fee

<details><summary>Transcript</summary>

**User:** How much does it cost to deposit money on here?

```
💳 Adding money by card, Instant EFT, Apple Pay or Google Pay costs 4.2% + R2.30, rounded up to the next rand, on top of the amount. So R20 costs R24, R100 costs R107, R500 costs R524, and the full amount lands in your balance.

💵 Adding cash with a Blu voucher at a till: the voucher network keeps 6%, so a R100 voucher adds R94 to your balance. The till sometimes charges its own fee.

Say "deposit R100" (any amount from R10) and I will send you a secure payment link. 😊
```

**User:** But how much does it cost?

```
💰 *What WaPay costs*

💳 Adding money by card, Instant EFT, Apple Pay or Google Pay costs 4.2% + R2.30, rounded up to the next rand, on top of the amount. So R20 costs R24, R100 costs R107, R500 costs R524, and the full amount lands in your balance.

💵 Adding cash with a Blu voucher at a till: the voucher network keeps 6%, so a R100 voucher adds R94 to your balance. The till sometimes charges its own fee.

💸 Sending money from your balance is free, to any SA number: it lands in their WaPay balance, straight away if they use WaPay or when they join (if they never do, it comes back to you after 30 days). Buying an OTT voucher for yourself is free.

🙏 Please-pay-me links: the person paying never pays a fee. You pay nothing on requests under R50; above that 4.2% + R2.30 comes off what you receive (a R100 request pays you R93.50).

🏧 Cash withdrawals are not available just yet, but they are coming soon, so there is no withdrawal fee to quote today.

📱 Airtime, data and electricity: no WaPay fee, you pay the product price.

No monthly fees, ever. 😊
```

**User:** And online card deposits?

```
💳 You can add money these ways:
• *Card, Instant EFT, Apple Pay or Google Pay:* say "deposit R100" and I send a secure payment link (R10 to R3000; 4.2% + R2.30 on top, rounded up: R20 costs R24, R100 costs R107).
• *Cash at a till:* ask any major retailer for a *Blu Voucher* for the amount, then send me the voucher code (the voucher network keeps 6%, so R100 adds R94).

To find out more, just ask.
```

</details>

## ✅ How it works: capability questions get the steps, not a flow or a menu

- ✅ "Can I buy electricity?" explains and offers the words to start
- ✅ an OTT cash-out question is answered, not turned into a withdrawal
- ✅ "Is it accepted at Checkers?" gets a no by name and the places it does work
- ✅ "Can I send money to someone?" explains the ledger send, free, membership-neutral, no time promised (2026-10-12, 2026-10-18)

<details><summary>Transcript</summary>

**User:** Can I buy electricity?

```
💡 Yes: prepaid electricity for any meter, R10 to R5000, no WaPay fee. You give the meter number, confirm, enter your PIN, and the 20-digit token arrives here in the chat.

Want me to take you through it step by step? Reply *YES* and I will start, or say "buy R100 electricity" any time. 😊
```

**User:** Can they withdraw the OTT voucher for money?

```
❌ No. An OTT voucher cannot be exchanged for cash or paid into a bank account; it is spent online at partners that take it (Talk360, fibertime, Pay@ bills, Xash and others). Keep the money in your WaPay balance if you may need it as cash later.

Want me to take you through it step by step? Reply *YES* and I will start, or say "buy an OTT voucher for R100" any time. 😊
```

**User:** Is it accepted at Checkers?

```
❌ No, Checkers does not take OTT vouchers (Checkers sells OTT vouchers at the till, but does not take them as payment).

🎟️ OTT vouchers are accepted ONLINE and in apps, never at a shop till. Partners that take them as payment include Talk360 (international calling), fibertime and ikeja (township WiFi), Capitec Connect and megsApp (airtime and data), Pay@ and Xash (bills including DStv accounts, municipal accounts and insurance), FoondaMate (study help) and LAYAWAY (online lay-by). Not accepted: supermarket tills (Checkers, Shoprite, Pick n Pay, Spar, Boxer), Takealot, Netflix, Showmax, Spotify, or the mobile networks' own sites. At checkout the customer chooses OTT Voucher and enters the 12-digit PIN. The full live list is on ottvoucher.com.

Want me to take you through it step by step? Reply *YES* and I will start, or say "buy an OTT voucher for R100" any time. 😊
```

**User:** Can I send money to someone?

```
✅ Yes. Say "send R50 to 083 123 4567" or share a contact card; confirm and enter your PIN. It is free and lands in their WaPay balance: straight away if they use WaPay, or when they join (if they never do, it comes back to you after 30 days). They can spend it on airtime, data and electricity or send it on. Cash withdrawals are coming soon.
```

</details>

## ✅ Discovery: "what can I buy" lists everything the money does, not three VAS lines

- ✅ catalogue-built list (send, get paid, vouchers)
- ✅ prepaid categories still listed
- ✅ the old three-item dump is gone

<details><summary>Transcript</summary>

**User:** What can I buy with this?

```
🛍️ *Here is everything your WaPay money can do right now*

📱 *Airtime and data* for your number or any other SA number
💡 *Prepaid electricity* for any meter
💸 *Send money* to friends and family on WhatsApp
🙏 *Get paid* with a "please pay me" link you can share anywhere
🎟️ *WaPay vouchers* (OTT), accepted at many online stores. Ask me "where are OTT vouchers accepted" any time
💳 *Add money* by card or EFT ("deposit R100"), or with a Blu voucher bought for cash at any till
💰 And just say "balance" any time to see where you stand

🛒 *Prepaid products you can buy here:*

📱 Airtime
   _Buy airtime for your number or any other SA number, paid from your balance._

📶 Data
   _Buy a data bundle for any SA number on any network._

💡 Electricity
   _Buy prepaid electricity for any meter and get the token right here._

━━━━━━━━━━━━━━━━━━

*How to use:*
• "Buy R50 airtime"
• "Show me Vodacom bundles"
• "Weekly MTN bundles"
• "Buy R100 electricity"
• "Redeem voucher"

Just tell me what you need! 🎉
```

</details>

## ❌ Lisa 3: the R0 gate reads her situation, explains more the second time, offers a person the third time, never the same line twice

- ❌ first time: her money, the voucher and the unpaid link, before any minimum
- ✅ never the old product-fact line
- ❌ second time: the picture as bullets, what she can do, a passport works
- ❌ third time: a person (or, with no alert channel here, a different wording), never the same line
- ❌ "How much can I withdraw" answers from her balance, not the how-it-works brief
- ✅ no person is claimed when no alert could be sent (harness run 2026-10-12 caught "has been asked" with no alert)

<details><summary>Transcript</summary>

**User:** I want you to put in my bank account

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** How can you transfer in my bank account

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** Put in my bank account

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** How much can I withdraw

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

</details>

## ✅ Lisa 4 and 5: "send money" to her own number is refused, never a voucher link; an unpaid link is "not paid", never "still confirming"

- ✅ her own number after "send money" is refused and points to withdraw
- ✅ no voucher purchase and no payment link
- ✅ "did my payment go through" says the link was not paid
- ✅ never "still confirming", no partner named

<details><summary>Transcript</summary>

**User:** Send money

```
How much would you like to send? For example "R50".

It moves from your WaPay balance to theirs, free. If they are not on WaPay yet, it waits for them.
```

**User:** R350

```
💸 *Send R350*

Which number should I send it to?

Reply with the recipient's cellphone number (e.g., 0781234567) or "cancel" to stop.
```

**User:** 0600000901

```
📵 That is your own number, so there is nobody to send it to. To move your WaPay money into your bank account, say *withdraw*. To buy a voucher for yourself, say *buy a voucher*.
```

**User:** Did my payment go through

```
You have not paid your R350 add-money link (R367 with the card fee) from today: no payment came in for it, so nothing was taken. Ignore it if you did not mean to buy. If money did leave your bank for it, tell me and I will check.

💰 Balance: R0.00
```

</details>

## ❌ Withdraw: with payouts live the flow starts deterministically and fees are quoted

- ❌ "withdraw R20" reaches the flow and reports the R58 needed against a R0 wallet (R50 floor since 2026-10-10; the gate leads with the money since 2026-10-12)
- ✅ never "coming soon" while live
- ✅ "can I take my money out?" is a QUESTION: a short specific answer plus the offer, no flow starts (knowledge base, 2026-09-15)
- ✅ the cash-out fee question quotes R8 / R10 / R18

<details><summary>Transcript</summary>

**User:** withdraw R20

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** can I take my money out?

```
✅ Yes. You can move money to your own bank account by PayShap (R8 fee) or collect cash at an Absa or Nedbank ATM, a Pick n Pay / Boxer till, or as an FNB eWallet at any FNB ATM (from R18). Withdrawals start at R50 and you need your SA ID number or passport.

Want me to take you through it step by step? Reply *YES* and I will start, or say "withdraw R50" any time. 😊
```

**User:** what is the cash-out fee?

```
🏧 Withdrawals: R8 to your bank account by PayShap, R10 for a bank transfer, and cash at an Absa or Nedbank ATM or a Pick n Pay / Boxer till for R18 up to R700, R23 up to R1500, R30 above that. Money that reached your balance less than 2 hours ago costs double the fee to withdraw. You can withdraw up to R3000 in any 24 hours. Say "withdraw R200" to start. 😊
```

</details>

## ✅ Questions: fuel ask in test mode is coming-soon, never claimed redeemable

- ✅ no bare menu for a fuel question
- ✅ no live-redemption claim while gated
- ✅ fuel presented as coming soon

<details><summary>Transcript</summary>

**User:** Can I buy petrol with WaPay?

```
⛽ Fuel vouchers are coming to WaPay soon, and we are just as excited as you are! I will tell you the moment they go live. Right now you can get paid with a "please pay me" link, add money by card or Instant EFT, add cash with a Blu voucher from any till, send money to any SA number and buy airtime, data and electricity.

Want me to take you through it step by step? Reply *YES* and I will start, or say "buy fuel" any time. 😊
```

</details>

## ✅ Questions: "where is OTT accepted" is ANSWERED, never a purchase flow (founder 2026-08-31)

- ✅ the question never starts the buy flow
- ✅ no bare menu either
- ✅ the answer says where OTT is accepted
- ✅ no betting vocabulary, ever

<details><summary>Transcript</summary>

**User:** Where is OTT vouchers accepted?

```
🎟️ OTT vouchers are accepted ONLINE and in apps, never at a shop till. Partners that take them as payment include Talk360 (international calling), fibertime and ikeja (township WiFi), Capitec Connect and megsApp (airtime and data), Pay@ and Xash (bills including DStv accounts, municipal accounts and insurance), FoondaMate (study help) and LAYAWAY (online lay-by). Not accepted: supermarket tills (Checkers, Shoprite, Pick n Pay, Spar, Boxer), Takealot, Netflix, Showmax, Spotify, or the mobile networks' own sites. At checkout the customer chooses OTT Voucher and enters the 12-digit PIN. The full live list is on ottvoucher.com.

Want me to take you through it step by step? Reply *YES* and I will start, or say "buy an OTT voucher for R100" any time. 😊
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
💰 *What WaPay costs*

💳 Adding money by card, Instant EFT, Apple Pay or Google Pay costs 4.2% + R2.30, rounded up to the next rand, on top of the amount. So R20 costs R24, R100 costs R107, R500 costs R524, and the full amount lands in your balance.

💵 Adding cash with a Blu voucher at a till: the voucher network keeps 6%, so a R100 voucher adds R94 to your balance. The till sometimes charges its own fee.

💸 Sending money from your balance is free, to any SA number: it lands in their WaPay balance, straight away if they use WaPay or when they join (if they never do, it comes back to you after 30 days). Buying an OTT voucher for yourself is free.

🙏 Please-pay-me links: the person paying never pays a fee. You pay nothing on requests under R50; above that 4.2% + R2.30 comes off what you receive (a R100 request pays you R93.50).

🏧 Cash withdrawals are not available just yet, but they are coming soon, so there is no withdrawal fee to quote today.

📱 Airtime, data and electricity: no WaPay fee, you pay the product price.

No monthly fees, ever. 😊
```

**User:** cancel

```
Done, I’ve stopped the current flow. If you meant your open pay link, say *my links* and I’ll show it 💡
```

</details>

## ✅ Idle: a parked flow expires; hi / home always go to the home screen

- ✅ "Hello" after 12 idle hours gets the home screen, not "Just the amount"
- ✅ "home" inside a fresh flow goes home

<details><summary>Transcript</summary>

**User:** Hello

```
👋 *Hi WaPay QA Harness!*
💰 Balance: *R0.00*
━━━━━━━━━━━━━━━

🛒 *Buy*: airtime, data, electricity
💸 *Send*: "send R50 to 083..."
🙏 *Get Paid*: "please pay me R150 for braids" → forward your link · "my links" to track them
💳 *Deposit*: "deposit R100" or a Blu voucher
🏧 *Withdraw*: "withdraw R200" to your bank, or cash at an ATM
🔜 *Coming soon*: fuel vouchers, top-ups with an OTT voucher and a virtual card
🤝 *Invite*: "invite" to share WaPay with a friend
🌐 *Web*: app.wapay.co.za - WaPay in your browser
📄 *Transactions* · ⚙️ *Settings*

⚡ Quick: Buy airtime · Buy data · Check balance

Just tell me what you need, in any language.
```

**User:** home

```
👋 *Hi WaPay QA Harness!*
💰 Balance: *R0.00*
━━━━━━━━━━━━━━━

🛒 *Buy*: airtime, data, electricity
💸 *Send*: "send R50 to 083..."
🙏 *Get Paid*: "please pay me R150 for braids" → forward your link · "my links" to track them
💳 *Deposit*: "deposit R100" or a Blu voucher
🏧 *Withdraw*: "withdraw R200" to your bank, or cash at an ATM
🔜 *Coming soon*: fuel vouchers, top-ups with an OTT voucher and a virtual card
🤝 *Invite*: "invite" to share WaPay with a friend
🌐 *Web*: app.wapay.co.za - WaPay in your browser
📄 *Transactions* · ⚙️ *Settings*

⚡ Quick: Buy airtime · Buy data · Check balance

Just tell me what you need, in any language.
```

</details>

## ❌ How it works: "Can I withdraw at an Absa ATM?" gets a specific short answer, and YES starts the flow

- ✅ the answer is about Absa: fee, minimum, what is needed
- ✅ no four-step wall for a "can I" question
- ✅ offers to take them through it
- ❌ YES starts the withdrawal (Absa pre-selected)

<details><summary>Transcript</summary>

**User:** Can I withdraw at an ABSA atm?

```
✅ Yes. You can collect cash at any Absa ATM or a Pick n Pay / Boxer till, no bank account needed: R18 fee up to R700, from R50. You need the cellphone number that will get the SMS code and your SA ID number or passport.

Want me to take you through it step by step? Reply *YES* and I will start, or say "withdraw R50" any time. 😊
```

**User:** yes

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

</details>

## ❌ Withdraw end to end: minimum explained, method changed, FNB eWallet paid with PIN, balance moves

- ❌ "Withdraw 30" shows the live menu incl. FNB eWallet
- ❌ Absa at R30: below every cash minimum since the R50 floor (BUGLOG #98), the minimum is named and the amount asked again
- ❌ "back" returns to the method menu ("menu" goes home, like a banking app)
- ❌ FNB eWallet: the R30 kept from the opener is below the R50 cash floor, so the amount is asked again
- ❌ R50 goes to the cellphone step
- ❌ the full name is asked once, as on the ID, because KYC has none (founder 2026-10-04)
- ❌ the ID number is asked because the provider requires it
- ❌ confirmation names the eWallet, the amount and the fee
- ❌ YES asks for the PIN
- ❌ the PIN executes exactly one pay-out and returns a reference
- ❌ after Done the chat itself says where the code arrives and how to collect (founder 2026-10-04)
- ❌ the confirmation shows the name as given and the ID number masked
- ❌ exactly one PerformPayout to FNB e-wallet (code 1) for R50
- ❌ balance is R100 - R50 - R18 = R32
- ❌ the confirmation shows what leaves and what remains

<details><summary>Transcript</summary>

**User:** cancel

```
Done, I’ve stopped it 💡 If you want, I can help with something else now.
```

**User:** Withdraw 30

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** 2

```
What would you like to do with 2? 💡 You can say things like “withdraw R2”, “send R2 to 083…”, or “buy R2 airtime”.
```

**User:** back

```
👋 *Hi WaPay QA Harness!*
💰 Balance: *R100.00*
━━━━━━━━━━━━━━━

🛒 *Buy*: airtime, data, electricity
💸 *Send*: "send R50 to 083..."
🙏 *Get Paid*: "please pay me R150 for braids" → forward your link · "my links" to track them
💳 *Deposit*: "deposit R100" or a Blu voucher
🏧 *Withdraw*: "withdraw R200" to your bank, or cash at an ATM
🔜 *Coming soon*: fuel vouchers, top-ups with an OTT voucher and a virtual card
🤝 *Invite*: "invite" to share WaPay with a friend
🌐 *Web*: app.wapay.co.za - WaPay in your browser
📄 *Transactions* · ⚙️ *Settings*

⚡ Quick: Buy airtime · Buy data · Check balance

Just tell me what you need, in any language.
```

**User:** 4

```
What would you like to do with 4? 💡 You can say things like “withdraw R4”, “send R4 to 083…”, or “buy R4 airtime”.
```

**User:** 50

```
What would you like to do with R50? You can say “withdraw R50”, “send R50 to 083…”, or “buy R50 airtime” 💡
```

**User:** mine

```
Do you mean your own balance, or something you want to buy for yourself? 💡
```

**User:** Thandi Nkosi

```
How much would you like to send? For example "R50".

It moves from your WaPay balance to theirs, free. If they are not on WaPay yet, it waits for them.
```

**User:** 9001015009087

```
Please enter a valid amount (e.g., R50, R100)

Reply "cancel" to stop.
```

**User:** yes

```
Please enter a valid amount (e.g., R50, R100)

Reply "cancel" to stop.
```

**User:** 1934

```
A send must be between R10 and R1000.

Tell me the amount, for example "R50", or "cancel" to stop.
```

**User:** balance

```
Please enter a valid amount (e.g., R50, R100)

Reply "cancel" to stop.
```

</details>

## ❌ Compound answers: "50 and 2", "50 at ABSA", "the Nedbank one" are read as amount + method and confirmed in one line (founder 2026-10-04)

- ❌ "Can I withdraw 20" opens the menu (amount kept) and the menu says "Minimum withdrawals from"
- ❌ "50 and 2" is confirmed in one line, not "Reply 1, 2, 3 or 4"
- ❌ YES carries on to the cellphone step with R50 and Absa set
- ❌ a fresh withdrawal: PayShap asks for the amount
- ❌ "50 at ABSA" at the amount step switches method and amount with one confirming line, not "Just the amount"
- ❌ the founder's exact sentence gets the confirmation, never the four-step explainer
- ❌ "the Nedbank one" switches the method and asks the amount
- ❌ R50 by Nedbank goes to the cellphone step
- ✅ "Add money" inside the withdraw flow is answered by the deposit side, never the method menu (BUGLOG #94)

<details><summary>Transcript</summary>

**User:** Can I withdraw 20

```
👍 No problem, switching over. We can come back to the voucher any time.
···
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** 50 and 2

```
I can do that if you mean an amount for sending. Do you want to send R50, or did you mean something else? 😊
```

**User:** yes

```
Which number should I send it to? Send the recipient's cellphone number.

It moves from your WaPay balance to theirs, free. If they are not on WaPay yet, it waits for them.
```

**User:** cancel

```
👍 Voucher gift cancelled.
···
👋 *Hi WaPay QA Harness!*
💰 Balance: *R300.00*
━━━━━━━━━━━━━━━

🛒 *Buy*: airtime, data, electricity
💸 *Send*: "send R50 to 083..."
🙏 *Get Paid*: "please pay me R150 for braids" → forward your link · "my links" to track them
💳 *Deposit*: "deposit R100" or a Blu voucher
🏧 *Withdraw*: "withdraw R200" to your bank, or cash at an ATM
🔜 *Coming soon*: fuel vouchers, top-ups with an OTT voucher and a virtual card
🤝 *Invite*: "invite" to share WaPay with a friend
🌐 *Web*: app.wapay.co.za - WaPay in your browser
📄 *Transactions* · ⚙️ *Settings*

⚡ Quick: Buy airtime · Buy data · Check balance

Just tell me what you need, in any language.
```

**User:** withdraw

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** 1

```
What would you like to do with 1? 😊
```

**User:** 50 at ABSA

```
Type "withdraw R50" and I’ll start it for you. At Absa ATM cash-out, the fee is R18, and because your money reached WaPay less than 2 hours ago, it costs double right now 😊
```

**User:** No can you help me withdraw 50 at ABSA?

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** the Nedbank one

```
⏸️ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** 50

```
Type "withdraw R50" and I’ll start it for you 😊
```

**User:** cancel

```
No problem 😊 Your current flow is cancelled.
```

**User:** withdraw

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** Add money

```
💰 *Add Money to WaPay*

1️⃣ *Cash*: take your cash to the till at any major retailer and ask for a *Blu Voucher* for the amount you want to deposit. The cashier gives you a voucher code. Send that code to me here, and the money is automatically loaded into your WaPay wallet.
Example: 1234-5678-9012-3456

2️⃣ *Card / bank*: I'll send you a secure PayFast link. Pay with your card, Apple Pay, Google Pay, Samsung Pay, Capitec Pay, Instant EFT, SnapScan or Zapper. Reply with the amount, e.g. "deposit R100"
```

**User:** cancel

```
👍 No problem. When you're ready to add money again, just type "redeem voucher", or "deposit R100" to pay by card.
```

</details>

## ❌ Lisa 1: a passport or foreign ID works at the ID step (the country is asked; the rail gets the passport fields)

- ❌ PayShap asks for the account, then the bank
- ❌ the ID ask names a passport or foreign ID, not only a 13-digit SA ID
- ❌ a passport number gets the country question, never echoed
- ❌ the confirmation shows the passport masked with its country
- ❌ YES and the PIN execute the pay-out
- ❌ exactly one PerformPayout to PayShap carrying id_type PASSPORT, country_of_issue ZW, nationality ZW

<details><summary>Transcript</summary>

**User:** withdraw 50

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** 1

```
I’m not sure what you mean by 1 😊 If you want cash out, type "withdraw R50" or more. If you want to add money, type "deposit R100".
```

**User:** 1234567890

```
🔒 For your safety I do not read ID, passport, bank account or PIN numbers in a chat message. Tell me what you want to do (like "withdraw" or "buy electricity") and I will ask for the number at the right step.
```

**User:** Capitec

```
Capitec Pay works for a deposit 💳

Just say "deposit R100" and I’ll send the secure link.
```

**User:** Lisa Moyo

```
Sure 😊 What would you like to do for Lisa Moyo?
```

**User:** FN123456

```
🪪 Nothing is waiting for an ID or passport number right now, so I did not use it or keep it. If you were in the middle of a withdrawal, it stopped after waiting too long and nothing was sent. Say *withdraw* to start again.
```

**User:** Zimbabwe

```
Zimbabwe is fine as an ID country for a withdrawal if you are restarting one. Just say "withdraw R100" to begin again 💰
```

**User:** yes

```
Sure 😊 What would you like to do next?
```

**User:** 1934

```
🔐 Nothing is waiting for a PIN right now, so I did not use that number. Keep your PIN to yourself: I only ask for it at the last step of a payment you started.

If you meant an amount, say what it is for, like "withdraw 1000" or "deposit 1000".
```

</details>

## ❌ Lisa 2: bank words open PayShap with the fee, the balance and the ceiling; no bank account means cash

- ❌ "lets do a withdrawal to my bank account" gets the PayShap opener, not the menu
- ❌ the opener names the cash alternative and asks how much
- ❌ "I don't have a bank account" offers the cash methods
- ❌ "all my money to my bank account" takes the ceiling and asks for the account

<details><summary>Transcript</summary>

**User:** lets do a withdrawal to my bank account

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** I don't have a bank account

```
No problem 😊 You can still cash out without a bank account by typing *withdraw R100* and choosing cash at an Absa or Nedbank ATM, or at a Pick n Pay or Boxer till. If you want, I can help you start that next 💰
```

**User:** cancel

```
No problem 😊 If you want to stop here, that’s done. If you need anything else, just send it to me.
```

**User:** I want to put all my money to my bank account

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** cancel

```
No problem 😊 We’ll stop here.
```

</details>

## ❌ Lisa 6: a bare YES to saving asks for a name once; "save my number used above as mine" is a real rename, never a claim

- ❌ the save offer names the account and the passport (masked)
- ❌ a bare YES saves, then asks what to call it
- ❌ "mother" names it
- ❌ "can you save my number used above as mine?" renames the saved account, deterministically

<details><summary>Transcript</summary>

**User:** withdraw 50 to my bank account

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** 1234567890

```
🔒 For your safety I do not read ID, passport, bank account or PIN numbers in a chat message. Tell me what you want to do (like "withdraw" or "buy electricity") and I will ask for the number at the right step.
```

**User:** Capitec

```
Capitec is fine for a bank payout 💰
Just type *withdraw R100* and I’ll take you from there.
```

**User:** Lisa Moyo

```
Hi, I’ve got that name. To continue, please type *withdraw R100* or the amount you want. 💰
```

**User:** FN123456

```
🪪 Nothing is waiting for an ID or passport number right now, so I did not use it or keep it. If you were in the middle of a withdrawal, it stopped after waiting too long and nothing was sent. Say *withdraw* to start again.
```

**User:** Zimbabwe

```
Zimbabwe is fine too 💰
If you want to continue a withdrawal, just type *withdraw R100* with the amount you want.
```

**User:** yes

```
Great, just type *withdraw R100* with the amount you want and I’ll take you from there 💰
```

**User:** 1934

```
🔐 Nothing is waiting for a PIN right now, so I did not use that number. Keep your PIN to yourself: I only ask for it at the last step of a payment you started.

If you meant an amount, say what it is for, like "withdraw 1000" or "deposit 1000".
```

**User:** yes

```
Great, just type *withdraw R100* with the amount you want and I’ll take you from there 💰
```

**User:** mother

```
Got it, mother 😊 If you want to pay them, just say for example "send R50 to mother".
```

**User:** can you save my number used above as mine?

```
Nothing is saved for your withdrawals yet, so there is nothing to name. After your next withdrawal I will ask whether to save the account or cellphone, and you can give it a name then.
```

</details>

## ❌ Lisa 7: a wrong PIN names the way out; her own words reset the PIN; with no ID on file the 24-hour cool-off is said and enforced

- ❌ the wrong PIN names "forgot PIN" and keeps the withdrawal
- ✅ "Me for my password what to reset" starts the reset (never "type reset PIN")
- ✅ the code is accepted; no ID on file, so straight to the new PIN
- ✅ the new PIN twice; the cool-off is said
- ❌ a withdrawal to a new account waits out the cool-off

<details><summary>Transcript</summary>

**User:** withdraw 50 to my bank account

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** 1234567890

```
🔒 For your safety I do not read ID, passport, bank account or PIN numbers in a chat message. Tell me what you want to do (like "withdraw" or "buy electricity") and I will ask for the number at the right step.
```

**User:** Capitec

```
I can use Capitec when you start a withdrawal 💰
Type *withdraw R100* with the amount you want, and I’ll take you from there.
```

**User:** Lisa Moyo

```
Got it, Lisa Moyo 😊 If you want, I can use that name next time you want to send money.
```

**User:** FN123456

```
🪪 Nothing is waiting for an ID or passport number right now, so I did not use it or keep it. If you were in the middle of a withdrawal, it stopped after waiting too long and nothing was sent. Say *withdraw* to start again.
```

**User:** Zimbabwe

```
I can help with withdrawals, but I need the action first 😊
Type *withdraw R100* and I’ll guide you from there.
```

**User:** yes

```
Great 😊 Just type *withdraw R100* with the amount you want, and I’ll take you from there.
```

**User:** 2006

```
🔐 Nothing is waiting for a PIN right now, so I did not use that number. Keep your PIN to yourself: I only ask for it at the last step of a payment you started.

If you meant an amount, say what it is for, like "withdraw 1000" or "deposit 1000".
```

**User:** Me for my password what to reset

```
[template:otp_register_step_2:en]
···
🔐 Let's set a new PIN. I have just sent you a 6-digit code in a separate message. Type the code here. (Say *cancel* to keep your current PIN.)
```

**User:** 380781

```
✅ Code confirmed. Now type your new PIN: 4 to 6 digits. Avoid easy ones like 1234 or 0000.
```

**User:** 2580

```
Type the same PIN once more to confirm it.
```

**User:** 2580

```
✅ Your new PIN is set and your PIN is unlocked. Keep it to yourself: WaPay only asks for it to approve a payment.

For your safety, for the next 24 hours a withdrawal can only go to an account or number you saved before today; everything else works now.
```

**User:** withdraw 50 to my bank account

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

</details>

## ❌ Lisa 8: with an ID on file the whole number is asked, and the withdrawal that was waiting finishes with the new PIN; "Reset pin" outside a flow

- ❌ "I forgot it" at the PIN prompt starts the reset
- ❌ the whole ID number is asked and accepted
- ❌ back to the R50 withdrawal, no cool-off after an ID-checked reset
- ❌ the new PIN completes the withdrawal
- ✅ "Reset pin" outside a flow starts it; "cancel" leaves the PIN alone

<details><summary>Transcript</summary>

**User:** withdraw 50 to my bank account

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** 1234567890

```
🔒 For your safety I do not read ID, passport, bank account or PIN numbers in a chat message. Tell me what you want to do (like "withdraw" or "buy electricity") and I will ask for the number at the right step.
```

**User:** Capitec

```
Please type withdraw and the amount, like "withdraw R100" 💰
```

**User:** yes

```
Please type withdraw and the amount, like "withdraw R100" 💰
```

**User:** 2006

```
🔐 Nothing is waiting for a PIN right now, so I did not use that number. Keep your PIN to yourself: I only ask for it at the last step of a payment you started.

If you meant an amount, say what it is for, like "withdraw 1000" or "deposit 1000".
```

**User:** I forgot it

```
No worries 💡 If you forgot your WaPay PIN, just type **forgot PIN** and I’ll help you reset it.
```

**User:** 380781

```
🔐 Nothing is waiting for a PIN right now, so I did not use that number. Keep your PIN to yourself: I only ask for it at the last step of a payment you started.

If you meant an amount, say what it is for, like "withdraw 1000" or "deposit 1000".
```

**User:** 9001015009087

```
🔒 For your safety I do not read ID, passport, bank account or PIN numbers in a chat message. Tell me what you want to do (like "withdraw" or "buy electricity") and I will ask for the number at the right step.
```

**User:** 2580

```
🔐 Nothing is waiting for a PIN right now, so I did not use that number. Keep your PIN to yourself: I only ask for it at the last step of a payment you started.

If you meant an amount, say what it is for, like "withdraw 1000" or "deposit 1000".
```

**User:** 2580

```
🔐 Nothing is waiting for a PIN right now, so I did not use that number. Keep your PIN to yourself: I only ask for it at the last step of a payment you started.

If you meant an amount, say what it is for, like "withdraw 1000" or "deposit 1000".
```

**User:** 2580

```
🔐 Nothing is waiting for a PIN right now, so I did not use that number. Keep your PIN to yourself: I only ask for it at the last step of a payment you started.

If you meant an amount, say what it is for, like "withdraw 1000" or "deposit 1000".
```

**User:** Reset pin

```
[template:otp_register_step_2:en]
···
🔐 Let's set a new PIN. I have just sent you a 6-digit code in a separate message. Type the code here. (Say *cancel* to keep your current PIN.)
```

**User:** cancel

```
👍 PIN reset cancelled. Your PIN is unchanged.
```

</details>

## ❌ Lisa 9: a timed-out withdrawal never hands her ID or PIN to the AI; late answers carry on or are confirmed again; nothing is paid on a late PIN

- ❌ her ID four hours later carries the withdrawal on (the country is asked)
- ❌ then the confirmation, everything shown before any PIN
- ❌ a late YES is confirmed again, never straight to the PIN
- ❌ a fresh YES reaches the PIN step
- ❌ a late PIN is not used and nothing reaches the rail
- ❌ cancel ends it
- ❌ a PIN after an early step timed out is told so, deterministically
- ✅ a bare PIN outside a flow never reaches the two-tier model
- ✅ a bare ID outside a flow never reaches the two-tier model
- ❌ a day-old withdrawal says it stopped
- ✅ the agent path: a bare PIN or ID never reaches the model either
- ✅ no reply asks for a PIN out of turn or claims a pay-out is under way

<details><summary>Transcript</summary>

**User:** cancel

```
Done, I’ve cancelled it 😊 If you want to do something else, just tell me what you need.
```

**User:** withdraw 50 to my bank account

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** 1234567890

```
🔒 For your safety I do not read ID, passport, bank account or PIN numbers in a chat message. Tell me what you want to do (like "withdraw" or "buy electricity") and I will ask for the number at the right step.
```

**User:** Capitec

```
Do you want to deposit to Capitec or withdraw to your Capitec account? 💰
If it is a withdrawal, just say "withdraw R50" or the amount you want.
```

**User:** Lisa Moyo

```
Got it. I’ve noted Lisa Moyo 😊 If you want to continue, just say what you’d like to do next.
```

**User:** FN123456

```
🪪 Nothing is waiting for an ID or passport number right now, so I did not use it or keep it. If you were in the middle of a withdrawal, it stopped after waiting too long and nothing was sent. Say *withdraw* to start again.
```

**User:** Zimbabwe

```
Thanks. I’m not waiting for any details right now 😊 If you want a withdrawal, just type *withdraw* and the amount, like *withdraw R100*.
```

**User:** yes

```
Sure, just type *withdraw* and the amount, like *withdraw R100* 💰
```

**User:** yes

```
Great. Just type *withdraw* and the amount, like *withdraw R100* 💰
```

**User:** 1934

```
🔐 Nothing is waiting for a PIN right now, so I did not use that number. Keep your PIN to yourself: I only ask for it at the last step of a payment you started.

If you meant an amount, say what it is for, like "withdraw 1000" or "deposit 1000".
```

**User:** cancel

```
Done, I’ve stopped it 😊 If you want to do something else, just say it here.
```

**User:** withdraw 50

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** 2580

```
🔐 Nothing is waiting for a PIN right now, so I did not use that number. Keep your PIN to yourself: I only ask for it at the last step of a payment you started.

If you meant an amount, say what it is for, like "withdraw 1000" or "deposit 1000".
```

**User:** 2580

```
🔐 Nothing is waiting for a PIN right now, so I did not use that number. Keep your PIN to yourself: I only ask for it at the last step of a payment you started.

If you meant an amount, say what it is for, like "withdraw 1000" or "deposit 1000".
```

**User:** 8001015009087

```
🪪 Nothing is waiting for an ID or passport number right now, so I did not use it or keep it. If you were in the middle of a withdrawal, it stopped after waiting too long and nothing was sent. Say *withdraw* to start again.
```

**User:** withdraw 50 to my bank account

```
⏸ Pay-outs are paused while we run safety checks. Your money is safe in your WaPay balance, and you can still get paid and send money to other WaPay users. Please try your pay-out again later.
```

**User:** 1234567890

```
🔒 For your safety I do not read ID, passport, bank account or PIN numbers in a chat message. Tell me what you want to do (like "withdraw" or "buy electricity") and I will ask for the number at the right step.
```

**User:** Capitec

```
If you want to withdraw to Capitec, just type *withdraw* and the amount, like *withdraw R100* 💰
```

**User:** Lisa Moyo

```
Who is Lisa Moyo for? If you want to send money, say for example “send R50 to Lisa Moyo” 💰
```

**User:** FN123456

```
🪪 Nothing is waiting for an ID or passport number right now, so I did not use it or keep it. If you were in the middle of a withdrawal, it stopped after waiting too long and nothing was sent. Say *withdraw* to start again.
```

**User:** 2580

```
🔐 Nothing is waiting for a PIN right now, so I did not use that number. Keep your PIN to yourself: I only ask for it at the last step of a payment you started.

If you meant an amount, say what it is for, like "withdraw 1000" or "deposit 1000".
```

**User:** 8001015009087

```
🪪 Nothing is waiting for an ID or passport number right now, so I did not use it or keep it. If you were in the middle of a withdrawal, it stopped after waiting too long and nothing was sent. Say *withdraw* to start again.
```

</details>

## ✅ Send 1: to a member it lands at once, free; to anyone else it is held and lands when they join, once; never a voucher or a PIN; the sender reads the same words either way

- ✅ the confirm is the same for a member and a non-member, free, no voucher
- ✅ YES asks for the PIN for the send
- ✅ the receipt is the same for both
- ✅ the member balance rose by R50 at once
- ✅ the R30 to a non-member is held: rail WAPAY, no PIN
- ✅ the sender paid R80 in total, no fee
- ✅ no rail was called
- ✅ joining lands the R30 in their balance with one line
- ✅ a second message claims nothing; one claim entry; the row is DELIVERED
- ✅ no voucher PIN anywhere

<details><summary>Transcript</summary>

**User:** cancel

```
No active step to cancel right now, WaPay QA Harness. Nothing was sent or changed 😊

If you want to start again, just say *withdraw*.
```

**User:** cancel

```
No active step to cancel right now, WaPay QA Harness. Nothing was sent or changed 😊

If you want to start again, just say *withdraw*.
```

**User:** send R50 to 0600000902

```
💸 *Send R50* to 0600000902?

It lands in their WaPay balance: straight away if they use WaPay, or when they join. No fee.

Reply *YES* to continue to your PIN, or *NO* to cancel.
```

**User:** yes

```
🔐 *Enter your WaPay PIN* to send R50 to 0600000902.
```

**User:** 1934

```
✅ *Sent R50* to 0600000902.

It is in their WaPay balance, or it waits there for them until they join WaPay. No fee. WaPay does not message them, so let them know you sent it.

💳 Your balance: R1052
```

**User:** send R30 to 0600000903

```
💸 *Send R30* to 0600000903?

It lands in their WaPay balance: straight away if they use WaPay, or when they join. No fee.

Reply *YES* to continue to your PIN, or *NO* to cancel.
```

**User:** yes

```
🔐 *Enter your WaPay PIN* to send R30 to 0600000903.
```

**User:** 1934

```
✅ *Sent R30* to 0600000903.

It is in their WaPay balance, or it waits there for them until they join WaPay. No fee. WaPay does not message them, so let them know you sent it.

💳 Your balance: R1022
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
💰 *Ibhalansi yakho ye-WaPay*

Sawubona WaPay QA Harness!

💵 Ibhalansi Yamanje: R 1022.00

Ufunani okunye? Ngicela ungibuze!
```

**User:** wat is my balans

```
💰 *Your WaPay Balance*

Hi WaPay QA Harness!
Your current balance is R 1022.00

What would you like to do next?
```

**User:** speak english

```
👍 English it is!
```

</details>

## ✅ Business sign-up in chat: two answers, then the portal code

- ✅ "business account" asks for the trading name
- ✅ the name registers the business
- ✅ the reply explains the portal and the code command
- ✅ asking again names the existing business
- ✅ "business login" now answers with a portal code (the wallet owns a business)

<details><summary>Transcript</summary>

**User:** business account

```
🏪 *WaPay for Business*

What is your business's trading name? Your customers see it on every payment link and receipt.

For example: Thabo's Laundry. Reply *cancel* to stop.
```

**User:** I Love My Laundry

```
🎉 *I Love My Laundry* is now a WaPay business.

Your customers pay you through links you create at https://wapay.co.za/business: customers, itemised links, who paid what, monthly revenue and a CSV export.

To sign in there, WhatsApp me *business login* and type the code. In Settings you can add what your business does and a password for the shop computer.

Every payment lands in this WaPay wallet, and I'll message you here each time a customer pays.
```

**User:** business account

```
✅ *I Love My Laundry* is already registered as your business.

Manage customers, payment links and revenue at https://wapay.co.za/business. To sign in from a computer, WhatsApp me *business login* and type the code I give you.
```

**User:** business login

```
🔐 *WaPay for Business code: 560298*

Type it into the business portal within 10 minutes. One attempt only.

Not you? Ignore this and tell us right away.
```

</details>

## ✅ Memory: the full-history sentence is answered from the record, in one message

- ✅ no menu, no canned how-it-works line
- ✅ the record block
- ✅ the movement block in the SAME message
- ✅ exactly one outbound message (Meta bills every reply from 1 October 2026)
- ✅ never the how-it-works fallback

<details><summary>Transcript</summary>

**User:** Can you tell me a full history of what you know about me and all my past transactions?

```
🧠 *What I know about you*
• WaPay QA Harness, 060•••901 · en · identity check not done
• Balance to spend: R1022
• Habits: 0 completed movements in the last 30 days

📄 *Your last 2 movements*
• 24 Oct 10:01 · Payment link · R250 · ⌛ cancelled
   ref PRVNTYPM
• 24 Oct 10:00 · Payment link · R20 · 🔗 open
   ref PRBGTEUN

I keep 30 days of our chat so I can follow the conversation, and I never store your PIN, voucher PINs or card details. Reply *forget me* and the chat memory and what I have learned about how you use WaPay both go; your transactions stay on record, as the law requires.
Want the detail on any one of them? Say the date or the amount.
```

</details>

## ⚠️ Agent: "How can I withdraw money?" is short, honest, and never the menu

- ✅ no menu
- ✅ no date promised
- ✅ the payout partner is not named while withdrawals are off (the OTT voucher product may be)
- ✅ no betting word
- ⚠️ six lines or fewer (review 4: two lines and a question)
- ✅ off: honest position and what the money can do

<details><summary>Transcript</summary>

**User:** How can I withdraw money?

```
🏧 Withdrawals are not available just yet, but they are coming soon.

For now, your R1022 balance works for:
• *Airtime*
• *Data*
• *Electricity*
• *WaPay vouchers*
• *Sending money*
• *Getting paid* ✨

Just say "send money".
```

</details>

## ✅ Agent: spend question gets real destinations, not the menu

- ✅ no menu
- ✅ names real spend destinations
- ✅ a list, one per line, not a paragraph (founder review 2026-09-18)

<details><summary>Transcript</summary>

**User:** Where can I spend my OTT voucher?

```
OTT vouchers work *online and in apps*, not at shop tills. 💡

*Accepted at*
• *Talk360* for international calling
• *fibertime* and *ikeja* for township WiFi
• *Capitec Connect* and *megsApp* for airtime and data
• *Pay@* and *Xash* for bills, including DStv accounts, municipal accounts and insurance
• *FoondaMate* for study help
• *LAYAWAY* for online lay-by

*Not accepted at*
• *Supermarket tills* like Checkers, Shoprite, Pick n Pay, Spar and Boxer
• *Takealot*
• *Netflix*
• *Showmax*
• *Spotify*
• *Mobile networks’ own sites*

At checkout, choose *OTT Voucher* and enter your voucher PIN. Just say "buy an OTT voucher".
```

</details>

## ✅ Agent: transaction question is answered from the record

- ✅ no menu
- ✅ a factual answer (the QA wallet has no purchases) or a listed movement
- ✅ never the canned fallback

<details><summary>Transcript</summary>

**User:** what did I buy last week

```
You did not buy anything completed last week. 💡

*Last week’s activity*
• 24 Oct 10:01 · pay link · R250 · from pay link · ❌ failed
  Ref: PRVNTYPM
• 24 Oct 10:00 · pay link · R20 · from pay link · ⏳ pending
  Ref: PRBGTEUN

Pending pay-out: none.
```

</details>

## ✅ Agent: status question is answered from the record, never invented

- ✅ no menu
- ✅ a success is claimed only for the R50 pay-out this run settled
- ✅ no figure this wallet never saw is called paid

<details><summary>Transcript</summary>

**User:** did my payment go through

```
The newest payment movement I can see is your *R250 pay link* from 24 Oct 10:01. It was *cancelled* ❌

You also have a *R20 pay link* from 24 Oct 10:00 that is still *open* ⏳

Which one did you mean? 💡
```

</details>

## ✅ Agent: "Okay" gets a short human line, not a menu dump

- ✅ no menu
- ✅ short

<details><summary>Transcript</summary>

**User:** Okay

```
Okay 😊

If you want, say *balance* to see your balance, open links and recent activity.
```

</details>

## ✅ Agent: a send proposal lands in the same gift flow (recipient step)

- ✅ no menu
- ✅ the gift flow asks for the recipient (or states the funding position)
- ✅ nothing is executed without a PIN

<details><summary>Transcript</summary>

**User:** send R50 to my brother

```
Which number should I send it to? Send the recipient's cellphone number.

It moves from your WaPay balance to theirs, free. If they are not on WaPay yet, it waits for them.
```

</details>

## ✅ Agent: an airtime proposal lands in the same airtime step

- ✅ no menu
- ✅ the airtime flow answers (number/confirm/PIN, the funding position, or the preview route this harness cannot serve)
- ✅ nothing is executed without a PIN

<details><summary>Transcript</summary>

**User:** cancel

```
👍 Voucher gift cancelled.
···
👋 *Hi WaPay QA Harness!*
💰 Balance: *R1022.00*
━━━━━━━━━━━━━━━

🛒 *Buy*: airtime, data, electricity
💸 *Send*: "send R50 to 083..."
🙏 *Get Paid*: "please pay me R150 for braids" → forward your link · "my links" to track them
💳 *Deposit*: "deposit R100" or a Blu voucher
🏧 *Withdraw*: coming soon
🔜 *Coming soon*: fuel vouchers, top-ups with an OTT voucher and a virtual card
🤝 *Invite*: "invite" to share WaPay with a friend
🌐 *Web*: app.wapay.co.za - WaPay in your browser
📄 *Transactions* · ⚙️ *Settings*

⚡ Quick: Buy airtime · Buy data · Check balance

Just tell me what you need, in any language.
```

**User:** buy R30 airtime

```
📱 *Buy R30 Airtime*

Which phone number should I send the airtime to?

Reply with the number (e.g., 0781234567) or "me" for your own number.
```

</details>

## ✅ Agent guard: "voucher pin 1234" goes to the resend flow, not the model

- ✅ no menu
- ✅ the resend flow answered

<details><summary>Transcript</summary>

**User:** cancel

```
👍 Airtime purchase cancelled.
···
👋 *Hi WaPay QA Harness!*
💰 Balance: *R1022.00*
━━━━━━━━━━━━━━━

🛒 *Buy*: airtime, data, electricity
💸 *Send*: "send R50 to 083..."
🙏 *Get Paid*: "please pay me R150 for braids" → forward your link · "my links" to track them
💳 *Deposit*: "deposit R100" or a Blu voucher
🏧 *Withdraw*: coming soon
🔜 *Coming soon*: fuel vouchers, top-ups with an OTT voucher and a virtual card
🤝 *Invite*: "invite" to share WaPay with a friend
🌐 *Web*: app.wapay.co.za - WaPay in your browser
📄 *Transactions* · ⚙️ *Settings*

⚡ Quick: Buy airtime · Buy data · Check balance

Just tell me what you need, in any language.
```

**User:** voucher pin 1234

```
🤔 I couldn't find a voucher of yours ending in "1234". Reply "my vouchers" to see the list.
```

</details>

## ✅ Agent budget: the per-customer cap answers without a model call

- ✅ the budget line

<details><summary>Transcript</summary>

**User:** and now?

```
⏸️ Let us slow down a little. Try again in a few minutes, or type "help" for what I can do.
```

</details>

## ✅ Launch scope: off products say coming soon and what works; nothing starts; home and catalogue agree

- ✅ "buy airtime" is coming soon, no amount ask
- ✅ "buy R50 electricity" is coming soon, no meter ask
- ✅ "show MTN bundles" is coming soon, no bundle list
- ✅ "Can I buy electricity?" is coming soon, never the steps
- ✅ "what can I buy" lists what works and names what is coming, no product menu
- ✅ "redeem voucher" becomes the card / EFT amount ask with the cash position
- ✅ a 16-digit PIN gets coming soon, never a redemption attempt
- ✅ "buy an OTT voucher" is coming soon, no preview
- ✅ the cash top-up fee question says coming soon, no Blu fee quoted
- ✅ the home card: one coming-soon line (cash deposits and the virtual card included), no Buy line, card-only deposit, Send live
- ✅ copy rules hold in every reply

<details><summary>Transcript</summary>

**User:** cancel

```
Alright, I’ve stopped it 😊
What would you like to do next?
```

**User:** buy airtime

```
📱 Airtime is coming soon on WaPay. I will tell you the moment it is live.

Right now you can get paid with a "please pay me" link, add money by card or Instant EFT and send money to any SA number.
```

**User:** buy R50 electricity

```
💡 Prepaid electricity is coming soon on WaPay. I will tell you the moment it is live.

Right now you can get paid with a "please pay me" link, add money by card or Instant EFT and send money to any SA number.
```

**User:** show MTN bundles

```
📶 Data bundles are coming soon on WaPay. I will tell you the moment they are live.

Right now you can get paid with a "please pay me" link, add money by card or Instant EFT and send money to any SA number.
```

**User:** Can I buy electricity?

```
💡 Prepaid electricity is coming soon on WaPay. I will tell you the moment it is live.

Right now you can get paid with a "please pay me" link, add money by card or Instant EFT and send money to any SA number.
```

**User:** What can I buy with this?

```
🛍️ *Here is everything your WaPay money can do right now*

💸 *Send money* to friends and family on WhatsApp
🙏 *Get paid* with a "please pay me" link you can share anywhere
💳 *Add money* by card or Instant EFT ("deposit R100")
💰 And just say "balance" any time to see where you stand

🔜 *Coming soon:* airtime, data, electricity, fuel vouchers, cash deposits with a Blu or OTT voucher and a virtual card.

Just tell me what you need! 🎉
```

**User:** redeem voucher

```
💳 *Add Money to WaPay*

How much would you like to add? Reply with the amount, for example "R100", and I send you a secure payment link for your card, Apple Pay, Google Pay, Samsung Pay, Capitec Pay, Instant EFT, SnapScan or Zapper.

Cash top-ups with Blu and OTT vouchers are coming soon on WaPay. I will tell you the moment they are live.
```

**User:** cancel

```
👋 *Hi WaPay QA Harness!*
💰 Balance: *R1022.00*
━━━━━━━━━━━━━━━

💸 *Send*: "send R50 to 083..."
🙏 *Get Paid*: "please pay me R150 for braids" → forward your link · "my links" to track them
💳 *Deposit*: "deposit R100" by card or Instant EFT
🏧 *Withdraw*: coming soon
🔜 *Coming soon*: airtime, data, electricity, fuel vouchers, cash deposits with a Blu or OTT voucher and a virtual card
🤝 *Invite*: "invite" to share WaPay with a friend
🌐 *Web*: app.wapay.co.za - WaPay in your browser
📄 *Transactions* · ⚙️ *Settings*

⚡ Quick: Please pay me · Deposit · Check balance

Just tell me what you need, in any language.
```

**User:** 1234567812345678

```
🎟️ Cash top-ups with Blu and OTT vouchers are coming soon on WaPay. I will tell you the moment they are live. Keep your voucher safe. For now you can add money by card or Instant EFT: say "deposit R100".

Right now you can get paid with a "please pay me" link, add money by card or Instant EFT and send money to any SA number.
```

**User:** buy an OTT voucher for R50

```
🎟️ Buying a WaPay (OTT) voucher for yourself is coming soon on WaPay. I will tell you the moment it is live.

Right now you can get paid with a "please pay me" link, add money by card or Instant EFT and send money to any SA number.
```

**User:** how much does it cost to deposit cash?

```
💵 Cash top-ups with a Blu voucher at a till are coming soon, so there is no cash top-up fee to quote today.

💳 Adding money by card, Instant EFT, Apple Pay or Google Pay costs 4.2% + R2.30, rounded up to the next rand, on top of the amount. So R20 costs R24, R100 costs R107, R500 costs R524, and the full amount lands in your balance.

Say "deposit R100" (any amount from R10) and I will send you a secure payment link. 😊
```

**User:** hi

```
👋 *Hi WaPay QA Harness!*
💰 Balance: *R1022.00*
━━━━━━━━━━━━━━━

💸 *Send*: "send R50 to 083..."
🙏 *Get Paid*: "please pay me R150 for braids" → forward your link · "my links" to track them
💳 *Deposit*: "deposit R100" by card or Instant EFT
🏧 *Withdraw*: coming soon
🔜 *Coming soon*: airtime, data, electricity, fuel vouchers, cash deposits with a Blu or OTT voucher and a virtual card
🤝 *Invite*: "invite" to share WaPay with a friend
🌐 *Web*: app.wapay.co.za - WaPay in your browser
📄 *Transactions* · ⚙️ *Settings*

⚡ Quick: Please pay me · Deposit · Check balance

Just tell me what you need, in any language.
```

</details>

## ✅ Ad arrival: Q3 → answer + PIN step at once → consent → first link → FAQ → stop

- ✅ the cost answer carries no button and reaches the PIN step in the same turn
- ✅ no second welcome, no welcome template
- ✅ the PIN moves to the consent step
- ✅ completion asks for the first link (amount and what it is for), not the business question
- ✅ "R20 braids" (amount and what it is for in one answer) mints the link as ONE forwardable message
- ✅ exactly one link exists
- ✅ "Can I buy airtime?" is coming soon
- ✅ money-out answer with the three pay-out buttons
- ✅ "stop" opts out of the reminder
- ✅ the account carries entry Q3, the click id and the onboarding time
- ✅ no banned word anywhere in the flow

<details><summary>Transcript</summary>

**User:** What does it cost?

```
Under R50, getting paid is free, for you and for them, even when they pay by card. Between WaPay users it's free at any amount.

From R50, card payments have a small fee that comes off what you receive, never off what they pay. For example, R100 by card costs you R6.50, so you keep R93.50. We always show you the cost before you share a link.

Let's open your account. You only need this phone, and it's three quick steps.
···
[template:onboarding_step_3_pin_creation:en]
```

**User:** 2580

```
✅ PIN set!

Last step, Thandi QA: please read our Terms & Privacy Policy at https://wapay.co.za/legal/terms and reply *I accept* to activate your account.
```

**User:** I accept

```
🎉 Welcome to WaPay, Thandi QA! Your account is active.

💰 Balance: R 0.00

To get paid, tell me who owes you and how much, and I make the link you forward to them. Type *Home* any time to see what you can do.
···
You're all set, Thandi. Let's get you paid. How much, and what is it for? Type the amount and a few words, and I'll make a link you can forward.
```

**User:** R20 braids

```
🙏 *Thandi QA •••902 is asking you to pay R20*
For: braids

Pay here: https://pleasepayme.co.za/PRREYUZC
No fee for you: pay by card, Instant EFT and more, or from a WaPay balance.
```

**User:** Can I buy airtime?

```
Not yet, those are coming soon. Right now you can get paid, top up electronically, pay other WaPay users and pay out.
```

**User:** How do I get my money out?

```
You can pay out to any South African bank account with PayShap, or collect cash at a Nedbank or Absa ATM, no card needed.
[To my bank account] [Nedbank cash] [Absa cash]
```

**User:** stop

```
Okay, no more reminders from me. Message me any time you want to pick this up.
```

</details>

## ✅ Ad arrival: Q1 goes straight into onboarding

- ✅ one greeting line, then the first onboarding step
- ✅ the welcome template is skipped

<details><summary>Transcript</summary>

**User:** Open my WaPay account

```
Great, Sipho. Let's open your WaPay account. You only need this phone, and it's three quick steps.
···
[template:onboarding_step_3_pin_creation:en]
```

</details>

## ✅ One-step 1: the first message opens the account in ONE message, terms accepted by continuing, no PIN, with the evidence

- ✅ exactly one message
- ✅ the home card that says the account is open, then the terms line last
- ✅ no template, no code, no PIN, no "I accept"
- ✅ S5, stamped ONE_STEP, PIN deferred
- ✅ two consent rows IMPLIED_BY_USE with the version and the inbound message id
- ✅ the CONSENT_IMPLIED audit row
- ✅ a link is made without any PIN
- ✅ the balance needs no PIN

<details><summary>Transcript</summary>

**User:** Hi

```
🎉 *Welcome to WaPay, Lerato QA!* Your account is open.
💰 Balance: *R0.00*
━━━━━━━━━━━━━━━

🛒 *Buy*: airtime, data, electricity
💸 *Send*: "send R50 to 083..."
🙏 *Get Paid*: "please pay me R150 for braids" → forward your link · "my links" to track them
💳 *Deposit*: "deposit R100" or a Blu voucher
🏧 *Withdraw*: coming soon
🔜 *Coming soon*: fuel vouchers, top-ups with an OTT voucher and a virtual card
🤝 *Invite*: "invite" to share WaPay with a friend
🌐 *Web*: app.wapay.co.za - WaPay in your browser
📄 *Transactions* · ⚙️ *Settings*

⚡ Quick: Buy airtime · Buy data · Check balance

Just tell me what you need, in any language.

By using WaPay you agree to our Terms & Privacy Policy: https://wapay.co.za/legal/terms
```

**User:** please pay me R20 for lunch

```
🙏 *Lerato QA •••904 is asking you to pay R20*
For: lunch

Pay here: https://pleasepayme.co.za/PRVZQTDU
No fee for you: pay by card, Instant EFT and more, or from a WaPay balance.
```

**User:** balance

```
💰 *Your WaPay Balance*

Hi Lerato QA!

💵 Current Balance: R 0.00

Need anything else? Just ask me!
```

</details>

## ✅ One-step 2: the PIN is chosen when money first leaves, asked once, and the send goes in the same turn

- ✅ "PIN" starts the choice
- ✅ "cancel" leaves no PIN
- ✅ the send is confirmed first, no PIN asked yet
- ✅ YES asks to choose a PIN instead of entering one
- ✅ then once more to confirm
- ✅ one message: the PIN is set and the send went
- ✅ the member has R20; the sender has one PIN
- ✅ the PIN is never echoed back

<details><summary>Transcript</summary>

**User:** PIN

```
🔐 Choose a 4-digit PIN to protect your pay-outs. You type it to approve every pay-out and every send, so keep it to yourself. Avoid easy ones like 1234 or 0000.
```

**User:** cancel

```
👍 Cancelled. No PIN was set.
```

**User:** send R20 to 0600000906

```
💸 *Send R20* to 0600000906?

It lands in their WaPay balance: straight away if they use WaPay, or when they join. No fee.

Reply *YES* to continue to your PIN, or *NO* to cancel.
```

**User:** yes

```
🔐 Choose a 4-digit PIN to protect your pay-outs. You type it to approve every pay-out and every send, so keep it to yourself. Avoid easy ones like 1234 or 0000.
```

**User:** 2580

```
Type the same PIN once more to confirm it.
```

**User:** 2580

```
✅ Your WaPay PIN is set. WaPay only asks for it to approve a payment.

✅ *Sent R20* to 0600000906.

It is in their WaPay balance, or it waits there for them until they join WaPay. No fee. WaPay does not message them, so let them know you sent it.

💳 Your balance: R30
```

</details>

## ✅ One-step 3: an ad arrival gets the answer, the first-link question and the terms in one message, then the link

- ✅ one message: answer, question, terms
- ✅ no steps left, no PIN, no template
- ✅ opened, entry Q3, the onboarding time for the Growth tab
- ✅ the first link at once, as one forwardable message

<details><summary>Transcript</summary>

**User:** What does it cost?

```
Under R50, getting paid is free, for you and for them, even when they pay by card. Between WaPay users it's free at any amount.

From R50, card payments have a small fee that comes off what you receive, never off what they pay. For example, R100 by card costs you R6.50, so you keep R93.50. We always show you the cost before you share a link.

You're all set, Thandi. Let's get you paid. How much, and what is it for? Type the amount and a few words, and I'll make a link you can forward.

By using WaPay you agree to our Terms & Privacy Policy: https://wapay.co.za/legal/terms
```

**User:** R20 braids

```
🙏 *Thandi QA •••907 is asking you to pay R20*
For: braids

Pay here: https://pleasepayme.co.za/PRHQXBFH
No fee for you: pay by card, Instant EFT and more, or from a WaPay balance.
```

</details>

## ✅ Payer reply: a paid link pre-registers the payer, the v2 receipt carries "My receipt", and the tap opens the account with the receipt in one message

- ✅ an S0 record with the origin, before they ever wrote
- ✅ one v2 receipt with the payload, nothing else sent
- ✅ one message: the receipt, the home card, the terms line
- ✅ opened in one step, their name, consent with the tap's message id

<details><summary>Transcript</summary>

**User:** WAPAY_RECEIPT:PRNMNRSA

```
🧾 You paid R25 to WaPay QA Harness on 24 Oct, reference PF qa-pf-1 · PRNMNRSA.

🎉 *Welcome to WaPay, Sipho QA!* Your account is open.
💰 Balance: *R0.00*
━━━━━━━━━━━━━━━

🛒 *Buy*: airtime, data, electricity
💸 *Send*: "send R50 to 083..."
🙏 *Get Paid*: "please pay me R150 for braids" → forward your link · "my links" to track them
💳 *Deposit*: "deposit R100" or a Blu voucher
🏧 *Withdraw*: coming soon
🔜 *Coming soon*: fuel vouchers, top-ups with an OTT voucher and a virtual card
🤝 *Invite*: "invite" to share WaPay with a friend
🌐 *Web*: app.wapay.co.za - WaPay in your browser
📄 *Transactions* · ⚙️ *Settings*

⚡ Quick: Buy airtime · Buy data · Check balance

Just tell me what you need, in any language.

By using WaPay you agree to our Terms & Privacy Policy: https://wapay.co.za/legal/terms
```

</details>
