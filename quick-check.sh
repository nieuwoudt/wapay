#!/bin/bash

# Quick template check for WaPay production
WABA_ID="647978251504290"
TOKEN="${META_WHATSAPP_TOKEN:?export META_WHATSAPP_TOKEN first (value in Vercel)}"

echo "🔍 Checking WaPay Production Templates"
echo "WABA ID: $WABA_ID"
echo "========================================"
echo ""

curl -s -G "https://graph.facebook.com/v20.0/$WABA_ID/message_templates" \
  -d "fields=name,language,status,category" \
  -d "limit=100" \
  -d "access_token=$TOKEN" | jq -r '
    if .error then
      "❌ ERROR: \(.error.message)"
    else
      "📊 Total templates: \(.data | length)\n",
      (.data[] | 
        "✓ \(.name) [\(.language)] - \(.status) (\(.category))")
    end
  '

echo ""
echo "✅ Check complete!"

