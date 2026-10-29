/**
 * Money leaves a customer's balance only with their own approval
 * (BUGLOG #112, #114; founder 2026-10-16: "safeguards in place that we
 * can't transfer funds from a customer's account"). The rules this file
 * keeps true, each one a line of docs/GOLDEN_THREAD.md:
 *   - a pay-out needs a proof that this customer typed their PIN (or the
 *     business owner passed the step-up) for this intent and this amount,
 *     minutes ago; requestPayout, the one door to the rail, refuses without
 *     it before any row, cent, hold or rail call;
 *   - only verifyPIN and the business step-up issue proofs;
 *   - a card callback approves nothing without the whole merchant
 *     configuration, and never with Adumo's public sandbox secret.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issuePinProof, verifyPinProof, PIN_PROOF_TTL_MS } from '@wapay/auth/pin-proof';
import { proofFor } from './helpers/pin-proof.mjs';
import { requestPayout } from '../lib/payouts.js';
import { executeWithdraw } from '../lib/payout-chat.js';
import { verifyAdumoResponse, ADUMO_PUBLIC_TEST } from '../lib/adumo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('the proof: bound to the account, the intent and the exact amount, two minutes, signed', () => {
  const p = issuePinProof({ accountId: 'acc-1', intentId: 'wa-1', amountCents: 5000 });
  assert.ok(p);
  assert.deepEqual(verifyPinProof(p, { accountId: 'acc-1', intentId: 'wa-1', amountCents: 5000 }), { ok: true, via: 'PIN' });
  assert.equal(verifyPinProof(p, { accountId: 'acc-1', intentId: 'wa-1', amountCents: 50000 }).reason, 'WRONG_AMOUNT', 'R50 never executes R500');
  assert.equal(verifyPinProof(p, { accountId: 'acc-1', intentId: 'wa-2', amountCents: 5000 }).reason, 'WRONG_INTENT', 'one withdrawal never executes another');
  assert.equal(verifyPinProof(p, { accountId: 'acc-2', intentId: 'wa-1', amountCents: 5000 }).reason, 'WRONG_ACCOUNT');
  assert.equal(verifyPinProof(p, { accountId: 'acc-1', intentId: 'wa-1', amountCents: 5000, now: Date.now() + PIN_PROOF_TTL_MS + 1000 }).reason, 'EXPIRED');
  const [payload] = p.split('.');
  const forged = `${Buffer.from(JSON.stringify({ a: 'acc-1', i: 'wa-1', c: 500000, t: Date.now() })).toString('base64url')}.${p.split('.')[1]}`;
  assert.equal(verifyPinProof(forged, { accountId: 'acc-1', intentId: 'wa-1', amountCents: 500000 }).reason, 'BAD_SIGNATURE');
  assert.ok(payload);
  assert.equal(verifyPinProof(null, { accountId: 'acc-1', intentId: 'wa-1', amountCents: 5000 }).reason, 'MISSING');
  assert.equal(issuePinProof({ accountId: 'acc-1', intentId: 'wa-1', amountCents: 0 }), null, 'no proof for a non-amount');
  assert.equal(verifyPinProof(issuePinProof({ accountId: 'b', intentId: 'i', amountCents: 100, via: 'STEP_UP' }), { accountId: 'b', intentId: 'i', amountCents: 100 }).via, 'STEP_UP');
});

test('no secret, no proof, no withdrawal (fail closed; nothing in source can sign)', () => {
  const saved = { a: process.env.WAPAY_PIN_PROOF_SECRET, b: process.env.PIN_PEPPER, c: process.env.WAPAY_INTERNAL_API_KEY };
  const p = issuePinProof({ accountId: 'acc-1', intentId: 'wa-1', amountCents: 5000 });
  delete process.env.WAPAY_PIN_PROOF_SECRET; delete process.env.PIN_PEPPER; delete process.env.WAPAY_INTERNAL_API_KEY;
  try {
    assert.equal(issuePinProof({ accountId: 'acc-1', intentId: 'wa-1', amountCents: 5000 }), null);
    assert.equal(verifyPinProof(p, { accountId: 'acc-1', intentId: 'wa-1', amountCents: 5000 }).reason, 'NO_SECRET');
  } finally {
    if (saved.a) process.env.WAPAY_PIN_PROOF_SECRET = saved.a;
    if (saved.b) process.env.PIN_PEPPER = saved.b;
    if (saved.c) process.env.WAPAY_INTERNAL_API_KEY = saved.c;
  }
  const src = read('packages/auth/src/pin-proof.ts');
  assert.doesNotMatch(src.slice(src.indexOf('function proofKey'), src.indexOf('const b64')), /\|\|\s*['"`]/, 'no default secret in source');
});

function rail() {
  const calls = [];
  return {
    calls,
    prisma: { providerRequest: { async findUnique() { return null; }, async findMany() { return []; }, async create() { calls.push('row'); return {}; }, async update() { calls.push('update'); return {}; } } },
    ledger: { async ensureWallet() { calls.push('ensureWallet'); }, async postEntry() { calls.push('post'); return {}; }, async reserveHold() { calls.push('hold'); return {}; }, async settleHold() { calls.push('settle'); return {}; }, async releaseHold() { calls.push('release'); return {}; } },
    client: { async performPayout() { calls.push('rail'); return { status: '100', settlement: 'SETTLE' }; } },
  };
}
const providers = [{ method: 'PAYSHAP', label: 'PayShap', providerCode: '66', providerName: 'PayShap Account' }];
const recipient = { firstname: 'Ruth', surname: 'M', mobile: '0731234567', account_number: '1234567890', branch_code: '470010', branch_name: 'Capitec', id_number: '8001015009087' };
const account = { id: 'acc-lisa', profile: {} };

test('requestPayout, the one door to the rail: no proof, a stale proof or another amount refuses before any row, cent, hold or rail call', async () => {
  process.env.WAPAY_PAYOUT_ENABLED = 'true';
  process.env.WAPAY_PAYOUT_KYC = 'off';
  for (const authorization of [null, 'nonsense', proofFor(account, { intentId: 'wa-lisa-1', amountCents: 50000 }), issuePinProof({ accountId: account.id, intentId: 'wa-lisa-1', amountCents: 34200, now: Date.now() - PIN_PROOF_TTL_MS - 1000 })]) {
    const r = rail();
    const out = await requestPayout({ prisma: r.prisma, ledger: r.ledger, client: r.client, account, intentId: 'wa-lisa-1', method: 'PAYSHAP', amountCents: 34200, recipient, providers, authorization });
    assert.equal(out.error, 'NOT_AUTHORISED');
    assert.deepEqual(r.calls, [], 'nothing written, moved, held or sent');
  }
  const r = rail();
  const ok = await requestPayout({ prisma: r.prisma, ledger: r.ledger, client: r.client, account, intentId: 'wa-lisa-1', method: 'PAYSHAP', amountCents: 34200, recipient, providers, authorization: proofFor(account, { intentId: 'wa-lisa-1', amountCents: 34200 }) });
  assert.notEqual(ok.error, 'NOT_AUTHORISED');
  assert.ok(r.calls.includes('rail'), 'with the proof the rail is reached');
  delete process.env.WAPAY_PAYOUT_KYC;
});

test('executeWithdraw without a proof: nothing read, held or sent, and the customer is told plainly', async () => {
  const touched = [];
  const step = await executeWithdraw({
    account,
    data: { intentId: 'wa-lisa-2', method: 'PAYSHAP', amountCents: 34200, recipient: { savedId: 'd1' } },
    deps: { loadDestination: async () => { touched.push('decrypt'); return null; }, requestPayout: async () => { touched.push('rail'); return { ok: true }; } },
  });
  assert.equal(step.done, false);
  assert.match(step.text, /I could not confirm your PIN for this withdrawal, so nothing was sent and nothing has left your balance/);
  assert.deepEqual(touched, [], 'no saved detail decrypted, no rail call');
});

test('structure: only verifyPIN and the business step-up issue proofs; the checks sit before the money in source order; no stand-in verifier', () => {
  const issuers = [];
  const walk = (dir) => {
    for (const f of readdirSync(join(root, dir))) {
      const rel = join(dir, f);
      if (/node_modules|dist|\.next/.test(rel)) continue;
      if (statSync(join(root, rel)).isDirectory()) { walk(rel); continue; }
      if (!/\.(m?js|ts)$/.test(f)) continue;
      if (/issuePinProof\(/.test(read(rel))) issuers.push(rel);
    }
  };
  for (const d of ['lib', 'pages', 'packages', 'apps']) { try { walk(d); } catch { /* absent */ } }
  assert.deepEqual(issuers.sort(), ['lib/business-auth.js', 'packages/auth/src/pin-proof.ts', 'packages/auth/src/pin.ts'], 'nothing else can mint an approval');

  const pin = read('packages/auth/src/pin.ts');
  assert.ok(pin.indexOf('issuePinProof({') > pin.indexOf('// Reset attempts on successful verification'), 'a proof only after a correct PIN');
  const step = read('lib/business-auth.js');
  assert.match(step, /return out\.ok \? \{ ok: true, via: 'password', \.\.\.\(approves \? \{ proof: proofOf\(\) \} : \{\}\) \}/);
  assert.match(step, /return out\.ok \? \{ ok: true, via: 'otp', \.\.\.\(approves \? \{ proof: proofOf\(\) \} : \{\}\) \}/);

  const payouts = read('lib/payouts.js');
  const fn = payouts.slice(payouts.indexOf('export async function requestPayout('));
  const check = fn.indexOf('verifyPinProof(authorization');
  assert.ok(check > 0 && check < fn.indexOf('providerRequest.create(') && check < fn.indexOf('buildBalanceUpgrade(') && check < fn.indexOf('reserveHold(') && check < fn.indexOf('performPayout('), 'proof → row → cent → hold → rail');

  const chat = read('lib/payout-chat.js');
  const ex = chat.slice(chat.indexOf('export async function executeWithdraw('));
  assert.ok(ex.indexOf('verifyPinProof(pinProof') < ex.indexOf('loadDestination'), 'the proof before a saved detail is decrypted');
  assert.match(ex, /authorization: pinProof/);
  assert.doesNotMatch(chat + payouts, /deps\.verifyPinProof|verifyPinProof:\s/, 'no dependency can stand in for the verifier');

  const proc = read('pages/api/webhooks/message-processor-v2.js');
  assert.match(proc, /verifyPIN\(\{ accountId: account\.id, pin: text\.trim\(\), approves: \{ intentId: data\?\.intentId, amountCents: data\?\.amountCents \} \}\)/);
  assert.match(proc, /executeWithdraw\(\{ account, data, pinProof: pinResult\.proof \|\| null \}\)/);
  const biz = read('pages/api/business/payout.js');
  assert.match(biz, /approves: \{ intentId: body\.intentId, amountCents: Number\(body\.amountCents\) \}/);
  assert.match(biz, /authorization: step\.proof \|\| null/);
  // requestPayout has exactly these two production callers.
  const callers = ['lib/payout-chat.js', 'pages/api/business/payout.js'].filter((f) => /requestPayout\)?\(\{|realRequestPayout\)\(\{/.test(read(f)));
  assert.equal(callers.length, 2);
});

test('a card callback approves nothing without the whole configuration, and never with the public sandbox secret outside the sandbox', () => {
  const fields = { _RESPONSE_TOKEN: 'a.b.c' };
  assert.equal(verifyAdumoResponse({ fields, config: { jwtSecret: '', merchantId: '', applicationId: '', sandbox: false } }).error, 'NOT_CONFIGURED');
  assert.equal(verifyAdumoResponse({ fields, config: { jwtSecret: 'x'.repeat(32), merchantId: '', applicationId: 'APP', sandbox: false } }).error, 'NOT_CONFIGURED', 'an empty merchant id cannot match an empty claim');
  assert.equal(verifyAdumoResponse({ fields, config: { jwtSecret: ADUMO_PUBLIC_TEST.jwtSecret, merchantId: 'M', applicationId: 'A', sandbox: false } }).error, 'PUBLIC_TEST_SECRET');
  assert.notEqual(verifyAdumoResponse({ fields, config: { jwtSecret: ADUMO_PUBLIC_TEST.jwtSecret, merchantId: ADUMO_PUBLIC_TEST.merchantId, applicationId: 'A', sandbox: true } }).error, 'PUBLIC_TEST_SECRET', 'the sandbox keeps its test values');
});
