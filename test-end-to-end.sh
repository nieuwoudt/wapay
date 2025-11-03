#!/bin/bash

# WaPay End-to-End Test Script
# Tests all critical flows via API endpoints

echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║                                                                      ║"
echo "║                  🧪 WaPay End-to-End Tests 🧪                        ║"
echo "║                                                                      ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""

# Configuration
BASE_URL="${VERCEL_URL:-http://localhost:3000}"
TEST_ACCOUNT_ID="test-account-123"
TEST_PHONE="+27821234567"

echo "🔧 Configuration:"
echo "   Base URL: $BASE_URL"
echo "   Test Account: $TEST_ACCOUNT_ID"
echo "   Test Phone: $TEST_PHONE"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Test counter
TESTS_PASSED=0
TESTS_FAILED=0

# Helper function to test endpoint
test_endpoint() {
  local test_name="$1"
  local method="$2"
  local endpoint="$3"
  local data="$4"
  local expected_status="$5"
  
  echo "🧪 Test: $test_name"
  echo "   Method: $method"
  echo "   Endpoint: $endpoint"
  
  if [ "$method" = "GET" ]; then
    response=$(curl -s -w "\n%{http_code}" "$BASE_URL$endpoint")
  else
    response=$(curl -s -w "\n%{http_code}" -X "$method" "$BASE_URL$endpoint" \
      -H "Content-Type: application/json" \
      -d "$data")
  fi
  
  # Extract status code (last line)
  status_code=$(echo "$response" | tail -n 1)
  body=$(echo "$response" | head -n -1)
  
  echo "   Status: $status_code (expected: $expected_status)"
  
  if [ "$status_code" = "$expected_status" ]; then
    echo "   ✅ PASSED"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    echo "   ❌ FAILED"
    echo "   Response: $body"
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
  
  echo ""
}

# ============================================================================
# Test 1: Health Check
# ============================================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Test Suite 1: Health & Infrastructure"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

test_endpoint \
  "Health Check" \
  "GET" \
  "/api/health" \
  "" \
  "200"

# ============================================================================
# Test 2: Balance Check
# ============================================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Test Suite 2: Balance Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

test_endpoint \
  "Get Balance (Missing Account)" \
  "GET" \
  "/api/wallet/balance" \
  "" \
  "400"

test_endpoint \
  "Get Balance (With Account)" \
  "GET" \
  "/api/wallet/balance?accountId=$TEST_ACCOUNT_ID" \
  "" \
  "200"

# ============================================================================
# Test 3: VAS - Bundles Catalog
# ============================================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Test Suite 3: VAS - Data Bundles"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

test_endpoint \
  "Get Vodacom Bundles" \
  "GET" \
  "/api/vas/bundles/vodacom" \
  "" \
  "200"

test_endpoint \
  "Get MTN Bundles" \
  "GET" \
  "/api/vas/bundles/mtn" \
  "" \
  "200"

test_endpoint \
  "Get Invalid Network Bundles" \
  "GET" \
  "/api/vas/bundles/invalid" \
  "" \
  "400"

# ============================================================================
# Test 4: VAS - Airtime Preview
# ============================================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Test Suite 4: VAS - Airtime Preview"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

test_endpoint \
  "Airtime Preview (Missing Fields)" \
  "POST" \
  "/api/vas/airtime/preview" \
  '{"accountId":"'$TEST_ACCOUNT_ID'"}' \
  "400"

test_endpoint \
  "Airtime Preview (Valid Request)" \
  "POST" \
  "/api/vas/airtime/preview" \
  '{"accountId":"'$TEST_ACCOUNT_ID'","msisdn":"'$TEST_PHONE'","amountCents":5000}' \
  "200"

test_endpoint \
  "Airtime Preview (Amount Too Low)" \
  "POST" \
  "/api/vas/airtime/preview" \
  '{"accountId":"'$TEST_ACCOUNT_ID'","msisdn":"'$TEST_PHONE'","amountCents":100}' \
  "400"

test_endpoint \
  "Airtime Preview (Amount Too High)" \
  "POST" \
  "/api/vas/airtime/preview" \
  '{"accountId":"'$TEST_ACCOUNT_ID'","msisdn":"'$TEST_PHONE'","amountCents":200000}' \
  "400"

# ============================================================================
# Test 5: VAS - Data Preview
# ============================================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Test Suite 5: VAS - Data Preview"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

test_endpoint \
  "Data Preview (Missing Fields)" \
  "POST" \
  "/api/vas/data/preview" \
  '{"accountId":"'$TEST_ACCOUNT_ID'"}' \
  "400"

test_endpoint \
  "Data Preview (Valid Request)" \
  "POST" \
  "/api/vas/data/preview" \
  '{"accountId":"'$TEST_ACCOUNT_ID'","msisdn":"'$TEST_PHONE'","productId":"042","vendorId":"vodacom"}' \
  "200"

# ============================================================================
# Test 6: WhatsApp Webhook
# ============================================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Test Suite 6: WhatsApp Webhook"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

test_endpoint \
  "Webhook Verification (Invalid Token)" \
  "GET" \
  "/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=test123" \
  "" \
  "403"

test_endpoint \
  "Webhook Message Receipt" \
  "POST" \
  "/api/webhooks/whatsapp" \
  '{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messages":[{"from":"'$TEST_PHONE'","text":{"body":"test"}}]}}]}]}' \
  "200"

# ============================================================================
# Summary
# ============================================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Test Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   ✅ Passed: $TESTS_PASSED"
echo "   ❌ Failed: $TESTS_FAILED"
echo ""

TOTAL_TESTS=$((TESTS_PASSED + TESTS_FAILED))
SUCCESS_RATE=$((TESTS_PASSED * 100 / TOTAL_TESTS))

echo "   Success Rate: $SUCCESS_RATE%"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
  echo "🎉 All tests passed! Ready to deploy! 🚀"
  exit 0
else
  echo "⚠️  Some tests failed. Please review and fix before deploying."
  exit 1
fi

