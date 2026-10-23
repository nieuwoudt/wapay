// Continue where the customer left off after the identity check (founder, 2026-10-20).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { takePendingWithdraw, resumeAfterKyc, verifiedResumeLine, VERIFIED_PLAIN_LINE, PENDING_WITHDRAW_TTL_MS } from '../lib/kyc-resume.js';
import { kycReturnUrl } from '../lib/didit-kyc.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const NOW = Date.parse('2026-10-20T12:40:00Z');

test('a pending ask is kept for 24 hours and then dropped', () => {
  const fresh = { kyc: { status: 'VERIFIED', pendingWithdraw: { amountCents: 300000, method: 'PAYSHAP', at: '2026-10-20T12:33:00Z' } } };
  assert.deepEqual(takePendingWithdraw(fresh, NOW), { amountCents: 300000, method: 'PAYSHAP' });
  const stale = { kyc: { pendingWithdraw: { amountCents: 300000, method: null, at: new Date(NOW - PENDING_WITHDRAW_TTL_MS - 1000).toISOString() } } };
  assert.equal(takePendingWithdraw(stale, NOW), null);
  assert.equal(takePendingWithdraw({ kyc: { pendingWithdraw: null } }, NOW), null);
  assert.equal(takePendingWithdraw({}, NOW), null);
});

test('resumeAfterKyc: verified line, then the flow reopened with the kept ask, state set, pending cleared', async () => {
  const sends = []; const states = []; const patches = [];
  const prisma = { account: { findUnique: async () => null, updateMany: async () => ({ count: 1 }), update: async () => ({}) }, $queryRawUnsafe: async () => [], $executeRawUnsafe: async () => 1, $executeRaw: async () => 1, $queryRaw: async () => [] };
  const account = { id: 'cmi7t758h000dnf0ndpexchob', waId: '27600000919', profile: { language: 'en', kyc: { status: 'VERIFIED', pendingWithdraw: { amountCents: 300000, method: 'PAYSHAP', at: '2026-10-20T12:33:00Z' } } } };
  const deps = {
    startWithdraw: async ({ ask }) => { patches.push(ask); return { state: 'PAYOUT_ACCOUNT', data: { amountCents: ask.amountCents, method: ask.method }, text: 'What is the bank account number the money must go to?' }; },
    updateConversationState: async (waId, state, data) => { states.push({ waId, state, data }); },
    send: async (a) => { sends.push(a); return { ok: true }; },
    localize: async (t) => t,
  };
  const r = await resumeAfterKyc({ prisma, account, deps, now: NOW });
  assert.equal(r.resumed, true); assert.equal(r.sent, true);
  assert.equal(sends[0].text, verifiedResumeLine({ amountCents: 300000 }));
  assert.match(sends[0].text, /^✅ You are verified\. Continuing your pay-out of R3,000\./);
  assert.deepEqual(patches[0], { amountCents: 300000, method: 'PAYSHAP' }, 'the flow reopens with the kept amount and method');
  assert.equal(states[0].state, 'PAYOUT_ACCOUNT'); assert.equal(states[0].waId, '27600000919');
  assert.equal(sends[1].text, 'What is the bank account number the money must go to?');
  // nothing pending: the plain line only
  const sends2 = [];
  const r2 = await resumeAfterKyc({ prisma, account: { ...account, profile: { kyc: { status: 'VERIFIED' } } }, deps: { ...deps, send: async (a) => { sends2.push(a); return { ok: true }; } }, now: NOW });
  assert.equal(r2.resumed, false); assert.equal(sends2.length, 1); assert.equal(sends2[0].text, VERIFIED_PLAIN_LINE);
  for (const t of [verifiedResumeLine({ amountCents: 5000 }), VERIFIED_PLAIN_LINE]) { assert.ok(!/—/.test(t)); assert.ok(!/\b(tomorrow|soon|shortly)\b/i.test(t)); }
});

test('the Didit session sends the customer back into the chat when the check is done', () => {
  assert.equal(kycReturnUrl({}), 'https://wa.me/27760497624?text=withdraw');
  assert.equal(kycReturnUrl({ WAPAY_WA_NUMBER: '+27 60 000 0000' }), 'https://wa.me/27600000000?text=withdraw');
  assert.match(read('../lib/didit-kyc.js'), /callback: kycReturnUrl\(\),/);
});

test('the flow keeps the interrupted ask at both identity-check stops and picks it up on a bare withdraw; webhook and manual sync continue it', () => {
  const chat = read('../lib/payout-chat.js');
  assert.match(chat, /if \(rules\.error === 'KYC_REQUIRED'\) await rememberPendingWithdraw\(\{ prisma: prismaClient, accountId: account\.id, ask: \{ amountCents, method: data\.method \|\| null \} \}\);/);
  assert.match(chat, /await rememberPendingWithdraw\(\{ prisma: prismaClient, accountId: account\.id, ask: \{ amountCents: data\.amountCents, method: data\.method \|\| null \} \}\);/);
  assert.match(chat, /const pending = takePendingWithdraw\(account\?\.profile\);/);
  assert.match(read('../pages/api/webhooks/didit.js'), /if \(status === 'VERIFIED'\) \{[\s\S]*resumeAfterKyc\(/);
  assert.match(read('../pages/api/admin/kyc.js'), /kycStatus === 'VERIFIED' && synced\.changed[\s\S]*resumeAfterKyc\(/);
});
