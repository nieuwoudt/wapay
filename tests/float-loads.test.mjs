// Float loads and the float reconciliation (founder, 2026-10-20).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFloatLoad, ACCT, validateBalanced } from '../lib/ledger-core.js';
import { loadIdemKey, validateLoad, recordFloatLoad, floatRecon, listFloatLoads, FLOAT_KEYS } from '../lib/float-loads.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

test('a float load debits the float asset and credits the bank, balanced, with the operator facts in meta', () => {
  const e = buildFloatLoad({ key: 'ott_payout', amountCents: 250000, idemKey: 'float-load:OTT_PAYOUT:2026-10-20:250000:ref', reference: 'ref', loadedAt: '2026-10-20', by: 'founder' });
  assert.equal(e.source, 'FLOAT_LOAD');
  assert.deepEqual(e.postings.map((p) => [p.accountCode, p.debitCents || 0, p.creditCents || 0]), [['ASSET:FLOAT:OTT_PAYOUT', 250000, 0], ['FUNDING:BANK', 0, 250000]]);
  assert.doesNotThrow(() => validateBalanced(e.postings));
  assert.equal(e.meta.key, 'OTT_PAYOUT'); assert.equal(e.meta.loadedAt, '2026-10-20');
  assert.equal(ACCT.floatAsset('blu'), 'ASSET:FLOAT:BLU');
  assert.throws(() => buildFloatLoad({ key: 'OTT_PAYOUT', amountCents: 0, idemKey: 'x' }));
});

test('validation and the deterministic idempotency key', () => {
  assert.deepEqual(FLOAT_KEYS, ['OTT_PAYOUT', 'OTT', 'BLU', 'YOYO', 'PAYFAST']);
  assert.equal(validateLoad({ key: 'nope', amountCents: 100 }).error, 'BAD_KEY');
  assert.equal(validateLoad({ key: 'OTT_PAYOUT', amountCents: -5 }).error, 'BAD_AMOUNT');
  assert.equal(validateLoad({ key: 'OTT_PAYOUT', amountCents: 100, loadedAt: '20/10/2026' }).error, 'BAD_DATE');
  const v = validateLoad({ key: 'ott_payout', amountCents: 250000, loadedAt: '2026-10-20T14:00:00Z', reference: ' ABC 123 ' });
  assert.deepEqual(v, { ok: true, key: 'OTT_PAYOUT', amountCents: 250000, loadedAt: '2026-10-20', reference: 'ABC 123' });
  assert.equal(loadIdemKey({ key: 'OTT_PAYOUT', loadedAt: '2026-10-20', amountCents: 250000, reference: 'ABC 123' }), 'float-load:OTT_PAYOUT:2026-10-20:250000:abc-123');
  assert.equal(loadIdemKey({ key: 'OTT_PAYOUT', loadedAt: '2026-10-20', amountCents: 250000, reference: null }), 'float-load:OTT_PAYOUT:2026-10-20:250000:noref');
});

test('recordFloatLoad posts once; the same load again is a replay, not a second load', async () => {
  const posted = [];
  const post = async (entry) => { const again = posted.some((p) => p.idemKey === entry.idemKey); if (!again) posted.push(entry); return { journalEntryId: 'je-' + posted.length, replayed: again }; };
  const a = await recordFloatLoad({ prisma: {}, key: 'OTT_PAYOUT', amountCents: 250000, loadedAt: '2026-10-20', reference: 'bank 1', post });
  const b = await recordFloatLoad({ prisma: {}, key: 'OTT_PAYOUT', amountCents: 250000, loadedAt: '2026-10-20', reference: 'bank 1', post });
  assert.equal(a.ok, true); assert.equal(a.replayed, false); assert.equal(b.replayed, true); assert.equal(posted.length, 1);
  assert.equal((await recordFloatLoad({ prisma: {}, key: 'BLU', amountCents: 'x', post })).error, 'BAD_AMOUNT');
});

test('floatRecon: loads minus the journal usage for the pay-out float; other floats list loads only', async () => {
  const prisma = {
    journalEntry: {
      findMany: async ({ where }) => {
        if (where.source === 'FLOAT_LOAD') return [
          { id: 'a', idemKey: 'k1', createdAt: new Date('2026-10-20T10:00:00Z'), metadata: { key: 'OTT_PAYOUT', amountCents: 250000, loadedAt: '2026-10-20', reference: 'r1' } },
          { id: 'b', idemKey: 'k2', createdAt: new Date('2026-10-19T10:00:00Z'), metadata: { key: 'OTT_PAYOUT', amountCents: 100000, loadedAt: '2026-10-19', reference: null } },
          { id: 'c', idemKey: 'k3', createdAt: new Date('2026-10-19T10:00:00Z'), metadata: { key: 'BLU', amountCents: 50000, loadedAt: '2026-10-19', reference: null } },
        ];
        if (where.source?.startsWith === 'CASHOUT') return [
          { lines: [{ accountCode: 'WALLET:x:CASH', debitCents: 30800, creditCents: 0 }, { accountCode: 'CLEARING:OTT', debitCents: 0, creditCents: 30000 }, { accountCode: 'REVENUE:FEE:CASHOUT', debitCents: 0, creditCents: 800 }] },
          { lines: [{ accountCode: 'EXPENSE:PROVIDER:OTT', debitCents: 288, creditCents: 0 }, { accountCode: 'CLEARING:OTT', debitCents: 0, creditCents: 288 }] },
        ];
        return [];
      },
    },
  };
  const r = await floatRecon({ prisma, key: 'OTT_PAYOUT' });
  assert.equal(r.loads, 2); assert.equal(r.loadedCents, 350000); assert.equal(r.usageCents, 30288); assert.equal(r.expectedCents, 319712); assert.equal(r.lastLoad.loadedAt, '2026-10-20');
  const blu = await floatRecon({ prisma, key: 'BLU' });
  assert.equal(blu.loads, 1); assert.equal(blu.loadedCents, 50000); assert.equal(blu.usageCents, null); assert.equal(blu.expectedCents, null);
  assert.equal((await listFloatLoads({ prisma, key: 'OTT_PAYOUT' })).length, 2);
});

test('the route needs an admin and the Floats card carries the recon pill and the record form', () => {
  const route = read('../pages/api/admin/float-load.js');
  assert.match(route, /requireAdmin\(req\)/); assert.match(route, /recordFloatLoad\(/); assert.match(route, /floatRecon\(/);
  const floats = read('../pages/api/admin/floats.js');
  assert.match(floats, /floatRecon\(\{ key: 'OTT_PAYOUT' \}\)/); assert.match(floats, /reconDriftCents/);
  const page = read('../pages/admin/index.js');
  assert.match(page, /function RecordLoad\(/); assert.match(page, /\/api\/admin\/float-load/); assert.match(page, /'Recon',/);
});
