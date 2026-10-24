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

## When Meta stops delivering

A restriction shows first in Meta's delivery statuses, not in our logs: the API accepts the send and the status comes back `failed 131031`. The Health tab's WhatsApp card shows "Delivery, last hour"; an ops e-mail and WhatsApp alert go out when five failures of one code land in fifteen minutes with nothing delivered. Response: pause the ad, appeal in Meta Business Suite → Account quality with the behaviour since the fix, change no code.

## 2026-10-21 addendum: the 30-day restriction and what changed

Meta restricted the number for "Sending spam" from 20 October 21:30 UTC for 30 days (no replies to customers). Review requested 21 October. Two onboarding templates Meta files under MARKETING (`consent_terms_`, `welcome_new_user_account_activation`) are now off by default (`WAPAY_ONBOARDING_MARKETING_TEMPLATES`), replaced by one plain line each inside the customer's own window. Where the enforcement shows: Business Support Home → the WhatsApp account's Account overview (the Health Status API and the portfolio issues page do not show it).

## 2026-10-23: guardrails in code and the daily check

**In code (cannot be bypassed by any feature):**
- **No marketing template can be sent.** `MARKETING_TEMPLATES` in `packages/whatsapp/src/send.ts` lists every
  template Meta files as MARKETING on WaPay's account (ten as of 23 October); `sendWhatsAppTemplate` refuses them
  before any network call (`MARKETING_TEMPLATE_BLOCKED`). `WAPAY_ALLOW_MARKETING_TEMPLATES=on` lifts it; never
  while the quality rating is not GREEN. The onboarding welcome (`onboarding_step_1`) now falls back to one plain
  text inside the customer's window.
- **Nobody hears from WaPay unless they wrote first.** The money/airtime/voucher recipient notice used to send the
  MARKETING template `wapay_voucher_received` to people who had never written to WaPay. It now sends one plain text
  only when the recipient wrote in the last 24 hours; otherwise nothing, and the sender's receipt says "WaPay does
  not message them, so let them know you sent it."
- New templates can only be created as UTILITY or AUTHENTICATION (`/api/internal/template-create`).

**Every day (`lib/meta-compliance.js`, `GET /api/internal/compliance-check`, run by the 02:00 UTC cron):**
- Meta's view: quality rating, messaging limit tier (and whether it fell), number health, every template's category
  and status; RED if a template the code sends is filed as MARKETING, AMBER for a new MARKETING template not yet on
  the block list or a paused template.
- What Meta billed: the webhook records each message's pricing category (`price-<category>` pulse rows); any
  MARKETING message is RED.
- Meta's refusals: 131031 restricted, 131042 billing, 131049 marketing limit (RED); 131047 outside the window (AMBER
  from five minutes a day); account events (RED).
- Our behaviour over the last 24 hours, ops numbers and QA numbers excluded: reminders (must be 0), messages after a
  stop (must be 0), complaint words (AMBER from three), customer messages that got three or more replies (AMBER above
  8%; 4.8% on 23 October).
- One summary e-mail a day; a WhatsApp alert to ops when the verdict is not GREEN and a reason is new since yesterday.
  The Health tab shows the verdict live ("Meta compliance, last 24 h").

**What no code can promise:** Meta decides on people's reports and can change its rules. These guardrails keep
WaPay's own behaviour inside every rule and raise the alarm the first day anything drifts; the delivery stall
check (every ten minutes) catches a restriction within minutes.

## 2026-10-24: payment requests never come from WaPay (CHANGELOG 127)

The founder asked whether WaPay could message the payer itself ("request payment from this number ... the payer
gets a message from WaPay: please pay this person X for Y"). It does not: that is WaPay starting a conversation
with someone who never asked to hear from it (rule 1 above), on a number restricted for "sending spam" four days
earlier, and it would let anyone make WaPay send "please pay R500" to any number. Instead:

- After a link is made the requester gets **one** message, the card to forward (rule 2).
- When they name the payer's number, that same message carries a tap-to-send link
  (`https://wa.me/<number>?text=<the card>`): it opens the requester's own chat with that person, the request
  ready to send, so the payer hears from someone they know. WaPay sends that number nothing, and the number is
  not stored on the request.
- The one exception that stays: a WaPay member the requester has already sent money to gets WaPay's
  informational note, and only while that member's own 24-hour window is open (they wrote to WaPay in the last
  24 hours). Outside it nothing is sent (Meta would refuse it with 131047, BUGLOG #138). The requester's message
  is the same either way, so it never tells whether a number is on WaPay.
- Reminders ("remind 2" in the chat, "Send reminder" on the web) are a message the customer sends themselves.
