/**
 * Confirm-meter only runner.
 * Skips cleanly if required env vars are missing.
 */

import assert from 'node:assert/strict';

function skipIfMissingEnv(required) {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.log(`SKIP confirm-meter: missing env ${missing.join(',')}`);
    process.exit(0);
  }
}

async function main() {
  skipIfMissingEnv([
    'WAPAY_INTERNAL_API_KEY',
    'WAPAY_TEST_ACCOUNT_ID',
  ]);

  const metersEnv = process.env.WAPAY_TEST_METERS || process.env.WAPAY_TEST_METER;
  if (!metersEnv) {
    console.log('SKIP confirm-meter: no WAPAY_TEST_METERS or WAPAY_TEST_METER provided');
    process.exit(0);
  }

  const meters = metersEnv.split(',').map((m) => m.trim()).filter(Boolean);
  const base = (process.env.WAPAY_BASE_URL || 'https://wapay-api.vercel.app').replace(/\/$/, '');
  const url = `${base}/api/vas/electricity/preview`;
  const amountCents = Number(process.env.WAPAY_TEST_AMOUNT_CENTS || '500');

  let passed = 0;
  let failed = 0;
  const results = [];

  for (const meter of meters) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': process.env.WAPAY_INTERNAL_API_KEY,
        },
        body: JSON.stringify({
          accountId: process.env.WAPAY_TEST_ACCOUNT_ID,
          meterNumber: meter,
          amountCents,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        failed += 1;
        results.push(`FAIL meter=${meter} http=${res.status} body=${text.slice(0, 300)}`);
        continue;
      }

      const body = await res.json();
      assert.equal(body.ok, true, 'preview should succeed');
      assert.ok(body.preview?.reference, 'preview should return reference');
      passed += 1;
      results.push(`PASS meter=${meter} ref=${body.preview.reference}`);
    } catch (err) {
      failed += 1;
      results.push(`FAIL meter=${meter} err=${err.message}`);
    }
  }

  const status = failed === 0 ? 'PASS' : 'FAIL';
  console.log(`CONFIRM-METER ${status} passed=${passed} failed=${failed}`);
  results.forEach((r) => console.log(r));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL confirm-meter:', err);
  process.exit(1);
});

