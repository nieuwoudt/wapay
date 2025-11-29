# Blu VAS Deployment Guide

This document covers environment configuration, deployment procedures, and operational considerations for the Blu VAS integration.

## Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `BLU_BASE_URL` | Blu API base URL | `https://api.bluvoucher.co.za` |
| `BLU_BASIC_USER` | Basic auth username | `wapay-prod` |
| `BLU_BASIC_PASS` | Basic auth password | `********` |
| `BLU_TRADE_API_KEY` | Shared API key for all Blu Trade API endpoints (Voucher + VAS) | `e73d6237-0864-...` |

> **Note**: `BLU_TRADE_API_KEY` is the single shared API key for both Blu Voucher redemption and Blu VAS (airtime/data). They use the same Aeon RESTful BLT Trade API. For backward compatibility, `BLU_API_KEY` is also supported.

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BLU_TIMEOUT_MS` | Request timeout | `60000` |
| `BLU_RETRY_ATTEMPTS` | Max retry attempts | `3` |
| `SENTRY_DSN` | Sentry error tracking | - |

### Environment-Specific Configuration

#### QA Environment

```bash
BLU_BASE_URL=https://qa-api.bluvoucher.co.za
BLU_BASIC_USER=wapay-qa
BLU_BASIC_PASS=qa-password
BLU_TRADE_API_KEY=qa-api-key
```

#### Production Environment

```bash
BLU_BASE_URL=https://api.bluvoucher.co.za
BLU_BASIC_USER=wapay-prod
BLU_BASIC_PASS=prod-password
BLU_TRADE_API_KEY=prod-api-key
```

---

## Vercel Deployment

### Setting Environment Variables

```bash
# Via Vercel CLI
vercel env add BLU_BASE_URL production
vercel env add BLU_BASIC_USER production
vercel env add BLU_BASIC_PASS production
vercel env add BLU_API_KEY production

# Or via Vercel Dashboard:
# Project Settings → Environment Variables
```

### Deploying

```bash
# Deploy to production
vercel --prod

# Deploy to preview (uses QA credentials)
vercel
```

### Vercel Function Configuration

In `vercel.json`:

```json
{
  "functions": {
    "pages/api/vas/**/*.js": {
      "maxDuration": 30,
      "memory": 1024
    }
  }
}
```

---

## Network & Firewall

### Blu API IP Whitelisting

Blu may require IP whitelisting for production access.

**Vercel IP Ranges**: Vercel uses dynamic IPs. Options:
1. Request Blu to allow all Vercel IPs (not recommended)
2. Use a proxy/API gateway with static IPs
3. Use Vercel Edge Functions with dedicated IPs (Enterprise)

**Static IP Proxy Option**:
```
WaPay → Static IP Proxy → Blu API
```

### Outbound Connections

Ensure these domains are accessible:

| Domain | Port | Purpose |
|--------|------|---------|
| `api.bluvoucher.co.za` | 443 | Production API |
| `qa-api.bluvoucher.co.za` | 443 | QA API |

---

## Switching Environments

### Method 1: Environment Variables

```bash
# Development (pointing to QA)
export BLU_BASE_URL=https://qa-api.bluvoucher.co.za

# Production
export BLU_BASE_URL=https://api.bluvoucher.co.za
```

### Method 2: Vercel Environment Scoping

```bash
# Set for specific environment
vercel env add BLU_BASE_URL development
vercel env add BLU_BASE_URL preview
vercel env add BLU_BASE_URL production
```

### Method 3: `.env.local` Override

```bash
# .env.local (gitignored)
BLU_BASE_URL=https://qa-api.bluvoucher.co.za
```

---

## Pre-Deployment Checklist

### Before QA Deployment

- [ ] QA credentials obtained from Blu
- [ ] Test numbers documented
- [ ] Environment variables set
- [ ] Database migrated
- [ ] VasProduct table seeded

### Before Production Deployment

- [ ] Production credentials obtained from Blu
- [ ] IP whitelisting confirmed (if required)
- [ ] Rate limits agreed with Blu
- [ ] Monitoring configured
- [ ] Runbook documented
- [ ] Rollback plan prepared

---

## Database Setup

### Migrations

```bash
# Generate migration
cd packages/domain
npx prisma migrate dev --name add_vas_support

# Apply to production
npx prisma migrate deploy
```

### Seed VAS Products

```bash
# Run seed script
node packages/domain/scripts/seed-vas-products.cjs
```

### Verify Schema

```sql
-- Check VasProduct table exists
SELECT * FROM "VasProduct" LIMIT 5;

-- Check indexes
SELECT indexname FROM pg_indexes WHERE tablename = 'VasProduct';
```

---

## Monitoring Setup

### Sentry Integration

```bash
# Add Sentry DSN
vercel env add SENTRY_DSN production
```

```typescript
// In API routes
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1, // 10% of transactions
});
```

### Custom Metrics

Metrics are logged in this format:
```json
{"metric":"vas.airtime.success","value":1,"tags":{"vendorId":"vodacom"},"timestamp":"..."}
```

For structured log aggregation:
- **Vercel**: Use Log Drains to forward to Datadog/etc.
- **Self-hosted**: Configure logging to stdout for container collection

### Alerts to Configure

| Alert | Threshold | Action |
|-------|-----------|--------|
| VAS failure rate | >5% in 5min | Page on-call |
| Blu latency | >10s avg | Notify team |
| Auth errors spike | >10 in 1min | Check credentials |
| Rate limit errors | Any | Reduce traffic |

---

## Rollback Procedures

### Immediate Rollback

```bash
# Via Vercel CLI
vercel rollback

# Or promote previous deployment in dashboard
```

### Database Rollback

If schema changes caused issues:

```bash
# Revert migration (if possible)
npx prisma migrate resolve --rolled-back <migration_name>

# Or restore from backup
pg_restore -d wapay_production backup.dump
```

### Feature Flag Rollback

If VAS feature needs to be disabled:

```typescript
// Add to execute handlers
if (process.env.DISABLE_VAS === 'true') {
  return res.status(503).json({
    error: 'SERVICE_UNAVAILABLE',
    message: 'VAS purchases are temporarily unavailable'
  });
}
```

---

## Performance Optimization

### Timeout Configuration

```typescript
// BluVasClient constructor
const TIMEOUT_MS = parseInt(process.env.BLU_TIMEOUT_MS || '60000');

// In requests
await request(url, {
  bodyTimeout: TIMEOUT_MS,
  headersTimeout: TIMEOUT_MS,
});
```

### Connection Pooling

```typescript
// Reuse client instance
let bluClientInstance: BluVasClient | null = null;

function getBluClient() {
  if (!bluClientInstance) {
    bluClientInstance = new BluVasClient();
  }
  return bluClientInstance;
}
```

### Bundle Caching

```typescript
// Cache bundles for 1 hour
const CACHE_TTL = 60 * 60 * 1000;
let bundleCache: Map<string, { data: any; expires: number }> = new Map();

async function getCachedBundles(vendorId: string) {
  const cached = bundleCache.get(vendorId);
  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }
  
  const data = await bluClient.getDataProducts(vendorId);
  bundleCache.set(vendorId, { data, expires: Date.now() + CACHE_TTL });
  return data;
}
```

---

## Security Considerations

### Credential Storage

- **Never** commit credentials to git
- Use Vercel encrypted environment variables
- Rotate credentials periodically

### PIN Handling

- PINs are **never** logged
- PIN verification uses Argon2id
- Failed attempts are rate-limited

### Audit Logging

All VAS transactions are logged:
- AccountId
- Amount
- Timestamp
- Success/failure
- Blu reference

---

## Support & Escalation

### Blu Support

- **Email**: support@bluvoucher.co.za
- **Phone**: (contact Blu for current number)
- **Portal**: https://portal.bluvoucher.co.za (if available)

### Internal Escalation

1. **L1**: Check logs, verify credentials, retry
2. **L2**: Contact Blu support, check for service disruption
3. **L3**: Engineering investigation

---

## Related Documentation

- [Blu VAS Catalogue](../providers/blu-vas-catalogue.md)
- [Blu VAS E2E Testing](../testing/blu-vas-e2e.md)
- [Blu VAS Runbook](../runbooks/blu-vas.md)

