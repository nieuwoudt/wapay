# 🗄️ WaPay Database Setup Guide

## Step 1: Get Your Supabase Connection String

### Option A: Use Supabase Dashboard

1. Go to: https://supabase.com/dashboard/project/ibczmxhgvrmjzijwonwd
2. Click **"Project Settings"** (gear icon, bottom left)
3. Click **"Database"** in the left sidebar
4. Scroll to **"Connection string"**
5. Select **"URI"** tab
6. Copy the **connection pooling** string (port 6543)
7. It should look like:
   ```
   postgresql://postgres.ibczmxhgvrmjzijwonwd:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
   ```

### Option B: Direct Connection (For Migrations)

Use port **5432** for migrations:
```
postgresql://postgres:[YOUR-PASSWORD]@db.lqkpshowocitirxrmgpy.supabase.co:5432/postgres
```

Your password: `Wapay@202508`

---

## Step 2: Apply the Migration

### Method 1: Using Supabase SQL Editor (EASIEST) ⭐

1. Go to: https://supabase.com/dashboard/project/ibczmxhgvrmjzijwonwd/sql/new
2. Copy the entire contents of: `packages/domain/prisma/migrations/000_init/migration.sql`
3. Paste into the SQL Editor
4. Click **"Run"**
5. You should see: "Success. X rows affected"

### Method 2: Using Prisma CLI

```bash
cd packages/domain
export DATABASE_URL="postgresql://postgres:Wapay@202508@db.lqkpshowocitirxrmgpy.supabase.co:5432/postgres"
pnpm prisma migrate deploy
```

---

## Step 3: Verify Tables Created

Go to: https://supabase.com/dashboard/project/ibczmxhgvrmjzijwonwd/editor

You should see these tables:
- ✅ Account
- ✅ Wallet
- ✅ JournalEntry
- ✅ JournalLine
- ✅ ProviderRequest
- ✅ AuthSession
- ✅ Limit
- ✅ VasProduct
- ✅ YoyoInstrument

---

## Step 4: Generate Prisma Client

```bash
cd packages/domain
pnpm prisma generate
```

---

## Step 5: Set Environment Variable

### For Local Development:

Create `.env` in the repo root:
```bash
DATABASE_URL="postgresql://postgres.ibczmxhgvrmjzijwonwd:Wapay@202508@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
```

### For Vercel (Next Step):

Add to Vercel dashboard (we'll do this next!)

---

## ✅ Quick Test

Once migration is applied, test the connection:

```bash
cd packages/domain
pnpm prisma studio
```

This opens a GUI where you can see your tables!

---

## 🚨 Troubleshooting

### "Can't reach database server"
- ✅ Use Method 1 (SQL Editor) instead
- ✅ Check password has no typos
- ✅ Use port 5432 for migrations, 6543 for app

### "Relation already exists"
- ✅ Migration already applied! Skip to Step 3

### "Permission denied"
- ✅ Check Supabase project is active
- ✅ Verify password is correct

