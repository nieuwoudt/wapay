# WaPay Onboarding Implementation Plan

**Status**: Templates approved, backend implementation needed  
**Priority**: HIGH - Core onboarding flow

---

## ✅ **Available Templates (Approved in Meta)**

### **Onboarding Flow Templates**
1. ✅ `onboarding_step_1` - Welcome & CTA (MARKETING, en)
2. ✅ `otp_register` - OTP verification (AUTHENTICATION, en)
3. ❌ `onboarding_step_3_pin_creation` - **MISSING - Need to create**
4. ✅ `consent_terms` - POPIA consent (UTILITY, en)
5. ✅ `welcome_new_user_account_activation` - Welcome banner (MARKETING, en)
6. ❌ `successful_account_creation` - **MISSING - Need to create**

### **Supporting Templates**
- ✅ `welcome_new_user` - Alternative welcome
- ✅ `balance_summary` - Balance display
- ✅ `help_me_menu` - Help menu
- ✅ `bluvoucher_redeem_prompt` - Voucher redemption
- ✅ `bluvoucher_redeem_success` - Voucher success
- ✅ `deposit_failed` - Error handling

---

## 🗄️ **Database Schema Updates Needed**

### **1. Add OTP Tables**
```sql
-- OTP codes table
CREATE TABLE IF NOT EXISTS "otp_codes" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "otp_codes_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id")
);

CREATE INDEX "otp_codes_accountId_idx" ON "otp_codes"("accountId");
CREATE INDEX "otp_codes_code_idx" ON "otp_codes"("code");
```

### **2. Add PIN/Auth Factors Table**
```sql
-- Auth factors (PIN storage)
CREATE TABLE IF NOT EXISTS "auth_factors" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "type" TEXT NOT NULL CHECK ("type" IN ('PIN')),
  "secretHash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT "auth_factors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auth_factors_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id")
);

CREATE UNIQUE INDEX "auth_factors_accountId_type_key" ON "auth_factors"("accountId", "type");
```

### **3. Add Consents Table**
```sql
-- POPIA consents
CREATE TABLE IF NOT EXISTS "consents" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "agreedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "waMessageId" TEXT,
  
  CONSTRAINT "consents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "consents_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id")
);

CREATE INDEX "consents_accountId_idx" ON "consents"("accountId");
```

### **4. Add Audit Log Table**
```sql
-- Audit log for all events
CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" TEXT NOT NULL,
  "accountId" TEXT,
  "event" TEXT NOT NULL,
  "metadata" JSONB,
  "waMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_log_accountId_idx" ON "audit_log"("accountId");
CREATE INDEX "audit_log_event_idx" ON "audit_log"("event");
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt");
```

### **5. Update Account Table**
```sql
-- Add status and onboarding state fields
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'pending';
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "onboardingState" TEXT DEFAULT 'S0';

-- Update existing accounts
UPDATE "Account" SET "status" = 'pending', "onboardingState" = 'S0' WHERE "status" IS NULL;
```

---

## 🔧 **Backend Implementation Tasks**

### **Phase 1: Database & Core Auth (Week 1)**

#### **Task 1.1: Create Migration**
- [ ] Create `003_add_onboarding_tables.sql`
- [ ] Add otp_codes, auth_factors, consents, audit_log tables
- [ ] Update Account table with status and onboardingState
- [ ] Test migration locally

#### **Task 1.2: OTP Service**
- [ ] Create `packages/auth/src/otp.ts`
- [ ] `generateOTP()` - 6-digit numeric code
- [ ] `sendOTP(msisdn, code)` - Send via WhatsApp template
- [ ] `verifyOTP(accountId, code)` - Validate and consume
- [ ] Add rate limiting (max 3 OTPs per 5 minutes)
- [ ] 5-minute TTL enforcement

#### **Task 1.3: PIN Service**
- [ ] Create `packages/auth/src/pin.ts`
- [ ] Install `argon2` package
- [ ] `hashPIN(pin, pepper)` - Argon2id hashing
- [ ] `verifyPIN(accountId, pin)` - Verify with lockout
- [ ] `setPIN(accountId, pin)` - Store hashed PIN
- [ ] Implement lockout logic (5 soft, 10 hard)
- [ ] Generate short-lived PIN tokens (JWT, 5min)

#### **Task 1.4: Consent Service**
- [ ] Create `packages/domain/src/consents.ts`
- [ ] `recordConsent(accountId, version, waMessageId)`
- [ ] `hasValidConsent(accountId)` - Check consent
- [ ] Version management (current: "v1.0")

#### **Task 1.5: Audit Service**
- [ ] Create `packages/domain/src/audit.ts`
- [ ] `logEvent(accountId, event, metadata, waMessageId)`
- [ ] Event types: OTP_SENT, OTP_VERIFIED, PIN_SET, CONSENT_GIVEN, etc.

---

### **Phase 2: Onboarding State Machine (Week 1-2)**

#### **Task 2.1: State Controller**
- [ ] Create `pages/api/onboarding/state-machine.ts`
- [ ] Implement state transitions (S0 → S5)
- [ ] State validation and guards
- [ ] Idempotency handling

#### **Task 2.2: Update Message Processor**
- [ ] Update `pages/api/webhooks/message-processor.js`
- [ ] Add onboarding state routing
- [ ] Handle button clicks (interactive messages)
- [ ] Integrate OTP/PIN flows

#### **Task 2.3: Onboarding Endpoints**
```
POST /api/onboarding/start         # S0 → S1 (send onboarding_step_1)
POST /api/onboarding/send-otp      # S1 → S2 (send OTP)
POST /api/onboarding/verify-otp    # S2 → S3 (verify OTP)
POST /api/onboarding/set-pin       # S3 → S4 (create PIN)
POST /api/onboarding/consent       # S4 → S5 (record consent)
POST /api/onboarding/complete      # S5 → active (activate account)
```

---

### **Phase 3: Template Integration (Week 2)**

#### **Task 3.1: Create Missing Templates in Meta**
1. **`onboarding_step_3_pin_creation`**
   - Category: AUTHENTICATION
   - Language: en
   - Body: "Create your 4-6 digit PIN to secure your WaPay account. {{1}}\n\nReply with your PIN (e.g., 1234)"
   - Sample: {{1}} = "This PIN will be required for all transactions."

2. **`successful_account_creation`**
   - Category: UTILITY
   - Language: en
   - Header: ✅ Account Active
   - Body: "Congratulations {{1}}! Your WaPay account is now active.\n\n💰 Balance: R {{2}}\n\nWhat would you like to do?"
   - Buttons: [Deposit Money] [Send Money] [Shop & Pay]
   - Samples: {{1}} = "John", {{2}} = "0.00"

#### **Task 3.2: Update Template Catalog**
- [ ] Re-seed templates to include new ones
- [ ] Update `templateCatalog.ts` with onboarding templates
- [ ] Test template resolution

#### **Task 3.3: Template Sending Functions**
- [ ] `sendOnboardingStep1(to, name)`
- [ ] `sendOTPTemplate(to, code)`
- [ ] `sendPINCreation(to, instructions)`
- [ ] `sendConsentTerms(to, termsUrl)`
- [ ] `sendWelcomeActivation(to, name)`
- [ ] `sendAccountCreated(to, name, balance)`

---

### **Phase 4: Forgot PIN Flow (Week 2-3)**

#### **Task 4.1: LLM Intent Detection**
- [ ] Add `FORGOT_PIN` intent to NLP
- [ ] Train intent patterns: "forgot pin", "reset pin", "can't remember pin"

#### **Task 4.2: PIN Recovery Endpoint**
```
POST /api/auth/pin/forgot         # Initiate recovery
POST /api/auth/pin/reset          # Reset with OTP
```

#### **Task 4.3: Recovery Flow**
- [ ] Detect FORGOT_PIN intent
- [ ] Send OTP via `otp_register` template
- [ ] Verify OTP
- [ ] Allow PIN reset via `onboarding_step_3_pin_creation`
- [ ] Rate limit: max 3 resets per day
- [ ] Audit all recovery events

---

### **Phase 5: Testing & Polish (Week 3)**

#### **Task 5.1: End-to-End Testing**
- [ ] Test complete onboarding flow (S0 → S5)
- [ ] Test OTP expiry and rate limiting
- [ ] Test PIN creation and verification
- [ ] Test PIN lockout (5 attempts)
- [ ] Test consent capture
- [ ] Test forgot PIN flow

#### **Task 5.2: Error Handling**
- [ ] OTP expired
- [ ] OTP invalid
- [ ] PIN too weak
- [ ] PIN locked
- [ ] Rate limit exceeded
- [ ] Template send failures

#### **Task 5.3: Monitoring**
- [ ] Add logging for all state transitions
- [ ] Track onboarding completion rate
- [ ] Monitor OTP delivery success
- [ ] Alert on high failure rates

---

## 📋 **Implementation Checklist**

### **Week 1: Foundation**
- [ ] Create database migration (003_add_onboarding_tables)
- [ ] Run migration in Supabase
- [ ] Implement OTP service
- [ ] Implement PIN service (with Argon2id)
- [ ] Implement consent service
- [ ] Implement audit logging

### **Week 2: Onboarding Flow**
- [ ] Create missing templates in Meta
- [ ] Implement state machine controller
- [ ] Update message processor for onboarding
- [ ] Create onboarding API endpoints
- [ ] Test S0 → S5 flow

### **Week 3: PIN Recovery & Polish**
- [ ] Implement forgot PIN flow
- [ ] Add LLM intent for FORGOT_PIN
- [ ] End-to-end testing
- [ ] Error handling
- [ ] Monitoring and alerts

---

## 🎯 **Success Criteria**

1. ✅ New user can complete onboarding in < 3 minutes
2. ✅ OTP delivery success rate > 95%
3. ✅ PIN security: Argon2id + pepper + lockout
4. ✅ POPIA consent captured with version tracking
5. ✅ All state transitions logged in audit_log
6. ✅ Forgot PIN recovery works seamlessly
7. ✅ Zero template send failures

---

## 🚀 **Next Steps**

1. **Create missing templates in Meta** (onboarding_step_3_pin_creation, successful_account_creation)
2. **Run database migration** (003_add_onboarding_tables.sql)
3. **Implement OTP service** (packages/auth/src/otp.ts)
4. **Implement PIN service** (packages/auth/src/pin.ts)
5. **Build state machine** (pages/api/onboarding/state-machine.ts)

---

**Ready to start implementation!** 🎉

