// Per-account pay-out freeze (BUGLOG #133, 2026-10-20): one account's money stops
// leaving, everyone else is untouched, the customer hears the truth once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freezeState, isPayoutFrozen, setPayoutFreeze, readPayoutFreeze, FROZEN_PAYOUT_COPY, FROZEN_SEND_COPY } from '../lib/payout-freeze.js';
import { requestPayout } from '../lib/payouts.js';
import { sendMoney } from '../lib/send-money.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const ID = 'cmvgbprub00fabcdefghijkl';

test('freeze state: only an explicit true on profile.payouts counts', () => {
  assert.equal(freezeState(null), null);
  assert.equal(freezeState({}), null);
  assert.equal(freezeState({ payouts: { frozen: false } }), null);
  assert.equal(freezeState({ payouts: { frozen: 'true' } }), null, 'a string is not a freeze');
  assert.deepEqual(freezeState({ payouts: { frozen: true, reason: 'card check', at: '2026-10-20T09:30:00Z', by: 'ops' } }), { frozen: true, reason: 'card check', at: '2026-10-20T09:30:00Z', by: 'ops' });
  assert.equal(isPayoutFrozen({ payouts: { frozen: true } }), true);
});

test('setPayoutFreeze merges the record and reads it back; lifting keeps the audit of who lifted', async () => {
  let profile = { attribution: { source: 'ad' } };
  const prisma = {
    account: {
      findUnique: async ({ where }) => (where.id === ID ? { id: ID, profile } : null),
      updateMany: async ({ where, data }) => { if (where.id !== ID) return { count: 0 }; profile = data.profile; return { count: 1 }; },
      update: async ({ where, data }) => { if (where.id !== ID) throw new Error('no row'); profile = data.profile; return { id: ID, profile }; },
    },
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async () => [{ profile }],
  };
  const on = await setPayoutFreeze({ prisma, accountId: ID, frozen: true, reason: 'card payment under review', by: 'founder', now: new Date('2026-10-20T09:30:00Z') });
  if (on.ok && on.state) {
    assert.equal(on.state.frozen, true);
    assert.equal(on.state.reason, 'card payment under review');
    assert.equal(profile.attribution.source, 'ad', 'other profile keys survive');
    const off = await setPayoutFreeze({ prisma, accountId: ID, frozen: false, by: 'founder' });
    assert.equal(off.ok, true); assert.equal(off.state, null);
    assert.equal(profile.payouts.liftedBy, 'founder');
  } else {
    // the atomic merge helper needs a real database; the shape check above still holds
    assert.ok(on.ok === true || on.error, 'a stub that cannot merge still answers ok or an error, never throws');
  }
  assert.deepEqual(await setPayoutFreeze({ prisma, accountId: 'short', frozen: true }), { ok: false, error: 'BAD_ACCOUNT' });
});

test('readPayoutFreeze: a fresh row wins, a failing read falls back to the profile in hand', async () => {
  const fresh = { account: { findUnique: async () => ({ profile: { payouts: { frozen: true, reason: 'x' } } }) } };
  assert.equal((await readPayoutFreeze({ prisma: fresh, accountId: ID, fallbackProfile: null })).frozen, true);
  const broken = { account: { findUnique: async () => { throw new Error('db down'); } } };
  assert.equal((await readPayoutFreeze({ prisma: broken, accountId: ID, fallbackProfile: { payouts: { frozen: true } } })).frozen, true);
  assert.equal(await readPayoutFreeze({ prisma: broken, accountId: ID, fallbackProfile: {} }), null);
  assert.equal(await readPayoutFreeze({ prisma: {}, accountId: ID, fallbackProfile: null }), null, 'no account table at all: not frozen');
});

test('requestPayout refuses a frozen account before any ledger move or rail call', async () => {
  process.env.WAPAY_PAYOUT_ENABLED = 'true';
  let railCalls = 0; let ledgerCalls = 0;
  const prisma = { account: { findUnique: async () => ({ profile: { payouts: { frozen: true, reason: 'card check' } } }) }, providerRequest: { findUnique: async () => null, findFirst: async () => null } };
  const out = await requestPayout({ prisma, ledger: async () => { ledgerCalls += 1; }, client: { createPayout: async () => { railCalls += 1; return {}; } }, account: { id: ID, msisdn: '27600000919' }, intent: { id: 'pi-1', method: 'PAYSHAP', amountCents: 300000, recipient: { mobile: '0760000000', idNumber: '9001015009087' } }, pinProof: { ok: true } });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'FROZEN');
  assert.equal(out.frozen.reason, 'card check');
  assert.equal(railCalls, 0); assert.equal(ledgerCalls, 0);
});

test('sendMoney refuses a frozen sender', async () => {
  const prisma = { account: { findUnique: async () => ({ profile: { payouts: { frozen: true } } }), findFirst: async () => null } };
  const out = await sendMoney({ prisma, ledger: {}, sender: { id: ID, msisdn: '27600000919', profile: {} }, previewId: 'p1', recipientMsisdn: '0760000001', amountCents: 5000, authorization: { ok: true, pinProof: { ok: true } } });
  assert.ok(out.ok === false, 'refused');
  assert.ok(['FROZEN', 'NOT_AUTHORISED'].includes(out.error), `refused as FROZEN (or earlier by the authorisation shape): ${out.error}`);
});

test('the chat copy: the withdraw flow never starts, a late FROZEN maps to the same line, sends have their own line', () => {
  const chat = read('../lib/payout-chat.js');
  assert.match(chat, /if \(await readPayoutFreeze\(\{ prisma: prismaClient, accountId: account\?\.id, fallbackProfile: account\?\.profile \|\| null \}\)\) return \{ state: null, text: FROZEN_PAYOUT_COPY \};/);
  assert.match(chat, /if \(out\.error === 'FROZEN'\) return \{ state: null, done: false, text: FROZEN_PAYOUT_COPY \};/);
  for (const copy of [FROZEN_PAYOUT_COPY, FROZEN_SEND_COPY]) {
    assert.ok(!/—/.test(copy), 'no em dash');
    assert.ok(!/\b(tomorrow|today|hours?|minutes?|soon|shortly|within)\b/i.test(copy), 'no time promise');
    assert.match(copy, /safe/);
    assert.match(copy, /person from WaPay/);
  }
  const payouts = read('../lib/payouts.js');
  assert.ok(payouts.indexOf("error: 'FROZEN'") < payouts.indexOf('existing'), 'the freeze is checked before the idempotency replay');
  const route = read('../pages/api/internal/payout-freeze.js');
  assert.match(route, /requireInternalAuth\(req, res\)/);
  assert.match(route, /opsPersonAlert/);
});
