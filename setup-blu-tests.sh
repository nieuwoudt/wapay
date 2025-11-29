#!/bin/bash

# Setup script for Blu QA tests
# This helps you configure the test environment

echo "🔧 Blu Voucher QA Test Setup"
echo ""
echo "This script will help you configure the test environment."
echo ""

# Step 1: Vercel URL
echo "Step 1: Vercel Deployment URL"
echo "----------------------------------------"
echo "Find your Vercel deployment URL from:"
echo "  1. Go to https://vercel.com/dashboard"
echo "  2. Find your WaPay project"
echo "  3. Copy the deployment URL (e.g., https://wapay-abc123.vercel.app)"
echo ""
read -p "Enter your Vercel URL: " VERCEL_URL

if [ -z "$VERCEL_URL" ]; then
  echo "❌ No URL provided. Exiting."
  exit 1
fi

# Step 2: Test voucher PINs
echo ""
echo "Step 2: Test Voucher PINs"
echo "----------------------------------------"
echo "You need test vouchers from Blu for different scenarios."
echo ""

read -p "Enter a VALID/unused voucher PIN (16 digits): " VALID_PIN
read -p "Enter an ALREADY USED voucher PIN (16 digits): " USED_PIN
read -p "Enter an EXPIRED voucher PIN (16 digits, or press Enter to skip): " EXPIRED_PIN

# Step 3: Test account details
echo ""
echo "Step 3: Test Account Details"
echo "----------------------------------------"
read -p "Enter test account ID (or press Enter for default 'test-account-qa'): " ACCOUNT_ID
read -p "Enter test WhatsApp number (or press Enter for default '27787051175'): " WA_ID

# Set defaults
ACCOUNT_ID=${ACCOUNT_ID:-test-account-qa}
WA_ID=${WA_ID:-27787051175}
EXPIRED_PIN=${EXPIRED_PIN:-1111111111111111}

# Step 4: Generate .env file
echo ""
echo "Step 4: Generating test configuration..."
echo "----------------------------------------"

cat > .env.blu-tests << EOF
# Blu Voucher QA Test Configuration
# Generated: $(date)

# Vercel Deployment
export VERCEL_API_BASE="$VERCEL_URL"

# Test Voucher PINs
export BLU_TEST_VALID_PIN="$VALID_PIN"
export BLU_TEST_USED_PIN="$USED_PIN"
export BLU_TEST_EXPIRED_PIN="$EXPIRED_PIN"

# Test Account
export TEST_ACCOUNT_ID="$ACCOUNT_ID"
export TEST_WA_ID="$WA_ID"
EOF

echo "✅ Configuration saved to .env.blu-tests"
echo ""
echo "To run the tests:"
echo "  1. Load the configuration:"
echo "     source .env.blu-tests"
echo ""
echo "  2. Run the test suite:"
echo "     ./run-blu-tests.sh"
echo ""
echo "Or run both commands at once:"
echo "  source .env.blu-tests && ./run-blu-tests.sh"
echo ""

