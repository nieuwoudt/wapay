# 🔍 Debug: Welcome Template Not Sending

## The Issue

New users are getting **plain text** instead of the **welcome template with button**.

**Expected:**
- Welcome template (`onboarding_step_1`) with "Open My WaPay Account Now" button

**Actual:**
- Plain text: "Hi Nieuwoudt! 👋 Ready to get started?..."

## What This Means

The code is sending the template, but it's **failing silently** and using the text fallback.

From the code in `packages/auth/src/onboarding.ts`:
```typescript
const result = await sendWhatsAppTemplate({
  to: waId,
  templateName: 'onboarding_step_1',
  ...
});

if (!result.ok) {
  console.error('❌ Failed to send welcome template:', result.error);
  
  // Fallback to text message (THIS IS WHAT'S HAPPENING)
  await sendWhatsAppText({
    to: waId,
    text: `👋 Welcome to WaPay, ${displayName}!...`,
  });
}
```

## Possible Causes

### 1. Template Component Mismatch
The template in Meta might have different components than what the code is sending.

**Code sends:**
```typescript
components: [
  {
    type: 'body',
    parameters: [{ type: 'text', text: displayName }],
  },
]
```

**Meta template might have:**
- Button component
- Different parameter format
- Header component

### 2. Template Name Issue
- Template exists: ✅ `onboarding_step_1` (confirmed in logs)
- Template approved: ✅ APPROVED (confirmed in logs)
- But might have different structure than expected

### 3. New Token Permissions
The newly generated token might not have template sending permissions (only text messages).

## 🔧 How to Fix

### Option 1: Check Vercel Logs (RECOMMENDED)

Look for the actual error message:
1. Go to Vercel Dashboard
2. Click your deployment
3. Go to Functions
4. Find `/api/webhooks/whatsapp`
5. Look for: `❌ Failed to send welcome template:`
6. See the actual error

### Option 2: Check Template Structure in Meta

1. Go to: https://business.facebook.com/wa/manage/message-templates/
2. Find template: `onboarding_step_1`
3. Check if it has:
   - Body with {{1}} placeholder
   - Button component
   - Proper structure

### Option 3: Verify Template Matches Code

The template structure in Meta must match exactly what the code sends.

**If template has a BUTTON**, the code needs to send button component:
```typescript
components: [
  {
    type: 'body',
    parameters: [{ type: 'text', text: displayName }],
  },
  {
    type: 'button',
    sub_type: 'quick_reply',
    index: 0,
    parameters: [
      { type: 'payload', payload: 'continue' }
    ]
  }
]
```

**If template has only BODY**, the current code is correct.

### Option 4: Test Template Directly

Test if the template works at all:

```bash
curl -X POST "https://graph.facebook.com/v21.0/870272072828461/messages" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messaging_product": "whatsapp",
    "to": "27787051175",
    "type": "template",
    "template": {
      "name": "onboarding_step_1",
      "language": { "code": "en" },
      "components": [
        {
          "type": "body",
          "parameters": [
            { "type": "text", "text": "Nieuwoudt" }
          ]
        }
      ]
    }
  }'
```

If this works, the issue is in the code.
If this fails, the issue is with Meta/template.

## 🚀 Quick Fix

For now, let's make the text fallback better until we fix the template:

Update the fallback to include better onboarding instructions and make it clear what to do next.

## Next Steps

1. **Check Vercel logs** - Get the actual error message
2. **Inspect template in Meta** - Verify structure matches code
3. **Test template with curl** - Verify it works at all
4. **Share error message** - So we can fix the exact issue

The template exists and is approved, so it's likely a structure/component mismatch between Meta and the code.

