# 🚨 CRITICAL: Database Connection Still Failing

## The Problem

You're still getting: **"Tenant or user not found"**

This means your DATABASE_URL in Vercel is **still incorrect**.

## 🎯 The Most Common Issue

Your connection string is probably missing the **project reference** in the username.

### ❌ WRONG Format (What you probably have):
```
postgresql://postgres:password@aws-1-eu-north-1.pooler.supabase.com:6543/postgres
```

### ✅ CORRECT Format (What you need):
```
postgresql://postgres.abcdefghijklmnop:password@aws-1-eu-north-1.pooler.supabase.com:6543/postgres
```

**Notice:** `postgres.abcdefghijklmnop` instead of just `postgres`

## 📋 Step-by-Step Fix

### Step 1: Get YOUR Exact Connection String from Supabase

**DO NOT type it manually!** Copy it from Supabase:

1. Open your browser and go to:
   ```
   https://supabase.com/dashboard/projects
   ```

2. Click on your **WaPay** project (or whatever you named it)

3. In the left sidebar, click: **Settings** (gear icon)

4. Click: **Database**

5. Scroll down to the section: **"Connection string"**

6. You'll see several tabs: **URI**, **JDBC**, etc.
   - Click the **URI** tab

7. **IMPORTANT:** Look for a dropdown that says either:
   - "Direct connection" 
   - "Connection pooling"
   
   **SELECT "Connection pooling"** (Mode: Session)

8. You should now see a connection string like:
   ```
   postgresql://postgres.[YOUR-PROJECT-REF]:[YOUR-PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true...
   ```

9. **Click the "Copy" button** (don't type it!)

10. If it shows `[YOUR-PASSWORD]`, replace that part with your actual database password

### Step 2: Test Locally FIRST

Before updating Vercel, test that it works locally:

```bash
# Go to your project
cd "/Users/nieuwoudtgresse/Desktop/WaPay /WaPay V1.01"

# Set the DATABASE_URL (paste the one you copied from Supabase)
export DATABASE_URL="postgresql://postgres.xxxxx:yourpass@aws-0-region.pooler.supabase.com:6543/postgres"

# Run the test script
node test-database-connection.js
```

If you see ✅ success messages, the connection string is correct!

### Step 3: Update Vercel

Only after the local test succeeds:

1. Go to: https://vercel.com/dashboard
2. Click your WaPay project
3. Click: **Settings** → **Environment Variables**
4. Find: **DATABASE_URL**
5. Click: **Edit**
6. **Paste** the exact connection string that worked locally
7. Make sure it's set for: **All Environments**
8. Click: **Save**

### Step 4: Redeploy

1. Go to: **Deployments** tab
2. Click the three dots (...) on the latest deployment
3. Click: **Redeploy**
4. Wait 2-3 minutes
5. Test WhatsApp again

## 🔍 If You Don't Remember Your Supabase Password

If you can't find your database password:

1. Go to Supabase Dashboard → Your Project
2. Settings → Database
3. Click: **"Reset database password"**
4. Save the new password somewhere safe
5. Use it in your connection string
6. Update in Vercel

## 🆘 Alternative: Create New Supabase Project

If your project is lost or you can't access it:

```bash
# 1. Create a new Supabase project at supabase.com
# 2. Save the database password!
# 3. Get the connection pooling URL
# 4. Run migrations:

cd "/Users/nieuwoudtgresse/Desktop/WaPay /WaPay V1.01"
export DATABASE_URL="your-new-connection-string"
pnpm --filter @wapay/domain exec prisma migrate deploy

# 5. Update in Vercel
# 6. Redeploy
```

## ✅ When It's Fixed

You'll know it works when you see in Vercel logs:
```
✅ Templates initialized successfully
👤 Creating new user for: 27...
✅ New user created
```

Instead of:
```
❌ Failed to initialize templates: Tenant or user not found
```

## Need Help?

Run the test script and share the output:
```bash
cd "/Users/nieuwoudtgresse/Desktop/WaPay /WaPay V1.01"
export DATABASE_URL="your-connection-string"
node test-database-connection.js
```

This will tell you exactly what's wrong with your connection string.


