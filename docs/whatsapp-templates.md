# WhatsApp Message Templates

This document lists all WhatsApp message templates that need to be registered in Meta Business Manager for WaPay.

## Template Registration

All templates must be registered and approved by Meta before they can be used. Register them at:
https://business.facebook.com/wa/manage/message-templates/

## Template Definitions

### 1. `redeem_in_progress`
**Category:** UTILITY  
**Language:** English (en)

**Body:**
```
We're processing your voucher redemption. This may take a few moments...
```

---

### 2. `deposit_receipt`
**Category:** UTILITY  
**Language:** English (en)

**Body:**
```
✅ Deposit successful!

Amount: {{1}}
Reference: {{2}}

Your WaPay balance has been updated.
```

**Parameters:**
1. Currency (amount in ZAR)
2. Text (transaction reference)

---

### 3. `deposit_failed`
**Category:** UTILITY  
**Language:** English (en)

**Body:**
```
❌ Deposit failed

Reason: {{1}}

Please try again or contact support if the problem persists.
```

**Parameters:**
1. Text (failure reason)

---

### 4. `topup_collect_number`
**Category:** UTILITY  
**Language:** English (en)

**Body:**
```
📱 Please reply with the phone number you'd like to top up.

Format: 0821234567
```

---

### 5. `airtime_select_amount`
**Category:** UTILITY  
**Language:** English (en)

**Body:**
```
How much airtime would you like to purchase?

Reply with an amount (e.g., 10, 20, 50, 100)
```

---

### 6. `airtime_preview_confirm`
**Category:** UTILITY  
**Language:** English (en)

**Body:**
```
📱 Airtime Purchase Preview

Amount: {{1}}
Number: {{2}}
Network: {{3}}

Reply YES to confirm or NO to cancel.
```

**Parameters:**
1. Currency (amount in ZAR)
2. Text (phone number)
3. Text (network name)

---

### 7. `airtime_receipt`
**Category:** UTILITY  
**Language:** English (en)

**Body:**
```
✅ Airtime purchase successful!

Amount: {{1}}
Number: {{2}}
Network: {{3}}

Your airtime should arrive within a few minutes.
```

**Parameters:**
1. Currency (amount in ZAR)
2. Text (phone number)
3. Text (network name)

---

### 8. `data_select_bundle`
**Category:** UTILITY  
**Language:** English (en)

**Body:**
```
📊 Available Data Bundles

Reply with the bundle number:
1. 1GB - R29
2. 2GB - R49
3. 5GB - R99
4. 10GB - R149
```

---

### 9. `data_preview_confirm`
**Category:** UTILITY  
**Language:** English (en)

**Body:**
```
📊 Data Bundle Preview

Bundle: {{1}}
Number: {{2}}
Network: {{3}}

Reply YES to confirm or NO to cancel.
```

**Parameters:**
1. Text (bundle description)
2. Text (phone number)
3. Text (network name)

---

### 10. `data_receipt`
**Category:** UTILITY  
**Language:** English (en)

**Body:**
```
✅ Data bundle purchase successful!

Bundle: {{1}}
Number: {{2}}
Network: {{3}}

Your data should be active within a few minutes.
```

**Parameters:**
1. Text (bundle description)
2. Text (phone number)
3. Text (network name)

---

## Template Naming Convention

All templates follow the pattern: `{action}_{context}`

- `redeem_*` - Voucher redemption flow
- `deposit_*` - Deposit confirmations
- `topup_*` - Top-up collection flows
- `airtime_*` - Airtime purchase flow
- `data_*` - Data bundle purchase flow

## Template Governance

⚠️ **Important:** WhatsApp templates cannot be changed once approved. Any modifications require submitting a new template for approval, which can take 24-48 hours.

### Best Practices:
1. Test template content thoroughly before submission
2. Use generic placeholders that work for all scenarios
3. Keep messages concise and clear
4. Include clear call-to-actions
5. Use emojis sparingly and appropriately
6. Ensure compliance with WhatsApp Business Policy

## Testing

Before production use:
1. Register all templates in Meta Business Manager
2. Wait for approval (usually 24-48 hours)
3. Test each template with real WhatsApp numbers
4. Verify parameter substitution works correctly
5. Check message formatting on different devices

## Usage in Code

```typescript
import { WhatsAppClient, Templates } from '@wapay/whatsapp';

const client = new WhatsAppClient({
  accessToken: process.env.META_WHATSAPP_TOKEN,
  phoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID,
});

// Send deposit receipt
await client.sendTemplate(
  Templates.depositReceipt(
    '+27821234567',
    10000, // R100.00 in cents
    'BLU-REF-123456'
  )
);
```

## Support

For template approval issues, contact Meta Business Support:
https://business.facebook.com/business/help

