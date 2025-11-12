# 🧪 WaPay Complete Testing Plan

## 📋 Pre-Test Checklist

### ✅ Vercel Deployment
- [ ] Check Vercel dashboard for successful deployment
- [ ] Verify build completed without errors
- [ ] Check deployment URL is active

### ✅ Environment Variables
Verify these are set in Vercel:
- [ ] `DATABASE_URL` (Supabase connection pooler)
- [ ] `WHATSAPP_ACCESS_TOKEN`
- [ ] `WHATSAPP_PHONE_NUMBER_ID`
- [ ] `WHATSAPP_BUSINESS_ACCOUNT_ID`
- [ ] `WHATSAPP_VERIFY_TOKEN`
- [ ] `OPENAI_API_KEY` (optional)
- [ ] `PIN_PEPPER` (optional, has default)
- [ ] `PIN_TOKEN_SECRET` (optional, has default)

### ✅ Database
- [ ] Migration 003 applied (OTP, PIN, Consent, Audit tables)
- [ ] Connection pooling enabled
- [ ] Test account deleted (if exists)

---

## 🧪 Test Suite

### **Test 1: Basic Onboarding Flow (Happy Path)**

**Objective**: Complete onboarding from S0 → S5

**Steps**:

1. **Clean Database**
   ```sql
   DELETE FROM "Account" WHERE "waId" = '27787051175';
   ```

2. **Send First Message**
   - WhatsApp: `Hi`
   - Expected: Welcome template or text

3. **Continue Onboarding**
   - WhatsApp: `continue`
   - Expected: OTP template with 6-digit code

4. **Check OTP in Database**
   ```sql
   SELECT code, expiresAt FROM "otp_codes" 
   WHERE "accountId" = (SELECT id FROM "Account" WHERE "waId" = '27787051175')
   ORDER BY "createdAt" DESC LIMIT 1;
   ```

5. **Enter OTP**
   - WhatsApp: `123456` (use actual code from step 4)
   - Expected: PIN creation prompt

6. **Create PIN**
   - WhatsApp: `5678`
   - Expected: Consent prompt

7. **Accept Consent**
   - WhatsApp: `I accept`
   - Expected: Account activation message with balance

8. **Verify Database State**
   ```sql
   SELECT 
     "id",
     "waId",
     "displayName",
     "status",
     "onboardingState",
     "createdAt"
   FROM "Account"
   WHERE "waId" = '27787051175';
   ```
   - Expected: `status` = `ACTIVE`, `onboardingState` = `S5_COMPLETED`

9. **Check Audit Trail**
   ```sql
   SELECT "event", "metadata", "timestamp"
   FROM "audit_log"
   WHERE "accountId" = (SELECT id FROM "Account" WHERE "waId" = '27787051175')
   ORDER BY "timestamp" ASC;
   ```
   - Expected events: OTP_SENT, OTP_VERIFIED, PIN_SET, CONSENT_RECORDED, STATE_TRANSITION, ONBOARDING_COMPLETED

**Result**: ☐ PASS ☐ FAIL

**Notes**: _______________________________________________

---

### **Test 2: Weak PIN Rejection**

**Objective**: System rejects weak PINs

**Steps**:

1. Complete steps 1-5 from Test 1 (get to PIN creation)

2. **Try Weak PIN**
   - WhatsApp: `1234`
   - Expected: Error message about weak pattern

3. **Try Another Weak PIN**
   - WhatsApp: `0000`
   - Expected: Same rejection

4. **Try Valid PIN**
   - WhatsApp: `5678`
   - Expected: Success, move to consent

**Result**: ☐ PASS ☐ FAIL

**Notes**: _______________________________________________

---

### **Test 3: OTP Resend**

**Objective**: User can request new OTP

**Steps**:

1. Complete steps 1-3 from Test 1 (get OTP sent)

2. **Request Resend**
   - WhatsApp: `resend`
   - Expected: New OTP sent

3. **Check Database**
   ```sql
   SELECT code, "createdAt" FROM "otp_codes" 
   WHERE "accountId" = (SELECT id FROM "Account" WHERE "waId" = '27787051175')
   ORDER BY "createdAt" DESC LIMIT 2;
   ```
   - Expected: 2 codes, different timestamps

4. **Use New Code**
   - WhatsApp: `[new code]`
   - Expected: Success

**Result**: ☐ PASS ☐ FAIL

**Notes**: _______________________________________________

---

### **Test 4: Invalid OTP**

**Objective**: System rejects invalid OTP

**Steps**:

1. Complete steps 1-3 from Test 1 (get OTP sent)

2. **Enter Wrong Code**
   - WhatsApp: `000000`
   - Expected: Error message, stay in S2

3. **Check Audit Log**
   ```sql
   SELECT "event", "metadata" FROM "audit_log"
   WHERE "accountId" = (SELECT id FROM "Account" WHERE "waId" = '27787051175')
   AND "event" = 'OTP_VERIFY_FAILED';
   ```
   - Expected: Failed attempt logged

4. **Enter Correct Code**
   - WhatsApp: `[correct code]`
   - Expected: Success

**Result**: ☐ PASS ☐ FAIL

**Notes**: _______________________________________________

---

### **Test 5: Voucher Redemption (Post-Onboarding)**

**Objective**: User redeems voucher after onboarding

**Steps**:

1. Complete Test 1 (full onboarding)

2. **Initiate Redemption**
   - WhatsApp: `redeem voucher`
   - Expected: Prompt for 16-digit PIN

3. **Enter Test Voucher** (if you have one)
   - WhatsApp: `1234-5678-9012-3456`
   - Expected: Processing message, then success/failure

4. **Check Balance** (if successful)
   ```sql
   SELECT "availableCents" FROM "Wallet"
   WHERE "accountId" = (SELECT id FROM "Account" WHERE "waId" = '27787051175');
   ```

**Result**: ☐ PASS ☐ FAIL

**Notes**: _______________________________________________

---

### **Test 6: AI Chat (Post-Onboarding)**

**Objective**: User can chat with AI

**Steps**:

1. Complete Test 1 (full onboarding)

2. **Ask Natural Question**
   - WhatsApp: `How do I check my balance?`
   - Expected: AI response with helpful info

3. **Ask Another Question**
   - WhatsApp: `What can you help me with?`
   - Expected: AI provides menu/options

**Result**: ☐ PASS ☐ FAIL

**Notes**: _______________________________________________

---

### **Test 7: PIN Lockout (Soft)**

**Objective**: Account locks after 5 failed attempts

**Prerequisites**: Need a way to trigger PIN verification (future feature)

**Steps**:

1. Complete Test 1 (full onboarding)

2. **Trigger PIN Verification** (placeholder - will need actual endpoint)
   - For now, we can test this manually via SQL:
   ```sql
   -- Simulate 5 failed attempts
   UPDATE "auth_factors" 
   SET attempts = 5, 
       "lockedUntil" = NOW() + INTERVAL '15 minutes'
   WHERE "accountId" = (SELECT id FROM "Account" WHERE "waId" = '27787051175')
   AND type = 'PIN';
   ```

3. **Check Lock Status**
   ```sql
   SELECT attempts, "lockedUntil" FROM "auth_factors"
   WHERE "accountId" = (SELECT id FROM "Account" WHERE "waId" = '27787051175')
   AND type = 'PIN';
   ```
   - Expected: `attempts` = 5, `lockedUntil` = 15 minutes from now

**Result**: ☐ PASS ☐ FAIL

**Notes**: _______________________________________________

---

### **Test 8: PIN Lockout (Hard)**

**Objective**: Account permanently locks after 10 failed attempts

**Steps**:

1. Complete Test 1 (full onboarding)

2. **Simulate Hard Lock**
   ```sql
   UPDATE "auth_factors" 
   SET attempts = 10, 
       "lockedUntil" = NOW() + INTERVAL '1 year'
   WHERE "accountId" = (SELECT id FROM "Account" WHERE "waId" = '27787051175')
   AND type = 'PIN';
   ```

3. **Check Lock Status**
   ```sql
   SELECT attempts, "lockedUntil" FROM "auth_factors"
   WHERE "accountId" = (SELECT id FROM "Account" WHERE "waId" = '27787051175')
   AND type = 'PIN';
   ```
   - Expected: `attempts` = 10, `lockedUntil` = 1 year from now

4. **Proceed to Test 9 (Forgot PIN)**

**Result**: ☐ PASS ☐ FAIL

**Notes**: _______________________________________________

---

### **Test 9: Forgot PIN Flow**

**Objective**: User resets PIN after hard lock

**Prerequisites**: Complete Test 8 (hard lock)

**Steps**:

1. **Trigger Forgot PIN** (via AI chat)
   - WhatsApp: `I forgot my PIN`
   - Expected: AI should detect intent and trigger reset flow

2. **Check OTP Sent**
   ```sql
   SELECT code, "createdAt" FROM "otp_codes"
   WHERE "accountId" = (SELECT id FROM "Account" WHERE "waId" = '27787051175')
   ORDER BY "createdAt" DESC LIMIT 1;
   ```

3. **Enter OTP**
   - WhatsApp: `[OTP code]`
   - Expected: Prompt for new PIN

4. **Enter New PIN**
   - WhatsApp: `9876`
   - Expected: Success message, account unlocked

5. **Verify Unlock**
   ```sql
   SELECT attempts, "lockedUntil" FROM "auth_factors"
   WHERE "accountId" = (SELECT id FROM "Account" WHERE "waId" = '27787051175')
   AND type = 'PIN';
   ```
   - Expected: `attempts` = 0, `lockedUntil` = NULL

6. **Check Audit Trail**
   ```sql
   SELECT "event", "metadata" FROM "audit_log"
   WHERE "accountId" = (SELECT id FROM "Account" WHERE "waId" = '27787051175')
   AND "event" IN ('PIN_RESET_INITIATED', 'PIN_RESET')
   ORDER BY "timestamp" DESC;
   ```
   - Expected: Both events logged

**Result**: ☐ PASS ☐ FAIL

**Notes**: _______________________________________________

---

### **Test 10: Template Fallbacks**

**Objective**: System falls back to text when templates fail

**Steps**:

1. **Temporarily Break Template** (optional)
   - Can test by using wrong template name in code
   - Or by checking logs when template fails

2. **Check Logs**
   - Vercel logs should show template failure
   - Should also show text fallback sent

3. **User Experience**
   - User should still receive messages (as text)
   - Flow should continue normally

**Result**: ☐ PASS ☐ FAIL

**Notes**: _______________________________________________

---

## 📊 Test Results Summary

| Test | Status | Time | Notes |
|------|--------|------|-------|
| 1. Basic Onboarding | ☐ | ___ | ___ |
| 2. Weak PIN Rejection | ☐ | ___ | ___ |
| 3. OTP Resend | ☐ | ___ | ___ |
| 4. Invalid OTP | ☐ | ___ | ___ |
| 5. Voucher Redemption | ☐ | ___ | ___ |
| 6. AI Chat | ☐ | ___ | ___ |
| 7. PIN Soft Lockout | ☐ | ___ | ___ |
| 8. PIN Hard Lockout | ☐ | ___ | ___ |
| 9. Forgot PIN Flow | ☐ | ___ | ___ |
| 10. Template Fallbacks | ☐ | ___ | ___ |

**Overall Result**: ☐ ALL PASS ☐ SOME FAILURES

---

## 🐛 Common Issues & Solutions

### Issue: "Templates not ready"
**Solution**: 
- Check `WHATSAPP_BUSINESS_ACCOUNT_ID` is correct
- Verify templates are APPROVED in Meta
- Check Vercel logs for initialization errors

### Issue: "Database connection failed"
**Solution**:
- Verify `DATABASE_URL` uses connection pooler (port 6543)
- Check Supabase is not paused
- Test connection in Supabase dashboard

### Issue: "OTP not received"
**Solution**:
- Check Vercel logs for send attempt
- Verify `WHATSAPP_ACCESS_TOKEN` is valid
- Check Meta API logs in Business Manager

### Issue: "PIN verification fails"
**Solution**:
- Check `auth_factors` table exists
- Verify Argon2 is installed correctly
- Check `PIN_PEPPER` is consistent

### Issue: "Forgot PIN not triggering"
**Solution**:
- Check AI chat is working (`OPENAI_API_KEY` set)
- Try explicit command: "reset PIN"
- Check account is actually hard locked

---

## 📝 Test Log Template

```
Date: ___________
Tester: ___________
Environment: Vercel Production
Deployment: ___________

Pre-Test Checklist:
- [ ] Vercel deployed successfully
- [ ] All env vars set
- [ ] Database migration applied
- [ ] Templates approved

Test Results:
[Paste results from summary table above]

Issues Found:
1. _______________________________________________
2. _______________________________________________
3. _______________________________________________

Recommendations:
1. _______________________________________________
2. _______________________________________________
3. _______________________________________________

Sign-off: ___________
```

---

**Let's start testing! 🚀**

Run through each test in order and document results.

