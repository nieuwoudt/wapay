# 🔧 Your Correct DATABASE_URL

Based on your Supabase connection string and Vercel password:

## Format from Supabase:
```
postgres://postgres:[YOUR-PASSWORD]@db.lqkpshowocitirxrmgpy.supabase.co:6543/postgres
```

## Your Password (from Vercel):
`Wapay@20250` (or possibly `Wapay@2025`)

## URL-Encoded Version:
Since your password has `@` in it, it needs to be URL-encoded for the connection string:
- `@` becomes `%40`
- So: `Wapay@20250` becomes `Wapay%4020250`

## Your Complete DATABASE_URL:

### Option 1 (most likely):
```
postgres://postgres:Wapay%4020250@db.lqkpshowocitirxrmgpy.supabase.co:6543/postgres
```

### Option 2 (if password is Wapay@2025):
```
postgres://postgres:Wapay%402025@db.lqkpshowocitirxrmgpy.supabase.co:6543/postgres
```

## Test It Now:

```bash
cd "/Users/nieuwoudtgresse/Desktop/WaPay /WaPay V1.01"

# Try option 1:
export DATABASE_URL="postgres://postgres:Wapay%4020250@db.lqkpshowocitirxrmgpy.supabase.co:6543/postgres"
node test-database-connection.js

# If that fails, try option 2:
export DATABASE_URL="postgres://postgres:Wapay%402025@db.lqkpshowocitirxrmgpy.supabase.co:6543/postgres"
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


