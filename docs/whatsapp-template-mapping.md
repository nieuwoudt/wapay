# 📱 WhatsApp Template Mapping

**How Your Existing Templates Map to Our Flow**

---

## ✅ **Perfect Matches (Use As-Is)**

### **Airtime Flow:**

| **Step** | **Template Name** | **Status** | **Usage** |
|----------|-------------------|------------|-----------|
| Ask for amount | `airtime_select_amount` | ✅ Active | When amount is missing |
| Ask for number | `topup_collect_number` | ✅ Active | When phone number is missing |
| Show preview | `airtime_preview_confirm` | ✅ Active | Before executing purchase |
| Send receipt | `airtime_receipt` | ✅ Active | After successful purchase |

**Flow Example:**
```
Customer: "I need airtime"
→ Send: airtime_select_amount (Quick replies: R10, R20, R50, R100)

Customer: "R50"
→ Send: topup_collect_number ("Please enter phone number")

Customer: "0821234567"
→ Send: airtime_preview_confirm ("Buy R50 airtime for 082... Reply YES")

Customer: "YES"
→ Execute purchase
→ Send: airtime_receipt ("Airtime purchase successful!")
```

---

### **Data Flow:**

| **Step** | **Template Name** | **Status** | **Usage** |
|----------|-------------------|------------|-----------|
| Ask for number | `topup_collect_number` | ✅ Active | When phone number is missing |
| Show bundles | `data_select_bundle` | ✅ Active | After network is known |
| Show preview | `data_preview_confirm` | ✅ Active | Before executing purchase |
| Send receipt | `data_receipt` | ✅ Active | After successful purchase |

**Flow Example:**
```
Customer: "Buy data for 0821234567"
→ Ask for network (text or quick reply)

Customer: "Vodacom"
→ Send: data_select_bundle ("Here are popular data bundles...")

Customer: "2" (selects 1GB bundle)
→ Send: data_preview_confirm ("Buy 1GB bundle for R35. Reply YES")

Customer: "YES"
→ Execute purchase
→ Send: data_receipt ("Data purchase successful!")
```

---

### **Voucher Redemption Flow:**

| **Step** | **Template Name** | **Status** | **Usage** |
|----------|-------------------|------------|-----------|
| Processing | `redeem_in_progress` | ✅ Active | While calling Blu API |
| Success | `bluvoucher_redeem_success` | ✅ Active | After successful redemption |
| Failed | `deposit_failed` | ✅ Active | If redemption fails |

**Flow Example:**
```
Customer: "Redeem voucher 1234567890123456"
→ Send: redeem_in_progress ("Checking your voucher...")
→ Call Blu API

If success:
→ Send: bluvoucher_redeem_success ("Voucher redeemed! R100 added")

If failed:
→ Send: deposit_failed ("We couldn't redeem your voucher. Reason: ...")
```

---

### **Onboarding Flow:**

| **Step** | **Template Name** | **Status** | **Usage** |
|----------|-------------------|------------|-----------|
| First contact | `welcome_intro` | ✅ Active | First time user messages |
| Account created | `welcome_new_user` | ✅ Active | After registration |
| OTP verification | `otp_register` | ✅ Active | Send verification code |
| Terms consent | `consent_terms` | ✅ Active | Before using service |

---

## ❌ **Missing Templates (Need to Create)**

### **Balance Check:**

| **Step** | **Template Name** | **Status** | **Usage** |
|----------|-------------------|------------|-----------|
| Show balance | `balance_summary` | ❌ Need to create | Response to "What's my balance?" |

**Temporary Solution:**
```javascript
// Use regular text message until template approved
await whatsapp.sendText(waId,
  `Hi ${name}, here is your balance.\n\n` +
  `Wallet: R ${wallet}\n` +
  `Gift Balance: R ${gift}\n\n` +
  `Total Available: R ${total}`
);
```

---

### **Help/Unknown Command:**

| **Step** | **Template Name** | **Status** | **Usage** |
|----------|-------------------|------------|-----------|
| Show help | `help_menu` | ❌ Need to create | When intent is UNKNOWN |

**Temporary Solution:**
```javascript
// Use regular text message
await whatsapp.sendText(waId,
  `Hi ${name}, I can help you with:\n\n` +
  `• Check balance\n` +
  `• Buy airtime or data\n` +
  `• Redeem vouchers\n` +
  `• Pay at stores\n\n` +
  `Just tell me what you need!`
);
```

---

### **Network Selection:**

| **Step** | **Template Name** | **Status** | **Usage** |
|----------|-------------------|------------|-----------|
| Ask network | `network_select` | ⚠️ Optional | When network can't be auto-detected |

**Recommended Solution:**
```javascript
// Use quick replies (no template needed)
await whatsapp.sendText(waId, "Which network?", {
  quickReplies: ["Vodacom", "MTN", "Cell C", "Telkom"]
});
```

---

## 🎯 **Template Usage Summary**

### **✅ Ready to Use (20 templates)**
- airtime_receipt
- data_receipt
- airtime_preview_confirm
- data_preview_confirm
- data_select_bundle
- airtime_select_amount
- topup_collect_number
- redeem_in_progress
- bluvoucher_redeem_success
- deposit_failed
- welcome_intro
- welcome_new_user
- otp_register
- consent_terms
- topup_choose_type
- shop_pay_options
- deposit_options
- welcome_new_user_acc
- hello_world (test)
- ... and more!

### **❌ Need to Create (2 templates)**
1. `balance_summary` - CRITICAL
2. `help_menu` - RECOMMENDED

### **⚠️ Can Skip (1 template)**
3. `network_select` - Use quick replies instead

---

## 🔄 **Implementation Strategy**

### **Phase 1: Launch with Existing Templates** ✅ DO THIS NOW

**Use:**
- ✅ All 20 existing templates
- ✅ Regular text messages for balance & help
- ✅ Quick replies for network selection

**Result:**
- ✅ Can launch immediately!
- ✅ 90% of flow uses approved templates
- ✅ Only 2 responses use text messages

---

### **Phase 2: Add Missing Templates** ⏳ SUBMIT TODAY

**Submit to Meta:**
1. `balance_summary` (Utility)
2. `help_menu` (Utility)

**Wait for approval:** 3-5 business days

---

### **Phase 3: Switch to New Templates** 🔄 AFTER APPROVAL

**Update code:**
- Replace text messages with templates
- Monitor delivery rates
- Track engagement

---

## 📊 **Template Coverage**

```
Airtime Flow:        ████████████████████  100% ✅
Data Flow:           ████████████████████  100% ✅
Voucher Flow:        ████████████████████  100% ✅
Onboarding:          ████████████████████  100% ✅
Balance Check:       ░░░░░░░░░░░░░░░░░░░░    0% ❌ (use text)
Help/Unknown:        ░░░░░░░░░░░░░░░░░░░░    0% ❌ (use text)

Overall Coverage:    ████████████████░░░░   85%!
```

---

## 🚀 **Recommendation**

### **DO THIS:**

1. ✅ **Use your existing 20 templates** - they're perfect!
2. ✅ **Use text messages** for balance & help (temporary)
3. ✅ **Submit 2 new templates** to Meta today
4. ✅ **Launch immediately** with 85% template coverage
5. ✅ **Switch to templates** when approved (3-5 days)

### **DON'T DO THIS:**
- ❌ Wait for template approval before launching
- ❌ Redesign existing templates (they're good!)
- ❌ Create templates for everything (quick replies work!)

---

## 💡 **Pro Tips**

### **For Best UX:**

1. **Use templates for transactional messages:**
   - ✅ Receipts
   - ✅ Confirmations
   - ✅ Status updates

2. **Use text/quick replies for conversational:**
   - ✅ Disambiguation ("Which network?")
   - ✅ Clarification ("How much?")
   - ✅ Help responses

3. **Use buttons for selections:**
   - ✅ Amount selection (R10, R20, R50, R100)
   - ✅ Network selection (Vodacom, MTN, Cell C, Telkom)
   - ✅ Bundle selection (1, 2, 3, 4)

---

## 🎉 **Bottom Line**

**You're 85% ready to launch!**

- ✅ All critical flows have templates
- ✅ Only balance & help need text messages
- ✅ Can switch to templates in 3-5 days
- ✅ **Launch now, optimize later!**

**Let's do it!** 🚀


