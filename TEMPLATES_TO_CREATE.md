# WhatsApp Templates to Create/Copy

## 📊 **Current Status**

### ✅ **Already in Production WABA (647978251504290)**
1. `welcome_new_user` - Initial greeting
2. `welcome_new_user_account_activation` - Account setup
3. `deposit_failed` - Voucher error
4. `bluvoucher_redeem_success` - Voucher success
5. `redeem_in_progress` - Processing
6. `bluvoucher_redeem_prompt` - Request PIN
7. `deposit_options` - Deposit methods
8. `consent_terms_` - Terms
9. `hello_world` - Test

### ✅ **Already in Test Account (801970852418258) - Available to Copy**
- `help_me_menu`
- `data_disambiguate`
- `balance_summary`
- `otp_register`
- `data_receipt`
- `airtime_receipt`
- (and more...)

---

## 🎯 **Priority 1: Onboarding Flow (CREATE NEW)**

### **1. onboarding_step_1**
**Category**: UTILITY  
**Language**: English (en)

**Header**: None

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

**Footer**: None

**Buttons**: 
- Quick Reply: "Continue"

**Sample Values**:
- {{1}}: "John"

---

### **2. onboarding_step_2**
**Category**: UTILITY  
**Language**: English (en)

**Header**: None

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

**Footer**: None

**Buttons**: None (auto-proceeds)

**Sample Values**:
- {{1}}: "John"

---

### **3. account_created**
**Category**: UTILITY  
**Language**: English (en)

**Header**: ✅ Account Ready

**Body**:
```
Welcome to WaPay, {{1}}!

Your account is ready to use.

💰 Current Balance: R {{2}}

What would you like to do?
```

**Footer**: Powered by WaPay

**Buttons**: 
- Quick Reply: "Redeem Voucher"
- Quick Reply: "Buy Airtime"
- Quick Reply: "Check Balance"

**Sample Values**:
- {{1}}: "John"
- {{2}}: "0.00"

---

## 🎯 **Priority 2: Balance & Quick Actions (CREATE NEW)**

### **4. balance_summary**
**Category**: UTILITY  
**Language**: English (en)

**Header**: 💰 Your WaPay Balance

**Body**:
```
Hi {{1}}!

Your current balance is R {{2}}.

What would you like to do?
```

**Footer**: None

**Buttons**: 
- Quick Reply: "Buy Airtime"
- Quick Reply: "Buy Data"
- Quick Reply: "Send Money"
- Quick Reply: "Redeem Voucher"

**Sample Values**:
- {{1}}: "John"
- {{2}}: "150.50"

---

### **5. help_menu** (COPY FROM TEST ACCOUNT)
**Already exists in Test account - just copy to Production**

---

## 🎯 **Priority 3: VAS (Airtime/Data)**

### **6. airtime_preview**
**Category**: UTILITY  
**Language**: English (en)

**Header**: None

**Body**:
```
Buy R {{1}} airtime for {{2}}.

Network: {{3}}
Fee: R {{4}}
Total: R {{5}}

Reply YES to confirm or NO to cancel.
```

**Footer**: None

**Buttons**: 
- Quick Reply: "YES"
- Quick Reply: "NO"

**Sample Values**:
- {{1}}: "50"
- {{2}}: "082 123 4567"
- {{3}}: "Vodacom"
- {{4}}: "0.50"
- {{5}}: "50.50"

---

### **7. airtime_receipt** (COPY FROM TEST ACCOUNT)
**Already exists in Test account - just copy to Production**

---

### **8. data_disambiguate** (COPY FROM TEST ACCOUNT)
**Already exists in Test account - just copy to Production**

---

### **9. data_preview**
**Category**: UTILITY  
**Language**: English (en)

**Header**: None

**Body**:
```
Buy {{1}} data for {{2}}.

Network: {{3}}
Price: R {{4}}
Fee: R {{5}}
Total: R {{6}}

Reply YES to confirm or NO to cancel.
```

**Footer**: None

**Buttons**: 
- Quick Reply: "YES"
- Quick Reply: "NO"

**Sample Values**:
- {{1}}: "1GB Daily"
- {{2}}: "082 123 4567"
- {{3}}: "Vodacom"
- {{4}}: "29"
- {{5}}: "0.50"
- {{6}}: "29.50"

---

### **10. data_receipt** (COPY FROM TEST ACCOUNT)
**Already exists in Test account - just copy to Production**

---

## 🎯 **Priority 4: P2P Transfers (CREATE NEW)**

### **11. p2p_preview**
**Category**: UTILITY  
**Language**: English (en)

**Header**: None

**Body**:
```
Send R {{1}} to {{2}}.

Recipient: {{3}}
Fee: R {{4}}
Total: R {{5}}

Reply YES to confirm or NO to cancel.
```

**Footer**: None

**Buttons**: 
- Quick Reply: "YES"
- Quick Reply: "NO"

**Sample Values**:
- {{1}}: "100"
- {{2}}: "+27 82 123 4567"
- {{3}}: "John Doe"
- {{4}}: "2.00"
- {{5}}: "102.00"

---

### **12. p2p_receipt_sender**
**Category**: UTILITY  
**Language**: English (en)

**Header**: ✅ Money Sent

**Body**:
```
You sent R {{1}} to {{2}}.

Recipient: {{3}}
Reference: {{4}}
New Balance: R {{5}}

Thank you for using WaPay!
```

**Footer**: None

**Buttons**: None

**Sample Values**:
- {{1}}: "100"
- {{2}}: "+27 82 123 4567"
- {{3}}: "John Doe"
- {{4}}: "WP123456789"
- {{5}}: "50.00"

---

### **13. p2p_receipt_recipient**
**Category**: UTILITY  
**Language**: English (en)

**Header**: 💰 Money Received

**Body**:
```
You received R {{1}} from {{2}}.

Sender: {{3}}
Reference: {{4}}
New Balance: R {{5}}

Funds are available immediately!
```

**Footer**: None

**Buttons**: None

**Sample Values**:
- {{1}}: "100"
- {{2}}: "+27 82 000 0000"
- {{3}}: "Jane Smith"
- {{4}}: "WP123456789"
- {{5}}: "200.00"

---

## 🎯 **Priority 5: AI Chat Banking (CREATE NEW)**

### **14. ai_chat_intro**
**Category**: UTILITY  
**Language**: English (en)

**Header**: 🤖 WaPay AI Assistant

**Body**:
```
Hi {{1}}! I'm your WaPay AI assistant.

Ask me anything about:
• How to use WaPay
• Fees and limits
• Troubleshooting

I speak all 11 South African languages! 🇿🇦

What can I help you with today?
```

**Footer**: None

**Buttons**: 
- Quick Reply: "How do I redeem a voucher?"
- Quick Reply: "How do I buy airtime?"
- Quick Reply: "Show me my balance"

**Sample Values**:
- {{1}}: "John"

---

### **15. ai_chat_response**
**Category**: UTILITY  
**Language**: English (en)

**Header**: None

**Body**:
```
{{1}}

Would you like me to help you with anything else?
```

**Footer**: Powered by WaPay AI

**Buttons**: 
- Quick Reply: "Yes"
- Quick Reply: "No, thanks"

**Sample Values**:
- {{1}}: "To redeem a voucher, simply send me 'redeem voucher' and I'll guide you through the process. You'll need your 16-digit voucher PIN."

---

## 📋 **Summary: What to Do**

### **Step 1: Copy from Test Account (5 templates)**
1. `help_me_menu`
2. `data_disambiguate`
3. `airtime_receipt`
4. `data_receipt`
5. `balance_summary` (if it exists)

### **Step 2: Create New Templates (10 templates)**
1. `onboarding_step_1`
2. `onboarding_step_2`
3. `account_created`
4. `balance_summary` (if not in Test)
5. `airtime_preview`
6. `data_preview`
7. `p2p_preview`
8. `p2p_receipt_sender`
9. `p2p_receipt_recipient`
10. `ai_chat_intro`
11. `ai_chat_response`

### **Total: 15 new templates needed**

---

## 🎯 **Recommended Order**

1. **Week 1**: Onboarding (3 templates) + Balance (1 template)
2. **Week 2**: VAS (4 templates - 2 copy, 2 create)
3. **Week 3**: P2P (3 templates)
4. **Week 4**: AI Chat (2 templates)

---

## 📝 **Template Creation Tips**

1. **Category**: Use UTILITY for transactional messages
2. **Language**: Start with English (en), add others later
3. **Variables**: Use {{1}}, {{2}}, etc. in order
4. **Samples**: Must match variable count and order exactly
5. **Headers**: Optional, keep short (< 60 chars)
6. **Body**: Max 1024 characters, end with punctuation
7. **Buttons**: Max 3 quick replies, keep text short
8. **Approval**: Takes 1-2 days, be patient

---

**Next Step**: Start with Priority 1 (Onboarding) templates!

