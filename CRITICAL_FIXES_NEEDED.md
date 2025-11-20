# 🚨 CRITICAL: Onboarding Flow Fixes Required

## Issues Identified

### ❌ Issue 1: Templates Failing to Send
**Symptom:** Welcome template shows plain text instead of button template
**Impact:** User experience degraded, no interactive buttons
**Root Cause:** Template send failing, falling back to text

### ❌ Issue 2: OTP Delivery Failure
**Symptom:** "Sorry, we couldn't send your verification code. Please try again later."
**Impact:** Users cannot complete onboarding
**Root Cause:** OTP template or text message failing to send

### ❌ Issue 3: OTP Verification Not Working
**Symptom:** User enters OTP but verification fails
**Impact:** Users stuck in onboarding loop
**Root Cause:** OTP verification logic or database issue

### ❌ Issue 4: Duplicate/Repeated Messages
**Symptom:** Same error message sent multiple times
**Impact:** User confusion, poor UX
**Root Cause:** Error handling creating message loops

### ❌ Issue 5: Button Clicks
**Symptom:** "Open My WaPay Account Now" button may not work
**Impact:** Users can't progress through onboarding
**Status:** Should be fixed in recent deployment, needs verification

### ❌ Issue 6: LLM Not Handling Onboarding
**Symptom:** AI chat not helping with onboarding queries
**Impact:** Users lost during registration
**Root Cause:** AI not aware of onboarding context

---

## 🎯 Priority Fix Order

### 🔥 CRITICAL (Fix First):
1. **OTP Delivery** - Users can't register without this
2. **OTP Verification** - Must work for onboarding to complete
3. **Template Sending** - Better UX with proper templates

### ⚠️ IMPORTANT (Fix Next):
4. **Duplicate Messages** - Causing confusion
5. **Button Clicks** - Verify working after recent fix

### 📈 ENHANCEMENT (After Core Works):
6. **LLM Integration** - Smarter assistance during onboarding

---

## 🔧 Fix Plan

### Fix 1: Template Sending Issue

**Problem:** Template API calls failing

**Investigation Steps:**
1. Check Vercel logs for exact error message
2. Verify token has template permissions
3. Test template send with curl directly

**Likely Solutions:**
```typescript
// Option A: Token missing template permission
// → Regenerate token with whatsapp_business_messaging scope

// Option B: Template structure mismatch
// → Update component parameters to match Meta template

// Option C: Rate limiting
// → Add retry logic with exponential backoff
```

**Action Required:**
- Get Vercel logs showing template send failure
- Test token permissions
- Verify template structure in Meta matches code

---

### Fix 2: OTP Delivery Failure

**Problem:** OTP send returns error

**Code Location:** `packages/auth/src/otp.ts` lines 85-117

**Current Flow:**
```typescript
// Try template first
sendWhatsAppTemplate({ templateName: 'otp_register_step_2' })

// Fallback to text
if (!result.ok) {
  sendWhatsAppText({ text: 'Your OTP code is: ${code}' })
}
```

**Issue:** BOTH template and text are failing!

**Possible Causes:**
1. Token doesn't have message sending permission
2. Rate limiting (too many messages)
3. Phone number not registered as test number
4. WhatsApp Business Account suspended

**Fix Strategy:**
```typescript
// Add better error logging
console.log('🔍 OTP Template result:', result);
if (!result.ok) {
  console.log('🔍 OTP Template error details:', result.error);
  console.log('🔍 Attempting text fallback...');
  
  const textResult = await sendWhatsAppText(...);
  console.log('🔍 Text fallback result:', textResult);
  
  if (!textResult.ok) {
    console.error('❌ BOTH template and text failed!');
    console.error('❌ Template error:', result.error);
    console.error('❌ Text error:', textResult.error);
    
    // Return specific error for debugging
    return {
      ok: false,
      error: `SEND_FAILED: Template=${result.error}, Text=${textResult.error}`
    };
  }
}
```

---

### Fix 3: OTP Verification Not Working

**Problem:** User enters OTP, verification fails

**Code Location:** `packages/auth/src/otp.ts` lines 153-226

**Possible Causes:**
1. OTP expired (5 min TTL)
2. Code mismatch (case sensitive?)
3. Database query failing
4. OTP already consumed

**Debug Steps:**
1. Log the OTP being verified
2. Log database query results
3. Check OTP expiry times

**Fix:**
```typescript
export async function verifyOTP(args: {
  accountId: string;
  code: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { accountId, code } = args;
  
  console.log(`🔍 Verifying OTP for account: ${accountId}`);
  console.log(`🔍 Code received: ${code.substring(0, 2)}****`);
  
  // Find OTP in database
  const otpRecord = await prisma.otpCode.findFirst({
    where: {
      accountId,
      code,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  
  if (!otpRecord) {
    // Debug: What OTPs exist for this account?
    const allOtps = await prisma.otpCode.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    
    console.log(`🔍 Found ${allOtps.length} OTPs for account`);
    allOtps.forEach(otp => {
      console.log(`  - Code: ${otp.code.substring(0, 2)}****, Expires: ${otp.expiresAt}, Consumed: ${otp.consumedAt ? 'YES' : 'NO'}`);
    });
    
    return { ok: false, error: 'INVALID_OR_EXPIRED' };
  }
  
  // Rest of verification...
}
```

---

### Fix 4: Duplicate Messages

**Problem:** Same message sent multiple times

**Possible Causes:**
1. Webhook receiving duplicate events from Meta
2. Error handler triggering multiple sends
3. State transitions causing re-sends

**Fix:**
```typescript
// Add message deduplication
const processedMessages = new Set();

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const body = req.body;
    
    for (const message of messages) {
      const messageId = message.id;
      
      // Deduplicate
      if (processedMessages.has(messageId)) {
        console.log(`⏭️ Skipping duplicate message: ${messageId}`);
        continue;
      }
      
      processedMessages.add(messageId);
      
      // Process message...
      await processMessage({ ... });
    }
    
    return res.status(200).json({ ok: true });
  }
}
```

---

### Fix 5: Button Clicks (Verify)

**Status:** Should be fixed in recent deployment

**Verification:**
- Test button click triggers onboarding
- Check Vercel logs for button click handling
- Ensure `interactive` message type processed

---

### Fix 6: LLM Onboarding Awareness

**Problem:** AI doesn't understand onboarding context

**Enhancement:**
```typescript
// Update AI system prompt
const systemPrompt = `
You are WaPay's banking assistant.

IMPORTANT: If user is in onboarding (S0-S4 states), provide helpful guidance:
- S0/S1: Explain they need to continue registration
- S2: Help them understand OTP process
- S3: Guide them on PIN creation
- S4: Explain terms and conditions

Current user state: ${onboardingState}

If they ask questions during onboarding, answer briefly but remind them to complete registration first.
`;
```

---

## 🚀 Immediate Action Plan

### Step 1: Get Diagnostic Data (5 min)

Run diagnostic script to gather all errors:

```bash
cd "/Users/nieuwoudtgresse/Desktop/WaPay /WaPay V1.01"

# Create diagnostic script
cat > diagnose-issues.js << 'EOF'
console.log('🔍 WaPay Diagnostics\n');

// Test 1: Database Connection
console.log('1️⃣ Testing database...');
// ... test connection

// Test 2: WhatsApp Token
console.log('2️⃣ Testing WhatsApp token...');
// ... test token permissions

// Test 3: Template Send
console.log('3️⃣ Testing template send...');
// ... test template

// Test 4: Text Send
console.log('4️⃣ Testing text send...');
// ... test text message

// Test 5: OTP Flow
console.log('5️⃣ Testing OTP flow...');
// ... test OTP generation and verification

console.log('\n✅ Diagnostics complete!');
EOF

node diagnose-issues.js
```

### Step 2: Fix OTP Delivery (30 min)

**Priority 1:** Make OTP work

1. Add detailed error logging to OTP send
2. Test token with curl
3. Verify template exists and is approved
4. Implement better fallback logic

### Step 3: Fix OTP Verification (20 min)

**Priority 2:** Make OTP verification reliable

1. Add debug logging to verification
2. Check database queries
3. Handle edge cases (expired, consumed, etc.)
4. Add better error messages to user

### Step 4: Fix Template Sending (30 min)

**Priority 3:** Get templates working

1. Check template structure in Meta
2. Verify token has template permissions
3. Match component structure to Meta template
4. Add retry logic for failures

### Step 5: Fix Duplicate Messages (15 min)

**Priority 4:** Prevent message loops

1. Add message deduplication
2. Prevent re-processing same message
3. Add idempotency keys

### Step 6: Enhance LLM (30 min)

**Priority 5:** Make AI helpful during onboarding

1. Add onboarding state to AI context
2. Train AI on onboarding help
3. Add specific onboarding prompts

---

## 📋 Checklist

Before marking complete, verify:
- [ ] New user can register end-to-end
- [ ] Welcome template with button appears
- [ ] Button click triggers next step
- [ ] OTP is delivered successfully
- [ ] OTP verification works
- [ ] No duplicate messages
- [ ] User completes onboarding to S5_COMPLETED
- [ ] LLM can help with onboarding questions

---

## 🆘 Need Help?

Share:
1. **Vercel logs** from latest onboarding attempt
2. **Screenshots** of Meta template structure
3. **Test results** from diagnostic script

This will help pinpoint exact issues and fix them quickly!

