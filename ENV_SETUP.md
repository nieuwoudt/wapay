# 🔐 WaPay Environment Variables Setup

## 📋 Complete List of Environment Variables

```bash
# ================================
# DATABASE
# ================================
DATABASE_URL="postgresql://postgres.ibczmxhgvrmjzijwonwd:Wapay@202508@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true"

# ================================
# BLU VOUCHER (QA Environment)
# ================================
BLU_BASE_URL="https://api.qa.bltelecoms.net/v2/api/trade"
BLU_BASIC_USER="bld"
BLU_BASIC_PASS="ornuk3i9vseei125s8qea71kub"
BLU_API_KEY="WAITING_FOR_BLU_TO_PROVIDE"

# ================================
# YOYO/WIGROUP (Placeholder for now)
# ================================
YOYO_BASE_URL="https://api.yoyo.co.za/v1"
YOYO_CLIENT_ID="placeholder"
YOYO_CLIENT_SECRET="placeholder"
YOYO_MERCHANT_ID="placeholder"

# ================================
# WHATSAPP (Meta Business API)
# ================================
META_WHATSAPP_TOKEN="YOUR_META_ACCESS_TOKEN_HERE"
META_WHATSAPP_PHONE_NUMBER_ID="529735..."
META_WHATSAPP_BUSINESS_ACCOUNT_ID="YOUR_BUSINESS_ACCOUNT_ID"
META_WEBHOOK_VERIFY_TOKEN="wapay_webhook_secret_2025"

# ================================
# FEATURE FLAGS
# ================================
FEATURE_ENABLE_YOYO="false"

# ================================
# OBSERVABILITY (Optional)
# ================================
SENTRY_DSN=""
LOG_LEVEL="info"
```

---

## 🚀 Setup Instructions

### STEP 1: Apply Database Migration First!

See `SETUP_DATABASE.md` for instructions.

---

### STEP 2: Add to Vercel

1. Go to: https://vercel.com/finfy-ai/wapay-api/settings/environment-variables

2. Click **"Add New"** for each variable below:

#### Database
```
Name: DATABASE_URL
Value: postgresql://postgres.ibczmxhgvrmjzijwonwd:Wapay@202508@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true
Environment: Production, Preview, Development
```

#### Blu Voucher
```
Name: BLU_BASE_URL
Value: https://api.qa.bltelecoms.net/v2/api/trade
Environment: All

Name: BLU_BASIC_USER
Value: bld
Environment: All

Name: BLU_BASIC_PASS
Value: ornuk3i9vseei125s8qea71kub
Environment: All

Name: BLU_API_KEY
Value: WAITING_FOR_BLU (update when you get it!)
Environment: All
```

#### WhatsApp (Update with your values)
```
Name: META_WHATSAPP_TOKEN
Value: [YOUR_TOKEN]
Environment: All

Name: META_WHATSAPP_PHONE_NUMBER_ID
Value: 529735...
Environment: All

Name: META_WEBHOOK_VERIFY_TOKEN
Value: wapay_webhook_secret_2025
Environment: All
```

#### Feature Flags
```
Name: FEATURE_ENABLE_YOYO
Value: false
Environment: All
```

---

### STEP 3: Create Local .env File

Create `.env` in the repo root (already gitignored):

```bash
# Copy all variables from above
DATABASE_URL="postgresql://..."
BLU_BASE_URL="https://..."
# ... etc
```

---

## ✅ Verification

### Test Database Connection:
```bash
cd packages/domain
DATABASE_URL="your_connection_string" pnpm prisma studio
```

### Test Vercel Deployment:
After adding env vars, trigger a new deployment:
```bash
git commit --allow-empty -m "Trigger deployment with env vars"
git push
```

---

## 📝 Notes

- ✅ **DATABASE_URL**: Use pooler (port 6543) for app, direct (5432) for migrations
- ⏳ **BLU_API_KEY**: Update when Blu provides it
- ✅ **FEATURE_ENABLE_YOYO**: Keep false until Yoyo integration is ready
- ✅ **Secrets**: Never commit .env file to git (already in .gitignore)

