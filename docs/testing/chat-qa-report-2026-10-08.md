# WaPay chat QA report · 2026-10-08

Conversational end-to-end run against the REAL message processor (live DB, live OpenAI, outbound WhatsApp captured, no money moved). QA account: `27600000901` (seeded and torn down by the run).

**29 pass · 1 warn · 0 fail**

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
[button:View my payment page -> https://pleasepayme.co.za/PRDASPMQ]
···
🙏 *Pay WaPay QA Harness now* · R20 on WaPay

Tap the link to pay. Free from a WaPay balance, or pay by card:
https://pleasepayme.co.za/PRDASPMQ
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
⛽ *Fuel vouchers*: coming soon
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
⛽ *Fuel vouchers*: coming soon
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
[button:View my payment page -> https://pleasepayme.co.za/PRUYANFR]
···
🙏 *Pay WaPay QA Harness now* · R250 on WaPay

Tap the link to pay. Free from a WaPay balance, or pay by card:
https://pleasepayme.co.za/PRUYANFR
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
⛽ *Fuel vouchers*: coming soon
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
Nice to meet you, Thabo 💰
Spaza shops can use WaPay for getting paid, sending money, airtime, data and electricity. If you want, we can set up a business account next ✨
```

**User:** What did I tell you my name was?

```
You told me your name is *Thabo* 😊
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
You can spend your WaPay money on:
• *Airtime and data* for your number or any other SA number
• *Prepaid electricity* for any meter
• *Send money* to friends and family on WhatsApp
• *Get paid* with a please-pay-me link you can share anywhere
• *WaPay vouchers* online and in apps at many stores and services

Just say "balance" any time to see what you have 💰✨
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

💸 Sending money to another WaPay user from your balance is free. Sending a WaPay voucher to any SA number costs R3 flat. Buying an OTT voucher for yourself is free.

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
• *OTT voucher:* already have one? Send me its 16-digit PIN and I load the value into your balance.

To find out more, just ask.
```

</details>

## ✅ How it works: capability questions get the steps, not a flow or a menu

- ✅ "Can I buy electricity?" explains and offers the words to start
- ✅ an OTT cash-out question is answered, not turned into a withdrawal
- ✅ "Is it accepted at Checkers?" gets a no by name and the places it does work
- ✅ "Can I send money to someone?" explains sending

<details><summary>Transcript</summary>

**User:** Can I buy electricity?

```
💡 Yes: prepaid electricity for any meter, R10 to R5000, no WaPay fee. You give the meter number, confirm, enter your PIN, and the 20-digit token arrives here in the chat within about a minute.

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
✅ Yes. Say "send R50 to 083 123 4567" or share a contact card; confirm and enter your PIN. If they are on WaPay it lands in their balance instantly and it is free; if not, they get a WaPay voucher PIN by WhatsApp (R3 fee). They can spend it on airtime, data, electricity or vouchers, or send it on.

Want me to take you through it step by step? Reply *YES* and I will start, or say "send R50 to 083 123 4567" any time. 😊
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
• "Show me Vodacom bundles"
• "Buy R50 airtime"
• "Weekly MTN bundles"
• "Redeem voucher"

Just tell me what you need! 🎉
```

</details>

## ✅ Withdraw: with payouts live the flow starts deterministically and fees are quoted

- ✅ "withdraw R20" reaches the flow and reports the R20 minimum against a R0 wallet
- ✅ never "coming soon" while live
- ✅ "can I take my money out?" is a QUESTION: a short specific answer plus the offer, no flow starts (knowledge base, 2026-09-15)
- ✅ the cash-out fee question quotes R8 / R10 / R18

<details><summary>Transcript</summary>

**User:** withdraw R20

```
💸 Withdrawals start at R20 plus the fee, so the smallest one needs R38, and you have R0 available right now. Your balance still works for airtime, data, electricity and sending money.
```

**User:** can I take my money out?

```
✅ Yes. You can move money to your own bank account by PayShap (R8, minutes) or collect cash at an Absa or Nedbank ATM, a Pick n Pay / Boxer till, or as an FNB eWallet (from R18). Withdrawals start at R20 and you need your 13-digit ID number.

Want me to take you through it step by step? Reply *YES* and I will start, or say "withdraw R50" any time. 😊
```

**User:** what is the cash-out fee?

```
🏧 Withdrawals: R8 to your bank account by PayShap in minutes, R10 for a bank transfer, and cash at an Absa or Nedbank ATM, a Pick n Pay / Boxer till, or as an FNB eWallet for R18 up to R700, R23 up to R1500, R30 above that. Say "withdraw R200" to start. 😊
```

</details>

## ✅ Questions: fuel ask in test mode is coming-soon, never claimed redeemable

- ✅ no bare menu for a fuel question
- ✅ no live-redemption claim while gated
- ✅ fuel presented as coming soon

<details><summary>Transcript</summary>

**User:** Can I buy petrol with WaPay?

```
⛽ Fuel vouchers are coming to WaPay soon, and we are just as excited as you are! I will tell you the moment they go live. In the meantime your money works for airtime, data, electricity, vouchers, sending and getting paid.

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

💸 Sending money to another WaPay user from your balance is free. Sending a WaPay voucher to any SA number costs R3 flat. Buying an OTT voucher for yourself is free.

🙏 Please-pay-me links: the person paying never pays a fee. You pay nothing on requests under R50; above that 4.2% + R2.30 comes off what you receive (a R100 request pays you R93.50).

🏧 Cash withdrawals are not available just yet, but they are coming soon, so there is no withdrawal fee to quote today.

📱 Airtime, data and electricity: no WaPay fee, you pay the product price.

No monthly fees, ever. 😊
```

**User:** cancel

```
No problem 😊 Cancelled. If you want to start again later, just say what you need.
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
💸 *Send*: "send R10 airtime to 083..."
🙏 *Get Paid*: "please pay me R50" → share your link
💳 *Deposit*: "deposit R100" or a Blu voucher
⛽ *Fuel vouchers*: coming soon
🏧 *Withdraw*: "withdraw R200" to your bank, or cash at an ATM
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
💸 *Send*: "send R10 airtime to 083..."
🙏 *Get Paid*: "please pay me R50" → share your link
💳 *Deposit*: "deposit R100" or a Blu voucher
⛽ *Fuel vouchers*: coming soon
🏧 *Withdraw*: "withdraw R200" to your bank, or cash at an ATM
📄 *Transactions* · ⚙️ *Settings*

⚡ Quick: Buy airtime · Buy data · Check balance

Just tell me what you need, in any language.
```

</details>

## ✅ How it works: "Can I withdraw at an Absa ATM?" gets a specific short answer, and YES starts the flow

- ✅ the answer is about Absa: fee, minimum, what is needed
- ✅ no four-step wall for a "can I" question
- ✅ offers to take them through it
- ✅ YES starts the withdrawal (Absa pre-selected)

<details><summary>Transcript</summary>

**User:** Can I withdraw at an ABSA atm?

```
✅ Yes. You can collect cash at any Absa ATM or a Pick n Pay / Boxer till, no bank account needed: R18 fee up to R700, from R50. You need the cellphone number that will get the SMS code and your 13-digit ID number.

Want me to take you through it step by step? Reply *YES* and I will start, or say "withdraw R50" any time. 😊
```

**User:** yes

```
How much would you like to withdraw by Cash at an Absa ATM (CashSend)? Between R50 and R82. You have R100 available; the fee comes off your balance on top of the amount.
```

</details>

## ✅ Withdraw end to end: minimum explained, method changed, FNB eWallet paid with PIN, balance moves

- ✅ "Withdraw 30" shows the live menu incl. FNB eWallet
- ✅ Absa at R30: the one method that carries R30 is offered as a yes or no, no menu bounce (founder review 2026-09-18)
- ✅ "back" returns to the method menu ("menu" goes home, like a banking app)
- ✅ FNB eWallet keeps the R30 and asks for the cellphone number
- ✅ the full name is asked once, as on the ID, because KYC has none (founder 2026-10-04)
- ✅ the ID number is asked because the provider requires it
- ✅ confirmation names the eWallet, the amount and the fee
- ✅ YES asks for the PIN
- ✅ the PIN executes exactly one pay-out and returns a reference
- ✅ after Done the chat itself says where the code arrives and how to collect (founder 2026-10-04)
- ✅ the confirmation shows the name as given and the ID number masked
- ✅ exactly one PerformPayout to FNB e-wallet (code 1) for R30
- ✅ balance is R100 - R30 - R18 = R52
- ✅ the confirmation shows what leaves and what remains

<details><summary>Transcript</summary>

**User:** cancel

```
👍 Cancelled. Your money stays in your balance.
```

**User:** Withdraw 30

```
💸 *Withdraw from WaPay*

You have R100 available. How would you like it?

1️⃣ *PayShap* to your bank account: R8 fee. Minimum withdrawals from R50.
2️⃣ *Cash at an Absa ATM* or a Pick n Pay / Boxer till, no bank account needed: from R18 fee. Minimum withdrawals from R50.
3️⃣ *Cash at a Nedbank ATM*, code by SMS, no bank account needed: from R18 fee. Minimum withdrawals from R20.
4️⃣ *FNB eWallet*: cash at any FNB ATM with the code sent by SMS, no bank account needed: from R18 fee. Minimum withdrawals from R20.

Reply 1, 2, 3 or 4. Reply "cancel" to stop.
```

**User:** 2

```
R30 is below the R50 minimum for cash at an Absa ATM, but cash at a Nedbank ATM takes R30 for an R18 fee, so R48 leaves your balance. Reply *YES* to switch to that, or type another amount.
```

**User:** back

```
💸 *Withdraw from WaPay*

You have R100 available. How would you like it?

1️⃣ *PayShap* to your bank account: R8 fee. Minimum withdrawals from R50.
2️⃣ *Cash at an Absa ATM* or a Pick n Pay / Boxer till, no bank account needed: from R18 fee. Minimum withdrawals from R50.
3️⃣ *Cash at a Nedbank ATM*, code by SMS, no bank account needed: from R18 fee. Minimum withdrawals from R20.
4️⃣ *FNB eWallet*: cash at any FNB ATM with the code sent by SMS, no bank account needed: from R18 fee. Minimum withdrawals from R20.

Reply 1, 2, 3 or 4. Reply "cancel" to stop.
```

**User:** 4

```
Which cellphone number should receive the FNB eWallet? Reply *mine* to use this WhatsApp number, or type the number. The eWallet code is sent to it by SMS and the cash is collected at any FNB ATM.
```

**User:** mine

```
What is your full name, exactly as it appears on your ID? First name and surname, please.
```

**User:** Thandi Nkosi

```
The bank needs your 13-digit South African ID number for this payout (it must match the account holder). Please type it, or "cancel".
```

**User:** 9001015009087

```
Please confirm:

💸 Withdraw *R30* to an FNB eWallet on 0600000901 (cash at any FNB ATM)
Name on the account: Thandi Nkosi
ID number: •••087
Fee: R18
Total leaving your balance: *R48* (R30 + R18 fee)
Balance after: *R52*

Reply *YES* to continue to your PIN, or *NO* to cancel.
```

**User:** yes

```
🔐 *Enter your WaPay PIN* to withdraw R30.
```

**User:** 1934

```
✅ *Done.* R30 is on its way to you by FNB eWallet. Reference WP7CD85AA0943A33. Fee R18.

📲 The eWallet code is sent by SMS to •••901.

Collecting your eWallet:
1️⃣ Go to any FNB ATM.
2️⃣ Choose *Cardless services* then *eWallet*.
3️⃣ Enter the cellphone number that received the SMS.
4️⃣ Enter the ATM PIN from the SMS and choose the amount.
5️⃣ Take your cash. No card or bank account needed.
If anything is unclear, just ask and I will guide you step by step.

If the SMS does not arrive, message me here with your reference and I will check.
```

**User:** balance

```
💰 *Your WaPay Balance*

Hi WaPay QA Harness!

💵 Current Balance: R 52.00

Need anything else? Just ask me!
```

</details>

## ✅ Compound answers: "50 and 2", "50 at ABSA", "the Nedbank one" are read as amount + method and confirmed in one line (founder 2026-10-04)

- ✅ "Can I withdraw 20" opens the menu (amount kept) and the menu says "Minimum withdrawals from"
- ✅ "50 and 2" is confirmed in one line, not "Reply 1, 2, 3 or 4"
- ✅ YES carries on to the cellphone step with R50 and Absa set
- ✅ a fresh withdrawal: PayShap asks for the amount
- ✅ "50 at ABSA" at the amount step switches method and amount with one confirming line, not "Just the amount"
- ✅ the founder's exact sentence gets the confirmation, never the four-step explainer
- ✅ "the Nedbank one" switches the method and asks the amount
- ✅ R20 by Nedbank goes to the cellphone step
- ✅ "Add money" inside the withdraw flow is answered by the deposit side, never the method menu (BUGLOG #94)

<details><summary>Transcript</summary>

**User:** Can I withdraw 20

```
💸 *Withdraw from WaPay*

You have R252 available. How would you like it?

1️⃣ *PayShap* to your bank account: R8 fee. Minimum withdrawals from R50.
2️⃣ *Cash at an Absa ATM* or a Pick n Pay / Boxer till, no bank account needed: from R18 fee. Minimum withdrawals from R50.
3️⃣ *Cash at a Nedbank ATM*, code by SMS, no bank account needed: from R18 fee. Minimum withdrawals from R20.
4️⃣ *FNB eWallet*: cash at any FNB ATM with the code sent by SMS, no bank account needed: from R18 fee. Minimum withdrawals from R20.

Reply 1, 2, 3 or 4. Reply "cancel" to stop.
```

**User:** 50 and 2

```
Got it: R50 by cash at an Absa ATM. Is that right? Reply *YES* to carry on, or tell me what to change.
```

**User:** yes

```
Which cellphone number will collect the cash at the Absa ATM or till? Reply *mine* to use this WhatsApp number, or type the number. The collection code is sent to it by SMS.
```

**User:** cancel

```
👍 Cancelled. Your money stays in your balance.
```

**User:** withdraw

```
💸 *Withdraw from WaPay*

You have R252 available. How would you like it?

1️⃣ *PayShap* to your bank account: R8 fee. Minimum withdrawals from R50.
2️⃣ *Cash at an Absa ATM* or a Pick n Pay / Boxer till, no bank account needed: from R18 fee. Minimum withdrawals from R50.
3️⃣ *Cash at a Nedbank ATM*, code by SMS, no bank account needed: from R18 fee. Minimum withdrawals from R20.
4️⃣ *FNB eWallet*: cash at any FNB ATM with the code sent by SMS, no bank account needed: from R18 fee. Minimum withdrawals from R20.

Reply 1, 2, 3 or 4. Reply "cancel" to stop.
```

**User:** 1

```
How much would you like to withdraw by PayShap? Between R50 and R244. You have R252 available; the fee comes off your balance on top of the amount.
```

**User:** 50 at ABSA

```
Got it: R50 by cash at an Absa ATM. Is that right? Reply *YES* to carry on, or tell me what to change.
```

**User:** No can you help me withdraw 50 at ABSA?

```
Got it: R50 by cash at an Absa ATM. Is that right? Reply *YES* to carry on, or tell me what to change.
```

**User:** the Nedbank one

```
How much would you like to withdraw by Cash at a Nedbank ATM? Between R20 and R234. You have R252 available; the fee comes off your balance on top of the amount.
```

**User:** 20

```
Which cellphone number will collect the cash at the Nedbank ATM? Reply *mine* to use this WhatsApp number, or type the number. The withdrawal code is sent to it by SMS.
```

**User:** cancel

```
👍 Cancelled. Your money stays in your balance.
```

**User:** withdraw

```
💸 *Withdraw from WaPay*

You have R252 available. How would you like it?

1️⃣ *PayShap* to your bank account: R8 fee. Minimum withdrawals from R50.
2️⃣ *Cash at an Absa ATM* or a Pick n Pay / Boxer till, no bank account needed: from R18 fee. Minimum withdrawals from R50.
3️⃣ *Cash at a Nedbank ATM*, code by SMS, no bank account needed: from R18 fee. Minimum withdrawals from R20.
4️⃣ *FNB eWallet*: cash at any FNB ATM with the code sent by SMS, no bank account needed: from R18 fee. Minimum withdrawals from R20.

Reply 1, 2, 3 or 4. Reply "cancel" to stop.
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

💵 Ibhalansi Yamanje: R 252.00

Ufunani okunye? Ngicela ungibuze!
```

**User:** wat is my balans

```
💰 *Ibhalansi yakho ye-WaPay*

Sawubona WaPay QA Harness!  
Ibhalansi yakho yamanje ingu-R 252.00

  
Uthanda ukwenza ini kulandela?
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
🔐 *WaPay for Business code: 972067*

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
• Balance to spend: R252
• Habits: 1 completed movement in the last 30 days

📄 *Your last 3 movements*
• 08 Oct 15:54 · Withdrawal (FNB eWallet) · R30 → Thandi Nkosi · ✅ paid
   ref WP7CD85AA0943A33
• 08 Oct 15:51 · Payment link · R250 · 🔗 open
   ref PRUYANFR
• 08 Oct 15:50 · Payment link · R20 · 🔗 open
   ref PRDASPMQ

I keep 30 days of our chat so I can follow the conversation, and I never store your PIN, voucher PINs or card details. Reply *forget me* and the chat memory and what I have learned about how you use WaPay both go; your transactions stay on record, as the law requires.
Want the detail on any one of them? Say the date or the amount.
```

</details>

## ⚠️ Agent: "How can I withdraw money?" is short, honest, and never the menu

- ✅ no menu
- ✅ no date promised
- ✅ the payout partner is not named while withdrawals are off
- ✅ no betting word
- ⚠️ six lines or fewer (review 4: two lines and a question)
- ✅ off: honest position and what the money can do

<details><summary>Transcript</summary>

**User:** How can I withdraw money?

```
🏧 Withdrawals are not available just yet, but they are coming soon.

For now your R252 balance works for:
• *Airtime*
• *Data*
• *Electricity*
• *WaPay vouchers*
• *Sending money*
• *Getting paid*

Just come back here if you have any questions. If you get stuck on any step, just ask me and I will guide you. ✨
```

</details>

## ✅ Agent: spend question gets real destinations, not the menu

- ✅ no menu
- ✅ names real spend destinations
- ✅ a list, one per line, not a paragraph (founder review 2026-09-18)

<details><summary>Transcript</summary>

**User:** Where can I spend my OTT voucher?

```
OTT vouchers are for *online and app payments*, not shop tills. 💡

*Accepted at*
• *Talk360* for international calling
• *fibertime* and *ikeja* for township WiFi
• *Capitec Connect* and *megsApp* for airtime and data
• *Pay@* and *Xash* for bills like DStv accounts, municipal accounts and insurance
• *FoondaMate* for study help
• *LAYAWAY* for online lay-by

*Not accepted at*
• *Supermarket tills* like Checkers, Shoprite, Pick n Pay, Spar and Boxer
• *Takealot*
• *Netflix*
• *Showmax*
• *Spotify*
• *Mobile networks’ own sites*

At checkout, choose *OTT Voucher* and enter the PIN. To find out more, just ask. ✨
```

</details>

## ✅ Agent: transaction question is answered from the record

- ✅ no menu
- ✅ a factual answer (the QA wallet has no purchases) or a listed movement
- ✅ never the canned fallback

<details><summary>Transcript</summary>

**User:** what did I buy last week

```
Last week, I only see one completed movement. No purchases. 💡

• *08 Oct 15:54* · pay-out · R30 · to Thandi Nkosi · ✅ paid
  ref WP7CD85AA0943A33
• *08 Oct 15:51* · payment link · R250 · from open link · ⏳ pending
  ref PRUYANFR
• *08 Oct 15:50* · payment link · R20 · from open link · ⏳ pending
  ref PRDASPMQ

Completed total: R30. Pending pay links: 2.
```

</details>

## ✅ Agent: status question is answered from the record, never invented

- ✅ no menu
- ✅ a success is claimed only for the R30 pay-out this run settled
- ✅ no figure this wallet never saw is called paid

<details><summary>Transcript</summary>

**User:** did my payment go through

```
Which one do you mean, your newest *R250 payment link* or the *R20 payment link*? 💡

• *R250 link* · ref PRUYANFR · still open
• *R20 link* · ref PRDASPMQ · still open
```

</details>

## ✅ Agent: "Okay" gets a short human line, not a menu dump

- ✅ no menu
- ✅ short

<details><summary>Transcript</summary>

**User:** Okay

```
No problem 😊

If you want to check one later, just send me the amount or the reference, like *PRUYANFR* or *PRDASPMQ*.
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

I'll send them a WaPay voucher they can spend online at any store that accepts OTT vouchers.
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
💰 Balance: *R252.00*
━━━━━━━━━━━━━━━

🛒 *Buy*: airtime, data, electricity
💸 *Send*: "send R10 airtime to 083..."
🙏 *Get Paid*: "please pay me R50" → share your link
💳 *Deposit*: "deposit R100" or a Blu voucher
⛽ *Fuel vouchers*: coming soon
🏧 *Withdraw*: coming soon
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
💰 Balance: *R252.00*
━━━━━━━━━━━━━━━

🛒 *Buy*: airtime, data, electricity
💸 *Send*: "send R10 airtime to 083..."
🙏 *Get Paid*: "please pay me R50" → share your link
💳 *Deposit*: "deposit R100" or a Blu voucher
⛽ *Fuel vouchers*: coming soon
🏧 *Withdraw*: coming soon
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
