#!/bin/bash

# Quick template check for WaPay production
WABA_ID="647978251504290"
TOKEN="EAATG3Axub2QBP2bEUQZAaKrwXptRg3J1mxstMzHtVdq1ZBfAQahOzKa0ZABFe5gEWTW4v159upyLNIpwDoP8IcXXZBlt5LoEPfLUooDQyyLOM4VSzVqiKuOzEtt5ovx8ZASsmD8FKg2HC5WfpsUN8Dtpd7kpqqzonMABWjJop3ZBgZBDGNbA747HXZC1yXhq9Q0NkiaB9Kr6luKEcFaWPY0t7vCo781yZALLEblpdPoZCZBR2HCgZAHnfb3IKFHdaIXVZCOZAfHIlmpC4tkeLPGpQUmPO4fcDu"

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

