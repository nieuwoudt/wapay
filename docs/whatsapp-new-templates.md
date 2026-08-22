# 🆕 New WhatsApp Templates to Submit

**Date**: November 1, 2025  
**Purpose**: Complete the VAS flow with balance & help templates

---

## 📋 **Templates to Create in Meta**

### **1. balance_summary** ✅ CRITICAL

**Category**: Utility  
**Name**: `balance_summary`  
**Language**: English

**Header**: `Your Balance` (Text header)

**Body**:
```
Hi {{1}}, your WaPay balance is R {{2}}.

What would you like to do?
```

**Variables**:
1. `{{1}}` - Customer first name (e.g., "John")
2. `{{2}}` - Total WaPay balance (e.g., "200.00")

**Sample**:
```
Hi John, your WaPay balance is R 200.00.

What would you like to do?
```

**Notes**:
- Customer sees ONE balance (not wallet + gift)
- No emojis in body (Meta compliance)
- Space after "R" for currency
- Body doesn't start/end with variable
- Header is static text: "Your Balance"

---

### **2. help_menu** ✅ RECOMMENDED

**Category**: Utility  
**Name**: `help_menu`  
**Language**: English

**Header**: `How Can I Help?` (Text header)

**Body**:
```
Hi {{1}}, I can help you with the following.

Check your balance
Buy airtime or data
Redeem vouchers
Pay at participating stores

Just tell me what you need.
```

**Variables**:
1. `{{1}}` - Customer first name (e.g., "John")

**Sample**:
```
Hi John, I can help you with the following.

Check your balance
Buy airtime or data
Redeem vouchers
Pay at participating stores

Just tell me what you need.
```

**Notes**:
- Simple bullet-style list (no actual bullets for compliance)
- Ends with period
- No emojis
- Header is static text: "How Can I Help?"

---

### **3. network_select** ⚠️ OPTIONAL (Can use buttons instead)

**Category**: Utility  
**Name**: `network_select`  
**Language**: English

**Body**:
```
Which mobile network?
```

**Buttons** (Interactive):
- Vodacom
- MTN
- Cell C
- Telkom

**Notes**:
- This is an interactive message template
- Buttons are part of the template definition
- Alternative: Use regular text with quick replies (no template needed)

---

## 🎯 **Priority**

### **Must Have** (Submit Today):
1. ✅ `balance_summary` - CRITICAL for balance checks

### **Should Have** (Submit Soon):
2. ✅ `help_menu` - Good UX for unknown commands

### **Nice to Have** (Optional):
3. ⚠️ `network_select` - Can use quick replies instead

---

## 📋 **Submission Checklist**

For each template:
- [ ] Category set to "Utility"
- [ ] Language set to "English"
- [ ] Body text doesn't start/end with variable
- [ ] All variables have samples
- [ ] Sample values match variable count
- [ ] No emojis in body text
- [ ] Space after "R" for currency
- [ ] Body ends with punctuation
- [ ] No marketing language

---

## 🔄 **Alternative: Use Existing Templates**

If you want to launch faster, you can:

### **For Balance:**
Use a **regular text message** (not template):
```javascript
await whatsapp.sendText(waId, 
  `💰 Your Balance\n\n` +
  `Wallet: R${wallet}\n` +
  `Gift: R${gift}\n\n` +
  `Total: R${total}`
);
```

**Pros**: No template approval needed  
**Cons**: Less professional, not tracked in Meta

### **For Network Selection:**
Use **quick replies** (not template):
```javascript
await whatsapp.sendText(waId, "Which network?", {
  quickReplies: ["Vodacom", "MTN", "Cell C", "Telkom"]
});
```

**Pros**: No template approval needed  
**Cons**: Quick replies may not persist

---

## 🎯 **My Recommendation**

### **Best Approach:**

1. ✅ **Submit `balance_summary` today** (CRITICAL)
2. ✅ **Submit `help_menu` today** (GOOD UX)
3. ⚠️ **Skip `network_select`** - use quick replies instead

### **While Waiting for Approval:**

Use regular text messages for balance & help:
```javascript
// Temporary balance response (until template approved)
await whatsapp.sendText(waId,
  `Hi ${name}, here is your balance.\n\n` +
  `Wallet: R ${wallet}\n` +
  `Gift Balance: R ${gift}\n\n` +
  `Total Available: R ${total}\n\n` +
  `What would you like to do?`
);
```

This way you can:
- ✅ Launch immediately with text messages
- ✅ Switch to templates when approved
- ✅ Get better tracking & compliance

---

## 📊 **Template Approval Timeline**

**Expected**:
- Submission: Today
- Review: 1-3 business days
- Approval: 3-5 business days total

**During Review**:
- Use regular text messages
- Test all flows
- Prepare for switch-over

**After Approval**:
- Update WhatsApp client
- Switch to templates
- Monitor delivery rates

---

## 🚀 **Next Steps**

1. **Review these 2 templates** (balance_summary, help_menu)
2. **Submit to Meta** via WhatsApp Business Manager
3. **I'll update the code** to use them (with fallback to text)
4. **Test the flow** with text messages first
5. **Switch to templates** when approved

**Sound good?** 🎯



---

## wapay_payment_receipt (added 2026-08-22 — card-payer auto-registration)

**Purpose**: deliver a payment receipt to a CARD payer of a payment request whose
24h service window is closed (they paid on the web page but never messaged us).
The in-window path uses free-form text; this template is the out-of-window
fallback, env-gated in `pages/api/payfast/itn.js`.

**Category**: Utility
**Name**: `wapay_payment_receipt`
**Language**: English

**Body**:
```
Payment confirmed: you paid {{1}} to {{2}} via WaPay.

Payment reference: {{3}}.

This message is your receipt. Reply here any time for your own free WaPay wallet.
```

**Variables**:
1. `{{1}}` - amount paid, e.g. "R150.00"
2. `{{2}}` - masked requester label, e.g. "076•••567" or a display name
3. `{{3}}` - payment reference (PayFast id or request code)

**Buttons**: Quick Reply — `Get my WaPay`

**Sample**:
```
Payment confirmed: you paid R150.00 to 076•••567 via WaPay.

Payment reference: 2412345.

This message is your receipt. Reply here any time for your own free WaPay wallet.
```

**Notes**:
- Utility (transactional receipt), NOT Marketing — cheaper + faster approval
- No emojis in body; body neither starts nor ends with a variable
- AFTER Meta approval: set Vercel env `WAPAY_TEMPLATE_PAYMENT_RECEIPT=wapay_payment_receipt`
  and redeploy — the ITN fallback activates itself, no code change needed
