#!/bin/bash

echo "🔍 WaPay WABA Alignment Diagnostics"
echo "===================================="
echo ""

# Get from Vercel env (you'll need to paste these)
read -p "Enter WHATSAPP_ACCESS_TOKEN: " WHATSAPP_TOKEN
read -p "Enter WHATSAPP_PHONE_NUMBER_ID (870272072828461): " PHONE_ID
PHONE_ID=${PHONE_ID:-870272072828461}

echo ""
echo "D1. 📱 Checking which WABA owns phone number $PHONE_ID..."
echo "------------------------------------------------------------"
curl -s -G "https://graph.facebook.com/v20.0/$PHONE_ID" \
  -d "fields=display_phone_number,verified_name,name_status,code_verification_status,quality_rating,account_mode,whatsapp_business_account" \
  -d "access_token=$WHATSAPP_TOKEN" | jq '.'

echo ""
echo ""
read -p "Enter the WABA ID from above (whatsapp_business_account.id): " WABA_ID_REAL

echo ""
echo "D2. 📋 Listing templates from WABA $WABA_ID_REAL..."
echo "------------------------------------------------------------"
curl -s -G "https://graph.facebook.com/v20.0/$WABA_ID_REAL/message_templates" \
  -d "fields=name,language,status,category" \
  -d "limit=100" \
  -d "access_token=$WHATSAPP_TOKEN" | jq '.data[] | {name, language, status, category}'

echo ""
echo ""
echo "D3. 👤 Checking token owner..."
echo "------------------------------------------------------------"
curl -s -G "https://graph.facebook.com/v20.0/me" \
  -d "access_token=$WHATSAPP_TOKEN" | jq '.'

echo ""
echo ""
echo "✅ Diagnostics Complete!"
echo ""
echo "📋 Action Items:"
echo "1. If WABA ID from D1 ≠ $WABA_ID_REAL in Vercel → Update WHATSAPP_BUSINESS_ACCOUNT_ID"
echo "2. Check if 'welcome_new_user' appears in D2 with APPROVED status"
echo "3. Note the exact language code for welcome_new_user"
echo ""

