# Founder test: one-step sign-up, the PIN on demand, the payer's reply (2026-10-22)

*For the founder, on his own phones, once branch `feat/one-step-onboarding` (CHANGELOG 121) is merged and
deployed. What each switch does: docs/ONBOARDING.md §5. The switches are turned on for your test numbers
only, never `on` for everyone, until this script has passed.*

## What you need

- **Phone X**: a WhatsApp number that has never written to WaPay. It tests A (one-step) and B (the PIN).
- **Phone Y**: another WhatsApp number that has never written to WaPay. It tests C (the payer's reply).
- Your own WhatsApp (your WaPay account) to make the link Y pays.
- The internal key (`<set in Vercel>`, `WAPAY_INTERNAL_API_KEY`) for the two read-only checks below.
- About R30 on a card for step C (a real card payment from Y to your own link; under R50 there is no fee).

Do not delete or "park" your own account to reuse your number: it holds your balance, pay-outs and history,
and nothing here needs it. Your own number would show nothing anyway: the switches change only numbers
without a finished account (A, C) or without a PIN (B), and yours has both.

Below, `X` and `Y` stand for the two numbers written as `27…` (for example `27821234567`).

## 0. Before: read the funnel and the Growth card

```
curl -s -H "x-internal-api-key: <set in Vercel>" "https://wapay-api.vercel.app/api/internal/funnel?since=2026-10-15&until=2026-10-22"
```

Note `summary.byPath.CLASSIC.rates.finished` (the classic finished rate) and that `summary.byPath.ONE_STEP.opened`
is 0. In Mission Control, Valuation Metrics (the Growth tab): the "Sign-up funnel" card shows the classic line
only, and its note reads "One-step off · deferred PIN off · payer pre-registration off".

## 1. Turn the switches on for X and Y only

In Vercel, Production environment variables:

```
WAPAY_ONBOARDING_ONE_STEP=X
WAPAY_PIN_ON_DEMAND=X
WAPAY_PAYER_PREREGISTER=Y
```

Leave `WAPAY_TEMPLATE_PAYMENT_RECEIPT_V2` unset for now (step 4 covers it once the template is approved).
Redeploy. Then check what production reads:

```
curl -s -H "x-internal-api-key: <set in Vercel>" https://wapay-api.vercel.app/api/internal/flags
```

Expect `"onboarding": { "oneStep": { "everyone": false, "listed": 1 }, "pinOnDemand": { "everyone": false, "listed": 1 }, "payerPreregister": { "everyone": false, "listed": 1 }, "receiptV2Template": false }`.

## 2. A: one-step sign-up (phone X)

| You send (from X) | You should see |
|---|---|
| `Hi` | ONE message: "🎉 Welcome to WaPay, <your WhatsApp name>! Your account is open.", your balance (R0.00), the home card lines, and last: "By using WaPay you agree to our Terms & Privacy Policy: https://wapay.co.za/legal/terms". No welcome template, no code, no PIN, no "reply I accept". |
| `please pay me R20` | Your payment link at once (pleasepayme.co.za/PR…). No PIN asked. |
| `balance` | Your balance. No PIN asked. |

Optional, from an ad: tap a WaPay ad from a third number that never wrote, and pick "What does it cost?". One
message: the cost answer, then "You're all set, <name>. Let's get you paid. Who owes you, and how much? Type
the amount and their name.", then the terms line. Typing `R20 Thandi` makes the link.

## 3. B: the PIN on demand (phone X)

| You send (from X) | You should see |
|---|---|
| `PIN` | "🔐 Choose a 4-digit PIN to protect your pay-outs. You type it to approve every pay-out and every send…" |
| `cancel` | "👍 Cancelled. No PIN was set." |
| On the web: log in at app.wapay.co.za with X and any 4 digits | "That cell number and PIN do not match a WaPay account. Check both and try again, or reset your PIN with your ID number. No PIN yet? Set your WaPay PIN in the WhatsApp chat first (say *PIN*), then log in here." |
| Top up X with R50 (`deposit R50`, pay by card), then `send R20 to <your own number, 0…>` | The send confirmation ("Send R20 to 0…? … Reply YES to continue to your PIN"). |
| `YES` | "🔐 Choose a 4-digit PIN to protect your pay-outs…" instead of "Enter your WaPay PIN". |
| a PIN, for example `2580` (not 1234 or 0000) | "Type the same PIN once more to confirm it." |
| the same PIN again | ONE message: "✅ Your WaPay PIN is set. WaPay only asks for it to approve a payment." and below it "✅ Sent R20 to 0…". Your own phone gets the money. |
| `send R10 to <your own number>`, then `YES` | This time "Enter your WaPay PIN": asked once, as everywhere else. |
| On the web: log in with X and the PIN | You are in. |

A pay-out from X (`withdraw R50`) behaves the same way as the send when X has no PIN yet; you do not need to
pay out to pass this script.

## 4. C: the payer's reply (phone Y)

1. From your own WhatsApp: `please pay me R20` and forward the link to Y.
2. On Y: open the link and pay by card, entering Y's cell number on the pay page.
3. Y gets the receipt. If the v2 template is not approved yet it is today's receipt (no button): on Y, reply
   anything, for example `hi`. Once `wapay_payment_receipt_v2` is approved and
   `WAPAY_TEMPLATE_PAYMENT_RECEIPT_V2=wapay_payment_receipt_v2` is set (docs/templates/wapay_payment_receipt_v2.md),
   it ends "Reply to this message to see your receipt and your options." with a **My receipt** button: tap it.
   (The v2 template takes the current template's place, the last of the receipt's rails. If Direct Send is on
   in production, `WHATSAPP_DIRECT_SEND`, the receipt arrives as a plain text before any template is tried,
   without the button: reply `hi` then.)
4. Y should see ONE message: "🧾 You paid R20 to <your first name> on <date>, reference PF … · PR…", then "🎉
   Welcome to WaPay, <Y's WhatsApp name>! Your account is open." with the home card, then the terms line.
5. Your own WhatsApp gets the usual "paid" notice for your link. Nothing else is sent to Y, ever, unless Y writes.

If you look Y up in Mission Control's Customers tab between the payment and Y's reply, the account is already
there, unfinished; after the reply it is finished. (In the database: `onboardingState` S0_INITIAL with
`profile.origin.kind` PAYER and your link's code, then S5_COMPLETED.)

## 5. After: read the funnel and the Growth card again

```
curl -s -H "x-internal-api-key: <set in Vercel>" "https://wapay-api.vercel.app/api/internal/funnel?since=2026-10-22&until=2026-10-23"
```

Expect, for today: `oneStepOn: true`; `byPath.ONE_STEP.opened` 2 (X and Y; 3 with the ad test), `finished`
the same, `finished10m` the same, `firstLink24h` at least 1 (X's link). The "Sign-up funnel" card shows a
one-step line next to the classic one for today, and its note reads "One-step on for 1 number · deferred PIN
on for 1 number · payer pre-registration on for 1 number". Tomorrow morning the nightly audit summary carries
"Sign-up <today>: one-step 2 of 2 finished (100%); classic …".

## 6. What to send the main session if something is off

The step, the exact message you sent, a screenshot of the reply, and the time. Do not send PINs or ID numbers.

## 7. Turning it on for everyone, and off again

For everyone: `on` instead of the numbers, then redeploy. Compare the funnel's one-step and classic rates by day
from then on. Off: unset the variable and redeploy. Accounts opened in one step meanwhile keep the PIN-on-demand
behaviour (`profile.onboarding.pinDeferred`), so none of them is left at a PIN prompt it cannot answer.
