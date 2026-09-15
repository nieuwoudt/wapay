# WaPay chat QA report · 2026-09-15

Conversational end-to-end run against the REAL message processor (live DB, live OpenAI, outbound WhatsApp captured, no money moved). QA account: `27600000901` (seeded and torn down by the run).

**16 pass · 0 warn · 0 fail**

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
[button:View my payment page -> https://pleasepayme.co.za/PRDHTPHM]
···
🙏 *Pay WaPay QA Harness now* · R20 on WaPay

Tap the link to pay. Free from a WaPay balance, or pay by card:
https://pleasepayme.co.za/PRDHTPHM
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
[button:View my payment page -> https://pleasepayme.co.za/PRRPPQRC]
···
🙏 *Pay WaPay QA Harness now* · R250 on WaPay

Tap the link to pay. Free from a WaPay balance, or pay by card:
https://pleasepayme.co.za/PRRPPQRC
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
Nice to meet you, Thabo 😊 That’s helpful, and I’ll keep it in mind.
```

**User:** What did I tell you my name was?

```
You told me your name was Thabo 😊
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
Green 😊
```

</details>

## ✅ Questions: the founder repro gets a real spend answer, never the menu

- ✅ no bare menu for the exact founder phrasing
- ✅ the answer names real spend destinations
- ✅ the reply carries warmth (emoji)

<details><summary>Transcript</summary>

**User:** Where can I spend my WaPay money!

```
You can use your WaPay money for airtime and data, prepaid electricity, sending money, getting paid, and OTT vouchers online or in apps 💡📱

Say "balance" anytime to see where you stand.
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
💳 Two ways to add money.

*Card, Instant EFT, Apple Pay or Google Pay:* say "deposit R100" (R10 to R3000) and I send you a secure payment link. The fee is 4.2% + R2.30 on top, rounded up to the next rand (R20 costs R24, R100 costs R107, R500 costs R524); the full amount lands in your balance the moment the payment clears and I message you.

*Cash at a till:* ask any major retailer for a Blu Voucher for the amount you want, then send me the voucher code. The voucher network keeps 6%, so a R100 voucher adds R94.
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
💡 Yes, you can buy prepaid electricity for any meter, from R10 to R5000, with no WaPay fee.

Say "buy R100 electricity", give me the meter number (11 to 13 digits, on your meter or an old slip), confirm, and enter your PIN. The 20-digit token arrives here in the chat, usually within a minute; some municipalities take up to about 90 seconds. Type the token into your meter and you are done.
```

**User:** Can they withdraw the OTT voucher for money?

```
🎟️ A WaPay voucher is an OTT voucher: a 12-digit PIN worth the amount you choose (R10 to R1000). Say "buy an OTT voucher for R100", confirm, enter your PIN, and the PIN arrives right here in the chat. Buying one for yourself is free.

Where it works: OTT vouchers are accepted ONLINE and in apps, never at a shop till. Partners that take them as payment include Talk360 (international calling), fibertime and ikeja (township WiFi), Capitec Connect and megsApp (airtime and data), Pay@ and Xash (bills including DStv accounts, municipal accounts and insurance), FoondaMate (study help) and LAYAWAY (online lay-by). Not accepted: supermarket tills (Checkers, Shoprite, Pick n Pay, Spar, Boxer), Takealot, Netflix, Showmax, Spotify, or the mobile networks' own sites. At checkout the customer chooses OTT Voucher and enters the 12-digit PIN. The full live list is on ottvoucher.com.

Good to know: The PIN is single-use and worth exactly the amount bought, so buy the amount you need. Some partners take the whole value, others charge the exact price and put the change into an OTT Wallet you register for with your SA ID number; the change never stays on the PIN. It cannot be exchanged for cash or paid into a bank account, it expires 36 months after purchase, and many partners cap one PIN at R3000. A PIN that will not redeem is an OTT support matter: WhatsApp +27 84 325 5632.
```

**User:** Is it accepted at Checkers?

```
❌ No, Checkers does not take OTT vouchers (Checkers sells OTT vouchers at the till, but does not take them as payment).

🎟️ OTT vouchers are accepted ONLINE and in apps, never at a shop till. Partners that take them as payment include Talk360 (international calling), fibertime and ikeja (township WiFi), Capitec Connect and megsApp (airtime and data), Pay@ and Xash (bills including DStv accounts, municipal accounts and insurance), FoondaMate (study help) and LAYAWAY (online lay-by). Not accepted: supermarket tills (Checkers, Shoprite, Pick n Pay, Spar, Boxer), Takealot, Netflix, Showmax, Spotify, or the mobile networks' own sites. At checkout the customer chooses OTT Voucher and enters the 12-digit PIN. The full live list is on ottvoucher.com.

🎟️ A WaPay voucher is an OTT voucher: a 12-digit PIN worth the amount you choose (R10 to R1000). Say "buy an OTT voucher for R100", confirm, enter your PIN, and the PIN arrives right here in the chat. Buying one for yourself is free.

Good to know: The PIN is single-use and worth exactly the amount bought, so buy the amount you need. Some partners take the whole value, others charge the exact price and put the change into an OTT Wallet you register for with your SA ID number; the change never stays on the PIN. It cannot be exchanged for cash or paid into a bank account, it expires 36 months after purchase, and many partners cap one PIN at R3000. A PIN that will not redeem is an OTT support matter: WhatsApp +27 84 325 5632.
```

**User:** Can I send money to someone?

```
💸 Sending money is simple: say "send R50 to 083 123 4567", use a saved name like "send R50 to Philly", or share a contact card from your phone. Confirm, enter your PIN, done.

If the person is on WaPay the money lands in their WaPay balance instantly and it is free. If they are not, they receive a WaPay voucher PIN by WhatsApp (R3 fee, R10 to R1000) which they can spend online wherever OTT vouchers are accepted, or load into WaPay by joining.

What can they do with it? Spend it on airtime, data, electricity or vouchers, or send it on. Cash withdrawals are coming soon.
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

📱 Mobile Airtime
   _Vodacom, MTN, Cell C, Telkom_

📶 Data Bundles
   _Daily, Weekly, Monthly bundles_

💡 Prepaid Electricity
   _Eskom, City Power, and more_

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
- ✅ "can I take my money out?" is a QUESTION: the steps are explained, no flow starts (knowledge base, 2026-09-15)
- ✅ the cash-out fee question quotes R8 / R10 / R18

<details><summary>Transcript</summary>

**User:** withdraw R20

```
💸 Withdrawals start at R20 and you have R0 available right now. Your balance still works for airtime, data, electricity and sending money.
```

**User:** can I take my money out?

```
🏧 Yes, you can take money out of WaPay. Here is how it works:

1️⃣ Say *withdraw* and the amount, for example "withdraw R200" (between R20 and R3000).
2️⃣ Choose how: *PayShap* to your own bank account (R8 fee, arrives in minutes), or *cash at an Absa ATM* or a Pick n Pay / Boxer till with no bank account needed (R18 fee up to R700, R23 up to R1500, R30 above).
3️⃣ Give the details the bank needs: your account number and bank for PayShap, or the cellphone number that will collect the cash, plus your 13-digit SA ID number.
4️⃣ Confirm, then enter your WaPay PIN. The amount plus the fee leaves your balance, you get a reference straight away, and I message you the moment the bank confirms.

A once-off identity check applies before your first withdrawal. The money must go to an account or a person in your own name.
```

**User:** what is the cash-out fee?

```
🏧 Withdrawals: R8 to your bank account by PayShap in minutes, R10 for a bank transfer, and cash at an Absa ATM or a Pick n Pay / Boxer till for R18 up to R700, R23 up to R1500, R30 above that. Say "withdraw R200" to start. 😊
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
🎟️ A WaPay voucher is an OTT voucher: a 12-digit PIN worth the amount you choose (R10 to R1000). Say "buy an OTT voucher for R100", confirm, enter your PIN, and the PIN arrives right here in the chat. Buying one for yourself is free.

Where it works: OTT vouchers are accepted ONLINE and in apps, never at a shop till. Partners that take them as payment include Talk360 (international calling), fibertime and ikeja (township WiFi), Capitec Connect and megsApp (airtime and data), Pay@ and Xash (bills including DStv accounts, municipal accounts and insurance), FoondaMate (study help) and LAYAWAY (online lay-by). Not accepted: supermarket tills (Checkers, Shoprite, Pick n Pay, Spar, Boxer), Takealot, Netflix, Showmax, Spotify, or the mobile networks' own sites. At checkout the customer chooses OTT Voucher and enters the 12-digit PIN. The full live list is on ottvoucher.com.

Good to know: The PIN is single-use and worth exactly the amount bought, so buy the amount you need. Some partners take the whole value, others charge the exact price and put the change into an OTT Wallet you register for with your SA ID number; the change never stays on the PIN. It cannot be exchanged for cash or paid into a bank account, it expires 36 months after purchase, and many partners cap one PIN at R3000. A PIN that will not redeem is an OTT support matter: WhatsApp +27 84 325 5632.
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
No problem 😊 If you want, just send me the next thing you need.
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

💵 Ibhalansi yamanje: R 0.00

Ufunani okunye? Ngicela ungibuze!
```

**User:** wat is my balans

```
💰 *Ibhalansi yakho ye-WaPay*

Sawubona WaPay QA Harness!  
Ibhalansi yakho yamanje ingu R 0.00

 Yini ofuna ukuyenza ngokulandelayo?
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
🔐 *WaPay for Business code: 105816*

Type it into the business portal within 10 minutes. One attempt only.

Not you? Ignore this and tell us right away.
```

</details>
