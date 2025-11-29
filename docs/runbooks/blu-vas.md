# Blu VAS Operational Runbook

This runbook provides procedures for operating, troubleshooting, and maintaining the Blu VAS integration.

## Quick Reference

| Metric | Normal | Warning | Critical |
|--------|--------|---------|----------|
| Success Rate | >98% | 95-98% | <95% |
| Latency (p50) | <2s | 2-5s | >5s |
| Latency (p99) | <10s | 10-20s | >20s |
| Error Rate | <1% | 1-3% | >3% |

---

## Common Scenarios

### Scenario 1: High Failure Rate

**Symptoms**:
- `vas.airtime.failure` metric spiking
- Customer complaints about failed purchases

**Diagnosis**:

```bash
# Check recent errors in logs
grep "VAS Airtime Error" /var/log/wapay/*.log | tail -50

# Check error distribution
grep "📊 METRIC.*vas.airtime.failure" /var/log/wapay/*.log | \
  jq -s 'group_by(.tags.errorType) | map({type: .[0].tags.errorType, count: length})'
```

**Resolution by Error Type**:

| Error Type | Cause | Action |
|------------|-------|--------|
| `USER_INPUT` | Invalid requests | Review NLP/validation |
| `AUTH` | Credential issue | Check env vars |
| `RETRYABLE` | Blu service issue | Wait, or contact Blu |

### Scenario 2: Authentication Failures

**Symptoms**:
- All requests returning `AUTH` error
- Blu returning 401/403

**Diagnosis**:

```bash
# Verify credentials are set
echo "BLU_BASE_URL: ${BLU_BASE_URL:-(not set)}"
echo "BLU_BASIC_USER: ${BLU_BASIC_USER:-(not set)}"
echo "BLU_API_KEY: ${BLU_API_KEY:0:8}..."

# Test connection manually
curl -v -u "$BLU_BASIC_USER:$BLU_BASIC_PASS" \
  -H "apikey: $BLU_API_KEY" \
  "$BLU_BASE_URL/health"
```

**Resolution**:

1. Verify credentials with Blu support
2. Check if credentials expired
3. Verify IP whitelisting (if applicable)
4. Update environment variables
5. Redeploy if needed

### Scenario 3: High Latency

**Symptoms**:
- `vas.airtime.blu_latency_ms` exceeding 10s
- Timeouts in logs

**Diagnosis**:

```bash
# Check latency distribution
grep "📊 METRIC.*blu_latency_ms" /var/log/wapay/*.log | \
  jq -s '[.[].value] | {min: min, max: max, avg: (add/length)}'

# Check for network issues
curl -o /dev/null -s -w "DNS: %{time_namelookup}s\nConnect: %{time_connect}s\nTLS: %{time_appconnect}s\nTotal: %{time_total}s\n" \
  "$BLU_BASE_URL/health"
```

**Resolution**:

1. Check Blu status page (if available)
2. Contact Blu support for service status
3. Consider increasing timeout temporarily
4. Enable request queuing if sustained

### Scenario 4: Duplicate Transactions

**Symptoms**:
- Customer charged twice
- Multiple ledger entries for same purchase

**Diagnosis**:

```sql
-- Find duplicate journal entries
SELECT "externalRef", COUNT(*), array_agg(id)
FROM "JournalEntry"
WHERE source LIKE 'VAS_%'
GROUP BY "externalRef"
HAVING COUNT(*) > 1;

-- Check ProviderRequest for same idemKey
SELECT * FROM "ProviderRequest"
WHERE "idemKey" = 'wapay-air-xxxxx-xxxxx'
ORDER BY "requestTs";
```

**Resolution**:

1. **If duplicate in WaPay only** (Blu has one transaction):
   - Reverse extra ledger entry
   - Credit customer wallet
   
2. **If duplicate in Blu** (should not happen with idempotency):
   - Contact Blu for reversal
   - Document incident

### Scenario 5: Unknown Outcome (Timeout)

**Symptoms**:
- Request timed out after 60s
- Blu may or may not have processed

**Diagnosis**:

```sql
-- Check if transaction exists
SELECT * FROM "ProviderRequest"
WHERE "idemKey" = 'wapay-air-xxxxx-xxxxx';

-- Check Blu reference if available
-- (May need to check Blu portal)
```

**Resolution**:

1. **Do NOT retry** - could cause duplicate
2. Check Blu portal for transaction status
3. If confirmed by Blu: update WaPay records
4. If not found in Blu: mark as failed, reverse ledger
5. If still unknown: wait for Blu settlement report

---

## Interpreting Blu Error Codes

### HTTP Status Codes

| Code | Meaning | WaPay Handling |
|------|---------|----------------|
| 200, 201 | Success | Process result |
| 400 | Bad request | USER_INPUT error |
| 401 | Unauthorized | AUTH error, check creds |
| 403 | Forbidden | AUTH error, check permissions |
| 404 | Not found | USER_INPUT error |
| 409 | Conflict | Duplicate/idempotent |
| 429 | Rate limited | RETRYABLE, backoff |
| 500 | Server error | RETRYABLE, retry |
| 502, 503 | Gateway/service unavailable | RETRYABLE, retry |

### Blu Error Messages

| Message Contains | Meaning | Action |
|-----------------|---------|--------|
| "Invalid mobile number" | Bad phone format | Check number normalization |
| "Vendor not found" | Wrong vendorId | Check network detection |
| "Insufficient balance" | Blu account low | Contact Blu |
| "Product not available" | Bundle discontinued | Refresh catalogue |
| "Duplicate request" | Same requestId used | Check idempotency |

---

## Reconciliation Procedures

### Daily Reconciliation

1. **Export WaPay Transactions**:
   ```sql
   SELECT 
     je."externalRef" as wapay_ref,
     pr."providerRef" as blu_ref,
     pr.status,
     SUM(jl."debitCents") as amount_cents,
     je."createdAt"
   FROM "JournalEntry" je
   JOIN "JournalLine" jl ON jl."entryId" = je.id
   LEFT JOIN "ProviderRequest" pr ON pr."idemKey" = je."externalRef"
   WHERE je.source LIKE 'VAS_%'
     AND je."createdAt" >= CURRENT_DATE - INTERVAL '1 day'
     AND je."createdAt" < CURRENT_DATE
   GROUP BY je."externalRef", pr."providerRef", pr.status, je."createdAt";
   ```

2. **Obtain Blu Settlement Report**:
   - Download from Blu portal (if available)
   - Or request from Blu support

3. **Compare Reports**:
   - Match by `providerRef` (Blu reference)
   - Flag any WaPay SUCCESS not in Blu
   - Flag any Blu transactions not in WaPay

4. **Resolve Discrepancies**:
   - Missing in Blu: Investigate timeout cases
   - Missing in WaPay: Check for failed webhook/response handling

### Monthly Reconciliation

Include:
- Total transaction count
- Total value
- Success/failure rates
- Average latency
- Disputed transactions

---

## Emergency Procedures

### Disable VAS Purchases

If critical issue requires immediate shutdown:

**Option 1: Environment Variable**
```bash
vercel env add DISABLE_VAS true production
vercel --prod
```

**Option 2: Code Change**
```typescript
// In execute handlers
export default async function handler(req, res) {
  return res.status(503).json({
    error: 'SERVICE_UNAVAILABLE',
    message: 'VAS purchases are temporarily unavailable. Please try again later.'
  });
}
```

**Option 3: Vercel Dashboard**
- Go to project → Settings → Environment Variables
- Add `DISABLE_VAS=true`
- Trigger redeploy

### Emergency Wallet Credits

If customers were incorrectly charged:

```sql
-- Create reversal journal entry
INSERT INTO "JournalEntry" (id, "externalRef", source, "createdAt")
VALUES ('je_reversal_xxx', 'REVERSAL-xxx', 'VAS_REVERSAL', NOW());

-- Add reversal lines
INSERT INTO "JournalLine" (id, "entryId", "accountCode", "debitCents", "creditCents")
VALUES 
  ('jl_rev_1', 'je_reversal_xxx', 'LIABILITY:VAS_CLEARING', 5000, NULL),
  ('jl_rev_2', 'je_reversal_xxx', 'WALLET:acc-123', NULL, 5000);

-- Update wallet balance
UPDATE "Wallet" SET "availableCents" = "availableCents" + 5000
WHERE "accountId" = 'acc-123';
```

---

## Monitoring Queries

### Current System Health

```sql
-- Last hour's success rate
SELECT 
  COUNT(*) FILTER (WHERE status = 'SUCCESS') * 100.0 / COUNT(*) as success_rate,
  COUNT(*) as total
FROM "ProviderRequest"
WHERE route LIKE '/mobile/%'
  AND "requestTs" > NOW() - INTERVAL '1 hour';
```

### Error Distribution

```sql
-- Errors by type (last 24h)
SELECT 
  status,
  COUNT(*) as count,
  COUNT(*) * 100.0 / SUM(COUNT(*)) OVER () as percentage
FROM "ProviderRequest"
WHERE route LIKE '/mobile/%'
  AND "requestTs" > NOW() - INTERVAL '24 hours'
  AND status != 'SUCCESS'
GROUP BY status
ORDER BY count DESC;
```

### Revenue Summary

```sql
-- Today's VAS revenue
SELECT 
  source,
  COUNT(*) as transactions,
  SUM("debitCents") / 100.0 as total_rand
FROM "JournalEntry" je
JOIN "JournalLine" jl ON jl."entryId" = je.id
WHERE je.source LIKE 'VAS_%'
  AND je.source NOT LIKE '%FAILED'
  AND je."createdAt" >= CURRENT_DATE
  AND jl."accountCode" LIKE 'WALLET:%'
GROUP BY source;
```

---

## Contact Information

### Blu Support
- **Email**: support@bluvoucher.co.za
- **Response Time**: Within business hours
- **Escalation**: Request account manager contact

### Internal Contacts
- **On-Call**: (Configure with your team)
- **Engineering Lead**: (Configure with your team)
- **Finance (for reconciliation)**: (Configure with your team)

---

## Maintenance Windows

### Planned Maintenance

1. Announce maintenance 24h in advance
2. Enable maintenance mode message
3. Perform changes
4. Run smoke tests
5. Disable maintenance mode
6. Monitor for 30 minutes

### Blu Planned Maintenance

- Blu typically announces via email
- Configure DISABLE_VAS during their window
- Re-enable after confirmation

---

## Related Documentation

- [Blu VAS Catalogue](../providers/blu-vas-catalogue.md)
- [Blu VAS E2E Testing](../testing/blu-vas-e2e.md)
- [Blu VAS Deployment](../deploy/blu-vas.md)

