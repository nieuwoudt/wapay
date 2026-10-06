# Chat QA (VAS flows), 2026-10-06

Harness account 27600000901; preview routes stubbed in-process (route contract only); no PIN entered, no money moved.

## [PASS] Data: a complete purchase sentence after browsing reaches the confirm, not the list

- ✅ browsing shows bundles (sets the active category)
- ✅ the purchase sentence is NOT answered with the bundle list
- ✅ it reaches the data confirm (bundle named, YES/NO)

```
> show me vodacom bundles
📶 *VODACOM Data Bundles*
I’ll show a few great options (no long lists).

*Top generic data*
• 3GB – R32
• 500MB – R10
• 1.5GB – R32
• 200MB – R5
• 3GB – R110

*App bundles that can save money*
• 5GB – R99 (TIKTOK)
• 1GB – R20 (TIKTOK)
• 250MB – R5 (WHATSAPP)
• 250MB – R5 (WHATSAPP)
• 500MB – R12 (TIKTOK)

Reply like: *"Buy 1GB data for 0821234567"* and I'll help you purchase.

> buy 50MB Vodacom data for 0720012345
📶 *Confirm Data Purchase*

Bundle: Power 50MB 1hr Data Bundle R5
Number: 0720012345 (Vodacom)
Amount: R5.00

Reply *YES* to confirm or *NO* to cancel.

```

## [PASS] Electricity: amount + meter in one message goes straight to the confirm

- ✅ the meter is NOT asked for again
- ✅ the electricity confirm shows the meter and the amount
- ✅ the chosen amount is quoted, not a default

```
> cancel
👍 Data purchase cancelled.

> buy R20 electricity for meter 000001020001
💡 *Confirm Electricity*

Utility: Eskom
Name: QA Customer
Address: QA Street
Meter: 000001020001
Amount: R20.00 + R1.00 fee = R21.00

Reply *YES* to confirm or *NO* to cancel.

```

## [PASS] Airtime shortfall: gap named, top-up link in the same turn, parked, then resumed

- ✅ no dead-end "try again later"
- ✅ the balance, the purchase with its number, and the gap are stated
- ✅ the top-up asked for is exactly the difference
- ✅ a deposit link (with its fee) is in the same turn
- ✅ a message while parked: top-up not landed yet (or still confirming), park kept
- ✅ once the money is there, even "hi" re-runs the purchase to the confirm

```
> no
👍 Electricity purchase cancelled. Let me know if you need anything else.

> buy R100 airtime for 0830012300
You have R40 available. R100 airtime for 0830012300 needs R60 more.

Top up R60 by card or EFT with the link below and I will finish it straight after. Or reply "cancel", or send a smaller amount.
···
R60 deposit + R5 payment fee = *R65*

I'll take you to *PayFast*, our secure payment partner, to pay by card or Instant EFT. When you've paid, tap *"Back to WaPay"* and you'll be brought straight back to this chat. I'll confirm here the moment your R60 lands. 💰
[button:Pay R65 now -> https://www.payfast.co.za/eng/process?merchant_id=&merchant_key=&return_url=https%3A%2F%2Fwa.me%2F27760497624&cancel_url=https%3A%2F%2Fwa.me%2F27760497624&notify_url=https%3A%2F%2Fwapay.co.za%2Fapi%2Fpayfast%2Fitn&cell_number=0600000901&m_payment_id=4ac34613-2461-4177-999d-a2cf3e070d9e&amount=65.00&item_name=WaPay+top-up&signature=806dda59591763df68063720d2819561]

> any news?
⏳ PayFast is still confirming your R60. I'll message you here the moment it clears.

If the payment didn't go through on PayFast's page (or your bank declined it), nothing left your account. Just reply "deposit R60" to try again.

💰 Balance: R40.00

> hi
📱 *Confirm Airtime Purchase*

Amount: R100
Number: 0830012300 (MTN)

Reply *YES* to confirm or *NO* to cancel.

```

## [PASS] Data shortfall: parked at the confirm, resumed into the confirm once funded

- ✅ the data confirm is shown first and names the bundle
- ✅ the available balance stated is the one the route reported
- ✅ a plain "50MB" ask is not silently a WhatsApp-only bundle
- ✅ "yes" at a shortfall states the R3 gap and the R10 minimum
- ✅ once funded, the confirm is re-offered

```
> no
👍 Airtime purchase cancelled.
···
👋 *Hi WaPay QA Harness!*
💰 Balance: *R140.00*
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

> buy 50MB Vodacom data for 0720012345
📶 *Confirm Data Purchase*

Bundle: Power 50MB 1hr Data Bundle R5
Number: 0720012345 (Vodacom)
Amount: R5.00

Reply *YES* to confirm or *NO* to cancel.

> yes
You have R140 available. The Power 50MB 1hr Data Bundle R5 bundle for 0720012345 needs R3 more. (R10 is the smallest card top-up.)

Top up R10 by card or EFT with the link below and I will finish it straight after. Or reply "cancel", or send a smaller amount.
···
R10 deposit + R3 payment fee = *R13*

I'll take you to *PayFast*, our secure payment partner, to pay by card or Instant EFT. When you've paid, tap *"Back to WaPay"* and you'll be brought straight back to this chat. I'll confirm here the moment your R10 lands. 💰
[button:Pay R13 now -> https://www.payfast.co.za/eng/process?merchant_id=&merchant_key=&return_url=https%3A%2F%2Fwa.me%2F27760497624&cancel_url=https%3A%2F%2Fwa.me%2F27760497624&notify_url=https%3A%2F%2Fwapay.co.za%2Fapi%2Fpayfast%2Fitn&cell_number=0600000901&m_payment_id=e7e591e5-0daa-4c23-8e2d-f72229fac637&amount=13.00&item_name=WaPay+top-up&signature=1d3525fa9f5c176a4bc7541710e846b3]

> thanks
💚 Your top-up landed. Confirm the data purchase: *Power 50MB 1hr Data Bundle R5* for 0720012345, R5.

Reply *YES* to confirm or *NO* to cancel.

```

## [PASS] A smaller amount while parked re-runs the airtime at that amount

- ✅ the offer invites a smaller amount
- ✅ "R40" restarts the purchase for the same number at R40

```
> no
👍 Data purchase cancelled.

> buy R100 airtime for 0830012300
You have R40 available. R100 airtime for 0830012300 needs R60 more.

Top up R60 by card or EFT with the link below and I will finish it straight after. Or reply "cancel", or send a smaller amount.
···
R60 deposit + R5 payment fee = *R65*

I'll take you to *PayFast*, our secure payment partner, to pay by card or Instant EFT. When you've paid, tap *"Back to WaPay"* and you'll be brought straight back to this chat. I'll confirm here the moment your R60 lands. 💰
[button:Pay R65 now -> https://www.payfast.co.za/eng/process?merchant_id=&merchant_key=&return_url=https%3A%2F%2Fwa.me%2F27760497624&cancel_url=https%3A%2F%2Fwa.me%2F27760497624&notify_url=https%3A%2F%2Fwapay.co.za%2Fapi%2Fpayfast%2Fitn&cell_number=0600000901&m_payment_id=00098176-9baa-4d1a-a1a5-2a8963b536c7&amount=65.00&item_name=WaPay+top-up&signature=0c602a942035b62273c8f659a6589f44]

> R40
📱 *Confirm Airtime Purchase*

Amount: R40
Number: 0830012300 (MTN)

Reply *YES* to confirm or *NO* to cancel.

```

## [PASS] Electricity confirm shows the fee and the total

- ✅ amount + fee = total is on the confirm

```
> no
👍 Airtime purchase cancelled.
···
👋 *Hi WaPay QA Harness!*
💰 Balance: *R150.00*
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

> buy R20 electricity for meter 000001020001
💡 *Confirm Electricity*

Utility: Eskom
Name: QA Customer
Address: QA Street
Meter: 000001020001
Amount: R20.00 + R1.00 fee = R21.00

Reply *YES* to confirm or *NO* to cancel.

```

## [PASS] Pilot path (agent dispatcher): purchase sentences reach the confirms, no list, no second meter ask

- ✅ agent path: data purchase is not answered with the bundle list
- ✅ agent path: data reaches the confirm
- ✅ agent path: the meter is not asked for again
- ✅ agent path: electricity reaches the confirm

```
> no
👍 Electricity purchase cancelled. Let me know if you need anything else.

> buy 50MB Vodacom data for 0720012345
📶 *Confirm Data Purchase*

Bundle: Power 50MB 1hr Data Bundle R5
Number: 0720012345 (Vodacom)
Amount: R5.00

Reply *YES* to confirm or *NO* to cancel.

> no
👍 Data purchase cancelled.

> buy R20 electricity for meter 000001020001
💡 *Confirm Electricity*

Utility: Eskom
Name: QA Customer
Address: QA Street
Meter: 000001020001
Amount: R20.00 + R1.00 fee = R21.00

Reply *YES* to confirm or *NO* to cancel.

> no
👍 Electricity purchase cancelled. Let me know if you need anything else.

```
