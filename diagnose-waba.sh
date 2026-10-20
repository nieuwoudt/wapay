#!/bin/bash

# WaPay WABA Diagnostics
# Export META_WHATSAPP_TOKEN first (the value lives in Vercel); never paste a token into this file

TOKEN="${META_WHATSAPP_TOKEN:?export META_WHATSAPP_TOKEN first (value in Vercel)}"
PHONE_ID="870272072828461"
ENV_WABA_ID="647978251504290"

echo "🔍 WaPay WABA Alignment Diagnostics"
echo "===================================="
echo ""

echo "D1. 📱 Checking which WABA owns phone number..."
echo "------------------------------------------------------------"
WABA_RESPONSE=$(curl -s -G "https://graph.facebook.com/v20.0/$PHONE_ID" \
  -d "fields=display_phone_number,whatsapp_business_account" \
  -d "access_token=$TOKEN")

echo "$WABA_RESPONSE" | jq '.'

# Extract WABA ID
WABA_ID=$(echo "$WABA_RESPONSE" | jq -r '.whatsapp_business_account.id // empty')

if [ -z "$WABA_ID" ]; then
  echo "❌ Could not extract WABA ID. Check token and phone number ID."
  exit 1
fi

echo ""
echo "✅ Found WABA ID: $WABA_ID"
echo ""

echo "D2. 📋 Listing templates from WABA $WABA_ID..."
echo "------------------------------------------------------------"
curl -s -G "https://graph.facebook.com/v20.0/$WABA_ID/message_templates" \
  -d "fields=name,language,status,category" \
  -d "limit=100" \
  -d "access_token=$TOKEN" | jq '.data[] | {name, language, status, category}'

echo ""
echo ""
echo "D3. 👤 Checking token owner..."
echo "------------------------------------------------------------"
curl -s -G "https://graph.facebook.com/v20.0/me" \
  -d "access_token=$TOKEN" | jq '.'

echo ""
echo ""
echo ""
echo "✅ Diagnostics Complete!"
echo ""
echo "📋 Analysis:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "WABA ID from phone number: $WABA_ID"
echo "WABA ID in Vercel env:     $ENV_WABA_ID"
if [ "$WABA_ID" = "$ENV_WABA_ID" ]; then
  echo "✅ MATCH - WABA IDs are aligned"
else
  echo "❌ MISMATCH - This is why templates aren't loading!"
  echo "   You need to update WHATSAPP_BUSINESS_ACCOUNT_ID in Vercel to: $WABA_ID"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

