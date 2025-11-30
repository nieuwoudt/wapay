# Airtime Purchase Issues - Analysis & Fix

## 🐛 Issues Reported

1. **❌ "Service temporarily unavailable"** - Airtime purchase failing
2. **❌ No conversation context** - Bot keeps repeating questions
3. **❌ No network detection** - Should auto-detect provider from phone number
4. **❌ No PIN verification** - Should ask for WaPay PIN before purchase
5. **❌ Blu whitelisted number not working** - Test numbers failing

---

## 🔍 Root Cause Analysis

### Issue 1: "Service temporarily unavailable"

**Location:** `pages/api/webhooks/message-processor-v2.js:833`

```javascript
return await sendWhatsAppText({
  to: from,
  text: `❌ Service temporarily unavailable. Please try again later.`,
});
```

This happens when the `/api/vas/airtime/preview` API call fails.

**Possible causes:**
1. Missing `BLU_TRADE_API_KEY` environment variable
2. Database connection issue (Prisma)
3. Blu API authentication failure
4. Network detection failure

**Check Vercel logs for:**
```
vas_airtime_preview_error
vas_airtime_network_detection_failed
```

### Issue 2: No Conversation Context

The conversation state IS being saved correctly in `user-manager.js`:

```javascript
await prisma.account.update({
  where: { waId },
  data: {
    conversationState: state,
    conversationData: data,
  },
});
```

**But** - the state might be cleared prematurely or not persisted due to:
1. Database schema mismatch (missing `conversationState` or `conversationData` columns)
2. Prisma connection issue
3. State being cleared by error handlers

**Fix:** Check database schema has these columns:
```sql
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "conversationState" TEXT;
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "conversationData" JSONB;
```

### Issue 3: Network Detection

Network detection IS implemented in `/api/vas/airtime/preview.js:119-154`:

```javascript
if (!vendorId) {
  try {
    const bluClient = new BluVasClient();
    const networkInfo = await bluClient.checkMobileNumber(msisdn);
    detectedVendorName = networkInfo.vendorName;
    detectedVendorId = bluClient.vendorNameToId(networkInfo.vendorName);
  } catch (error) {
    // Continue without network detection for other errors
  }
}
```

**But** - it might be failing silently. Check logs for:
```
vas_airtime_network_detection_failed
```

### Issue 4: PIN Verification

PIN verification IS implemented! The flow is:

1. User: "buy airtime"
2. Bot: "How much?"
3. User: "R20"
4. Bot: "Which number?"
5. User: "0840012300"
6. Bot: "Confirm?"
7. User: "yes"
8. Bot: **"🔐 Enter Your PIN"** ← This step exists!
9. User: enters PIN
10. Bot: Executes purchase

**The PIN step is at line 817-821 in message-processor-v2.js**

### Issue 5: Blu Whitelisted Numbers

The whitelisted numbers ARE configured:

```javascript
const BLU_QA_TEST_NUMBERS = new Set([
  '0840012300', // Cell C
  '0720012345', // Vodacom
  '0830012300', // MTN
  '0850012345', // Telkom
]);
```

**But** - Blu might still reject them if:
1. Wrong API key
2. Wrong base URL
3. Account not whitelisted on Blu's side

---

## ✅ Fixes Required

### Fix 1: Add Better Error Logging

Update `message-processor-v2.js` to log the actual error:

```javascript
} catch (error) {
  console.error('Preview API error:', error);
  console.error('Preview API error details:', {
    message: error.message,
    stack: error.stack,
    response: error.response,
  });
  logStructured('vas_airtime_preview_error', {
    from,
    accountId: account.id,
    error: error.message,
    errorDetails: JSON.stringify(error),
  });
  
  return await sendWhatsAppText({
    to: from,
    text: `❌ Service temporarily unavailable. Please try again later.\n\nError: ${error.message || 'Unknown'}`,
  });
}
```

### Fix 2: Verify Database Schema

Run this migration:

```sql
-- Add conversation state columns if missing
ALTER TABLE "Account" 
  ADD COLUMN IF NOT EXISTS "conversationState" TEXT,
  ADD COLUMN IF NOT EXISTS "conversationData" JSONB;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS "Account_conversationState_idx" 
  ON "Account"("conversationState");
```

### Fix 3: Verify Environment Variables

Check Vercel has these set:

```bash
BLU_BASE_URL=https://api.qa.bltelecoms.net/v2/trade
BLU_BASIC_USER=bld
BLU_BASIC_PASS=<secret>
BLU_API_KEY=<secret>  # For voucher redemption
BLU_TRADE_API_KEY=<secret>  # For VAS (airtime/data)
BLU_VEND_CHANNEL=API
```

**CRITICAL:** `BLU_TRADE_API_KEY` must be set for VAS to work!

### Fix 4: Add Conversation State Debugging

Add logging to track state persistence:

```javascript
// After updateConversationState
const verification = await getConversationState(from);
console.log('✅ State saved and verified:', {
  from,
  savedState: state,
  verifiedState: verification.state,
  match: verification.state === state,
});
```

### Fix 5: Handle Network Detection Gracefully

If network detection fails, ask the user:

```javascript
if (!detectedVendorId) {
  return res.status(200).json({
    ok: false,
    error: 'NETWORK_DETECTION_FAILED',
    message: 'Could not detect network. Please specify: Vodacom, MTN, Cell C, or Telkom',
    requiresNetwork: true,
  });
}
```

---

## 🧪 Testing Steps

### 1. Check Vercel Logs

```bash
# Look for these error patterns:
vas_airtime_preview_error
vas_airtime_network_detection_failed
vas_airtime_execute_failed
```

### 2. Test Database Schema

```bash
# Connect to Supabase
psql <connection_string>

# Check columns exist
\d "Account"

# Should show:
# conversationState | text
# conversationData  | jsonb
```

### 3. Test Environment Variables

```bash
# In Vercel dashboard, verify:
echo $BLU_TRADE_API_KEY  # Should NOT be empty
echo $BLU_BASE_URL       # Should be https://api.qa.bltelecoms.net/v2/trade
```

### 4. Test Conversation State

Send these messages in sequence:

```
User: buy airtime
Bot: How much?
User: R20
Bot: Which number?
User: 0840012300
Bot: Confirm? ← Should remember R20 and number
```

If bot asks "How much?" again, state is being lost.

### 5. Test Network Detection

Check logs for:

```json
{
  "type": "vas_airtime_network_detected",
  "msisdn": "0840012300",
  "vendorId": "cellc",
  "vendorName": "Cell C"
}
```

---

## 🚀 Immediate Actions

1. **Check Vercel logs** - Find the actual error
2. **Verify BLU_TRADE_API_KEY** - Must be set
3. **Check database schema** - Add missing columns
4. **Test with Blu QA numbers** - 0840012300, 0720012345
5. **Add debug logging** - See where state is lost

---

**Next:** Share Vercel logs so we can see the exact error!

