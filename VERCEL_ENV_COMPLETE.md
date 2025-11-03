# 🔐 Complete Vercel Environment Variables Setup

**Status**: ✅ Blu API Key Received!  
**Last Updated**: November 1, 2025

---

## 📋 All Environment Variables

Copy these to Vercel → Settings → Environment Variables

---

### 🗄️ **Database (Supabase)**

```bash
DATABASE_URL="postgresql://postgres:Wapay@202508@db.lqkpshowocitirxrmgpy.supabase.co:5432/postgres"
DIRECT_URL="postgresql://postgres:Wapay@202508@db.lqkpshowocitirxrmgpy.supabase.co:5432/postgres"
```

---

### 🎫 **Blu Voucher & VAS (COMPLETE!)**

```bash
BLU_BASE_URL="https://api.qa.bltelecoms.net/v2/api/trade"
BLU_BASIC_USER="bld"
BLU_BASIC_PASS="ornuk3i9vseei125s8qea71kub"
BLU_API_KEY="e73d6237-0864-4c87-ba40-e520e951b336"
```

**Status**: ✅ API Key Received!

---

### 🎁 **Yoyo/wiGroup (Pending)**

```bash
YOYO_BASE_URL="[PENDING]"
YOYO_API_KEY="[PENDING]"
YOYO_MERCHANT_ID="[PENDING]"
```

**Status**: ⏳ Need credentials from Yoyo

---

### 📱 **WhatsApp (Meta)**

```bash
META_PHONE_NUMBER_ID="[YOUR_PHONE_NUMBER_ID]"
META_ACCESS_TOKEN="[YOUR_ACCESS_TOKEN]"
META_WEBHOOK_VERIFY_TOKEN="wapay_webhook_secret_2025"
META_BUSINESS_ACCOUNT_ID="[YOUR_BUSINESS_ACCOUNT_ID]"
```

**Status**: ⏳ Need to set up Meta Business account

---

### 🚩 **Feature Flags**

```bash
ENABLE_BLU_VAS="true"
ENABLE_YOYO="false"
ENABLE_BETTING="false"
ENABLE_NLP="true"
```

---

## 🎯 **Quick Setup Steps**

### **Step 1: Go to Vercel**
https://vercel.com/finfy-ai/wapay/settings/environment-variables

### **Step 2: Add Variables**
1. Click "Add New"
2. Paste variable name (e.g., `BLU_API_KEY`)
3. Paste value (e.g., `e73d6237-0864-4c87-ba40-e520e951b336`)
4. Select "Production", "Preview", "Development"
5. Click "Save"
6. Repeat for all variables

### **Step 3: Redeploy**
1. Go to Deployments tab
2. Click "..." on latest deployment
3. Click "Redeploy"
4. Wait for deployment to complete

---

## ✅ **What's Ready NOW**

With the Blu API key, we can now:
- ✅ Test voucher redemption
- ✅ Test airtime purchases
- ✅ Test data bundle purchases
- ✅ Test network detection
- ✅ Deploy to production!

---

## ⏳ **What's Still Needed**

1. **Yoyo Credentials** - For gift balance & store payments
2. **WhatsApp Setup** - For message sending
3. **Meta Business Account** - For WhatsApp integration

---

## 🚀 **Priority**

### **HIGH (Can Test Now)**
- ✅ BLU_API_KEY - **DONE!**
- ✅ DATABASE_URL - **DONE!**

### **MEDIUM (Needed for Launch)**
- ⏳ META_ACCESS_TOKEN
- ⏳ META_PHONE_NUMBER_ID

### **LOW (Phase 2)**
- ⏳ YOYO credentials
- ⏳ Betting integrations

---

## 📝 **Notes**

- All Blu credentials are for **QA environment**
- Production credentials will be different
- Keep API keys secret (never commit to git!)
- Rotate keys regularly

---

**Ready to test Blu VAS!** 🎉


