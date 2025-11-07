#!/bin/bash

# Check templates in WaPay production account
WABA_ID="647978251504290"

echo "🔍 Checking templates in WaPay Production Account"
echo "WABA ID: $WABA_ID"
echo "=================================================="
echo ""

read -p "Enter your current WHATSAPP_ACCESS_TOKEN: " TOKEN

echo ""
echo "📋 Fetching all templates..."
echo ""

curl -s -G "https://graph.facebook.com/v20.0/$WABA_ID/message_templates" \
  -d "fields=name,language,status,category,components" \
  -d "limit=100" \
  -d "access_token=$TOKEN" | jq -r '
    .data[] | 
    "Template: \(.name)
     Language: \(.language)
     Status: \(.status)
     Category: \(.category)
     ─────────────────────────────────────────"
  '

echo ""
echo "📊 Summary by status:"
curl -s -G "https://graph.facebook.com/v20.0/$WABA_ID/message_templates" \
  -d "fields=name,status" \
  -d "limit=100" \
  -d "access_token=$TOKEN" | jq -r '
    .data | 
    group_by(.status) | 
    map({status: .[0].status, count: length}) | 
    .[] | 
    "  \(.status): \(.count) templates"
  '

echo ""
echo "✅ Check complete!"

