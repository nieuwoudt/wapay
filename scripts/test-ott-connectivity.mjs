#!/usr/bin/env node
/**
 * OTT Mobile connectivity smoke check.
 *
 * Makes exactly ONE live call: GetBalance (read-only, no voucher is issued,
 * no money moves). It NEVER calls GetAPIKey — that endpoint ROTATES the live
 * API key and would break the stored credentials.
 *
 * Env-gated: exits cleanly unless the OTT credentials are present.
 * Run: OTT_API_KEY=... OTT_API_USERNAME=... OTT_API_PASSWORD=... \
 *      OTT_BASE_URL=https://test-api.ott-mobile.com \
 *      node scripts/test-ott-connectivity.mjs
 *
 * Requires the workspace package to be built first:
 *   pnpm --filter @wapay/providers-ott build
 */

function skipIfMissingEnv(required) {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.log(`OTT SMOKE SKIP: missing env ${missing.join(',')} — set the OTT credentials to run the live GetBalance check.`);
    process.exit(0);
  }
}

async function main() {
  skipIfMissingEnv(['OTT_API_KEY', 'OTT_API_USERNAME', 'OTT_API_PASSWORD']);
  process.env.OTT_BASE_URL = process.env.OTT_BASE_URL || 'https://test-api.ott-mobile.com';

  const { OttClient, centsToRand } = await import('@wapay/providers-ott');
  const client = new OttClient();

  const uniqueReference = `wapay-conn-${Date.now()}`;
  console.log(JSON.stringify({ step: 'GetBalance', baseUrl: process.env.OTT_BASE_URL, uniqueReference }));

  try {
    const balance = await client.getBalance(uniqueReference);
    console.log(
      JSON.stringify({
        result: 'OK',
        balanceCents: balance.balanceCents,
        availableBalanceCents: balance.availableBalanceCents,
        balanceRand: centsToRand(balance.balanceCents),
        availableBalanceRand: centsToRand(balance.availableBalanceCents),
      }),
    );
  } catch (e) {
    console.error(
      JSON.stringify({
        result: 'FAIL',
        error: e?.message || String(e),
        reason: e?.reason,
        hint:
          e?.message === 'AUTH'
            ? 'Check OTT_API_USERNAME/OTT_API_PASSWORD (Basic auth) — and that OTT_API_KEY matches the portal (do NOT call GetAPIKey to fix this; reset on the portal instead).'
            : undefined,
      }),
    );
    process.exit(1);
  }
}

main();
