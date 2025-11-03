# WhatsApp Template Seeding - Setup Guide

## ✅ What We Just Built:

A production-grade template seeding system that:
- Fetches templates from Meta API automatically
- Stores them in database with correct language codes
- Builds fast in-memory cache for lookups
- Auto-resolves language codes (no more hard-coded `en_US`)
- Refreshes every 30 minutes

---

## 🎯 Setup Steps:

### Step 1: Apply Database Migration

Run this SQL in Supabase SQL Editor:

```sql
-- CreateTable
CREATE TABLE "WhatsappTemplate" (
    "id" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "category" TEXT,
    "componentsHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsappTemplate_wabaId_name_idx" ON "WhatsappTemplate"("wabaId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappTemplate_wabaId_name_language_key" ON "WhatsappTemplate"("wabaId", "name", "language");
```

### Step 2: Add Environment Variable in Vercel

1. Go to Vercel → Settings → Environment Variables
2. Add new variable:
   - **Name**: `WHATSAPP_BUSINESS_ACCOUNT_ID`
   - **Value**: `647978251504290` (from your Meta dashboard)
   - Check all environments
3. Click **Save**

### Step 3: Redeploy

Click **Redeploy** in Vercel to apply the new env var.

### Step 4: Initialize Templates

Once deployed, call this endpoint to seed templates:

```bash
curl https://your-app.vercel.app/api/admin/init-templates
```

Or visit it in your browser:
```
https://your-app.vercel.app/api/admin/init-templates
```

**Expected response:**
```json
{
  "ok": true,
  "message": "Templates initialized successfully"
}
```

---

## 🔍 Check Logs:

In Vercel logs, you should see:
```
🌱 Seeding WhatsApp templates from Meta API...
📥 Fetched 24 templates from Meta
✅ Seeded 24 templates to database
🏗️  Building template catalog...
✅ Built catalog with 24 templates
   - welcome_new_user: [English]
   - balance_summary: [English]
   - help_me_menu: [English]
   ... etc
```

---

## ✅ Success Indicators:

1. Database migration applied ✓
2. `WHATSAPP_BUSINESS_ACCOUNT_ID` added to Vercel ✓
3. `/api/admin/init-templates` returns success ✓
4. Vercel logs show template seeding ✓

---

## 🎯 How It Works Now:

When sending a template:
```javascript
sendTemplateMessage({
  to: '27787051175',
  templateName: 'welcome_new_user',
  preferredLanguage: 'en_US'  // Optional - will auto-resolve
})
```

The system will:
1. Check the catalog for `welcome_new_user`
2. Find available languages (e.g., `['English']`)
3. Use exact language code from Meta (not hard-coded!)
4. Send template with correct language
5. ✅ No more "template not found" errors!

---

## 🔄 Auto-Refresh:

Templates auto-refresh every 30 minutes, so if you:
- Approve a new template in Meta
- Update an existing template
- Change template languages

It will be picked up automatically within 30 minutes!

---

## 🧪 Test:

Once setup is complete, delete your Supabase account and send "hello" to WaPay. 

It should now work without any template errors!

