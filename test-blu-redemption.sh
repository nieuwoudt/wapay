#!/bin/bash

# Test Blu Voucher Redemption
# Run this script to test the redemption endpoint directly

echo "Testing Blu Voucher Redemption..."
echo "=================================="
echo ""

curl -X POST "https://api.qa.bltelecoms.net/v2/api/trade/voucher/variable/redemptions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(printf '%s:%s' "${BLU_BASIC_USER:-bld}" "${BLU_BASIC_PASS:?export BLU_BASIC_PASS first (value in Vercel)}" | base64 | tr -d '\n')" \
  -d '{
    "requestId": "wapay-test-001",
    "token": "5608644555612212",
    "amount": 1000
  }' \
  -v

echo ""
echo ""
echo "=================================="
echo "Test complete!"

