# 🚨 URGENT: Templates Needed for Production

## ⚠️ **Current Issue**
The onboarding flow is using **text message fallbacks** instead of proper WhatsApp templates because these templates don't exist in your production WABA yet.

---

## 📋 **Critical Templates to Copy from Test Account**

### **Priority 1: Onboarding Flow** ⭐⭐⭐

#### 1. `otp_register` 
**Status**: ❌ **MISSING** (currently using text fallback)  
**Category**: AUTHENTICATION  
**Purpose**: Send 6-digit OTP code during registration  

**Template Structure**:
```
🔐 WaPay Verification

Your verification code is: {{1}}

⏰ Code expires in 5 minutes
🔒 Never share this code

- WaPay Team
```

**Variables**:
- `{{1}}`: 6-digit OTP code (e.g., "123456")

**Why Critical**: Users can't complete onboarding without OTP verification. Currently sending ugly text messages instead of branded templates.

---

#### 2. `pin_setup_prompt`
**Status**: ❌ **MISSING** (will need text fallback)  
**Category**: AUTHENTICATION  
**Purpose**: Prompt user to create PIN after OTP verification  

**Template Structure**:
```
🔒 Secure Your Account

Create a 4-6 digit PIN to protect your WaPay wallet.

Your PIN will be required for:
✓ Sending money
✓ Buying airtime/data
✓ Redeeming vouchers

Reply with your chosen PIN.

💡 Choose something memorable but secure!
```

**Why Critical**: Part of mandatory onboarding flow (S3 → S4).

---

#### 3. `consent_terms_privacy`
**Status**: ⚠️ **PARTIAL** (have `consent_terms_` but incomplete)  
**Category**: UTILITY  
**Purpose**: Present T&C and Privacy Policy for POPIA compliance  

**Template Structure**:
```
📋 Terms & Conditions

By using WaPay, you agree to our:

📄 Terms of Service
🔒 Privacy Policy
📊 Data Processing Terms

View full terms: https://wapay.co.za/terms

Reply:
• ACCEPT - I agree
• DECLINE - I don't agree

Required for POPIA compliance.
```

**Buttons**:
- Quick Reply: "ACCEPT"
- Quick Reply: "DECLINE"

**Why Critical**: Legal requirement for POPIA compliance. Can't activate accounts without consent.

---

#### 4. `onboarding_complete`
**Status**: ❌ **MISSING**  
**Category**: UTILITY  
**Purpose**: Welcome message after successful onboarding (S5)  

**Template Structure**:
```
🎉 Welcome to WaPay!

Hi {{1}}, your account is ready!

💰 Current Balance: R {{2}}

What would you like to do?
```

**Variables**:
- `{{1}}`: User's name (e.g., "Nieuwoudt")
- `{{2}}`: Balance (e.g., "0.00")

**Buttons**:
- Quick Reply: "Redeem Voucher"
- Quick Reply: "Buy Airtime"
- Quick Reply: "Check Balance"

**Why Critical**: First impression after onboarding. Sets tone for user experience.

---

### **Priority 2: Post-Onboarding Actions** ⭐⭐

#### 5. `balance_summary`
**Status**: ❌ **MISSING** (exists in test account)  
**Category**: UTILITY  
**Purpose**: Show user's current balance  

**Why Critical**: Most common user action. Currently using text fallback.

---

#### 6. `airtime_receipt`
**Status**: ❌ **MISSING** (exists in test account)  
**Category**: UTILITY  
**Purpose**: Confirmation after successful airtime purchase  

**Why Critical**: Core MVP feature. Users need receipts for transactions.

---

#### 7. `data_receipt`
**Status**: ❌ **MISSING** (exists in test account)  
**Category**: UTILITY  
**Purpose**: Confirmation after successful data purchase  

**Why Critical**: Core MVP feature. Users need receipts for transactions.

---

### **Priority 3: Error Handling** ⭐

#### 8. `insufficient_balance`
**Status**: ❌ **MISSING**  
**Category**: UTILITY  
**Purpose**: Notify user when they don't have enough funds  

**Why Critical**: Better UX than generic error messages.

---

#### 9. `pin_locked`
**Status**: ❌ **MISSING**  
**Category**: AUTHENTICATION  
**Purpose**: Notify user their account is locked after failed PIN attempts  

**Why Critical**: Security feature. Users need to know why they can't transact.

---

## 🎯 **Immediate Action Required**

### **Option 1: Copy from Test Account** (Fastest)
1. Go to Meta Business Manager
2. Navigate to your **Test WABA** (801970852418258)
3. Find these templates:
   - `otp_register`
   - `balance_summary`
   - `airtime_receipt`
   - `data_receipt`
4. Copy each to **Production WABA** (647978251504290)
5. Wait for approval (~15 minutes for UTILITY templates)

### **Option 2: Create New Templates** (If copying doesn't work)
Use the specifications above to create new templates in production WABA.

---

## 📊 **Current Workaround**

✅ **Working Now**: Text message fallbacks are in place  
⚠️ **Impact**: Poor UX, looks unprofessional  
🎯 **Goal**: Replace all fallbacks with proper templates  

---

## 🔄 **After Adding Templates**

Once templates are approved in production:

1. **No code changes needed!** ✅
2. System will automatically:
   - Detect new templates on next webhook request
   - Rebuild template catalog
   - Start using templates instead of fallbacks

3. **Test the flow**:
   ```sql
   -- Delete test account
   DELETE FROM "Wallet" WHERE "accountId" IN (SELECT "id" FROM "Account" WHERE "waId" = '27787051175');
   DELETE FROM "Account" WHERE "waId" = '27787051175';
   ```
   
   Then send "Hi" to WaPay and go through onboarding again.

---

## 📝 **Notes**

- **Text fallbacks are temporary** - they work but don't look professional
- **Templates provide better UX** - buttons, formatting, branding
- **POPIA compliance** - consent template is legally required
- **User trust** - professional templates build confidence

---

## ✅ **Checklist**

- [ ] Copy `otp_register` from test account
- [ ] Copy `balance_summary` from test account
- [ ] Copy `airtime_receipt` from test account
- [ ] Copy `data_receipt` from test account
- [ ] Create `pin_setup_prompt` (new)
- [ ] Create `consent_terms_privacy` (new)
- [ ] Create `onboarding_complete` (new)
- [ ] Create `insufficient_balance` (new)
- [ ] Create `pin_locked` (new)
- [ ] Test full onboarding flow with templates
- [ ] Verify all templates render correctly on mobile

---

**Last Updated**: 2025-11-13  
**Status**: Text fallbacks working, templates needed for production UX

