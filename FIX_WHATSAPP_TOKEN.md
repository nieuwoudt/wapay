# 🔧 Fix WhatsApp Access Token Permission Error

## The Error

```
(#10) Application does not have permission for this action
OAuthException: There was a problem with the access token or permissions
```

This means your current access token either:
1. **Expired** (temporary tokens last 24 hours)
2. **Missing permissions** (doesn't have message sending rights)
3. **Wrong token type** (need System User token for production)

## 🚀 Quick Fix: Generate New Token

### Step 1: Go to Meta Developer Console

1. Open: https://developers.facebook.com/apps/
2. Select your WhatsApp app
3. Go to: **WhatsApp → API Setup** (left sidebar)

### Step 2: Generate Temporary Token (Testing - 24 hours)

On the API Setup page:
1. Find the section: **"Temporary access token"**
2. Click **"Generate Token"**
3. **Copy the new token** (it will be very long, starting with `EAAT...`)
4. This token lasts **24 hours** - good for testing

### Step 3: Update Token in Vercel

1. Go to: https://vercel.com/dashboard
2. Click your **WaPay project**
3. Go to: **Settings → Environment Variables**
4. Find: `WHATSAPP_ACCESS_TOKEN`
5. Click: **Edit**
6. **Paste the new token**
7. Make sure it's set for: **All Environments**
8. Click: **Save**

### Step 4: Redeploy

1. Go to: **Deployments** tab
2. Click **"..."** on latest deployment
3. Click: **"Redeploy"**
4. Wait 2-3 minutes

### Step 5: Test

Send a WhatsApp message - it should work now!

---

## 🏢 Production Fix: Create System User Token (Permanent)

For production, you need a **permanent token** that doesn't expire:

### Step 1: Create System User

1. Go to: https://business.facebook.com/settings/system-users
2. Click: **"Add"** (Create System User)
3. Name: `WaPay System User`
4. Role: **Admin**
5. Click: **"Create System User"**

### Step 2: Assign WhatsApp App

1. Click on the System User you just created
2. Click: **"Add Assets"**
3. Select: **"Apps"**
4. Find your WhatsApp app
5. Toggle: **"Manage app"** = ON
6. Click: **"Save Changes"**

### Step 3: Generate Permanent Token

1. Still on System User page
2. Click: **"Generate New Token"**
3. Select your **WhatsApp App**
4. Under permissions, select:
   - ✅ `whatsapp_business_messaging`
   - ✅ `whatsapp_business_management`
5. Token duration: **Never Expires** (60 days, but can be refreshed)
6. Click: **"Generate Token"**
7. **COPY AND SAVE THIS TOKEN SECURELY** (you won't see it again!)

### Step 4: Update in Vercel

Same as above - update `WHATSAPP_ACCESS_TOKEN` with the new permanent token.

---

## 🔍 Verify Your Current Token

To check if your token is valid, run:

```bash
# Replace YOUR_TOKEN with your actual token
curl -X GET "https://graph.facebook.com/v21.0/me?access_token=YOUR_TOKEN"
```

If you get an error, the token is invalid/expired.

---

## ✅ Quick Checklist

Current token in Vercel: `WHATSAPP_ACCESS_TOKEN`

Check:
- [ ] Token starts with `EAAT...`
- [ ] Token is recent (generated in last 24 hours if temporary)
- [ ] Token has `whatsapp_business_messaging` permission
- [ ] Token hasn't expired

---

## 🆘 Still Not Working?

If after generating a new token it still fails:

1. **Verify Phone Number:** Make sure your WhatsApp Business phone number is verified in Meta
2. **Check Business Verification:** Your WhatsApp Business Account might need verification
3. **Review App Status:** Make sure your app is not in "Development Mode" restrictions
4. **Test with Curl:** Verify token works with direct API call

### Test with Curl:

```bash
curl -X POST "https://graph.facebook.com/v21.0/870272072828461/messages" \
  -H "Authorization: Bearer YOUR_NEW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messaging_product": "whatsapp",
    "to": "27787051175",
    "type": "text",
    "text": {
      "body": "Test message from WaPay"
    }
  }'
```

If this works, the token is good! Update it in Vercel.

---

## 📝 Summary

**Quick Fix (24 hours):**
1. Generate temporary token from Meta Developer Console
2. Update `WHATSAPP_ACCESS_TOKEN` in Vercel
3. Redeploy

**Permanent Fix:**
1. Create System User in Meta Business
2. Generate permanent token with proper permissions
3. Update in Vercel
4. Never expires (or lasts 60 days, refreshable)

After updating the token, WaPay will work perfectly! 🚀


