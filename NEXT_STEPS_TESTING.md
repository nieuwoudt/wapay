# 🚀 WaPay Testing - Next Steps

## ✅ Code Changes Deployed

The following fixes are now live on Vercel:
- ✅ Auto-derive WABA ID from phone number (not env var)
- ✅ Pagination support to fetch ALL templates
- ✅ Readiness flag to block webhook until catalog is ready
- ✅ Boot logging to verify catalog state
- ✅ Webhook returns 503 if templates not ready

---

## 🔧 **CRITICAL: Update Vercel Environment Variables**

### **Step 1: Update Access Token**

1. Go to: https://vercel.com/finfy-ai/wapay-api
2. Click **Settings** → **Environment Variables**
3. Find `WHATSAPP_ACCESS_TOKEN`
4. Click **Edit**
5. Paste your new token:
   ```
   EAATG3Axub2QBP2bEUQZAaKrwXptRg3J1mxstMzHtVdq1ZBfAQahOzKa0ZABFe5gEWTW4v159upyLNIpwDoP8IcXXZBlt5LoEPfLUooDQyyLOM4VSzVqiKuOzEtt5ovx8ZASsmD8FKg2HC5WfpsUN8Dtpd7kpqqzonMABWjJop3ZBgZBDGNbA747HXZC1yXhq9Q0NkiaB9Kr6luKEcFaWPY0t7vCo781yZALLEblpdPoZCZBR2HCgZAHnfb3IKFHdaIXVZCOZAfHIlmpC4tkeLPGpQUmPO4fcDu
   ```
6. Click **Save**

### **Step 2: Verify Other Environment Variables**

Make sure these are set correctly:

| Variable | Value | Notes |
|----------|-------|-------|
| `WHATSAPP_PHONE_NUMBER_ID` | `870272072828461` | Your phone number ID |
| `WHATSAPP_ACCESS_TOKEN` | (new token from Step 1) | Fresh token |
| `DATABASE_URL` | (Supabase connection string) | Should already be set |
| `WHATSAPP_VERIFY_TOKEN` | (your webhook verify token) | Should already be set |

**Note:** You do NOT need `WHATSAPP_BUSINESS_ACCOUNT_ID` anymore - the code now auto-derives it!

### **Step 3: Redeploy**

1. Go to **Deployments** tab
2. Click **Redeploy** on the latest deployment
3. Wait for it to complete (~2 minutes)

---

## 🧪 **Test the Onboarding Flow**

Once redeployed, test the welcome flow:

### **Test 1: New User Onboarding**

1. **Send a message from a NEW WhatsApp number** (not one you've tested with before)
2. Send: `Hi`
3. **Expected result:**
   - You should receive the `welcome_new_user` template
   - Message should say something like: "Welcome to WaPay! We're excited to have you..."

### **Test 2: Balance Check**

1. Send: `what's my balance?`
2. **Expected result:**
   - Plain text response with your balance (R 0.00 for new users)
   - (We'll add the `balance_summary` template later)

### **Test 3: Help Menu**

1. Send: `help`
2. **Expected result:**
   - Plain text response with available commands

---

## 📊 **Check the Logs**

After redeploying, check the Vercel logs to see the boot logging:

1. Go to: https://vercel.com/finfy-ai/wapay-api
2. Click on the latest deployment
3. Click **Functions** tab
4. Look for the init logs - you should see:

```
🚀 Initializing WhatsApp templates...
📱 Phone Number ID: 870272072828461
✅ Resolved WABA ID: 647978251504290
📊 Seeded 9 templates
📋 WA READY: {
  phone_number_id: '870272072828461',
  waba_id_seeded: '647978251504290',
  templates_count: 9,
  templates: [
    'deposit_failed',
    'bluvoucher_redeem_success',
    'redeem_in_progress',
    'bluvoucher_redeem_prompt',
    'deposit_options',
    'consent_terms_',
    'welcome_new_user',
    'welcome_new_user_account_activation',
    'hello_world'
  ]
}
✅ WhatsApp templates initialized successfully
```

---

## 🎯 **What We Can Test Now**

With the 9 templates you have:

| Feature | Status | Template Used |
|---------|--------|---------------|
| New user welcome | ✅ Ready | `welcome_new_user` |
| Voucher redemption | ✅ Ready | `redeem_in_progress`, `bluvoucher_redeem_success`, `deposit_failed` |
| Deposit options | ✅ Ready | `deposit_options` |
| Terms consent | ✅ Ready | `consent_terms_` |
| Balance check | ⚠️ Text only | (no template yet) |
| Airtime purchase | ⚠️ Text only | (no template yet) |
| Data purchase | ⚠️ Text only | (no template yet) |
| Help menu | ⚠️ Text only | (no template yet) |

---

## 📝 **Missing Templates to Create Later**

After testing what we have, you can create these:

1. `balance_summary` - For balance checks
2. `airtime_preview` - For airtime purchase confirmation
3. `airtime_receipt` - For airtime purchase receipt
4. `data_preview` - For data bundle confirmation
5. `data_receipt` - For data purchase receipt
6. `help_menu` - For help/guidance menu

---

## 🐛 **Troubleshooting**

### **If welcome template doesn't send:**

Check the Vercel function logs for errors. Common issues:
- Token expired (regenerate)
- Template not found (check catalog logs)
- Permission error (check token scopes)

### **If you see "503 Service Unavailable":**

This means templates are still being seeded. Wait 10-15 seconds and try again.

### **If you see "Template not found in catalog":**

Check the boot logs to see which templates were loaded. The WABA ID should be `647978251504290`.

---

## 🎉 **Ready to Test!**

Once you've updated the token and redeployed, send me a message and I'll help you test the onboarding flow!

