# 🔧 Your Correct DATABASE_URL

Based on your Supabase connection string and the database password (Supabase → Project Settings → Database, or Vercel). The password is never written in this repository.

## Format from Supabase:
```
postgres://postgres:[YOUR-PASSWORD]@db.lqkpshowocitirxrmgpy.supabase.co:6543/postgres
```

## URL-Encoded Version:
If your password has `@` in it, it needs to be URL-encoded for the connection string:
- `@` becomes `%40`

## Your Complete DATABASE_URL:

```
postgres://postgres:[YOUR-PASSWORD]@db.lqkpshowocitirxrmgpy.supabase.co:6543/postgres
```

## Test It Now:

```bash
cd "/Users/nieuwoudtgresse/Desktop/WaPay /WaPay V1.01"

export DATABASE_URL="postgres://postgres:[YOUR-PASSWORD]@db.lqkpshowocitirxrmgpy.supabase.co:6543/postgres"
node test-database-connection.js
```

## Once It Works:

1. Copy the exact connection string that worked
2. Go to Vercel Dashboard
3. Settings → Environment Variables
4. Edit `DATABASE_URL`
5. Paste the working connection string
6. Save
7. Redeploy

Your DATABASE_URL should now work! 🚀


