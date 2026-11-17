# Template spec: `wapay_ops_alert` (UTILITY)

*Written 2026-11-17 (CHANGELOG 145). The code reads its name from `WAPAY_TEMPLATE_OPS_ALERT`.*

## What it is for

Operations alerts (a pay-out waiting for approval, a frozen account, a person stuck at a withdraw gate) go
only to the numbers in `WAPAY_OPS_ALERT_MSISDNS`, the people who run WaPay. They go through `notifyCustomer`
(`lib/notify.js`) from `deliver()` in `lib/ops-alerts.js`. Inside the recipient's 24-hour window they go as plain
text. Outside it, Meta only accepts a template, and this is that template. Without it, an alert that fires while
the operator has not written to WaPay in the last 24 hours is never delivered on WhatsApp; the e-mail twin
(`ALERT_EMAIL`) still goes.

It reports an event on the operator's own business account, never a customer, so it is utility. It has no
promotional word.

## The body

```
WaPay operations alert for the account owner

{{1}}

You get this because your number is on the WaPay operations alert list.
```

| Parameter | What the code sends | Example |
|---|---|---|
| `{{1}}` | the alert text, on one line: lines joined with " · ", at most 850 characters (`templateParamText`) | `Pay-out request: R500 by PayShap from account ending 1234, fraud level 1 of 5. Approve or reject it in Mission Control.` |

Meta refuses a template value with a new line, a tab or more than four spaces in a row (error 132018), and every
ops alert is several lines, so `notifyCustomer` flattens every template value before it is sent.

## Create it (UTILITY only)

`POST /api/internal/template-create` with the internal key and this body:

```json
{
  "name": "wapay_ops_alert",
  "category": "UTILITY",
  "language": "en",
  "components": [
    {
      "type": "BODY",
      "text": "WaPay operations alert for the account owner\n\n{{1}}\n\nYou get this because your number is on the WaPay operations alert list.",
      "example": { "body_text": [["Pay-out request: R500 by PayShap from account ending 1234, fraud level 1 of 5. Approve or reject it in Mission Control."]] }
    }
  ]
}
```

Submitted 2026-11-17. If Meta files it as MARKETING, do not use it: the sender blocks marketing templates anyway.

## Switch it on

1. Wait until `GET /api/internal/template-create` lists `wapay_ops_alert` as `APPROVED`, category `UTILITY`.
2. In Vercel: `WAPAY_TEMPLATE_OPS_ALERT=wapay_ops_alert` (it held placeholder text before), then redeploy.
3. `GET /api/internal/compliance-check` no longer reports `MISSING_TEMPLATE_WAPAY_TEMPLATE_OPS_ALERT`.
