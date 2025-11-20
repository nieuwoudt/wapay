# ⚡ Quick Deploy Guide - WaPay MVP

**Goal**: Get WaPay live in 15 minutes

---

## 🚀 **3-Step Deployment**

### **Step 1: OpenAI API Key** (5 minutes)

1. Go to: https://platform.openai.com
2. Sign up or log in
3. Click: "API Keys" in left sidebar
4. Click: "Create new secret key"
5. Name it: "WaPay Production"
6. Copy the key (starts with `sk-proj-...`)
7. **Save it somewhere safe!** (you can't see it again)

### **Step 2: Add to Vercel** (3 minutes)

1. Go to: https://vercel.com/finfy-ai/wapay-api/settings/environment-variables
2. Click: "Add New"
3. Key: `OPENAI_API_KEY`
4. Value: Paste your OpenAI key
5. Select: Production, Preview, Development
6. Click: "Save"

### **Step 3: Database Migration** (3 minutes)

**Option A - Supabase SQL Editor** (Easiest):
1. Go to: https://supabase.com/dashboard
2. Select your project
3. Click: "SQL Editor"
4. Click: "New Query"
5. Paste this SQL:

```sql
ALTER TABLE "Account" 
  ADD COLUMN IF NOT EXISTS "onboardingStatus" TEXT NOT NULL DEFAULT 'NEW',
  ADD COLUMN IF NOT EXISTS "conversationState" TEXT,
  ADD COLUMN IF NOT EXISTS "conversationData" JSONB;
```

6. Click: "Run" (bottom right)
7. Should see: "Success. No rows returned"

**Option B - Using Prisma**:
```bash
cd "/Users/nieuwoudtgresse/Desktop/WaPay /WaPay V1.01/packages/domain"
DATABASE_URL="your-supabase-url" npx prisma migrate deploy
```

---

## 📦 **Deploy Code** (2 minutes)

```bash
cd "/Users/nieuwoudtgresse/Desktop/WaPay /WaPay V1.01"

git add .
git commit -m "feat: MVP complete - Onboarding, Voucher, Balance, AI Chat"
git push origin main
```

Vercel will automatically deploy! ✅

---

## 🧪 **Test** (5 minutes)

### **Test 1: Onboarding**
```
1. Send "Hi" from new WhatsApp number
2. Should get: Welcome message
3. Reply: "continue"
4. Should get: Onboarding + Account created
```

### **Test 2: Voucher** (if you have one)
```
1. Send: "redeem voucher"
2. Enter: 16-digit PIN
3. Should get: Success message with balance
```

### **Test 3: Balance**
```
1. Send: "balance"
2. Should get: Current balance
```

### **Test 4: AI Chat**
```
1. Send: "How does WaPay work?"
2. Should get: AI explanation
3. Send: "Hoe werk WaPay?" (Afrikaans)
4. Should get: AI response in Afrikaans
```

---

## ✅ **Success!**

If all tests pass, you're **LIVE**! 🎉

---

## 🐛 **Troubleshooting**

### **AI not responding?**
- Check OpenAI key is set in Vercel
- Redeploy if needed: `git commit --allow-empty -m "redeploy" && git push`

### **Database error?**
- Verify migration ran successfully
- Check DATABASE_URL is correct

### **Voucher redemption fails?**
- Verify Blu credentials are set
- Check Blu service status

---

## 📊 **Monitor**

View logs in Vercel:
```
vercel logs --follow
```

Or visit: https://vercel.com/finfy-ai/wapay-api/logs

---

**That's it! You're live in 15 minutes!** 🚀






