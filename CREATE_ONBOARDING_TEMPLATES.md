# 🎯 Create Onboarding Templates in Meta - Step by Step

**Goal**: Create proper template flow with buttons for professional onboarding

---

## 📱 **Template 1: welcome_new_user** ✅ 
**Status**: Already exists in production!

This starts the flow when user sends "Hi"

---

## 📱 **Template 2: onboarding_continue**

### **Go to Meta Business Manager**
1. Open: https://business.facebook.com/wa/manage/message-templates/
2. Select: Your WaPay WABA (647978251504290)
3. Click: **"Create Template"**

### **Template Details**:
- **Name**: `onboarding_continue`
- **Category**: UTILITY
- **Language**: English

### **Header**: (None)

### **Body**:
```
Hi {{1}}! 👋

Welcome to WaPay - your digital wallet on WhatsApp.

What you can do:
💰 Redeem vouchers instantly
📱 Buy airtime for any network  
📶 Purchase data bundles
💸 Send money to friends

Ready to get started?
```

### **Footer**: (None)

### **Buttons**:
- Type: **Quick Reply**
- Button 1 Text: `Let's Go!`
- Button 2 Text: `Learn More`

### **Sample**:
- {{1}}: `John`

---

## 📱 **Template 3: account_ready**

### **Template Details**:
- **Name**: `account_ready`
- **Category**: UTILITY
- **Language**: English

### **Header**: (None)

### **Body**:
```
🎉 All set, {{1}}!

Your WaPay account is ready.

💰 Current Balance: R {{2}}

What would you like to do first?
```

### **Footer**: `Powered by WaPay`

### **Buttons**:
- Type: **Quick Reply**
- Button 1 Text: `Redeem Voucher`
- Button 2 Text: `Check Balance`  
- Button 3 Text: `Help`

### **Sample**:
- {{1}}: `John`
- {{2}}: `0.00`

---

## 📱 **Template 4: help_menu**

### **Template Details**:
- **Name**: `help_menu`
- **Category**: UTILITY
- **Language**: English

### **Header**: `📋 WaPay Help`

### **Body**:
```
Hi {{1}}! I can help you with:

Just ask me in your own words, like:
"How do I redeem a voucher?"
"Buy R50 airtime"
"What's my balance?"

I speak all South African languages! 🇿🇦
```

### **Footer**: (None)

### **Buttons**:
- Type: **Quick Reply**
- Button 1 Text: `Redeem Voucher`
- Button 2 Text: `Buy Airtime`
- Button 3 Text: `Check Balance`

### **Sample**:
- {{1}}: `John`

---

## 🔄 **Template Flow**

```
User: "Hi" 
  ↓
Bot: welcome_new_user ✅ (already exists)
  ↓
User: Clicks any button or replies
  ↓
Bot: onboarding_continue (with buttons)
  ↓
User: Clicks "Let's Go!"
  ↓
Bot: account_ready (with action buttons)
  ↓
User: Can now use all features!
```

---

## ⚡ **Quick Action**

**Create these 3 templates now**:
1. `onboarding_continue`
2. `account_ready`  
3. `help_menu`

**Timeline**:
- Submit: 15 minutes
- Approval: 1-3 days
- Deploy: Instant once approved

---

## 🎯 **After Approval**

Once templates are approved, I'll update the code to:
1. Use proper button-driven flows
2. Handle button clicks (not just text)
3. Sequence templates correctly

**For now**: The text fallbacks work, but buttons make it much more professional! 🚀


