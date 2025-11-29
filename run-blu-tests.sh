#!/bin/bash

# Blu Voucher QA Test Runner
# Quick script to run the test suite with your Vercel deployment

echo "🧪 Blu Voucher QA Test Suite"
echo ""

# Check if VERCEL_API_BASE is set
if [ -z "$VERCEL_API_BASE" ]; then
  echo "❌ VERCEL_API_BASE not set"
  echo ""
  echo "Please set your Vercel deployment URL:"
  echo "  export VERCEL_API_BASE='https://your-app.vercel.app'"
  echo ""
  echo "You can find this in your Vercel dashboard."
  exit 1
fi

# Show configuration
echo "Configuration:"
echo "  API Base: $VERCEL_API_BASE"
echo "  Test Account: ${TEST_ACCOUNT_ID:-test-account-qa}"
echo "  Test WhatsApp: ${TEST_WA_ID:-27787051175}"
echo ""

# Check for test PINs
if [ -z "$BLU_TEST_VALID_PIN" ]; then
  echo "⚠️  BLU_TEST_VALID_PIN not set - using default"
  export BLU_TEST_VALID_PIN="3608644555612212"
fi

if [ -z "$BLU_TEST_USED_PIN" ]; then
  echo "⚠️  BLU_TEST_USED_PIN not set - using placeholder"
  export BLU_TEST_USED_PIN="0000000000000000"
fi

if [ -z "$BLU_TEST_EXPIRED_PIN" ]; then
  echo "⚠️  BLU_TEST_EXPIRED_PIN not set - using placeholder"
  export BLU_TEST_EXPIRED_PIN="1111111111111111"
fi

echo ""
echo "Starting tests..."
echo ""

# Run the test suite
node test-blu-qa-suite.js

# Capture exit code
EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "✅ Test suite completed"
else
  echo "❌ Test suite failed with exit code $EXIT_CODE"
fi

exit $EXIT_CODE

