# Testing WhatsApp Integration

## 🎯 Quick Test Guide

### Prerequisites
- ✅ WhatsApp Business Account configured
- ✅ Templates approved in Meta Business Manager
- ✅ Environment variables set in Vercel
- ✅ Your SA number (+27 76 049 7624) connected

### Test Deposit with WhatsApp Notification

**Endpoint:** `POST /deposit/blu/redeem`

**Request:**
```bash
curl -X POST https://your-vercel-url.vercel.app/deposit/blu/redeem \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: test-$(date +%s)" \
  -d '{
    "pin": "TEST_VOUCHER_PIN",
    "accountId": "test-account-123",
    "waId": "27760497624"
  }'
```

**Important:** 
- `waId` must be in international format without `+` (e.g., `27760497624` for SA)
- Use your actual Vodacom number for testing

### Expected Flow

1. **Request sent** → API receives voucher redemption
2. **Blu Voucher redeemed** → Balance credited to wallet
3. **Ledger updated** → Journal entry created
4. **WhatsApp sent** → Receipt message delivered to your phone 📱

### Success Response

```json
{
  "ok": true,
  "reference": "BLU-REF-123456",
  "amount_cents": 10000
}
```

**You should receive a WhatsApp message:**
```
✅ Deposit successful!

Amount: R100.00
Reference: BLU-REF-123456

Your WaPay balance has been updated.
```

### Failure Response

```json
{
  "ok": false,
  "error": "USER_INPUT"
}
```

**You should receive a WhatsApp message:**
```
❌ Deposit failed

Reason: Invalid voucher PIN

Please try again or contact support if the problem persists.
```

---

## 🔧 Vercel Environment Variables

Add these to your Vercel project:

```bash
# Database
DATABASE_URL=postgresql://postgres.lqkpshowocitirxrmgpy:Wapay%40202508@aws-0-eu-central-1.pooler.supabase.com:6543/postgres

# Blu Voucher (use your actual credentials)
BLU_BASE_URL=https://api.bluvoucher.com/v1
BLU_BASIC_USER=your_username
BLU_BASIC_PASS=your_password
BLU_API_KEY=your_api_key

# Yoyo/wiGroup (use your actual credentials)
YOYO_BASE_URL=https://api.yoyo.co.za/v1
YOYO_CLIENT_ID=your_client_id
YOYO_CLIENT_SECRET=your_client_secret
YOYO_MERCHANT_ID=your_merchant_id

# Feature Flags
FEATURE_ENABLE_YOYO=false

# WhatsApp (Meta) - CONFIGURED ✅
META_WHATSAPP_TOKEN=EAATG3Axub2QBPxe79MDtaNAZAENUug5lmpP8j4LYVH4qkoHV66BGxp7RBPkRrurl5f4FzsALZASkwOvXjR675ISPe6uzXZCluQzqJhXZBPUPPKIMow6YtnxNcbwDx7o7ThnttBjwDkLqClLAPSQrbHMGELKxZAjjOq0B1PrMy03pOlGlJs9oBZBQpKKAXdYJO9RpSeouZCV5ifl1VFesKLZAfTgQjLDzXM8MZCcaMxn9oOQPwZBwZDZD
META_WHATSAPP_PHONE_NUMBER_ID=856018554259689
META_WHATSAPP_BUSINESS_ACCOUNT_ID=801970852418258
META_WEBHOOK_VERIFY_TOKEN=wapay_webhook_secret_2025
```

---

## 📋 Template Status Check

Before testing, verify your templates are approved:

1. Go to: https://business.facebook.com/wa/manage/message-templates/
2. Check status of these templates:
   - ✅ `deposit_receipt` - Should be "Approved"
   - ✅ `deposit_failed` - Should be "Approved"

If templates are pending, you'll need to wait for Meta approval (usually 24-48 hours).

---

## 🐛 Troubleshooting

### WhatsApp message not received?

**Check:**
1. Template is approved in Meta Business Manager
2. Your phone number is correct (international format without +)
3. Check Vercel logs for WhatsApp API errors
4. Verify access token hasn't expired

**Common errors:**
- `(#131030)` - Template not approved yet
- `(#131031)` - Template parameter mismatch
- `(#131026)` - Invalid phone number format
- `(#100)` - Invalid access token

### Deposit succeeds but no WhatsApp?

This is expected behavior! WhatsApp notifications are **non-blocking**:
- Deposit will succeed even if WhatsApp fails
- Check API logs for WhatsApp errors
- WhatsApp failures are logged but don't affect the transaction

---

## 🚀 Next Steps

Once WhatsApp is working:
1. Test with real voucher PIN
2. Verify message arrives on your phone
3. Check message formatting looks good
4. Test failure scenarios (invalid PIN)
5. Monitor Vercel logs for any issues

---

## 📞 Support

**Meta WhatsApp Support:**
- https://business.facebook.com/business/help

**Template Issues:**
- Check template status in Message Templates section
- Ensure template content matches exactly what was approved
- Parameter types must match (currency, text, etc.)

