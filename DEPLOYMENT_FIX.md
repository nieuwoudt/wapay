# 🚨 WaPay Not Responding - Fix Steps

## Issue Found
The code had environment variable mismatches that have been fixed. Now you need to redeploy.

## Your Correct WhatsApp Credentials
```
Access Token: IXhp2bUANrQJJNfIJsfDKjDFefhpeY76hJWJX745b51r6mWmSGLk0V3s4xNvpTZBkYuY8wiLWqeYmYB5
Phone Number ID: 870272072828461
Business Account ID: 647978251504290
```

## Step 1: Verify Vercel Environment Variables

Go to your Vercel dashboard and ensure these are set:

1. **META_WHATSAPP_TOKEN**
   - Value: `IXhp2bUANrQJJNfIJsfDKjDFefhpeY76hJWJX745b51r6mWmSGLk0V3s4xNvpTZBkYuY8wiLWqeYmYB5`
   - Environment: Production, Preview, Development

2. **META_WHATSAPP_PHONE_NUMBER_ID**
   - Value: `870272072828461`
   - Environment: Production, Preview, Development

3. **META_WHATSAPP_BUSINESS_ACCOUNT_ID**
   - Value: `647978251504290`
   - Environment: Production, Preview, Development

4. **META_WEBHOOK_VERIFY_TOKEN**
   - Value: `wapay_webhook_secret_2025`
   - Environment: Production, Preview, Development

## Step 2: Redeploy to Vercel

The code has been fixed to properly check for environment variables. Now redeploy:

### Option A: Using Vercel Dashboard
1. Go to your project in Vercel
2. Click "Deployments" tab
3. Click the three dots (...) on the latest deployment
4. Click "Redeploy"
5. Check "Use existing Build Cache" = OFF
6. Click "Redeploy"

### Option B: Using Git Push
```bash
git add .
git commit -m "Fix WhatsApp environment variable names"
git push origin main
```

Vercel will automatically deploy.

### Option C: Using Vercel CLI (if installed)
```bash
npm i -g vercel  # Install if needed
vercel --prod
```

## Step 3: Verify Webhook is Active

After deployment, check your webhook in Meta:

1. Go to: https://developers.facebook.com/apps/
2. Select your app
3. Go to WhatsApp → Configuration
4. Verify webhook URL is: `https://your-domain.vercel.app/api/webhooks/whatsapp`
5. Verify it shows a green checkmark ✅

## Step 4: Test

Send a test message to: **+27 76 049 7624**

Expected response: You should receive a welcome message or response within 2-3 seconds.

## What Was Fixed

1. ✅ Updated `packages/whatsapp/src/send.ts` to check both `META_WHATSAPP_TOKEN` and `WHATSAPP_ACCESS_TOKEN`
2. ✅ Updated `lib/initTemplates.js` to check both variable names
3. ✅ Updated `packages/whatsapp/src/seedTemplates.ts` for compatibility
4. ✅ Rebuilt the WhatsApp package

## Still Not Working?

If after redeploying it still doesn't work, check:

1. **Vercel Logs**
   - Go to Vercel Dashboard → Your Project → Deployments → Click latest → View Function Logs
   - Look for errors in `/api/webhooks/whatsapp`

2. **Meta Webhook Status**
   - Check if Meta is able to reach your webhook
   - Look for any error messages in Meta Developer Console

3. **Database Connection**
   - Verify `DATABASE_URL` is set in Vercel
   - Test database connectivity

## Need More Help?

Share the Vercel function logs for `/api/webhooks/whatsapp` after sending a test message.


