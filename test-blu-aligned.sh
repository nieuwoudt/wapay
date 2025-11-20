#!/bin/bash

# Test Blu Voucher with Aligned Client
# This script tests the updated Blu client against QA API

set -e

echo "🧪 Testing Blu Voucher Client (Aligned with Swagger)"
echo "====================================================="
echo ""

# Configuration
BLU_BASE_URL="${BLU_BASE_URL:-https://api.qa.bltelecoms.net/v2/trade}"
BLU_USER="${BLU_USER:-bld}"
BLU_PASS="${BLU_PASS:-ornuk3i9vseei125s8qea71kub}"
BLU_API_KEY="${BLU_API_KEY:-6b58e8ca-1564-462f-8481-c9f39b258a15}"

# Test voucher PINs from Blu (replace with actual test PINs)
TEST_PIN_1="${TEST_PIN_1:-8078880588211693}"
TEST_PIN_2="${TEST_PIN_2:-3608644555612212}"
TEST_PIN_3="${TEST_PIN_3:-4861611435586213}"

# Create Basic Auth header
AUTH_HEADER="Authorization: Basic $(echo -n "$BLU_USER:$BLU_PASS" | base64)"

echo "📋 Configuration:"
echo "  Base URL: $BLU_BASE_URL"
echo "  Username: $BLU_USER"
echo "  API Key: ${BLU_API_KEY:0:8}..."
echo ""

# Test 1: Check voucher status (GET request per Swagger)
echo "1️⃣  Testing Voucher Status Check (GET /voucher/variable/vouchers)"
echo "   PIN: ${TEST_PIN_1:0:4}****${TEST_PIN_1: -4}"
echo ""

STATUS_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" \
  -X GET \
  "$BLU_BASE_URL/voucher/variable/vouchers?token=$TEST_PIN_1" \
  -H "$AUTH_HEADER" \
  -H "apikey: $BLU_API_KEY" \
  -H "Content-Type: application/json")

HTTP_CODE=$(echo "$STATUS_RESPONSE" | grep "HTTP_CODE:" | cut -d: -f2)
BODY=$(echo "$STATUS_RESPONSE" | sed '/HTTP_CODE:/d')

echo "   Response Code: $HTTP_CODE"
echo "   Response Body:"
echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
  echo "   ✅ Status check successful"
  VOUCHER_STATUS=$(echo "$BODY" | jq -r '.status' 2>/dev/null || echo "UNKNOWN")
  VOUCHER_AMOUNT=$(echo "$BODY" | jq -r '.amount' 2>/dev/null || echo "0")
  echo "   Status: $VOUCHER_STATUS"
  echo "   Amount: $VOUCHER_AMOUNT cents (R$(echo "scale=2; $VOUCHER_AMOUNT / 100" | bc))"
else
  echo "   ❌ Status check failed"
fi
echo ""

# Test 2: Attempt redemption (POST request per Swagger)
if [ "$HTTP_CODE" = "200" ] && [ "$VOUCHER_STATUS" = "ACTIVE" ] && [ "$VOUCHER_AMOUNT" != "0" ]; then
  echo "2️⃣  Testing Voucher Redemption (POST /voucher/variable/redemptions)"
  echo "   PIN: ${TEST_PIN_1:0:4}****${TEST_PIN_1: -4}"
  echo "   Amount: $VOUCHER_AMOUNT cents"
  echo ""
  
  REQUEST_ID="test-$(date +%s)-$$"
  
  REDEEM_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" \
    -X POST \
    "$BLU_BASE_URL/voucher/variable/redemptions" \
    -H "$AUTH_HEADER" \
    -H "apikey: $BLU_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
      \"requestId\": \"$REQUEST_ID\",
      \"token\": \"$TEST_PIN_1\",
      \"amount\": $VOUCHER_AMOUNT
    }")
  
  HTTP_CODE=$(echo "$REDEEM_RESPONSE" | grep "HTTP_CODE:" | cut -d: -f2)
  BODY=$(echo "$REDEEM_RESPONSE" | sed '/HTTP_CODE:/d')
  
  echo "   Response Code: $HTTP_CODE"
  echo "   Response Body:"
  echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
  echo ""
  
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    echo "   ✅ Redemption successful"
    REFERENCE=$(echo "$BODY" | jq -r '.reference' 2>/dev/null || echo "N/A")
    echo "   Reference: $REFERENCE"
  else
    echo "   ❌ Redemption failed"
    ERROR_MSG=$(echo "$BODY" | jq -r '.message' 2>/dev/null || echo "Unknown error")
    echo "   Error: $ERROR_MSG"
  fi
else
  echo "2️⃣  Skipping redemption test (voucher not ACTIVE or amount unknown)"
fi

echo ""
echo "====================================================="
echo "✅ Test complete!"
echo ""
echo "📝 Notes:"
echo "  - If status check returns 404, the voucher may not exist in QA"
echo "  - If status is USED, the voucher was already redeemed"
echo "  - If status is EXPIRED, get a fresh test voucher from Blu"
echo "  - Amount should be in cents (e.g., 10000 = R100.00)"
echo ""

