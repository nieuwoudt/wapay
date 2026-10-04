/**
 * Remembered pay-out details (2026-10-04): the field vault, the two tables
 * through a stub Prisma, the masks, the cap, the erasure, and the "no key, no
 * feature" rule. Nothing here touches a database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptPii, decryptPii, vaultConfigured, currentKeyVersion, maskDigits, last3 } from '../lib/pii-vault.js';
import {
  MAX_DESTINATIONS, DESTINATION_FAMILY, fingerprintOf, destinationLabel, beneficiariesAvailable,
  savePayoutIdentity, getPayoutIdentity, loadPayoutIdentitySecret,
  savePayoutDestination, listPayoutDestinations, loadPayoutDestinationSecret, touchPayoutDestination, forgetPayoutDetails,
} from '../lib/payout-beneficiaries.js';

const KEY1 = 'a'.repeat(64);
const KEY2 = Buffer.alloc(32, 7).toString('base64');
function withKey(fn, key = KEY1, version = null) {
  const prev = { k: process.env.WAPAY_PII_KEY, v: process.env.WAPAY_PII_KEY_VERSION, v1: process.env.WAPAY_PII_KEY_V1 };
  if (key) process.env.WAPAY_PII_KEY = key; else delete process.env.WAPAY_PII_KEY;
  if (version) process.env.WAPAY_PII_KEY_VERSION = String(version); else delete process.env.WAPAY_PII_KEY_VERSION;
  return Promise.resolve(fn()).finally(() => {
    for (const [k, name] of [['k', 'WAPAY_PII_KEY'], ['v', 'WAPAY_PII_KEY_VERSION'], ['v1', 'WAPAY_PII_KEY_V1']]) {
      if (prev[k] === undefined) delete process.env[name]; else process.env[name] = prev[k];
    }
  });
}

/** Just enough Prisma for the two tables. */
function stubPrisma() {
  const identities = new Map();
  const destinations = new Map();
  let seq = 0;
  const matches = (row, where) => Object.entries(where || {}).every(([k, v]) => (v && typeof v === 'object' && 'in' in v ? v.in.includes(row[k]) : row[k] === v));
  return {
    identities, destinations,
    payoutIdentity: {
      findUnique: async ({ where }) => identities.get(where.accountId) || null,
      upsert: async ({ where, create, update }) => { const row = identities.get(where.accountId) ? { ...identities.get(where.accountId), ...update } : { ...create }; identities.set(where.accountId, row); return row; },
      deleteMany: async ({ where }) => { let n = 0; for (const [k, r] of identities) if (matches(r, where)) { identities.delete(k); n += 1; } return { count: n }; },
    },
    payoutDestination: {
      findMany: async ({ where, orderBy, take }) => { let rows = [...destinations.values()].filter((r) => matches(r, where)); if (orderBy?.lastUsedAt === 'desc') rows.sort((a, b) => b.lastUsedAt - a.lastUsedAt); return take ? rows.slice(0, take) : rows; },
      findUnique: async ({ where }) => destinations.get(where.id) || null,
      upsert: async ({ where, create, update }) => {
        const key = where.accountId_fingerprint;
        const existing = [...destinations.values()].find((r) => r.accountId === key.accountId && r.fingerprint === key.fingerprint);
        if (existing) { Object.assign(existing, { ...update, timesUsed: existing.timesUsed + (update.timesUsed?.increment || 0) }); return existing; }
        const row = { id: `d${++seq}`, createdAt: new Date(), timesUsed: 1, ...create }; destinations.set(row.id, row); return row;
      },
      deleteMany: async ({ where }) => { let n = 0; for (const [k, r] of destinations) if (matches(r, where)) { destinations.delete(k); n += 1; } return { count: n }; },
      updateMany: async ({ where, data }) => { let n = 0; for (const r of destinations.values()) if (matches(r, where)) { Object.assign(r, { ...data, timesUsed: r.timesUsed + (data.timesUsed?.increment || 0) }); n += 1; } return { count: n }; },
    },
  };
}

test('vault: AES-GCM round trip, fresh IV per call, masks, and no key means no feature', async () => {
  await withKey(async () => {
    assert.equal(vaultConfigured(), true); assert.equal(currentKeyVersion(), 1);
    const a = encryptPii('62012345678'); const b = encryptPii('62012345678');
    assert.notEqual(a.enc, b.enc, 'a fresh IV every time'); assert.ok(a.enc.startsWith('enc1:')); assert.ok(!a.enc.includes('62012345678'));
    assert.equal(decryptPii(a.enc, a.keyVersion), '62012345678');
    assert.throws(() => decryptPii(a.enc.slice(0, -2) + 'xx', 1), /authentication failed|VAULT_BAD_VALUE|not an encrypted value/);
    assert.throws(() => decryptPii('plain', 1), /not an encrypted value/);
  });
  await withKey(async () => {
    assert.equal(vaultConfigured(), false); assert.equal(beneficiariesAvailable(), false);
    assert.throws(() => encryptPii('x'), (e) => e.code === 'VAULT_NOT_CONFIGURED');
    const r = await savePayoutIdentity({ prisma: stubPrisma(), accountId: 'a1', fullName: 'Thandi Nkosi', idNumber: '9001015009087' });
    assert.deepEqual(r, { ok: false, error: 'VAULT_NOT_CONFIGURED' });
  }, null);
  assert.equal(maskDigits('27787051175'), '•••175'); assert.equal(last3('9001015009087'), '087'); assert.equal(maskDigits(''), '•••');
});

test('vault: key rotation keeps old rows readable (version on the row, old key as WAPAY_PII_KEY_V1)', async () => {
  let old;
  await withKey(() => { old = encryptPii('9001015009087'); });
  await withKey(() => {
    process.env.WAPAY_PII_KEY_V1 = KEY1;
    assert.equal(currentKeyVersion(), 2);
    const fresh = encryptPii('9001015009087'); assert.equal(fresh.keyVersion, 2);
    assert.equal(decryptPii(fresh.enc, 2), '9001015009087');
    assert.equal(decryptPii(old.enc, old.keyVersion), '9001015009087', 'the version-1 row still decrypts with the kept key');
    delete process.env.WAPAY_PII_KEY_V1;
    assert.throws(() => decryptPii(old.enc, 1), (e) => e.code === 'VAULT_NOT_CONFIGURED');
  }, KEY2, 2);
});

test('identity: validated, stored encrypted with a last-3 mask, read masked, decrypted only by the secret loader', async () => {
  await withKey(async () => {
    const prisma = stubPrisma();
    assert.equal((await savePayoutIdentity({ prisma, accountId: 'a1', fullName: 'Nieuwoudt', idNumber: '9001015009087' })).error, 'BAD_NAME', 'one word is not a full name');
    assert.equal((await savePayoutIdentity({ prisma, accountId: 'a1', fullName: 'Nieuwoudt Gresse', idNumber: '900101500908' })).error, 'BAD_ID');
    const r = await savePayoutIdentity({ prisma, accountId: 'a1', fullName: '  Nieuwoudt   Gresse ', idNumber: '900101 5009 087' });
    assert.deepEqual(r, { ok: true, fullName: 'Nieuwoudt Gresse', idLast3: '087' });
    const row = prisma.identities.get('a1');
    assert.ok(row.idEnc.startsWith('enc1:') && !row.idEnc.includes('9001015009087'), 'the ID number is never stored in clear');
    assert.equal(row.idLast3, '087'); assert.equal(row.keyVersion, 1); assert.equal(row.idType, 'RSAID');
    const masked = await getPayoutIdentity({ prisma, accountId: 'a1' });
    assert.deepEqual(Object.keys(masked).sort(), ['consentAt', 'fullName', 'idLast3', 'idType']);
    assert.ok(!JSON.stringify(masked).includes('9001015009087'));
    const secret = await loadPayoutIdentitySecret({ prisma, accountId: 'a1' });
    assert.equal(secret.idNumber, '9001015009087'); assert.equal(secret.fullName, 'Nieuwoudt Gresse');
    assert.equal(await getPayoutIdentity({ prisma, accountId: 'nobody' }), null);
    assert.equal(await loadPayoutIdentitySecret({ prisma, accountId: 'nobody' }), null);
  });
});

test('destinations: masked labels, one row per number across the bank family, cap of five, secrets only to the owner, erasure in one call', async () => {
  await withKey(async () => {
    const prisma = stubPrisma();
    assert.equal(destinationLabel('PAYSHAP', { account_number: '62012345394', branch_name: 'FNB' }), 'FNB account •••394');
    assert.equal(destinationLabel('NEDCASH', { mobile: '0787051175' }), 'Nedbank cash to •••175');
    assert.equal(DESTINATION_FAMILY.RTC, 'BANK'); assert.equal(DESTINATION_FAMILY.EWALLET, 'CASH');
    assert.equal(fingerprintOf('a1', 'PAYSHAP', '62012345394'), fingerprintOf('a1', 'RTC', '620 1234 5394'), 'the same account via PayShap or RTC is one destination');
    assert.notEqual(fingerprintOf('a1', 'PAYSHAP', '62012345394'), fingerprintOf('a2', 'PAYSHAP', '62012345394'));

    const one = await savePayoutDestination({ prisma, accountId: 'a1', method: 'PAYSHAP', recipient: { account_number: '62012345394', branch_code: '250655', branch_name: 'FNB' } });
    assert.equal(one.ok, true); assert.equal(one.label, 'FNB account •••394'); assert.equal(one.pruned, 0);
    const again = await savePayoutDestination({ prisma, accountId: 'a1', method: 'RTC', recipient: { account_number: '62012345394', branch_code: '250655', branch_name: 'FNB' } });
    assert.equal(again.id, one.id, 'same number, same row'); assert.equal(prisma.destinations.get(one.id).timesUsed, 2);
    const cash = await savePayoutDestination({ prisma, accountId: 'a1', method: 'NEDCASH', recipient: { mobile: '0787051175' } });
    assert.equal(cash.label, 'Nedbank cash to •••175');
    const stored = prisma.destinations.get(one.id);
    assert.ok(stored.accountEnc.startsWith('enc1:') && !stored.accountEnc.includes('62012345394') && stored.accountLast3 === '394');
    assert.equal(stored.mobileEnc, null);

    const list = await listPayoutDestinations({ prisma, accountId: 'a1' });
    assert.deepEqual(list.map((d) => d.label).sort(), ['FNB account •••394', 'Nedbank cash to •••175']);
    for (const d of list) { assert.ok(!('accountEnc' in d) && !('mobileEnc' in d), 'no encrypted field leaves the list'); assert.ok(!JSON.stringify(d).match(/\d{6,}/), 'no long digit run in the list'); }
    assert.deepEqual((await listPayoutDestinations({ prisma, accountId: 'a1', family: 'BANK' })).map((d) => d.label), ['FNB account •••394']);

    const secret = await loadPayoutDestinationSecret({ prisma, accountId: 'a1', id: one.id });
    assert.deepEqual(secret, { id: one.id, method: 'RTC', family: 'BANK', label: 'FNB account •••394', account_number: '62012345394', branch_code: '250655', branch_name: 'FNB' });
    assert.equal(await loadPayoutDestinationSecret({ prisma, accountId: 'a2', id: one.id }), null, 'another account never reads it');
    assert.equal((await loadPayoutDestinationSecret({ prisma, accountId: 'a1', id: cash.id })).mobile, '0787051175');

    await touchPayoutDestination({ prisma, accountId: 'a1', id: one.id });
    assert.equal(prisma.destinations.get(one.id).timesUsed, 3);

    for (let i = 0; i < 5; i += 1) await savePayoutDestination({ prisma, accountId: 'a1', method: 'CASHSEND', recipient: { mobile: `08311100${10 + i}` } });
    assert.equal(prisma.destinations.size, MAX_DESTINATIONS, 'the sixth and seventh saves pruned the oldest');
    assert.equal((await savePayoutDestination({ prisma, accountId: 'a1', method: 'PAYSHAP', recipient: { account_number: '123' } })).error, 'BAD_NUMBER');
    assert.equal((await savePayoutDestination({ prisma, accountId: 'a1', method: 'BITCOIN', recipient: { account_number: '12345678' } })).error, 'BAD_METHOD');

    await savePayoutIdentity({ prisma, accountId: 'a1', fullName: 'Nieuwoudt Gresse', idNumber: '9001015009087' });
    await savePayoutDestination({ prisma, accountId: 'a2', method: 'PAYSHAP', recipient: { account_number: '99912345678', branch_name: 'Capitec' } });
    const gone = await forgetPayoutDetails({ prisma, accountId: 'a1' });
    assert.deepEqual(gone, { ok: true, identities: 1, destinations: 5 });
    assert.equal(prisma.destinations.size, 1, 'the other account keeps its row');
    assert.deepEqual(await listPayoutDestinations({ prisma, accountId: 'a1' }), []);
    assert.equal(await getPayoutIdentity({ prisma, accountId: 'a1' }), null);
  });
});

test('reads are best-effort: a broken database answers [] / null, never a throw into the chat', async () => {
  const broken = { payoutIdentity: { findUnique: async () => { throw new Error('relation does not exist'); } }, payoutDestination: { findMany: async () => { throw new Error('relation does not exist'); }, findUnique: async () => { throw new Error('x'); }, deleteMany: async () => { throw new Error('x'); } } };
  assert.deepEqual(await listPayoutDestinations({ prisma: broken, accountId: 'a1' }), []);
  assert.equal(await getPayoutIdentity({ prisma: broken, accountId: 'a1' }), null);
  assert.equal(await loadPayoutDestinationSecret({ prisma: broken, accountId: 'a1', id: 'd1' }), null);
  assert.equal(await loadPayoutIdentitySecret({ prisma: broken, accountId: 'a1' }), null);
  assert.deepEqual(await forgetPayoutDetails({ prisma: broken, accountId: 'a1' }), { ok: false, identities: 0, destinations: 0 });
});
