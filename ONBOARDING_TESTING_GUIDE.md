# 🧪 WaPay Onboarding Flow - Testing Guide

## 📋 **Pre-Testing Checklist**

### ✅ **Vercel Deployment**
1. Check that the latest commit has deployed successfully
2. Verify all environment variables are set in Vercel:
   - `DATABASE_URL` (Supabase connection pooler)
   - `WHATSAPP_ACCESS_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_BUSINESS_ACCOUNT_ID`
   - `WHATSAPP_VERIFY_TOKEN`
   - `OPENAI_API_KEY` (optional, for AI chat)
   - `PIN_PEPPER` (optional, defaults to dev value)
   - `PIN_TOKEN_SECRET` (optional, defaults to dev value)

### ✅ **Database Setup**
1. Confirm migration 003 has been applied (OTP, PIN, Consent, Audit tables)
2. Check that Prisma client is up to date
3. Verify connection pooling is enabled (port 6543 or pooler host)

### ✅ **WhatsApp Templates**
Confirm these templates are **APPROVED** in Meta Business Manager:
- ✅ `onboarding_step_1` (UTILITY)
- ✅ `otp_register` (AUTHENTICATION)
- ✅ `onboarding_step_3_pin_creation` (AUTHENTICATION)
- ✅ `consent_terms` (UTILITY)
- ✅ `successful_account_creation` (UTILITY)

---

## 🧪 **Test Scenarios**

### **Test 1: Happy Path - Complete Onboarding**

**Objective**: User completes full onboarding flow from S0 → S5

**Steps**:
1. **Delete your test account** from Supabase (if exists):
   ```sql
   DELETE FROM "Account" WHERE "waId" = '27787051175';
   ```

2. **Send first message** to WaPay WhatsApp number:
   ```
   Hi
   ```

3. **Expected**: Welcome template (`onboarding_step_1`)
   - Should include your name
   - Should prompt to continue

4. **Reply**:
   ```
   continue
   ```

5. **Expected**: OTP template (`otp_register`)
   - Should receive 6-digit code
   - Check Supabase `otp_codes` table for the code

6. **Reply with OTP**:
   ```
   123456
   ```
   (Use the actual code from the template or database)

7. **Expected**: PIN creation template (`onboarding_step_3_pin_creation`)
   - Should prompt for 4-6 digit PIN
   - Should warn against weak patterns

8. **Reply with PIN**:
   ```
   5678
   ```

9. **Expected**: Consent template (`consent_terms`)
   - Should ask for T&C and Privacy Policy acceptance

10. **Reply**:
    ```
    I accept
    ```

11. **Expected**: Account activation template (`successful_account_creation`)
    - Should show your name
    - Should show balance (R 0.00)
    - Should confirm account is active

12. **Verify in Database**:
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
    - `status` should be `ACTIVE`
    - `onboardingState` should be `S5_COMPLETED`

13. **Verify Audit Trail**:
    ```sql
    SELECT 
      "event",
      "metadata",
      "timestamp"
    FROM "audit_log"
    WHERE "accountId" = (SELECT "id" FROM "Account" WHERE "waId" = '27787051175')
    ORDER BY "timestamp" DESC;
    ```
    - Should see: `STATE_TRANSITION`, `OTP_SENT`, `OTP_VERIFIED`, `PIN_SET`, `CONSENT_RECORDED`, `ONBOARDING_COMPLETED`

---

### **Test 2: OTP Resend**

**Objective**: User requests OTP resend

**Steps**:
1. Complete steps 1-5 from Test 1 (get to S2_OTP_SENT)

2. **Reply**:
   ```
   resend
   ```

3. **Expected**: New OTP sent
   - Check `otp_codes` table for new code
   - Old code should still exist but new one should be latest

4. **Verify Rate Limiting**:
   - Send "resend" 3 more times quickly
   - On 4th attempt, should get rate limit error

---

### **Test 3: Invalid OTP**

**Objective**: User enters wrong OTP code

**Steps**:
1. Complete steps 1-5 from Test 1 (get to S2_OTP_SENT)

2. **Reply with wrong code**:
   ```
   000000
   ```

3. **Expected**: Error message
   - Should say "Invalid or expired code"
   - Should prompt to try again or request resend
   - Should NOT transition to S3

4. **Verify Audit Log**:
   ```sql
   SELECT "event", "metadata"
   FROM "audit_log"
   WHERE "accountId" = (SELECT "id" FROM "Account" WHERE "waId" = '27787051175')
   AND "event" = 'OTP_VERIFY_FAILED';
   ```

---

### **Test 4: Weak PIN Rejection**

**Objective**: System rejects weak PINs

**Steps**:
1. Complete steps 1-7 from Test 1 (get to S3_OTP_VERIFIED)

2. **Reply with weak PIN**:
   ```
   1234
   ```

3. **Expected**: Error message
   - Should say "PIN is too weak"
   - Should prompt to try different PIN
   - Should NOT transition to S4

4. **Try another weak pattern**:
   ```
   0000
   ```

5. **Expected**: Same rejection

6. **Try valid PIN**:
   ```
   5678
   ```

7. **Expected**: Success, move to S4

---

### **Test 5: PIN Lockout**

**Objective**: Account locks after too many failed PIN attempts

**Steps**:
1. Complete full onboarding (Test 1)

2. **Trigger PIN verification** (e.g., by trying to send money - future feature)
   - For now, you can test this by calling the `verifyPIN` function directly via a test endpoint

3. **Enter wrong PIN 5 times**:
   - Should get soft lockout (15 minutes)

4. **Enter wrong PIN 10 times total**:
   - Should get hard lockout (60 minutes)

5. **Verify in Database**:
   ```sql
   SELECT "attempts", "lockedUntil"
   FROM "auth_factors"
   WHERE "accountId" = (SELECT "id" FROM "Account" WHERE "waId" = '27787051175')
   AND "type" = 'PIN';
   ```

---

### **Test 6: Consent Rejection**

**Objective**: User declines consent

**Steps**:
1. Complete steps 1-9 from Test 1 (get to S4_PIN_SET)

2. **Reply**:
   ```
   no
   ```

3. **Expected**: Prompt to accept
   - Should explain that acceptance is required
   - Should NOT transition to S5

4. **Reply**:
   ```
   I accept
   ```

5. **Expected**: Success, move to S5

---

### **Test 7: Post-Onboarding - Voucher Redemption**

**Objective**: User redeems voucher after onboarding

**Steps**:
1. Complete full onboarding (Test 1)

2. **Send message**:
   ```
   redeem voucher
   ```

3. **Expected**: Prompt for 16-digit PIN

4. **Reply with test voucher** (if you have one):
   ```
   1234-5678-9012-3456
   ```

5. **Expected**: Processing message, then success/failure

6. **Verify Balance Updated** (if successful):
   ```sql
   SELECT "availableCents"
   FROM "Wallet"
   WHERE "accountId" = (SELECT "id" FROM "Account" WHERE "waId" = '27787051175');
   ```

---

### **Test 8: Post-Onboarding - AI Chat**

**Objective**: User asks natural language questions

**Steps**:
1. Complete full onboarding (Test 1)

2. **Send natural language query**:
   ```
   How do I check my balance?
   ```

3. **Expected**: AI response explaining balance check

4. **Try another query**:
   ```
   What can you help me with?
   ```

5. **Expected**: AI provides helpful response

---

## 🐛 **Troubleshooting**

### **Issue: Templates not sending**
- Check Vercel logs for template initialization
- Verify `WHATSAPP_BUSINESS_ACCOUNT_ID` matches your WABA
- Check template approval status in Meta Business Manager
- Verify access token has `whatsapp_business_messaging` scope

### **Issue: OTP not received**
- Check Vercel logs for OTP send attempt
- Verify `otp_codes` table has entry
- Check Meta API logs in Business Manager
- Verify phone number is registered with WhatsApp

### **Issue: Database errors**
- Verify migration 003 is applied
- Check Prisma client is generated
- Verify `DATABASE_URL` uses connection pooler
- Check Supabase connection limits

### **Issue: State not progressing**
- Check `onboardingState` in `Account` table
- Review `audit_log` for state transitions
- Check Vercel logs for errors
- Verify message processor is using v2

---

## 📊 **Success Criteria**

✅ **Onboarding Complete**:
- User receives all 5 templates (or text fallbacks)
- Account status is `ACTIVE`
- Onboarding state is `S5_COMPLETED`
- OTP, PIN, and Consent records exist
- Audit trail shows all transitions
- User can perform post-onboarding actions

✅ **Error Handling**:
- Invalid inputs are rejected gracefully
- Rate limits are enforced
- Lockouts work correctly
- Fallback messages work when templates fail

✅ **Data Integrity**:
- No duplicate accounts created
- All foreign keys are valid
- Audit logs are complete
- Timestamps are accurate

---

## 🚀 **Next Steps After Testing**

1. **If all tests pass**:
   - Mark onboarding as production-ready
   - Begin implementing VAS features (airtime/data)
   - Add PIN verification to sensitive operations
   - Implement "forgot PIN" flow

2. **If tests fail**:
   - Review Vercel logs for errors
   - Check database state
   - Verify template configurations
   - Debug specific failure points

3. **Performance Testing**:
   - Test with multiple concurrent users
   - Monitor database connection pool usage
   - Check API response times
   - Verify rate limiting effectiveness

---

## 📝 **Test Results Template**

```
Date: ___________
Tester: ___________
Environment: Vercel Production

Test 1 (Happy Path): ☐ PASS ☐ FAIL
Test 2 (OTP Resend): ☐ PASS ☐ FAIL
Test 3 (Invalid OTP): ☐ PASS ☐ FAIL
Test 4 (Weak PIN): ☐ PASS ☐ FAIL
Test 5 (PIN Lockout): ☐ PASS ☐ FAIL
Test 6 (Consent Rejection): ☐ PASS ☐ FAIL
Test 7 (Voucher Redemption): ☐ PASS ☐ FAIL
Test 8 (AI Chat): ☐ PASS ☐ FAIL

Notes:
_______________________________
_______________________________
_______________________________
```

---

**Good luck with testing! 🎉**

