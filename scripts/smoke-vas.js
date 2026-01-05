#!/usr/bin/env node
/**
 * Golden Path Smoke Script for VAS.
 * Steps (non-vending):
 * 1) Trigger catalog sync (optional, best-effort)
 * 2) List Telkom bundles
 * 3) Search "tiktok"
 * 4) Electricity confirm-meter (no vend)
 *
 * Skips cleanly if required env vars are missing.
 */

import fetch from 'node-fetch';

function skipIfMissingEnv(required) {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.log(`SMOKE SKIP: missing env ${missing.join(',')}`);
    process.exit(0);
  }
}

async function callJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const json = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  return { ok: res.ok, status: res.status, json };
}

async function main() {
  skipIfMissingEnv([
    'WAPAY_INTERNAL_API_KEY',
    'WAPAY_TEST_ACCOUNT_ID',
    'WAPAY_TEST_METER',
  ]);

  const base = (process.env.WAPAY_BASE_URL || 'https://wapay-api.vercel.app').replace(/\/$/, '');
  const headers = {
    'content-type': 'application/json',
    'x-internal-api-key': process.env.WAPAY_INTERNAL_API_KEY,
  };

  const summary = [];
  let failed = false;

  // 1) Catalog sync (best-effort)
  try {
    const syncUrl = `${base}/api/vas/admin/sync`;
    const res = await callJson(syncUrl, { method: 'POST', headers });
    if (res.ok) summary.push('sync:PASS'); else summary.push(`sync:FAIL(${res.status})`);
  } catch (e) {
    summary.push('sync:SKIP');
  }

  // 2) List Telkom bundles
  try {
    const url = `${base}/api/vas/bundles/data?network=TELKOM`;
    const res = await callJson(url, { headers });
    if (res.ok && Array.isArray(res.json?.bundles)) summary.push('telkom:PASS'); else { summary.push('telkom:FAIL'); failed = true; }
  } catch (e) {
    summary.push('telkom:FAIL'); failed = true;
  }

  // 3) Search "tiktok"
  try {
    const url = `${base}/api/vas/bundles/data?query=tiktok`;
    const res = await callJson(url, { headers });
    if (res.ok) summary.push('search:tiktok:PASS'); else { summary.push('search:tiktok:FAIL'); failed = true; }
  } catch (e) {
    summary.push('search:tiktok:FAIL'); failed = true;
  }

  // 4) Electricity confirm-meter (no vend)
  try {
    const url = `${base}/api/vas/electricity/preview`;
    const res = await callJson(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        accountId: process.env.WAPAY_TEST_ACCOUNT_ID,
        meterNumber: process.env.WAPAY_TEST_METER,
        amountCents: Number(process.env.WAPAY_TEST_AMOUNT_CENTS || '2000'),
      }),
    });
    if (res.ok && res.json?.ok && res.json?.preview?.reference) summary.push('elec_preview:PASS');
    else { summary.push('elec_preview:FAIL'); failed = true; }
  } catch (e) {
    summary.push('elec_preview:FAIL'); failed = true;
  }

  const status = failed ? 'FAIL' : 'PASS';
  console.log(`SMOKE ${status} ${summary.join(' | ')}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('SMOKE FAIL', err);
  process.exit(1);
});

