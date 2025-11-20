# Blu Environment Configuration Verification

## Required Environment Variables

All Blu-related environment variables must be set in Vercel for the deployment to work correctly.

### QA Environment (Current)

```bash
BLU_BASE_URL="https://api.qa.bltelecoms.net/v2/api/trade"
BLU_BASIC_USER="bld"
BLU_BASIC_PASS="ornuk3i9vseei125s8qea71kub"
BLU_API_KEY="6b58e8ca-1564-462f-8481-c9f39b258a15"
```

### Production Environment (Future)

When moving to production, update these values with production credentials from Blu:

```bash
BLU_BASE_URL="https://api.bluvoucher.com/v1"  # or production URL from Blu
BLU_BASIC_USER="<production_username>"
BLU_BASIC_PASS="<production_password>"
BLU_API_KEY="<production_api_key>"
```

## Verification Checklist

### 1. Check Vercel Environment Variables

Go to Vercel Dashboard → Your Project → Settings → Environment Variables

Verify that ALL of the following are set:

- [ ] `BLU_BASE_URL` - Must end with `/v2/api/trade` for QA
- [ ] `BLU_BASIC_USER` - Should be `bld` for QA
- [ ] `BLU_BASIC_PASS` - QA password
- [ ] `BLU_API_KEY` - QA API key

### 2. Verify Base URL Format

The `BLU_BASE_URL` must include the full path:

✅ **Correct**: `https://api.qa.bltelecoms.net/v2/api/trade`  
❌ **Wrong**: `https://api.qa.bltelecoms.net`

The client appends paths like `/voucher/variable/vouchers` and `/voucher/variable/redemptions` to this base.

### 3. Test Configuration

After setting environment variables in Vercel:

1. Trigger a new deployment (or wait for auto-deploy)
2. Run the test script:
   ```bash
   ./test-blu-aligned.sh
   ```
3. Or test via WhatsApp by sending a QA voucher PIN

### 4. Check Logs

When testing, verify in Vercel logs that:

- Status check logs show: `[Blu] Status check success`
- Redemption logs show: `[Blu] Redeem success`
- No errors about missing environment variables

## Error Logging

The BluClient now logs comprehensive error details for debugging:

### Status Check Errors
```
[Blu] Status check failed {
  url: "https://api.qa.bltelecoms.net/v2/api/trade/voucher/variable/vouchers?token=...",
  method: "GET",
  pin: "****1234",
  statusCode: 404,
  responseBody: { ... }
}
```

### Redemption Errors
```
[Blu] Redeem error response {
  url: "https://api.qa.bltelecoms.net/v2/api/trade/voucher/variable/redemptions",
  method: "POST",
  requestBody: { requestId: "...", token: "****1234", amount: 10000 },
  statusCode: 400,
  responseBody: { ... },
  extractedMessage: "..."
}
```

## Common Issues

### Issue: "BLU_BASE_URL not set"
**Solution**: Add `BLU_BASE_URL` to Vercel environment variables

### Issue: 404 errors on all requests
**Solution**: Verify `BLU_BASE_URL` ends with `/v2/api/trade`

### Issue: 401 Unauthorized
**Solution**: Check `BLU_BASIC_USER`, `BLU_BASIC_PASS`, and `BLU_API_KEY` are correct

### Issue: "amountCents required for Blu variable voucher redemption"
**Solution**: This is a code error - status check must succeed before redemption

## Files Updated

The following files now use the consistent QA base URL:

- `env.template` - Template for local development
- `packages/utils/src/index.ts` - Default fallback value
- `packages/utils/src/index.js` - Compiled default fallback
- `test-blu-aligned.sh` - Test script default

All references now point to: `https://api.qa.bltelecoms.net/v2/api/trade`

