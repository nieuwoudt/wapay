# 🚀 Onboarding Templates - Creation Guide

**Status**: Templates need to be created in Meta  
**Priority**: HIGH - Required for MVP Launch  
**Timeline**: 3-5 business days for approval

---

## ✅ **Already Exists in Production**

1. `welcome_new_user` ✅ - Initial greeting (already approved)

---

## 📝 **Templates to Create in Meta**

### **Template 1: account_created**

**Purpose**: Confirm account creation and show initial balance

**Category**: `UTILITY`  
**Language**: `English (en)`

**Header**: (Optional - can be text or none)
```
Account Ready
```

**Body**:
```
Welcome to WaPay, {{1}}!

Your account is ready to use.

💰 Current Balance: R {{2}}

What would you like to do?
```

**Footer**: (Optional)
```
Powered by WaPay
```

**Buttons**: (Quick Reply buttons)
1. `Redeem Voucher`
2. `Buy Airtime`
3. `Check Balance`

**Sample Values**:
- {{1}}: `John`
- {{2}}: `0.00`

**Important Notes**:
- Use UTILITY category (not MARKETING)
- Body must end with punctuation
- Quick reply buttons are limited to 3
- Keep button text short (< 20 chars each)

---

## 🎯 **Optional: Onboarding Step Templates**

If you want to use templates for the onboarding steps (recommended for polish but not required for MVP):

### **Template 2: onboarding_step_1** (Optional)

**Body**:
```
Hi {{1}}! 👋

Welcome to WaPay - your WhatsApp wallet for South Africa.

Here's what you can do:
• Deposit money via vouchers
• Buy airtime & data
• Send money to friends
• Get instant receipts

Let's set up your account!
```

**Buttons**:
1. `Continue`

**Sample Values**:
- {{1}}: `John`

---

### **Template 3: onboarding_step_2** (Optional)

**Body**:
```
Great {{1}}! 🎉

Your WaPay account is being created.

You'll be able to:
✓ Check your balance anytime
✓ Buy airtime for any network
✓ Purchase data bundles
✓ Send money instantly

Creating your account now...
```

**Sample Values**:
- {{1}}: `John`

---

## 📋 **How to Create Templates in Meta**

### **Step 1: Go to Meta Business Manager**
1. Open: https://business.facebook.com
2. Navigate to: WhatsApp Manager → Message Templates
3. Click: `Create Template`

### **Step 2: Fill in Template Details**

**Template Name**: Use exact names above (lowercase, underscores)
- `account_created`
- `onboarding_step_1` (optional)
- `onboarding_step_2` (optional)

**Category**: Select `UTILITY`

**Languages**: Start with `English`

### **Step 3: Create Template Body**

1. Copy the body text exactly as shown above
2. Add variables by typing `{{1}}`, `{{2}}`, etc.
3. Add buttons (Quick Reply type)
4. Preview on the right side

### **Step 4: Add Sample Content**

**Critical**: You must provide sample values for ALL variables!
- Replace `{{1}}` with real name example: `John`
- Replace `{{2}}` with balance example: `0.00`

### **Step 5: Submit for Review**

1. Review all details
2. Click `Submit`
3. Wait for Meta approval (usually 1-3 business days)
4. Check approval status in Message Templates section

---

## 🚀 **Deployment Strategy**

### **Option A: Deploy with Text Fallbacks (RECOMMENDED)** ✅

**Timeline**: Deploy immediately!

**Status**:
- ✅ `welcome_new_user` already approved
- ✅ Text fallbacks implemented for all steps
- ✅ Flow works end-to-end

**Action**: Deploy now, switch to templates when approved

---

### **Option B: Wait for All Templates**

**Timeline**: 3-5 business days

**Status**: Wait for Meta approval before deploying

**Action**: Create all templates, wait for approval, then deploy

---

## ✅ **Recommended: Option A - Deploy Now**

Your onboarding flow is already implemented with text message fallbacks!

**What works today**:
1. New user sends "Hi"
2. Receives `welcome_new_user` template ✅
3. Replies "continue"
4. Receives text message with onboarding info
5. Automatically gets account created confirmation
6. Can immediately start using WaPay

**When templates are approved**:
- Flow automatically switches to templates
- No code changes needed
- Better visual experience

---

## 🧪 **Testing the Flow**

### **Test with a New WhatsApp Number**:

1. Send: `Hi` to WaPay
2. Expect: Welcome template
3. Reply: `continue` or `yes`
4. Expect: Onboarding message
5. Wait: 2 seconds
6. Expect: Account created confirmation with balance

### **Test Balance Check**:

1. Send: `balance`
2. Expect: Balance display with action buttons

### **Test Voucher Flow**:

1. Send: `redeem voucher`
2. Expect: Instructions to enter PIN
3. Send: Any number
4. Expect: Confirmation (placeholder for Phase 2)

---

## 📊 **Onboarding States**

Your system now tracks these states:

| State | Description |
|-------|-------------|
| `NEW` | User just created, never seen |
| `WELCOME_SENT` | Welcome message sent |
| `STEP_1_SENT` | Onboarding step 1 sent |
| `COMPLETED` | Onboarding finished, user active |

**Conversation States**:
- `ONBOARDING_WELCOME` - Waiting for user to continue
- `ONBOARDING_STEP_1` - In onboarding flow
- `AWAITING_VOUCHER_PIN` - Waiting for voucher PIN (Phase 2)

---

## 🎯 **Success Criteria**

**MVP Launch Requirements**:

- ✅ New users get welcomed
- ✅ Onboarding completes in < 2 minutes
- ✅ Account created with R 0.00 balance
- ✅ Users can check balance
- ✅ Users can attempt voucher redemption
- ⏳ Templates improve visual experience (nice to have)

**Current Status**: ✅ Ready to deploy!

---

## 📝 **Next Steps**

### **Now**:
1. ✅ Onboarding flow implemented
2. ✅ Database schema updated
3. ✅ Text fallbacks working

### **Optional (for polish)**:
1. Create `account_created` template in Meta
2. Wait 3-5 days for approval
3. Templates automatically used when approved

### **Phase 2**:
1. Wire Blu Voucher API
2. Implement actual voucher redemption
3. Add receipt templates

---

## 🎉 **You're Ready to Deploy!**

Your onboarding flow is complete and working with text fallbacks. Deploy now and users can start using WaPay immediately. Templates will make it prettier when approved, but functionality is 100% ready!

**Next**: Move to Phase 2 (Voucher Redemption) 🚀


