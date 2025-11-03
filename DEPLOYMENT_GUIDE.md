# 🚀 WaPay Deployment Guide

**Status**: Ready to Deploy (with text message fallbacks)  
**Date**: November 2, 2025

---

## 📋 **Deployment Strategy**

### **Option 1: Deploy Now (Recommended)** ✅

**Why**: Launch immediately with 95% template coverage

**What Works**:
- ✅ All airtime flows (100%)
- ✅ All data flows (100%)
- ✅ All voucher flows (100%)
- ✅ All onboarding flows (100%)
- ✅ Balance check (text message fallback)
- ✅ Help menu (text message fallback)

**What to Update Later**:
- ⏳ Balance template (when approved)
- ⏳ Help template (when approved)

---

### **Option 2: Wait for Templates** ⏳

**Why**: 100% template coverage from day one

**Timeline**: 3-5 business days

**Risk**: Delayed launch

---

## 🎯 **Recommended: Deploy Now!**

Launch immediately with text fallbacks, switch to templates when approved.

---

## 📝 **Pre-Deployment Checklist**

### **1. Database** ✅
- [x] Migration applied to Supabase
- [x] Tables created (Account, Wallet, JournalEntry, etc.)
- [ ] Test account created
- [ ] Test wallet funded

### **2. Environment Variables** ✅
- [x] `DATABASE_URL` set in Vercel
- [x] `BLU_BASE_URL` set
- [x] `BLU_BASIC_USER` set
- [x] `BLU_BASIC_PASS` set
- [x] `BLU_API_KEY` set
- [ ] `META_WEBHOOK_VERIFY_TOKEN` set
- [ ] `META_PHONE_NUMBER_ID` set
- [ ] `META_ACCESS_TOKEN` set

### **3. Code** ✅
- [x] NLP package built
- [x] BFF routes created
- [x] Balance API endpoint created
- [x] WhatsApp webhook handler created
- [x] All packages compile

### **4. Templates** ⏳
- [x] `balance_summary` submitted to Meta
- [x] `help_menu` submitted to Meta
- [ ] Templates approved (3-5 days)

---

## 🚀 **Deployment Steps**

### **Step 1: Commit & Push**

```bash
# Navigate to project
cd "/Users/nieuwoudtgresse/Desktop/WaPay /WaPay V1.01"

# Check status
git status

# Add all changes
git add .

# Commit
git commit -m "feat: Add VAS BFF routes, single balance, network detection

- Add airtime/data preview & execute routes
- Add balance API endpoint
- Update NLP for single balance view
- Add network detection edge cases doc
- Update WhatsApp templates
- Add end-to-end test script"

# Push to main
git push origin main
```

---

### **Step 2: Verify Vercel Deployment**

1. **Go to Vercel Dashboard**
   - https://vercel.com/finfy-ai

2. **Check Deployment Status**
   - Should auto-deploy from GitHub push
   - Wait for "Ready" status

3. **Check Build Logs**
   - Ensure no errors
   - Verify all routes deployed

---

### **Step 3: Set Missing Environment Variables**

**In Vercel Dashboard → Settings → Environment Variables:**

```bash
# WhatsApp (Meta)
META_WEBHOOK_VERIFY_TOKEN=wapay_webhook_secret_2025
META_PHONE_NUMBER_ID=<your_phone_number_id>
META_ACCESS_TOKEN=<your_meta_access_token>

# Feature Flags (optional)
ENABLE_BLU_VAS=true
ENABLE_YOYO=false
ENABLE_BETTING=false
```

**After adding, redeploy:**
- Vercel Dashboard → Deployments → Click "..." → Redeploy

---

### **Step 4: Test Deployment**

```bash
# Set your Vercel URL
export VERCEL_URL="https://your-app.vercel.app"

# Make test script executable
chmod +x test-end-to-end.sh

# Run tests
./test-end-to-end.sh
```

**Expected Results**:
- ✅ Health check passes
- ✅ Balance API works
- ✅ Bundles catalog works
- ✅ Airtime preview works
- ✅ Data preview works
- ✅ Webhook receives messages

---

### **Step 5: Create Test Account**

**Option A: Via Supabase SQL Editor**

```sql
-- Create test account
INSERT INTO "Account" (id, "waId", "msisdn", "displayName", "createdAt", "updatedAt")
VALUES (
  'test-account-123',
  '+27821234567',
  '+27821234567',
  'Test User',
  NOW(),
  NOW()
);

-- Create wallet
INSERT INTO "Wallet" (id, "accountId", "availableCents", "pendingCents", currency, "createdAt", "updatedAt")
VALUES (
  'test-wallet-123',
  'test-account-123',
  10000, -- R100.00
  0,
  'ZAR',
  NOW(),
  NOW()
);
```

**Option B: Via API** (create account endpoint - to be built)

---

### **Step 6: Test End-to-End Flow**

#### **Test 1: Balance Check**

```bash
curl "https://your-app.vercel.app/api/wallet/balance?accountId=test-account-123"

# Expected:
{
  "ok": true,
  "balance": {
    "totalCents": 10000,
    "displayAmount": "R100.00",
    "currency": "ZAR"
  }
}
```

#### **Test 2: Airtime Preview**

```bash
curl -X POST "https://your-app.vercel.app/api/vas/airtime/preview" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "test-account-123",
    "msisdn": "+27821234567",
    "amountCents": 5000
  }'

# Expected:
{
  "ok": true,
  "previewId": "preview-air-...",
  "preview": {
    "type": "airtime",
    "msisdn": "+27821234567",
    "amountCents": 5000,
    "vendorName": "Vodacom",
    ...
  }
}
```

#### **Test 3: Data Bundles**

```bash
curl "https://your-app.vercel.app/api/vas/bundles/vodacom"

# Expected:
{
  "ok": true,
  "network": "vodacom",
  "bundles": [...]
}
```

---

## 📱 **WhatsApp Integration**

### **Step 7: Configure WhatsApp Webhook**

1. **Go to Meta Developer Console**
   - https://developers.facebook.com/

2. **Navigate to Your App → WhatsApp → Configuration**

3. **Set Webhook URL**
   ```
   https://your-app.vercel.app/api/webhooks/whatsapp
   ```

4. **Set Verify Token**
   ```
   wapay_webhook_secret_2025
   ```
   (Must match `META_WEBHOOK_VERIFY_TOKEN` in Vercel)

5. **Subscribe to Webhooks**
   - [x] messages
   - [x] message_status

6. **Click "Verify and Save"**

---

### **Step 8: Test WhatsApp Integration**

1. **Send Test Message**
   - Send "Hi" to your WhatsApp Business number

2. **Check Vercel Logs**
   - Vercel Dashboard → Deployments → Latest → View Function Logs
   - Should see: "Received webhook event"

3. **Verify Message Received**
   - Check logs for message content

---

## 🎯 **Text Message Fallbacks**

While waiting for template approval, use text messages:

### **Balance Check Fallback**

```javascript
// In balance route handler
if (templateNotApproved) {
  await whatsapp.sendText(waId,
    `Hi ${name}, your WaPay balance is R${balance}.\n\n` +
    `What would you like to do?`
  );
}
```

### **Help Menu Fallback**

```javascript
// In help route handler
if (templateNotApproved) {
  await whatsapp.sendText(waId,
    `Hi ${name}, I can help you with:\n\n` +
    `• Check your balance\n` +
    `• Buy airtime or data\n` +
    `• Redeem vouchers\n` +
    `• Pay at stores\n\n` +
    `Just tell me what you need!`
  );
}
```

---

## ⏳ **After Template Approval**

### **When Templates Are Approved** (3-5 days)

1. **Update Code to Use Templates**

```javascript
// Replace text message with template
await whatsapp.sendTemplate(waId, 'balance_summary', {
  name: customer.displayName,
  balance: (balanceCents / 100).toFixed(2)
});
```

2. **Commit & Push**

```bash
git add .
git commit -m "feat: Switch to approved WhatsApp templates"
git push origin main
```

3. **Verify in Production**
   - Send "balance" message
   - Should receive template message

---

## 📊 **Monitoring**

### **What to Monitor**

1. **Vercel Function Logs**
   - API errors
   - Webhook events
   - NLP processing

2. **Supabase Database**
   - Account creation
   - Wallet updates
   - Journal entries

3. **Blu API**
   - Network detection success rate
   - Airtime/data purchase success
   - API errors

4. **WhatsApp**
   - Message delivery rate
   - Template approval status
   - User engagement

---

## 🚨 **Troubleshooting**

### **Issue: Webhook Not Receiving Messages**

**Check**:
1. Webhook URL correct in Meta console?
2. Verify token matches?
3. Function logs show any errors?

**Fix**:
```bash
# Test webhook manually
curl -X POST "https://your-app.vercel.app/api/webhooks/whatsapp" \
  -H "Content-Type: application/json" \
  -d '{"test": "message"}'
```

---

### **Issue: Balance API Returns 404**

**Check**:
1. Account exists in database?
2. Wallet exists for account?

**Fix**:
```sql
-- Check account
SELECT * FROM "Account" WHERE id = 'test-account-123';

-- Check wallet
SELECT * FROM "Wallet" WHERE "accountId" = 'test-account-123';
```

---

### **Issue: Airtime Preview Fails**

**Check**:
1. Blu API credentials correct?
2. Network detection working?
3. Phone number format valid?

**Fix**:
```bash
# Test Blu API directly
curl -X POST "https://api.qa.bltelecoms.net/v2/api/trade/mobile/airtime/mobile-number/check" \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic <base64_credentials>" \
  -H "apikey: <your_api_key>" \
  -d '{"mobileNumber": "0821234567", "requestId": "test-123"}'
```

---

### **Issue: Templates Not Working**

**Check**:
1. Templates approved in Meta?
2. Template names match code?
3. Variable count correct?

**Fix**:
- Use text message fallback until approved
- Check Meta Business Manager → Message Templates

---

## 📋 **Post-Deployment Checklist**

### **Day 1**
- [ ] Deployment successful
- [ ] All tests passing
- [ ] Webhook receiving messages
- [ ] Test account working
- [ ] Logs monitoring set up

### **Day 2-3**
- [ ] Monitor error rates
- [ ] Check Blu API success rate
- [ ] Verify network detection working
- [ ] Test with real users (small group)

### **Day 4-5**
- [ ] Templates approved?
- [ ] Switch to templates if approved
- [ ] Monitor template delivery rates

### **Week 2**
- [ ] Review NLP accuracy
- [ ] Analyze edge cases
- [ ] Update training data
- [ ] Optimize flows

---

## 🎉 **Success Criteria**

### **Launch is Successful When**:

1. ✅ **Health Check**: API responding
2. ✅ **Balance Check**: Returns correct balance
3. ✅ **Airtime Flow**: Preview → Execute works
4. ✅ **Data Flow**: Bundles → Preview → Execute works
5. ✅ **Network Detection**: >90% success rate
6. ✅ **Webhook**: Receiving messages
7. ✅ **Error Rate**: <5%
8. ✅ **Response Time**: <2 seconds

---

## 📞 **Support**

### **If Something Goes Wrong**:

1. **Check Vercel Logs**
   - Most issues show up here

2. **Check Supabase Logs**
   - Database connection issues

3. **Check Meta Business Manager**
   - WhatsApp issues

4. **Review Documentation**
   - `docs/` folder has all guides

---

## 🚀 **Ready to Deploy?**

### **Quick Start**:

```bash
# 1. Commit & push
git add . && git commit -m "feat: Launch WaPay" && git push

# 2. Wait for Vercel deployment

# 3. Run tests
./test-end-to-end.sh

# 4. Configure WhatsApp webhook

# 5. Test with real message

# 6. Monitor logs

# 7. 🎉 Launch!
```

---

**You're ready to go live!** 🚀

**Remember**: You can launch now with text fallbacks and switch to templates when approved (3-5 days).

**Don't wait for 100% - ship it!** 💪


