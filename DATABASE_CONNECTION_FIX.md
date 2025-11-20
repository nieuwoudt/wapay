# 🚨 Database Connection Error - Fix Guide

## The Problem

Your WhatsApp integration is working perfectly, but the database connection is failing:

```
Error querying the database: FATAL: Tenant or user not found
```

**What's Working:**
- ✅ WhatsApp receiving messages
- ✅ Templates fetched from Meta (13 templates found)
- ✅ WhatsApp API credentials valid

**What's Broken:**
- ❌ Database connection (can't save user data, balances, etc.)

## Your Current DATABASE_URL

From your Vercel screenshot:
```
postgresql://postgres:Wapay%4020...
```

The error "Tenant or user not found" means one of these is wrong:
1. **Username** (`postgres`)
2. **Password** (`Wapay%4020...`)
3. **Host/Database** doesn't exist
4. **Connection pooler** settings

## Fix Options

### Option 1: Get the Correct DATABASE_URL from Supabase

If you're using Supabase (recommended):

1. Go to: https://supabase.com/dashboard
2. Select your WaPay project
3. Go to **Settings** → **Database**
4. Look for **Connection String** section
5. Select **Connection pooling** (for Vercel)
6. Copy the **URI** format (not the individual fields)
7. It should look like:
   ```
   postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres
   ```

### Option 2: Verify Your Database Exists

If you have a custom PostgreSQL database:

1. Check the database exists
2. Verify the username/password
3. Ensure the user has the correct permissions
4. Test connection locally first

## Steps to Fix in Vercel

### 1. Update DATABASE_URL in Vercel

```bash
# Go to your Vercel dashboard
# Navigate to: Settings → Environment Variables
# Find: DATABASE_URL
# Click Edit
# Replace with the CORRECT connection string from Supabase
```

**Important:** Make sure to:
- Use the **pooler** connection string (port 6543) for Vercel
- Set it for **All Environments** (Production, Preview, Development)
- Click "Save"

### 2. Redeploy

After updating the DATABASE_URL:
- Click "Deployments" tab
- Click "..." on the latest deployment
- Click "Redeploy"
- Wait 2-3 minutes

### 3. Test the Database Connection Locally

Before redeploying, test the connection string locally:

```bash
# Create .env.local with the new DATABASE_URL
echo 'DATABASE_URL="postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres"' > .env.local

# Test with Prisma
cd "/Users/nieuwoudtgresse/Desktop/WaPay /WaPay V1.01"
pnpm --filter @wapay/domain exec prisma db pull
```

If this works, your connection string is correct!

## Common DATABASE_URL Issues

### Issue 1: Using Direct Connection Instead of Pooler
❌ **Wrong:** `postgresql://postgres:pass@db.xxx.supabase.co:5432/postgres`
✅ **Correct:** `postgresql://postgres.xxx:pass@aws-0-region.pooler.supabase.com:6543/postgres`

Vercel needs the **pooler** (port 6543), not direct connection (port 5432).

### Issue 2: Password Not URL-Encoded
If your password has special characters like `@`, `#`, `%`, etc., they must be URL-encoded:
- `@` becomes `%40`
- `#` becomes `%23`
- `%` becomes `%25`

Example:
- Password: `MyP@ss#123`
- Encoded: `MyP%40ss%23123`

### Issue 3: Wrong Database Name
Make sure the database name at the end is correct:
- Usually: `/postgres` (default)
- Could be: `/wapay` or custom name

## Quick Test Script

Run this to test your DATABASE_URL locally:

```bash
cd "/Users/nieuwoudtgresse/Desktop/WaPay /WaPay V1.01"

# Test connection
node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.\$connect()
  .then(() => { console.log('✅ Database connected!'); process.exit(0); })
  .catch((e) => { console.error('❌ Connection failed:', e.message); process.exit(1); });
"
```

## Need Help Finding Your Supabase Credentials?

If you don't remember your Supabase project:

1. Check your email for Supabase welcome email
2. Or create a new Supabase project:
   - Go to https://supabase.com
   - Create new project
   - Save the database password!
   - Run migrations: `pnpm --filter @wapay/domain exec prisma migrate deploy`

## After Fixing

Once DATABASE_URL is correct:
1. ✅ Users can register
2. ✅ Wallets will be created
3. ✅ Balances will be tracked
4. ✅ Transactions will be recorded
5. ✅ Onboarding will complete

## Summary

**Next Step:** Update `DATABASE_URL` in Vercel with the correct connection string from Supabase (use the pooler URL with port 6543).


