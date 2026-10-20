/**
 * Golden thread, section 8, the items in the main session's files
 * (2026-10-16): O3 PayFast merchant and passphrase mandatory in production,
 * O4 cron routes trust only Bearer CRON_SECRET, O5 Blu stub mode refused in
 * production, O6 an atomic claim on every execute route, O7 the two test
 * deposit routes gone, O8 the PIN pepper migrates by rehash.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isCronAuthed, cronSecretSet } from '../lib/cron-auth.js';
import { assertBluStubAllowed } from '@wapay/providers-blu';
import { pepperCandidates } from '@wapay/auth';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const exists = (p) => existsSync(fileURLToPath(new URL(p, import.meta.url)));

// ---------------------------------------------------------------- O4 cron

test('O4: a cron route is authed by Bearer CRON_SECRET only; header and query are nothing', () => {
  const env = { CRON_SECRET: 's'.repeat(32) };
  assert.equal(isCronAuthed({ headers: { authorization: `Bearer ${'s'.repeat(32)}` } }, env), true);
  assert.equal(isCronAuthed({ headers: { authorization: `bearer ${'s'.repeat(32)}` } }, env), true, 'scheme is case-insensitive');
  assert.equal(isCronAuthed({ headers: { authorization: `Bearer ${'s'.repeat(31)}x` } }, env), false);
  assert.equal(isCronAuthed({ headers: { 'x-vercel-cron': '1' } }, env), false, 'the spoofable header is not a gate');
  assert.equal(isCronAuthed({ headers: {}, query: { key: 's'.repeat(32) } }, env), false, 'a query token is not a gate');
  assert.equal(isCronAuthed({ headers: { authorization: `Bearer ${'s'.repeat(32)}` } }, {}), false, 'no secret configured: closed');
  assert.equal(isCronAuthed({ headers: { authorization: `Bearer short` } }, { CRON_SECRET: 'short' }), false, 'a short secret does not count as configured');
  assert.equal(cronSecretSet({ CRON_SECRET: 'x'.repeat(16) }), true);
  assert.equal(cronSecretSet({}), false);
  assert.equal(isCronAuthed({}, env), false);
});

test('O4: all three cron routes import the shared gate and carry no header or query trust', () => {
  for (const f of ['payout-reconcile', 'adumo-reconcile', 'daily-vas-sync']) {
    const src = read(`../pages/api/cron/${f}.js`);
    assert.match(src, /import \{ isCronAuthed \} from '..\/..\/..\/lib\/cron-auth.js'/, f);
    assert.doesNotMatch(src, /x-vercel-cron|query\?\.key|function isCronAuthed/, f);
  }
  assert.match(read('../pages/api/internal/payout-status.js'), /cronSecretSet: !!\(process\.env\.CRON_SECRET && process\.env\.CRON_SECRET\.length >= 16\)/);
});

// ---------------------------------------------------------------- O3 ITN

test('O3: the PayFast webhook refuses a foreign merchant and an unconfigured passphrase in production, before verifyItn; source IP stays warn-only', () => {
  const src = read('../pages/api/payfast/itn.js');
  const pre = src.indexOf("if (ourMerchantId && String(params.merchant_id || '').trim() !== ourMerchantId) return preReject('MERCHANT_MISMATCH');");
  const pass = src.indexOf("if (isProd && !process.env.PAYFAST_PASSPHRASE) return preReject('PASSPHRASE_NOT_CONFIGURED');");
  const mid = src.indexOf("if (isProd && !ourMerchantId) return preReject('MERCHANT_ID_NOT_CONFIGURED');");
  const verify = src.indexOf('const verification = await verifyItn({');
  const money = src.indexOf('ensureWallet(');
  assert.ok(pre > -1 && pass > -1 && mid > -1, 'both checks exist');
  assert.ok(pre < verify && pass < verify && mid < verify, 'the checks run before verifyItn');
  assert.ok(verify < money, 'and verifyItn still runs before any money moves');
  assert.match(src, /enforceSourceIp: process\.env\.PAYFAST_ENFORCE_SOURCE_IP === 'true'/, 'IP enforcement remains opt-in, with the 2026-08-21 reason recorded');
  assert.match(src, /await recordItnDebug\(\{ paymentId, rawItn: params, reason, sourceIp \}\)\.catch/, 'a pre-rejection keeps the raw ITN for debugging');
  assert.match(src, /merchant_id: params\.merchant_id \? String\(params\.merchant_id\)\.slice\(-4\) : null/, 'only the tail of a foreign merchant id is logged');
});

// ---------------------------------------------------------------- O5 stub

test('O5: Blu stub mode is a QA switch; in production it throws before any vend', () => {
  assert.equal(assertBluStubAllowed({}), false, 'off: not requested');
  assert.equal(assertBluStubAllowed({ BLU_VAS_STUB_MODE: 'true' }), true, 'on, outside production: stub');
  assert.throws(() => assertBluStubAllowed({ BLU_VAS_STUB_MODE: 'true', NODE_ENV: 'production' }), /BLU_STUB_FORBIDDEN_IN_PRODUCTION/);
  assert.throws(() => assertBluStubAllowed({ BLU_VAS_STUB_MODE: 'true', VERCEL_ENV: 'production' }), /BLU_STUB_FORBIDDEN_IN_PRODUCTION/);
  assert.equal(assertBluStubAllowed({ BLU_VAS_STUB_MODE: 'false', NODE_ENV: 'production' }), false);
  const vas = read('../packages/providers/blu/src/vas.ts');
  assert.equal((vas.match(/bluStubModeRequested\(\)/g) || []).length, 4, 'the three stub sites and the helper, no bare env read left');
  assert.doesNotMatch(vas.replace(/export function assertBluStubAllowed[\s\S]*?\n\}/, ''), /process\.env\.BLU_VAS_STUB_MODE/);
  const elec = read('../pages/api/vas/electricity/execute.js');
  assert.match(elec, /if \(assertBluStubAllowed\(\)\) \{/);
  assert.doesNotMatch(elec, /process\.env\.BLU_VAS_STUB_MODE/);
});

// ---------------------------------------------------------------- O6 claim

test('O6: airtime, data and voucher execute own the purchase with an atomic EXECUTING flip, after the PIN and before the hold', () => {
  for (const f of ['airtime', 'data', 'voucher']) {
    const src = read(`../pages/api/vas/${f}/execute.js`);
    const pin = src.indexOf('await verifyPIN(');
    const flip = src.indexOf("const flipped = await prisma.providerRequest.updateMany({");
    const hold = src.indexOf('await reserveHold(');
    assert.ok(pin > -1 && flip > -1 && hold > -1, f);
    assert.ok(pin < flip && flip < hold, `${f}: PIN → claim → hold`);
    assert.match(src, /where: \{ id: previewId, status: preview\.status \},\s*data: \{ status: 'EXECUTING', metadata: \{ \.\.\.metadata, executingAt: new Date\(\)\.toISOString\(\) \} \}/, f);
    assert.match(src, /if \(flipped\.count !== 1\) \{[\s\S]{0,300}status\(409\)\.json\(\{ error: 'IN_PROGRESS'/, f);
    assert.match(src, /const EXEC_TAKEOVER_MS = 120_000;/, f);
    assert.match(src, /if \(!preview \|\| !\(\['PENDING', 'RECONCILE'\]\.includes\(preview\.status\) \|\| staleExecuting\)\)/, f);
    assert.match(src, /if \(preview\?\.status === 'EXECUTING' && !staleExecuting\) \{\s*return res\.status\(409\)/, f);
  }
});

// ---------------------------------------------------------------- O7 gone

test('O7: the test deposit route and the scaffold deposit route are gone', () => {
  assert.equal(exists('../pages/api/test-deposit.js'), false);
  assert.equal(exists('../apps/api/src/routes/deposit.ts'), false);
  const idx = read('../apps/api/src/index.ts');
  assert.doesNotMatch(idx, /registerDepositRoutes|routes\/deposit/);
});

// ---------------------------------------------------------------- O8 pepper

test('O8: the pepper candidates are current first, then previous, then the in-source default; a verify under an old pepper rehashes', () => {
  const DEFAULT = 'wapay_pin_pepper_2025_change_in_production';
  assert.deepEqual(pepperCandidates({}), [DEFAULT], 'unset: the default only');
  assert.deepEqual(pepperCandidates({ PIN_PEPPER: 'new' }), ['new', DEFAULT], 'set: the default is tried second so old hashes still verify');
  assert.deepEqual(pepperCandidates({ PIN_PEPPER: 'v3', PIN_PEPPER_PREVIOUS: 'v2, v1' }), ['v3', 'v2', 'v1', DEFAULT]);
  assert.deepEqual(pepperCandidates({ PIN_PEPPER: DEFAULT }), [DEFAULT]);
  const src = read('../packages/auth/src/pin.ts');
  assert.match(src, /const rehash = verified\.pepper && verified\.pepper !== PIN_PEPPER \? await hashPIN\(pin\) : null;/);
  assert.match(src, /\.\.\.\(rehash \? \{ secretHash: rehash \} : \{\}\)/);
  assert.match(src, /pin_pepper_default_in_production/);
  // hashPIN still uses the CURRENT pepper only.
  assert.match(src, /async function hashPIN\(pin: string\): Promise<string> \{\s*const pepperedPIN = pin \+ PIN_PEPPER;/);
});
