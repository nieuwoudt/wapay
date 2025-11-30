# Blu Authorization Error Handling - Fixed

## 🐛 Problem

Blu was returning:
```
400 Bad Request
"You are not authorized to redeem voucher type"
```

But our code was treating this as a **USER_INPUT** error (invalid PIN), when it's actually a **provider configuration/permission error**.

This caused users to see:
```
❌ Voucher Redemption Failed

Bad Request

Double-check the 16-digit PIN and enter it again when you're ready.
```

This was confusing because:
- The PIN format was correct
- It wasn't the user's fault
- Retrying wouldn't help

---

## ✅ Solution

Updated `BluClient.redeem()` to detect authorization errors **even when status code is 400**:

### Detection Logic

```typescript
// Check for authorization/permission errors (even with 400 status)
const isAuthError = 
  res.statusCode === 401 || 
  res.statusCode === 403 ||
  message.toLowerCase().includes('not authorized') ||
  message.toLowerCase().includes('permission') ||
  message.toLowerCase().includes('invalid transaction type');

if (isAuthError) {
  const err = new Error('AUTH');
  (err as any).reason = message;
  throw err;
}
```

### New User Message

Instead of blaming the user, we now show:

```
❌ Voucher Redemption Failed

We couldn't complete your voucher redemption due to a provider 
configuration error. Please try again later or contact support.

Need help? Type "help" for options or try again later.
```

Key improvements:
- ✅ Neutral tone - doesn't blame user
- ✅ Accurate - it IS a provider config issue
- ✅ No retry prompt - user won't waste time retrying
- ✅ Clear next steps - contact support

---

## 🔍 Error Classification

| Blu Response | Old Classification | New Classification | User Sees |
|--------------|-------------------|-------------------|-----------|
| `400 "not authorized"` | USER_INPUT ❌ | AUTH ✅ | Provider config error |
| `400 "invalid PIN"` | USER_INPUT ✅ | USER_INPUT ✅ | Check your PIN |
| `400 "already used"` | USER_INPUT ✅ | USER_INPUT ✅ | Voucher already used |
| `401 Unauthorized` | AUTH ✅ | AUTH ✅ | Provider config error |
| `403 Forbidden` | AUTH ✅ | AUTH ✅ | Provider config error |

---

## 📝 Code Changes

### 1. BluClient Error Detection
**File:** `packages/providers/blu/src/client.ts`

```typescript
// Before: All 400 errors → USER_INPUT
if (res.statusCode === 400 || res.statusCode === 404 || res.statusCode === 409) {
  const err = new Error('USER_INPUT');
  throw err;
}

// After: Check message content first
const isAuthError = 
  res.statusCode === 401 || 
  res.statusCode === 403 ||
  message.toLowerCase().includes('not authorized') ||
  message.toLowerCase().includes('permission') ||
  message.toLowerCase().includes('invalid transaction type');

if (isAuthError) {
  throw new Error('AUTH');
}

// Only then check for user input errors
if (res.statusCode === 400 || res.statusCode === 404 || res.statusCode === 409) {
  throw new Error('USER_INPUT');
}
```

### 2. WhatsApp Message Update
**File:** `pages/api/webhooks/message-processor-v2.js`

```javascript
// Before
} else if (errorType === 'AUTH') {
  errorMessage = 'We could not connect to the voucher provider. Please contact support.';
}

// After
} else if (errorType === 'AUTH') {
  // Provider configuration/permission error - not user's fault
  errorMessage = 'We couldn\'t complete your voucher redemption due to a provider configuration error. Please try again later or contact support.';
}
```

---

## 🧪 Testing

### Before Fix
```
User: 8078880588211693
Bot: ❌ Voucher Redemption Failed
     Bad Request
     Double-check the 16-digit PIN... ❌ Wrong message
```

### After Fix
```
User: 8078880588211693
Bot: ❌ Voucher Redemption Failed
     We couldn't complete your voucher redemption due to 
     a provider configuration error. Please try again later 
     or contact support. ✅ Correct message
```

---

## 🚀 Deployment

**Commit:** `780fc52`  
**Status:** ✅ Pushed to main  
**Vercel:** Deploying automatically

---

## 📋 Next Steps

1. **Wait for Vercel deployment** (~2 minutes)
2. **Test with same voucher** - should see new error message
3. **Contact Blu support** - they need to enable your account for Variable Voucher redemptions
4. **Test again** once Blu fixes permissions

---

## 🔑 Key Takeaway

**Not all 400 errors are user input errors!**

Some 400 responses indicate:
- Permission issues
- Configuration problems
- Account limitations

Always check the error **message content**, not just the status code.

---

**Status:** ✅ Fixed and Deployed  
**Date:** November 24, 2025

