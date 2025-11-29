#!/bin/bash
# Generate TypeScript types from Blu OpenAPI spec
#
# Prerequisites:
#   pnpm add -D @hey-api/openapi-ts
#
# Usage: ./generate-types.sh

set -e

SPEC_FILE="blu-trade-api.json"
OUTPUT_DIR="../src/generated"

if [ ! -f "$SPEC_FILE" ]; then
  echo "❌ Spec file not found: $SPEC_FILE"
  echo "   Run ./fetch-spec.sh first"
  exit 1
fi

echo "🔧 Generating TypeScript types from Blu OpenAPI spec..."

# Using @hey-api/openapi-ts for type generation
npx @hey-api/openapi-ts \
  -i "$SPEC_FILE" \
  -o "$OUTPUT_DIR" \
  -c @hey-api/client-fetch

echo "✅ Types generated in $OUTPUT_DIR"
echo ""
echo "📝 Next steps:"
echo "   1. Review generated types in $OUTPUT_DIR"
echo "   2. Import and use in BluVasClient"
echo "   3. Regenerate when Blu API spec changes"

