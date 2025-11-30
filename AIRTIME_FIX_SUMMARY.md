# Airtime Purchase Fix - Summary

## 🐛 Root Cause Found!

The **"Service temporarily unavailable"** error was caused by a **database schema mismatch**.

The `/api/vas/airtime/preview` endpoint was trying to save preview data with `accountId` and `metadata` fields, but the `ProviderRequest` model didn't have these columns!

```javascript
// This was FAILING:
await prisma.providerRequest.create({
  data: {
    accountId: accountId,  // ❌ Column doesn't exist!
    metadata: {            // ❌ Column doesn't exist!
      msisdn,
      amountCents,
      ...
    }
  }
});
```

---

## ✅ Fixes Applied

### 1. Database Schema Update

**File:** `packages/domain/prisma/schema.prisma`

Added missing fields to `ProviderRequest`:

```prisma
model ProviderRequest {
  id             String   @id @default(cuid())
  provider       String
  route          String
  idemKey        String   @unique
  requestTs      DateTime @default(now())
  status         String
  providerRef    String?
  redactedPayload String?
  responseJson   String?
  accountId      String?   // ✅ NEW
  metadata       Json?     // ✅ NEW

  @@index([accountId])    // ✅ NEW
  @@index([status])       // ✅ NEW
}
```

### 2. Database Migration

**File:** `packages/domain/prisma/migrations/20251130_add_provider_request_fields/migration.sql`

```sql
-- Add accountId to track which customer made the request
ALTER TABLE "ProviderRequest" 
  ADD COLUMN IF NOT EXISTS "accountId" TEXT;

-- Add metadata to store preview details
ALTER TABLE "ProviderRequest" 
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS "ProviderRequest_accountId_idx" 
  ON "ProviderRequest"("accountId");

CREATE INDEX IF NOT EXISTS "ProviderRequest_status_idx" 
  ON "ProviderRequest"("status");
```

---

## 📋 What This Fixes

### ✅ Issue 1: "Service temporarily unavailable"
- **Before:** Preview API crashed trying to save to non-existent columns
- **After:** Preview saves successfully with all required data

### ✅ Issue 2: No conversation context
- **Status:** Already working! Schema has `conversationState` and `conversationData`
- **Note:** The state WAS being saved, but users never got past the preview step due to Issue #1

### ✅ Issue 3: Network auto-detection
- **Status:** Already implemented in `preview.js:119-154`
- **Note:** Will work once preview API stops crashing

### ✅ Issue 4: PIN verification
- **Status:** Already implemented! Flow exists at `message-processor-v2.js:817-945`
- **Note:** Users never reached this step due to preview failing

### ✅ Issue 5: Blu whitelisted numbers
- **Status:** Already configured in code
- **Note:** Will be tested once preview works

---

## 🚀 Deployment Steps

### Step 1: Run Migration on Supabase

```bash
# Connect to Supabase
psql <your_supabase_connection_string>

# Run the migration
\i packages/domain/prisma/migrations/20251130_add_provider_request_fields/migration.sql

# Verify columns were added
\d "ProviderRequest"

# Should show:
# accountId | text
# metadata  | jsonb
```

### Step 2: Generate Prisma Client

```bash
cd packages/domain
pnpm prisma generate
```

### Step 3: Build and Deploy

```bash
# Build domain package
pnpm --filter @wapay/domain build

# Commit and push
git add -A
git commit -m "Fix airtime purchase: add ProviderRequest.accountId and metadata fields"
git push origin main
```

### Step 4: Vercel will auto-deploy

Wait ~2 minutes for Vercel to deploy.

---

## 🧪 Testing After Deployment

### Test 1: Basic Airtime Flow

```
User: buy airtime
Bot: How much airtime would you like to buy?

User: r20
Bot: Which phone number should I send the airtime to?

User: 0840012300
Bot: Confirm Airtime Purchase
     Amount: R20
     Number: 0840012300
     Reply YES to confirm or NO to cancel.

User: yes
Bot: 🔐 Enter Your PIN ← Should reach this step now!

User: 1234
Bot: ✅ Airtime Purchase Successful! (or ❌ Invalid PIN)
```

### Test 2: Network Detection

Check Vercel logs for:

```json
{
  "type": "vas_airtime_network_detected",
  "msisdn": "0840012300",
  "vendorId": "cellc",
  "vendorName": "Cell C"
}
```

### Test 3: Conversation State Persistence

The bot should remember:
- The amount you entered
- The phone number you entered
- Not ask the same question twice

---

## 📊 Expected Vercel Logs (After Fix)

### Success Flow:

```
1. vas_airtime_preview_call
   { accountId, msisdn, amountCents }

2. vas_airtime_network_detected
   { msisdn, vendorId: "cellc", vendorName: "Cell C" }

3. vas_airtime_preview_result
   { success: true, previewId, totalCents }

4. vas_airtime_execute_call
   { previewId, accountId, hasPin: true }

5. vas_airtime_execute_result
   { success: true, providerRef, newBalance }
```

---

## 🔧 If Still Failing

### Check These:

1. **Migration ran successfully**
   ```sql
   SELECT column_name, data_type 
   FROM information_schema.columns 
   WHERE table_name = 'ProviderRequest';
   ```

2. **Prisma client regenerated**
   ```bash
   pnpm --filter @wapay/domain prisma generate
   ```

3. **Environment variables set**
   ```
   BLU_TRADE_API_KEY=<your_key>
   BLU_BASE_URL=https://api.qa.bltelecoms.net/v2/trade
   ```

4. **Vercel logs show the error**
   Look for `vas_airtime_preview_result` with `success: false`

---

## 🎯 Summary

**Root Cause:** Missing database columns (`accountId`, `metadata`)  
**Fix:** Added columns + migration  
**Impact:** All 5 reported issues should now work  
**Next Step:** Run migration, deploy, test  

---

**Status:** ✅ Ready to deploy  
**Date:** November 30, 2025

