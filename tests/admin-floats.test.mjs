/**
 * Supplier floats route (v1.3 Task 1) — static + behavioral guards.
 *
 * The card must: gate like every admin route, call both OTT balance clients
 * server-side only, degrade per supplier (one dead API never kills the
 * card), cache ~60s, and never leak a credential or raw provider message.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const routeSource = readFileSync(
  fileURLToPath(new URL('../pages/api/admin/floats.js', import.meta.url)),
  'utf8'
);
const adminPageSource = readFileSync(
  fileURLToPath(new URL('../pages/admin/index.js', import.meta.url)),
  'utf8'
);

test('floats route is admin-gated, GET-only, duration-capped', () => {
  assert.match(routeSource, /import \{ requireAdmin \} from '..\/..\/..\/lib\/admin-auth.js'/);
  assert.match(routeSource, /if \(!requireAdmin\(req\)\.ok\) return res\.status\(401\)\.json\(\{ error: 'UNAUTHORIZED' \}\)/);
  assert.match(routeSource, /if \(req\.method !== 'GET'\) return res\.status\(405\)/);
  assert.match(routeSource, /export const config = \{ maxDuration: 25 \}/);
});

test('both OTT balance clients are wired — and GetAPIKey is nowhere near this', () => {
  assert.match(routeSource, /new OttClient\(\{ timeoutMs: 8000 \}\)/);
  assert.match(routeSource, /new OttPayoutClient\(\{ timeoutMs: 8000 \}\)/);
  assert.match(routeSource, /client\.getBalance\(\)/);
  assert.match(routeSource, /client\.getBalance\(\{ yourUniqueReference: ref \}\)/);
  assert.ok(!routeSource.includes('GetAPIKey'), 'the key-rotating endpoint must never be referenced');
});

test('ledger view derives CLEARING positions from the journal, debit minus credit', () => {
  assert.match(routeSource, /accountCode: \{ startsWith: 'CLEARING:' \}/);
  assert.match(routeSource, /_sum: \{ debitCents: true, creditCents: true \}/);
  assert.match(routeSource, /\(r\._sum\.debitCents \|\| 0\) - \(r\._sum\.creditCents \|\| 0\)/);
});

test('per-supplier degradation: every supplier call is fenced, errors become short codes', () => {
  assert.match(routeSource, /clearingPositions\(\)\.catch\(\(\) => null\)/);
  assert.match(routeSource, /ledgerAvailable: positions !== null/, 'a dead ledger reads as unknown, never R0');
  assert.match(routeSource, /function safeErrorCode\(/);
  // No raw provider error message may reach the response: the only error
  // field is the safe code.
  assert.ok(!/error: error\.message|error\?\.message \?\?/.test(routeSource.replace(/function safeErrorCode[\s\S]*?\n\}/, '')), 'raw messages never leave safeErrorCode');
  for (const code of ['AUTH', 'UNREACHABLE', 'TIMEOUT', 'NOT_CONFIGURED']) {
    assert.ok(routeSource.includes(`'${code}'`), `safe code ${code} declared`);
  }
});

test('missing credentials degrade to configured:false instead of throwing', () => {
  assert.match(routeSource, /hasEnv\('OTT_BASE_URL', 'OTT_API_USERNAME', 'OTT_API_PASSWORD', 'OTT_API_KEY'\)/);
  assert.match(routeSource, /hasEnv\('OTT_PAYOUT_BASE_URL', 'OTT_PAYOUT_USERNAME', 'OTT_PAYOUT_PASSWORD', 'OTT_PAYOUT_API_KEY'\)/);
  assert.match(routeSource, /return \{ configured: false \}/);
});

test('the response never carries env values', () => {
  // The only process.env reads are the presence checks and thresholds;
  // nothing interpolates an env VALUE into the payload.
  assert.ok(!/process\.env\.[A-Z_]+\s*[,}]?\s*\.\.\./.test(routeSource));
  assert.ok(!/apiKey|password|username/i.test(routeSource.replace(/hasEnv\([^)]*\)/g, '').replace(/OTT_API_USERNAME|OTT_API_PASSWORD|OTT_API_KEY|OTT_PAYOUT_USERNAME|OTT_PAYOUT_PASSWORD|OTT_PAYOUT_API_KEY/g, '')), 'no credential identifiers outside the presence checks');
});

test('60s cache + private cache header', () => {
  assert.match(routeSource, /CACHE_TTL_MS = 60_000/);
  assert.match(routeSource, /Date\.now\(\) - cache\.at < CACHE_TTL_MS/);
  assert.match(routeSource, /Cache-Control', 'private, max-age=60'/);
});

test('all five suppliers are represented, including CLEARING:YOYO for UniFuel', () => {
  for (const s of ["'OTT'", "'OTT_PAYOUT'", "'BLU'", "'YOYO'", "'PAYFAST'"]) {
    assert.ok(routeSource.includes(`supplierRow(${s}`), `${s} row present`);
  }
  assert.match(routeSource, /'Yoyo \/ wiCode \(UniFuel\)'/);
});

test('low-float warning thresholds are env-tunable with a sane default', () => {
  assert.match(routeSource, /WAPAY_FLOAT_WARN_CENTS_/);
  assert.match(routeSource, /WAPAY_FLOAT_WARN_CENTS/);
  assert.match(routeSource, /return 50_000/);
  assert.match(routeSource, /low: balanceCents != null \? balanceCents < warnCents : null/);
});

test('drift is only computed when both views exist — never a fake zero', () => {
  assert.match(
    routeSource,
    /driftCents: balanceCents != null && ledgerCents != null \? balanceCents - ledgerCents : null/
  );
});

test('Mission Control renders the Supplier floats card from its own endpoint', () => {
  assert.match(adminPageSource, /function Floats\(\)/);
  assert.match(adminPageSource, /fetch\('\/api\/admin\/floats'\)/);
  assert.match(adminPageSource, /<h2>Supplier floats<\/h2>/);
  assert.match(adminPageSource, /LOW FLOAT/);
  // Tri-state pill idiom: unknown must render grey, never false-green.
  const floatsFn = adminPageSource.slice(
    adminPageSource.indexOf('function Floats()'),
    adminPageSource.indexOf('function Funnel(')
  );
  assert.match(floatsFn, /ok === null \? 'var\(--ink3\)' : ok \? 'var\(--good\)' : 'var\(--crit\)'/);
});
