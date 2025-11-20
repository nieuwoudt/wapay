#!/bin/bash

echo "🔍 Quick WhatsApp Token Test"
echo "================================"
echo ""
echo "Paste your new WhatsApp Access Token and press Enter:"
read TOKEN

echo ""
echo "Testing token..."
echo ""

# Test token validity
RESPONSE=$(curl -s -X GET "https://graph.facebook.com/v21.0/me?access_token=$TOKEN")

if echo "$RESPONSE" | grep -q '"id"'; then
  echo "✅ TOKEN IS VALID!"
  echo ""
  echo "Token details:"
  echo "$RESPONSE" | jq .
  echo ""
  echo "Now testing message send..."
  echo ""
  
  # Test sending a text message
  MSG_RESPONSE=$(curl -s -X POST "https://graph.facebook.com/v21.0/870272072828461/messages" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "messaging_product": "whatsapp",
      "to": "27787051175",
      "type": "text",
      "text": {
        "body": "✅ Token test successful! Your WaPay is ready."
      }
    }')
  
  if echo "$MSG_RESPONSE" | grep -q '"messages"'; then
    echo "✅ MESSAGE SENT SUCCESSFULLY!"
    echo ""
    echo "Message ID:"
    echo "$MSG_RESPONSE" | jq -r '.messages[0].id'
    echo ""
    echo "🎉 Your token is working perfectly!"
    echo "Now redeploy Vercel and everything will work!"
  else
    echo "❌ Message send failed:"
    echo "$MSG_RESPONSE" | jq .
  fi
else
  echo "❌ TOKEN IS INVALID!"
  echo ""
  echo "Error:"
  echo "$RESPONSE" | jq .
  echo ""
  echo "Please generate a new token from:"
  echo "https://developers.facebook.com/apps/"
fi

