# Meta WhatsApp Business update, September 2026 — impact on WaPay

> Source: Meta's business-messaging update (founder forwarded 2026-09-01),
> cross-checked against Meta's developer docs
> (developers.facebook.com/documentation/business-messaging/whatsapp/direct-send
> and its FAQ). Four items were announced; only one affects us.

## Impact at a glance

| Announcement | Impact on WaPay | Action |
|---|---|---|
| **Direct Send** for utility messages | **HIGH — implemented** (flag-gated). Kills our biggest notification pain: template dependence outside the 24h window | Founder enables the beta, then set `WHATSAPP_DIRECT_SEND=true` + redeploy |
| MM API **max price** (marketing) | None. WaPay sends **no marketing messages** on WhatsApp (and never will for betting — Meta gambling policy) | None |
| **Embedded signup v4** (v2/v3 die 2026-10-15) | None. Embedded signup is for partners onboarding *businesses* onto the API; we onboard consumers onto our own WABA. Repo grep confirms zero usage of embedded signup / `only_waba_sharing` / `marketing_messages_lite` / `coex` | None |
| Embedded signup **UX change** (phone entry first) | None (see above) | None |

## 1. What Direct Send is

A business-initiated **UTILITY** message with **no template**: the ordinary
`POST /{PHONE_NUMBER_ID}/messages` text payload plus one new top-level field:

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "27XXXXXXXXX",
  "type": "text",
  "text": { "body": "Payment confirmed: R20 to Niev. Ref PF 123." },
  "category": "utility"
}
```

Facts that matter (from Meta's docs/FAQ):

- **Beta**, gated per WABA; participation requires accepting beta terms.
  Supported types: text and interactive CTA-URL/reply buttons.
- **Pricing follows utility-conversation session logic**: if an open utility
  conversation exists the message rides it; otherwise a new 24h utility
  conversation opens (billed as utility). In-window free-form service
  messages remain FREE — so Direct Send must only ever be a *fallback*,
  never the first attempt.
- Messages are **never recategorized** (predictable cost) — but persistently
  sending marketing content through it draws warning emails and then **loss
  of Direct Send access**. WaPay sends only transactional content through
  it, enforced by review + test.
- Meta auto-adds **fallback templates** to the WABA at onboarding.

## 2. Why it matters to us

Our two weakest delivery paths both depend on pre-approved templates:

1. **Requester "you got paid"** — request paid on day 6, requester's 24h
   window long closed → today only `WAPAY_TEMPLATE_REQUEST_PAID` lands.
2. **Payer card receipt** — a payer who never messaged us has *no* window →
   today only `WAPAY_TEMPLATE_PAYMENT_RECEIPT` lands.

Template approval is per-WABA and has burned us before (BUGLOG #33: admin
login code — template mismatch #132001 + silently dropped free-form). Direct
Send removes the template dependency for exactly this class of message.

**Limitation:** per Meta's FAQ, Direct Send covers **utility only — not
authentication**. OTP/login codes stay on authentication templates (or the
in-session "admin login" path, which already works).

## 3. What we implemented (2026-09-01)

- `@wapay/whatsapp`: `sendWhatsAppUtilityDirect({to, text})` — the ordinary
  text send plus `category: "utility"` — and `directSendEnabled()`
  (`WHATSAPP_DIRECT_SEND === 'true'`). The category field is stamped in
  exactly one place and only when explicitly asked, so ordinary sends can
  never accidentally carry it.
- `lib/request-notify.js`: both notification legs now fall back
  **text → Direct Send (if enabled) → template**. Free in-window sends stay
  first (cost), the approved template stays last (works even if the beta is
  revoked). Every rung logs its failure distinctly
  (`request_notify_*_direct_failed`).
- Tests: `tests/whatsapp-direct-send.test.mjs` — chain ordering enabled/
  disabled, payer leg, single category-assignment guard.

Not wired (deliberately): admin OTP (authentication — not covered), and the
conversational brain (always replies inside an open window, where free-form
is free; adding a paid rail there would only add cost).

## 4. Founder actions to activate

1. In **WhatsApp Manager** (or via the Cloud API dashboard for our WABA),
   check Direct Send availability and **accept the beta terms** when
   offered. We are directly integrated, so no BSP is involved.
2. Add the Vercel env `WHATSAPP_DIRECT_SEND=true` — **and redeploy**
   (env changes do nothing until a redeploy; that lesson is already paid
   for).
3. Until then nothing changes: the flag defaults off and the existing
   text → template behaviour is untouched.

## 5. Standing rule

**Nothing marketing ever goes through Direct Send** — no promos, no
campaigns, no betting anything (that's doubly banned: Meta gambling policy).
Transactional statements about a transaction the customer initiated: that's
the entire allowed surface. Losing Direct Send access would put us back on
templates for every out-of-window receipt.
