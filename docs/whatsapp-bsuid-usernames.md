# WhatsApp usernames & Business-Scoped User IDs (BSUID) — WaPay architecture note

*Banked 2026-08-24 from Meta's "Business-scoped user IDs" doc (founder supplied the
full text; source lives under developers.facebook.com → WhatsApp → Business-scoped
user IDs, changelog through June 29 2026). This file keeps the load-bearing facts
plus what WaPay must change. Supporting BSUID is REQUIRED for all WhatsApp Business
Platform businesses — users adopting usernames is out of our control.*

## The mechanics (facts we build against)

- **BSUID** = per-business stable user id, format `ZA.` + up to 128 alphanumerics
  (country-code prefix + period). Unique per business-portfolio↔user pair. Already
  appearing in webhooks since **April 2026** as `user_id` (contacts block) /
  `from_user_id` (messages block). Regenerated if the user changes phone number
  (system webhook `user_changed_user_id` fires; also `user_id_update` webhook).
- **Usernames roll out gradually in 2026.** When a user adopts one, their PHONE
  NUMBER DISAPPEARS from our webhooks unless: we messaged/called them in the last
  30 days (per business phone number), they messaged/called us in the last 30 days,
  or they're in the Meta-hosted **contact book** (auto-stores number+BSUID on every
  interaction AFTER the feature launches; scoped to the portfolio; deletable).
- **Sending to BSUIDs works from July 2026**: `recipient: "<BSUID>"` instead of
  `to: "<phone>"` (phone takes precedence if both). One-tap/copy-code AUTH templates
  CANNOT be sent to BSUIDs — OTP flows need real phone numbers.
- **`REQUEST_CONTACT_INFO` button** (early July 2026): a Utility/Marketing template
  or interactive message button; user taps → contacts webhook delivers their phone
  number (`origin: contact_request`) and Meta adds it to the contact book.
- **Business usernames**: reservable/claimable since **June 29 2026** via WhatsApp
  Manager / Business Suite / Username API (`POST /<PHONE_NUMBER_ID>/username`,
  status approved|reserved; `username_suggestions` lists reserved names; higher
  messaging-limit tier required — error 147002 if not eligible). Format: 3–35 chars,
  a–z 0–9 . _, ≥1 letter, no leading/trailing/double periods, not "www"-prefixed,
  no domain suffix. One username per phone number, globally unique. Display
  priority in chat: saved contact name → verified business name → username → number.
  Subscribe to the `business_username_updates` webhook field.

## What breaks in WaPay if we do nothing

Everything in WaPay keys on the payer's phone number (`from` = 27-form waId):
`getOrCreateUser(from)`, `claimMessage` dedupe, conversation state, beneficiaries,
`Account.msisdn`, gift recipients, payer receipts (`27` + 0-form slice), OTP.
A username-adopting NEW user would arrive with **no `from` at all** — today that
message would fail account resolution and the person is unreachable. Existing
active users keep their number visible via the 30-day cache + contact book, so the
cliff arrives with NEW users and RETURNING dormant (>30d) users.

## WaPay adoption plan (queued, not yet built)

1. **Capture now, cheaply**: store `from_user_id`/`user_id` (+ `username` when
   present) from every inbound webhook onto `Account` (new nullable columns
   `bsuid`, `waUsername`). Purely additive; zero behavior change. Subscribe the
   app to `user_id_update` + `business_username_updates` webhook fields.
2. **Resolution order**: account lookup becomes msisdn OR bsuid; `processMessage`
   accepts messages with `from_user_id` and no `from` (dedupe key must not assume
   a phone).
3. **Sends**: `sendWhatsApp*` helpers accept `{to}` OR `{recipient: bsuid}`;
   fall back to bsuid whenever we hold no fresh msisdn (July 2026+).
4. **Onboarding without a number**: OTP needs a real number (auth templates can't
   target BSUIDs) → for no-number arrivals, lead with the `REQUEST_CONTACT_INFO`
   button, then run the normal OTP flow against the shared number.
5. **Keep the contact book enabled** (it's Meta-hosted, zero integration) — it is
   the cheapest phone-number continuity we can get.

## The founder's play: usernames as a payments handle

- **Reserve `wapay` (and variants) as our business username ASAP** — claimable
  since June 29 2026; usernames are globally unique and searchable by exact match.
  Losing `@wapay` to a squatter is a real risk. (Requires higher messaging-limit
  tier — check eligibility in WhatsApp Manager; error 147002 = not yet eligible.)
- **Merchant "get paid" card at the till** (concept, post-username-launch): a
  printed card/QR — *"Pay me on WaPay"* — where the customer either messages our
  business username/number with `Pay request <code>`-style text, or scans a QR to
  a wa.me deep link prefilled with the merchant's standing request. User usernames
  are per-CONSUMER handles (a customer's own @name); the merchant-facing handle
  that matters is OURS — payments route through the WaPay bot with the merchant
  identified by their standing code/username registered with us. Design doc when
  the Meta feature ships; today's building block is exactly the payment-request
  rail (PR-codes + wa-pay.me links + amount-change), which a printed card can
  already carry NOW: "wa-pay.me/PRXXXXXX" or "WhatsApp 076 049 7624: Pay request
  PRXXXXXX".
- Regulatory note: nothing here changes the money model (still requests +
  vouchers); Meta policy note: any printed material stays betting-free.

## Dated to-dos

- **Now**: reserve/claim the business username in WhatsApp Manager (founder, 5 min;
  check `username_suggestions` first). Add `bsuid`/`waUsername` capture (small
  migration + webhook write — queued build).
- **Before username GA** (Meta "gradually in 2026"): items 2–4 above.
- **July 2026+**: REQUEST_CONTACT_INFO onboarding leg; BSUID sends.
