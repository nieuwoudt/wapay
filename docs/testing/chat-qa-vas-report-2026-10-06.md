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

Bundle: 50MB daily
Number: 0720012345 (Vodacom)
Amount: R3.00

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
Amount: R20.00

Reply *YES* to confirm or *NO* to cancel.

```

## [PASS] Airtime shortfall: gap named, top-up link in the same turn, parked, then resumed

- ✅ no dead-end "try again later"
- ✅ the two figures are stated
- ✅ the top-up asked for is exactly the difference
- ✅ a deposit link (with its fee) is in the same turn
- ✅ a message while parked: top-up not landed yet (or still confirming), park kept
- ✅ once the money is there, even "hi" re-runs the purchase to the confirm

```
> no
👍 Electricity purchase cancelled. Let me know if you need anything else.

> buy R100 airtime for 0830012300
You have R40 available. R100 airtime needs R100, which is R60 more.

Top up R60 by card or EFT with the link below and I will finish the R100 airtime straight after. Or reply "cancel", or choose a smaller amount.
···
R60 deposit + R5 payment fee = *R65*

I'll take you to *PayFast*, our secure payment partner, to pay by card or Instant EFT. When you've paid, tap *"Back to WaPay"* and you'll be brought straight back to this chat. I'll confirm here the moment your R60 lands. 💰
[button:Pay R65 now -> https://www.payfast.co.za/eng/process?merchant_id=&merchant_key=&return_url=https%3A%2F%2Fwa.me%2F27760497624&cancel_url=https%3A%2F%2Fwa.me%2F27760497624&notify_url=https%3A%2F%2Fwapay.co.za%2Fapi%2Fpayfast%2Fitn&cell_number=0600000901&m_payment_id=f75002d8-1340-456c-8721-97a7f1c8f9d5&amount=65.00&item_name=WaPay+top-up&signature=3232fbfcd3534d314039adb143885611]

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

- ✅ the data confirm is shown first
- ✅ "yes" at a shortfall names the gap and asks for exactly the difference
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

Bundle: 50MB daily
Number: 0720012345 (Vodacom)
Amount: R3.00

Reply *YES* to confirm or *NO* to cancel.

> yes
You have R140 available. the Daily WhatsApp 50MB R3 bundle needs R200, which is R60 more.

Top up R60 by card or EFT with the link below and I will finish the the Daily WhatsApp 50MB R3 bundle straight after. Or reply "cancel", or choose a smaller amount.
···
R60 deposit + R5 payment fee = *R65*

I'll take you to *PayFast*, our secure payment partner, to pay by card or Instant EFT. When you've paid, tap *"Back to WaPay"* and you'll be brought straight back to this chat. I'll confirm here the moment your R60 lands. 💰
[button:Pay R65 now -> https://www.payfast.co.za/eng/process?merchant_id=&merchant_key=&return_url=https%3A%2F%2Fwa.me%2F27760497624&cancel_url=https%3A%2F%2Fwa.me%2F27760497624&notify_url=https%3A%2F%2Fwapay.co.za%2Fapi%2Fpayfast%2Fitn&cell_number=0600000901&m_payment_id=ba523973-5210-46cf-adfc-5fe00815df3e&amount=65.00&item_name=WaPay+top-up&signature=569096328df938b5be9c37c91e9177e0]

> thanks
💚 Your top-up landed. Confirm the data purchase: *Daily WhatsApp 50MB R3* for 0720012345, R3.

Reply *YES* to confirm or *NO* to cancel.

```
