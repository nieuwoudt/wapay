# Template spec: `wapay_money_received` (UTILITY)

*Written 2026-11-10 (CHANGELOG 137). The founder: "the user should automatically receive a message from
WaPay if they get paid by another customer." Created through the route below; the code reads its name
from `WAPAY_TEMPLATE_MONEY_RECEIVED`.*

## What it is for

A member who is sent money from another member's WaPay balance is told every time. Inside their 24-hour
window the message goes as plain text, with no template needed. Outside it, Meta only accepts a template,
and this is that template. It goes only through `notifyCustomer` (`lib/notify.js`), so the outbound guard
(`lib/outbound-guard.js`, BUGLOG #144) checks first that the number wrote to WaPay. A member always has,
because they signed up.

It is the receipt of a credit to the person's own account (an account update), so it is utility. It has
no promotional word: no offer, no "join", no invitation. It never goes to someone who is not a member:
their money waits for them, and they hear about it only inside a window they opened
(`notifySendRecipient` in `lib/send-money.js`). Someone who said stop is not written to until they write
again.

## The body

```
Money received ✅
{{1}} sent you {{2}} with WaPay. It is in your WaPay balance now.

Reply *balance* to this message to see it.
```

| Parameter | What the code sends | Example |
|---|---|---|
| `{{1}}` | the sender's WhatsApp name (no markdown or brackets, at most 40 characters), else their masked number | `Thandi` |
| `{{2}}` | the amount | `R400` |

## Create it (UTILITY only)

`POST /api/internal/template-create` with the internal key and this body:

```json
{
  "name": "wapay_money_received",
  "category": "UTILITY",
  "language": "en",
  "components": [
    {
      "type": "BODY",
      "text": "Money received ✅\n{{1}} sent you {{2}} with WaPay. It is in your WaPay balance now.\n\nReply *balance* to this message to see it.",
      "example": { "body_text": [["Thandi", "R400"]] }
    }
  ]
}
```

If Meta files it as MARKETING, do not use it. The sender blocks marketing templates anyway
(`marketingTemplateBlocked`), so nothing would go out.

## Switch it on

1. Wait until `GET /api/internal/template-create` lists `wapay_money_received` as `APPROVED`, category `UTILITY`.
2. In Vercel: `WAPAY_TEMPLATE_MONEY_RECEIVED=wapay_money_received`, then redeploy.
3. The sender's receipt changes with the same switch. "WaPay does not message them, so let them know you sent
   it." becomes "If they use WaPay, WaPay tells them on WhatsApp. If not, let them know it is waiting for
   them." That line is the same whoever the number belongs to.

Unset the variable, or set it to `off`, to go back: members are then told only inside their window.
