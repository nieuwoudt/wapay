# Runbook: "WaPay is not answering on WhatsApp" / no inbound messages

*Written 2026-09-06 after three days of silence (no inbound processed 2026-09-03 18:23Z → 2026-09-06) that turned out NOT to be the webhook. Everything below is read-only and needs only the local `.env` (`DATABASE_URL`, `WAPAY_INTERNAL_API_KEY`).*

## 1. Is anything arriving? (database, 30 seconds)

`processed_messages` gets one row per accepted inbound message (`wamid.…`, written by the webhook's `claimMessage` dedupe BEFORE processing), plus, since 2026-09-06, **pulse rows**:

| row id | meaning |
|---|---|
| `webhook-ok:<minute>` | Meta POSTed to the endpoint and the HMAC signature verified (any event, including delivery statuses) |
| `webhook-401:<reason>:<minute>` | Meta (or someone) POSTed and the signature did NOT verify → `META_APP_SECRET` in Vercel does not match the app |
| `status-sent` / `status-delivered` / `status-read:<minute>` | an outbound message's delivery status |
| `status-failed-131047:<minute>` | an outbound free-form message was dropped: outside the 24-hour customer-service window (the portal/admin "send me a code" push when the owner has not chatted in 24h) |

```sql
SELECT to_char("processedAt" AT TIME ZONE 'UTC','YYYY-MM-DD') d, count(*) FROM processed_messages
 WHERE "processedAt" > now() - interval '14 days' GROUP BY 1 ORDER BY 1;
SELECT "waMessageId", "processedAt" FROM processed_messages ORDER BY "processedAt" DESC LIMIT 20;
```

Note: the processor's own dedupe (`wasMessageProcessed` in `pages/api/webhooks/user-manager.js`) lives in `accounts.conversationData.processedMessageIds`, not in this table.

## 2. What does Meta think? (one request)

```bash
curl -s -H "x-internal-api-key: $WAPAY_INTERNAL_API_KEY" https://business.wapay.co.za/api/internal/meta-status
```

Read-only. Returns: the app the token belongs to; the app's webhook subscriptions (**callback URL**, `active`, fields, must include `messages`); the WABA's `subscribed_apps` (must list our app); WABA review/verification; the phone number (`status: CONNECTED`, `qualityRating`, `nameStatus`); the phone-number-level webhook override (wins over the app URL when set); every template with its status. 2026-09-06 facts: callback `https://wapay-api.vercel.app/api/webhooks/whatsapp`, which is an alias of the SAME Vercel project as `business.wapay.co.za` / `pleasepayme.co.za` (all serve the same build); `otp_register_step_2` is an APPROVED AUTHENTICATION template.

## 3. Make Meta hit the endpoint on demand

Any outbound message produces delivery-status webhooks within seconds. The cheapest trigger is a portal code for an allowlisted owner:

```bash
curl -s -X POST -H "Content-Type: application/json" -d '{"action":"request","msisdn":"0787051175"}' https://business.wapay.co.za/api/business/auth
```

Then re-run step 1. Within ~2 s a `webhook-ok:<minute>` row appears if Meta reaches us and the signature verifies (seen 2026-09-06 20:35:43Z), followed by `status-*` rows. With the internal key on that POST (`-H "x-internal-api-key: $KEY"`) the response also carries `diag`: which authentication template was tried, the Graph error for each, and whether the free-form text fallback carried the code (`textOk`).

## 4. Interpret

| what you see | it means | fix |
|---|---|---|
| `webhook-401:*` rows | Meta reaches us, signature fails | Meta App Dashboard → Settings → Basic → App Secret; paste into Vercel `META_APP_SECRET`; redeploy |
| no pulse rows at all after step 3 | Meta is not reaching this deployment | step 2: callback URL and the phone override must point at a host of THIS project (`pleasepayme.co.za`, `business.wapay.co.za`, `wapay-api.vercel.app`); verify token = Vercel `WHATSAPP_VERIFY_TOKEN`; Meta App Dashboard → WhatsApp → Configuration → "Verify and save"; check `subscribed_apps` |
| `webhook-ok` + `status-*` rows but no `wamid` rows for days | the pipe is healthy and **nobody is messaging the number** (or Meta is not forwarding user messages: app in Development mode only forwards from test numbers) | send `hi` to **+27 76 049 7624** from a phone and re-run step 1; if still nothing, App Dashboard → App Mode must be Live |
| `wamid` rows but no replies | processing fails after the claim | Vercel logs for the minute: `wa_webhook_*`, `business_*`, OpenAI errors (see the 2026-08 silence incident in the tracker) |
| `status-failed-131047` | a free-form message was dropped: recipient outside the 24h window | for codes: the authentication template must have carried it (`diag.templateOk`); if `diag.tried` shows `#132001`, the template language/catalog fallback regressed (BUGLOG #42); the owner can always type `business login` / the admin command in chat instead |

## 5. What NOT to conclude from silence

A silent bot with a healthy `webhook-ok` pulse is not a webhook problem. Before 2026-09-06 the only evidence was `processed_messages` recency, which cannot distinguish "Meta stopped sending" from "nobody wrote". The pulse rows do.
