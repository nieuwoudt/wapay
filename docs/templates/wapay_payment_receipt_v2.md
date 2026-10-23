# Template spec: `wapay_payment_receipt_v2` (UTILITY)

*Written 2026-10-22 for the payer pre-registration switch (`WAPAY_PAYER_PREREGISTER`, docs/ONBOARDING.md
§5, brief `docs/briefs/ONE_STEP_ONBOARDING_BRIEF.md` section C). This file specifies the template; it is
not created by the code. The founder or the main session creates it with the route below. The current
`wapay_payment_receipt` stays as it is and keeps going out until the steps at the end are done.*

## What it is for

A card payer who paid someone's WaPay link gets a receipt on WhatsApp. When they never wrote to WaPay,
there is no 24-hour window, so the receipt goes as an approved template (the last rail in
`lib/request-notify.js`, after a plain text and Direct Send). Version 2 is the same receipt with one
neutral closing line and one quick-reply button. A tap on **My receipt** comes back to the webhook with
the payload `WAPAY_RECEIPT:<request code>` and opens the payer's WaPay account in one message: their
receipt ("You paid R250 to Thandi on 22 Oct, reference …"), the home card and the terms line. Nothing
else is ever sent to the payer: no reminder, no follow-up.

It stays a receipt. Meta re-files a utility template that sells as marketing, so the body has no
promotional word: no "free", no "join", no "open your account", no offer, no invitation.

## The body and the button

```
Payment confirmed ✅
You paid {{1}} to {{2}}.
Reference: {{3}}

Reply to this message to see your receipt and your options.
```

| Parameter | What the code sends | Example |
|---|---|---|
| `{{1}}` | the amount the payer paid, with cents | `R250.00` |
| `{{2}}` | the requester's first name (a business link: the business's name; no usable name: "a WaPay user") | `Thandi` |
| `{{3}}` | the PayFast reference, else the request code | `2491733` |

One quick-reply button: **My receipt**. Its payload is set per message by the code
(`receiptV2TemplateMessage` in `lib/payer-preregister.js`): `WAPAY_RECEIPT:PRXXXXXX`.

## Create it (UTILITY only)

`POST /api/internal/template-create` with the header `x-internal-api-key: <set in Vercel>` and this
body. The route refuses any category but UTILITY and AUTHENTICATION, and any em dash in the body.

```json
{
  "name": "wapay_payment_receipt_v2",
  "category": "UTILITY",
  "language": "en",
  "components": [
    {
      "type": "BODY",
      "text": "Payment confirmed ✅\nYou paid {{1}} to {{2}}.\nReference: {{3}}\n\nReply to this message to see your receipt and your options.",
      "example": { "body_text": [["R250.00", "Thandi", "2491733"]] }
    },
    {
      "type": "BUTTONS",
      "buttons": [{ "type": "QUICK_REPLY", "text": "My receipt" }]
    }
  ]
}
```

Check the answer: `"category": "UTILITY"`. If Meta answers MARKETING, do not use it: delete it in
WhatsApp Manager and keep the current template.

## Switch it on

1. Wait until `GET /api/internal/template-create` lists `wapay_payment_receipt_v2` as `APPROVED`, category `UTILITY`.
2. In Vercel: `WAPAY_TEMPLATE_PAYMENT_RECEIPT_V2=wapay_payment_receipt_v2`.
3. It goes only to payers that `WAPAY_PAYER_PREREGISTER` covers (`on`, or a comma list of numbers);
   everyone else keeps `WAPAY_TEMPLATE_PAYMENT_RECEIPT` exactly as before. If a v2 send fails, the
   current template follows in the same delivery.
4. `GET /api/internal/flags` shows `onboarding.receiptV2Template: true` once the variable is read.

Unset the variable to go back. Nothing else changes.
