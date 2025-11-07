#!/bin/bash

# WaPay WABA Diagnostics
# Replace YOUR_TOKEN_HERE with your actual token from Vercel

TOKEN="EAATG3Axub2QBP08RipQHc7xh39z1ozgZAA55uVSnoP8UW0tTlcsagDmwtINVu3F9X9ZCLY2Fo4NXlBgSV40aSfIjZCk6JpQicHB7WsyZC9cDxHqqI2hpdxnFfJMTSIONn5xya4KFiSSxq4laOg8bDued08WJsm2jeCmjpkg6ZCxhCpfdjZArdYZA7dpBZA9XoFBNZCDIryft2t5pjN02WVEZBWM81eFZCD9cgUhhItxn2HTtyzx121I3IlJeiPMia5ie5UEvDzabSv3GjtCs29tSGVHwd970wZDZD"
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

