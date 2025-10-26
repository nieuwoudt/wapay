#!/bin/bash

# WaPay WhatsApp Integration Test Script
# This script tests the deposit flow with WhatsApp notifications

set -e

API_BASE="https://wapay-api.vercel.app"
YOUR_WHATSAPP_NUMBER="+27787051175"  # Your personal number for testing
IDEMPOTENCY_KEY="test-$(date +%s)"

echo "🧪 WaPay WhatsApp Integration Test"
echo "=================================="
echo ""

echo "📱 Testing with WhatsApp number: $YOUR_WHATSAPP_NUMBER"
echo "🔑 Idempotency Key: $IDEMPOTENCY_KEY"
echo ""

echo "1️⃣  Testing Health Endpoint..."
curl -s "$API_BASE/api/health" | jq '.'
echo ""

echo "2️⃣  Testing Yoyo Retailer Eligibility..."
curl -s "$API_BASE/api/yoyo/eligible?retailer=checkers" | jq '.'
echo ""

echo "3️⃣  Testing Blu Voucher Redemption (with WhatsApp notification)..."
echo "   This will attempt to:"
echo "   - Redeem a test voucher"
echo "   - Post to the ledger"
echo "   - Send a WhatsApp notification to $YOUR_WHATSAPP_NUMBER"
echo ""

curl -X POST "$API_BASE/api/deposit/blu/redeem" \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d "{
    \"pin\": \"1234567890\",
    \"accountId\": \"test-account-001\",
    \"waId\": \"$YOUR_WHATSAPP_NUMBER\"
  }" | jq '.'

echo ""
echo "✅ Test complete!"
echo ""
echo "📱 Check your WhatsApp ($YOUR_WHATSAPP_NUMBER) for notifications!"
echo ""
echo "⚠️  Note: If you see errors, it's likely because:"
echo "   1. Environment variables aren't set in Vercel yet"
echo "   2. Blu/Yoyo credentials are stubs"
echo "   3. Database connection needs to be configured"
echo ""
echo "Next steps:"
echo "1. Set up environment variables in Vercel (see VERCEL_ENV_SETUP.md)"
echo "2. Configure WhatsApp webhook in Meta dashboard"
echo "3. Test with real Blu voucher PIN"

