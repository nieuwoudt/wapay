# Vercel Environment Variables Setup Guide

## 🎯 Quick Setup Instructions

Go to: https://vercel.com/finfy-ai/wapay-api/settings/environment-variables

Add these environment variables (copy-paste the values):

---

## 📋 Required Environment Variables

### Database (Supabase)
```
DATABASE_URL=postgresql://postgres:Wapay@202508@db.lqkpshowocitirxrmgpy.supabase.co:5432/postgres
```

### WhatsApp (Meta)
```
META_WHATSAPP_TOKEN=EAATG3Axub2QBPxe79MDtaNAZAENUug5lmpP8j4LYVH4qkoHV66BGxp7RBPkRrurl5f4FzsALZASkwOvXjR675ISPe6uzXZCluQzqJhXZBPUPPKIMow6YtnxNcbwDx7o7ThnttBjwDkLqClLAPSQrbHMGELKxZAjjOq0B1PrMy03pOlJs9oBZBQpKKAXdYJO9RpSeouZCV5ifl1VFesKLZAfTgQjLDzXM8MZCcaMxn9oOQPwZBwZDZD

META_WHATSAPP_PHONE_NUMBER_ID=856018554259689

META_WHATSAPP_BUSINESS_ACCOUNT_ID=801970852418258

META_WEBHOOK_VERIFY_TOKEN=wapay_webhook_secret_2025
```

### Blu Voucher (Stub values for now - replace with real credentials when available)
```
BLU_BASE_URL=https://api.bluvoucher.com/v1

BLU_BASIC_USER=your_blu_username

BLU_BASIC_PASS=your_blu_password

BLU_API_KEY=your_blu_api_key
```

### Yoyo/wiGroup (Stub values for now - replace with real credentials when available)
```
YOYO_BASE_URL=https://api.yoyo.co.za/v1

YOYO_CLIENT_ID=your_yoyo_client_id

YOYO_CLIENT_SECRET=your_yoyo_client_secret

YOYO_MERCHANT_ID=your_yoyo_merchant_id
```

### Feature Flags
```
FEATURE_ENABLE_YOYO=false
```

### Observability (Optional for now)
```
SENTRY_DSN=

LOG_LEVEL=info
```

---

## ⚙️ How to Add in Vercel:

1. Go to: https://vercel.com/finfy-ai/wapay-api/settings/environment-variables
2. For each variable above:
   - Click "Add New"
   - Enter the **Key** (e.g., `DATABASE_URL`)
   - Enter the **Value** (copy from above)
   - Select **All Environments** (Production, Preview, Development)
   - Click "Save"
3. After adding all variables, trigger a new deployment

---

## 🔄 After Adding Variables:

The next git push will automatically use these environment variables!

