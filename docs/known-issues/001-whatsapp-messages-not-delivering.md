# Issue #001: WhatsApp Messages Not Delivering (1 Tick)

**Date:** 2026-02-12 → 2026-03-12 (resolved)
**Severity:** CRITICAL
**Status:** RESOLVED

---

## Symptoms

- All WhatsApp messages from WaPay showed only **one tick** (sent but not delivered)
- WhatsApp Cloud API **accepted** messages and returned a valid `wamid`
- No error returned by the API — silent delivery failure
- Affected ALL recipients (not just one phone)
- Message Delivery Insights showed **all zeros** (0 sent, 0 delivered, 0 received)
- Bot was completely non-functional for ~1 month

## Investigation Steps

1. ✅ Verified webhook URL is correct (`/api/webhooks/whatsapp` responds to GET verify)
2. ✅ Verified phone number status: **Connected**, quality **GREEN**, mode **LIVE**
3. ✅ Verified token returns valid `wamid` on send
4. ✅ Verified payment method is linked to WABA
5. ✅ Tested sending to multiple different phone numbers — ALL failed
6. ✅ Tested both text messages AND template messages — ALL failed
7. ❌ Discovered token had **expired** on Feb 12, 2026

## Root Causes (Multiple)

### Cause 1: Expired Access Token
- The WhatsApp access token was a **temporary developer token** (24h expiry)
- It expired on **Thursday, 12-Feb-26 14:00:00 PST**
- The API still accepted calls and returned `wamid` but silently refused to deliver

### Cause 2: Two-Step Verification PIN Stuck
- The phone number had **2FA enabled** with an unknown PIN
- Could not re-register the number because 2FA PIN was required
- Meta UI also could not change/remove the PIN (showed "Unknown error")

### Cause 3: Phone Number Registration Lost
- During troubleshooting, we deregistered the number to fix 2FA
- After deregistration, the number required **phone verification** (SMS code)
- Re-registration required the correct system user token with `whatsapp_business_management` permission

## Resolution Steps

### Step 1: Create Permanent System User Token
1. Go to Meta Business Settings → System Users
2. Create system user "WaPay API" (Admin role)
3. Assign assets:
   - Apps → WaPay app → Full control
   - WhatsApp accounts → WaPay → Full control (Messages + Manage phone numbers)
4. Generate token with **BOTH** permissions:
   - `whatsapp_business_management`
   - `whatsapp_business_messaging`
5. Set expiration to **Never**

### Step 2: Turn Off Two-Step Verification
1. Go to WhatsApp Manager → Phone numbers → +27 76 049 7624
2. Click "Two-step verification" tab
3. Click "Turn off two-step verification"
4. (This only worked AFTER deregistering the number first)

### Step 3: Deregister the Phone Number
```bash
curl -s -X POST "https://graph.facebook.com/v19.0/870272072828461/deregister" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp"}'
# Response: {"success":true}
```

### Step 4: Request Phone Verification Code
```bash
curl -s -X POST "https://graph.facebook.com/v19.0/870272072828461/request_code" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"code_method":"SMS","language":"en"}'
# Response: {"success":true}
# SMS code received on +27 76 049 7624 phone
```

**Note:** This step requires the `whatsapp_business_management` permission on the token.

### Step 5: Verify the Code
```bash
curl -s -X POST "https://graph.facebook.com/v19.0/870272072828461/verify_code" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"code":"151867"}'
# Response: {"success":true}
```

### Step 6: Re-Register the Number
```bash
curl -s -X POST "https://graph.facebook.com/v19.0/870272072828461/register" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","pin":"654321"}'
# Response: {"success":true}
```

### Step 7: Test Delivery
```bash
curl -s -X POST "https://graph.facebook.com/v19.0/870272072828461/messages" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","to":"27787051175","type":"text","text":{"body":"WaPay is BACK!"}}'
# Response: {"messaging_product":"whatsapp","contacts":[...],"messages":[{"id":"wamid.xxx"}]}
# Message arrived with TWO TICKS ✅✅
```

### Step 8: Update Vercel
1. Update `META_WHATSAPP_TOKEN` in Vercel env vars with the permanent token
2. Update `WHATSAPP_ACCESS_TOKEN` if it exists
3. Redeploy

## Prevention

1. **NEVER use temporary developer tokens in production** — always create a System User with a permanent (never-expiring) token
2. **Document the 2FA PIN** — the registration PIN (654321) should be stored securely
3. **Monitor token expiry** — add a health check that validates the token periodically
4. **Set up alerts** — if Message Delivery Insights drops to 0, something is wrong

## Key Reference Information

| Field | Value |
|-------|-------|
| Phone Number | +27 76 049 7624 |
| Phone Number ID | 870272072828461 |
| WABA ID | 647978251504290 |
| System User | WaPay API (ID: 61588380805990) |
| 2FA PIN | 654321 |
| Token Type | Permanent (never expires) |
| Required Permissions | `whatsapp_business_management` + `whatsapp_business_messaging` |
| Payment Method | Visa ····4909 (linked to WABA) |

## Useful Diagnostic Commands

### Check token validity
```bash
curl -s "https://graph.facebook.com/v19.0/me?access_token=<TOKEN>"
```

### Check token permissions
```bash
curl -s "https://graph.facebook.com/v19.0/me/permissions?access_token=<TOKEN>"
```

### Check phone number status
```bash
curl -s "https://graph.facebook.com/v19.0/870272072828461?fields=display_phone_number,verified_name,quality_rating,account_mode,status&access_token=<TOKEN>"
```

### Check messaging tier
```bash
curl -s "https://graph.facebook.com/v19.0/870272072828461?fields=messaging_limit_tier,platform_type,throughput&access_token=<TOKEN>"
```

### Test send
```bash
curl -s -X POST "https://graph.facebook.com/v19.0/870272072828461/messages" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","to":"27787051175","type":"text","text":{"body":"Test"}}'
```
