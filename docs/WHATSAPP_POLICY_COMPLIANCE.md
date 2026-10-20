# WhatsApp Business Platform: how WaPay complies (2026-10-20)

Written the morning Meta's notice arrived ("WhatsApp Business account WaPay has been identified
as sending spam… the account may face restrictions or be disabled") and our number's quality
rating read RED. This page maps the rules we are held to onto what the code does, and is the
operating standard from now on. BUGLOG #130 is the incident.

## 1. The rules (WhatsApp Terms for the Business Platform; WhatsApp Business Messaging Policy)

| Rule | Where it comes from |
|---|---|
| Message people only with their opt-in; you are "solely responsible" for the opt-in method | Messaging Policy §1 |
| Honour every request to "block, discontinue, or otherwise opt out"; the Terms say the Company "must also honor and comply with all WhatsApp user requests to stop or opt-out" | Messaging Policy §1; Platform Terms §4 |
| Do not "spam, or surprise people with your communications"; WhatsApp limits businesses on "significant amounts of negative feedback" (blocks, reports) | Messaging Policy §1, §7; Platform Terms §5, §9 |
| Start a conversation only with an approved Message Template; free-form only inside the 24-hour window, which "opens and resets with each user message" | Messaging Policy §2 |
| Automation is fine inside the window, but there must be "prompt, clear, and direct escalation paths" to a person | Messaging Policy §2 |
| Keep a business profile with "customer support contact information"; never impersonate or mislead | Messaging Policy §1 |
| Prohibited: payday loans, peer-to-peer lending, debt collection; "real, virtual, or fake currency"; real-money gambling (permission-only, listed countries) | Messaging Policy §4 to §6 |
| Payments and money movement: the business is "solely responsible" for its transactions; WhatsApp does not process them | Messaging Policy, commerce section |

## 2. What we were doing, and what changed today

| Behaviour | Before | Now |
|---|---|---|
| Reminders to ad arrivals who went quiet (business-initiated, ~20 h later) | 54 sent in two days; one "stop" | **Off** unless `WAPAY_AD_REMINDERS=on`; even then one per customer, inside their window, never after a stop |
| Messages per customer turn | Often two or three: receipt + "💚 If you have any questions…", "⏳ Sending…" + receipt, prompt + coming-soon line | The trailer and the interim message are gone; the rule is one message per turn, a second only when it carries the link or the receipt |
| "Stop" | Honoured for ad arrivals only, and only for the reminder | Honoured for everyone, before any flow: `profile.messaging.optOut`, the chat replies once and starts nothing again; a human reply (`/api/*/ops-reply`) is refused unless they wrote after saying stop |
| Business-initiated messages outside the window | `notifyCustomer` tries Direct Send, a template, then text | Unchanged in mechanism, but nothing calls it proactively any more except the receipts of the customer's own transactions |
| Escalation to a person | The third-tier gate, the person alert, the Inbox, the reply box | Unchanged; the audit's process checks now also flag a repeated prompt with no way out |
| Knowing Meta's view | A probe route nobody looked at | `lib/whatsapp-quality.js`: read daily by the cron, alert to ops while not GREEN, the Health tab's first card, the flags readout |

## 3. The operating rules from now on

1. **WaPay never starts a conversation.** Everything we send is a reply to a message the customer sent, or the receipt of a transaction they just made. Reminders, nudges, follow-ups and campaigns are off. A future opt-in campaign needs an approved template and a recorded opt-in for that category.
2. **One message per turn.** A second message in the same turn only when it is the payment card, the receipt, or a template the flow requires.
3. **Stop means stop.** Any customer, any state outside a PIN step: opt-out recorded, one acknowledgement, nothing started again. A person's reply is allowed only after the customer writes again.
4. **A person is always reachable.** The third tier of the gate, "close my account", "a person" in any language: the alert goes to ops, the Inbox shows it, and the business profile must carry a support e-mail and website.
5. **Quality is watched.** The rating is read every day; YELLOW or RED is an alert and a stop on anything business-initiated until GREEN returns.
6. **No prohibited verticals in copy.** No lending, no currency trading, no gambling words (the ad flow's banned-word test, the audit's rules).

## 4. What the founder does in WhatsApp Manager

- Account quality: read the reason Meta gives, and use "Request review" where offered.
- Business profile: add the support e-mail and the website if either is missing (the Health tab shows which).
- Templates: leave every MARKETING template unused until the rating is GREEN; UTILITY and AUTHENTICATION templates sent inside a flow the customer started are fine.

## Reaching a customer after the 24-hour window

A person who asked WaPay for help and then went quiet must never be out of reach. Free-form
text is refused by Meta after 24 hours, so the ops reply route (`lib/ops-reply.js`, the Inbox
reply box and `/api/internal/ops-reply`) switches rail by itself: inside the window the text
goes as a normal message; after it, the same text travels inside the approved UTILITY template
`wapay_support_followup` ("Hi {{1}}, WaPay support here, about your message to us. {{2}} Reply to
this message if you still need help."). A customer's own support request is the opt-in for that
follow-up; it is a utility message, never marketing. A customer who said stop is not written to
on either rail until they write again. `WAPAY_TEMPLATE_SUPPORT_FOLLOWUP=off` disables the rail;
another name selects another approved utility template with the same two parameters.

Templates are created through `POST /api/internal/template-create` (internal key), which refuses
the MARKETING category outright: nothing promotional is added while the rating is not GREEN.
Receipts filed as marketing (the paid-link notice `wapay_request_paid`) are re-created as
utility and the env names switched (`WAPAY_TEMPLATE_REQUEST_PAID`).

## The send cap

No code path, agent or hook may send a storm of messages. `lib/say.js` refuses the ninth text
to one number inside twenty seconds with `{ ok: false, error: 'SEND_CAP' }` and logs
`say_send_cap`; legitimate turns never reach four. `WAPAY_SEND_CAP` raises or lowers the count
(never below three). The agent's prompt carries the matching standing rule: WaPay only answers,
one reply per message, never a promise to message, remind or follow up later.
