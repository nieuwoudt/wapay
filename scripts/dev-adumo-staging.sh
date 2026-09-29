#!/bin/zsh
# Local dev server wired to Adumo's STAGING with the published test merchant, on a scratch schema.
# Usage: SCRATCH_URL_FILE=<file with the scratch DATABASE_URL> zsh scripts/dev-adumo-staging.sh
set -e
cd "$(dirname "$0")/.."
export DATABASE_URL="$(cat "${SCRATCH_URL_FILE:?set SCRATCH_URL_FILE}")"
export APP_BASE_URL=http://localhost:3010
export WAPAY_ADUMO_ENABLED=true
export ADUMO_SANDBOX=true
export ADUMO_MERCHANT_ID=9BA5008C-08EE-4286-A349-54AF91A621B0
export ADUMO_APPLICATION_ID=904A34AF-0CE9-42B1-9C98-B69E6329D154
export ADUMO_JWT_SECRET=yglTxLCSMm7PEsfaMszAKf2LSRvM2qVW
export ADUMO_CLIENT_ID=9BA5008C-08EE-4286-A349-54AF91A621B0
export ADUMO_CLIENT_SECRET=23adadc0-da2d-4dac-a128-4845a5d71293
export WAPAY_INTERNAL_API_KEY="$(grep '^WAPAY_INTERNAL_API_KEY=' .env | cut -d= -f2-)"
exec pnpm exec next dev -p 3010
