# Blu Voucher QA Test Suite

## Overview

This automated test suite tests your **deployed Vercel API** for Blu voucher redemption across multiple scenarios.

## Setup

1. **Get your Vercel deployment URL**
   ```bash
   # Find it in your Vercel dashboard or from the latest deployment
   # Example: https://wapay-abc123.vercel.app
   ```

2. **Get test voucher PINs from Blu**
   - ✅ Valid/unused voucher (R10 or R50)
   - ❌ Already-used voucher
   - ❌ Expired voucher (request from Blu if needed)

3. **Set environment variables**
   ```bash
   export VERCEL_API_BASE="https://your-actual-deployment.vercel.app"
   export BLU_TEST_VALID_PIN="3608644555612212"
   export BLU_TEST_USED_PIN="1234567890123456"
   export BLU_TEST_EXPIRED_PIN="9876543210987654"
   export TEST_ACCOUNT_ID="test-account-qa"
   export TEST_WA_ID="27787051175"
   ```

## Run Tests

```bash
node test-blu-qa-suite.js
```

## What It Tests

### ✅ Success Cases
1. **Valid Voucher Redemption**
   - Expects: 200 OK
   - Validates: Amount credited, reference returned, balance updated

### ❌ Error Cases
2. **Already Used Voucher**
   - Expects: 400 Bad Request with `USER_INPUT` error
   - Validates: Clean error message to user

3. **Invalid/Fake PIN**
   - Expects: 400 Bad Request with `USER_INPUT` error
   - Validates: Blu rejects unknown voucher

4. **Expired Voucher**
   - Expects: 400 Bad Request with `USER_INPUT` error
   - Validates: Blu rejects expired voucher

### 🔄 Flow Tests
5. **Wallet Balance Check**
   - Validates: Balance endpoint works
   - Can compare before/after redemption

6. **Idempotency** (optional)
   - Validates: Same requestId returns cached response
   - Prevents double-redemption

## Expected Output

```
🚀 Starting Blu Voucher QA Test Suite
📍 API Base: https://wapay-abc123.vercel.app
👤 Test Account: test-account-qa
📱 Test WhatsApp: 27787051175

🧪 Test: Valid Voucher Redemption
   PIN: 3608****2212
   Status: 200 ✅
   Duration: 1234ms
   Response: {
     "ok": true,
     "reference": "BLU-1763971714144",
     "amount_cents": 1000
   }

🧪 Test: Already Used Voucher
   PIN: 1234****3456
   Status: 400 ✅
   Duration: 567ms
   Response: {
     "ok": false,
     "error": "USER_INPUT",
     "message": "Voucher already redeemed"
   }

...

================================================================================
📊 BLU VOUCHER QA TEST REPORT
================================================================================

✅ Passed: 5/5
❌ Failed: 0/5
📈 Success Rate: 100.0%
```

## Troubleshooting

### "Please set VERCEL_API_BASE"
- You need to export your actual Vercel URL
- Check Vercel dashboard for the deployment URL

### "Request failed: ENOTFOUND"
- Check your Vercel URL is correct
- Ensure the deployment is live

### All tests return 401/403
- Check Blu credentials in Vercel environment variables
- Verify `BLU_BASE_URL`, `BLU_BASIC_USER`, `BLU_BASIC_PASS`, `BLU_API_KEY`

### Valid voucher returns 400
- Voucher may already be used
- Get a fresh test voucher from Blu

## Next Steps

After running the test suite:

1. **Review the report** - Check all tests passed
2. **Fix any failures** - Update error handling if needed
3. **Test in WhatsApp** - Validate the actual user experience
4. **Monitor logs** - Check Vercel logs for detailed Blu responses

## Advanced: Testing Auth Failures

To test authentication errors, temporarily set wrong credentials:

```bash
# In Vercel dashboard, temporarily change:
# BLU_API_KEY=wrong-key

# Run tests - should see AUTH errors
node test-blu-qa-suite.js

# Restore correct credentials after testing
```

## Notes

- Each test waits 2 seconds between requests to avoid rate limiting
- Valid voucher tests will consume real vouchers
- Idempotency test is commented out to preserve vouchers
- All tests hit your **live production/staging API**

