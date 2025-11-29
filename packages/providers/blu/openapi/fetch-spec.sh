#!/bin/bash
# Fetch Blu OpenAPI specification
#
# The Blu API documentation is available at:
# - Swagger UI: https://api.bluvoucher.co.za/swagger-ui/index.html
# - OpenAPI JSON: https://api.bluvoucher.co.za/v3/api-docs
#
# Usage: ./fetch-spec.sh

set -e

SPEC_URL="${BLU_OPENAPI_URL:-https://api.bluvoucher.co.za/v3/api-docs}"
OUTPUT_FILE="blu-trade-api.json"

echo "📥 Fetching Blu OpenAPI spec from: $SPEC_URL"

curl -s "$SPEC_URL" \
  -H "Accept: application/json" \
  -o "$OUTPUT_FILE"

if [ -s "$OUTPUT_FILE" ]; then
  echo "✅ Saved to $OUTPUT_FILE"
  echo "📊 Spec info:"
  jq -r '.info | "   Title: \(.title)\n   Version: \(.version)"' "$OUTPUT_FILE" 2>/dev/null || echo "   (Could not parse spec info)"
else
  echo "❌ Failed to fetch spec or empty response"
  exit 1
fi

