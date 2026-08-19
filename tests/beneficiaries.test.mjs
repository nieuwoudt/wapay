/**
 * Beneficiaries — remembered recipients + contact-card sends.
 *
 * Locks:
 * - rememberBeneficiary (stubbed prisma): normalises the msisdn, upserts on
 *   (accountId, msisdn), bumps usage, fills a name in when learned but never
 *   overwrites a known name with null, and rejects invalid numbers;
 * - findBeneficiariesByName: name lookup shape (case-insensitive, recent
 *   first) and the too-short-query guard;
 * - static wiring: the webhook turns a 'contacts' message into a
 *   sharedContact; the processor routes it (mid-flow fill or fresh
 *   send-money ask), remembers every successful gift recipient, resolves
 *   names in the VOUCHER_GIFT_RECIPIENT state, and the orchestrator's
 *   SEND_VOUCHER dispatch resolves recipientName through beneficiaries.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  rememberBeneficiary,
  findBeneficiariesByName,
  formatBeneficiary,
} from '../lib/beneficiaries.js';

const processorSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);
const webhookSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/whatsapp.js', import.meta.url)),
  'utf8'
);

function stubPrisma() {
  const calls = { upserts: [], findManys: [] };
  return {
    calls,
    beneficiary: {
      upsert: async (q) => {
        calls.upserts.push(q);
        return { id: 'b1', ...q.create };
      },
      findMany: async (q) => {
        calls.findManys.push(q);
        return [];
      },
    },
  };
}

// ---------------------------------------------------------------------------
// rememberBeneficiary
// ---------------------------------------------------------------------------

test('remember: normalises 27-prefixed numbers and upserts on (accountId, msisdn)', async () => {
  const stub = stubPrisma();
  await rememberBeneficiary({ prisma: stub, accountId: 'acc1', msisdn: '27798743910', name: ' Philly ' });
  const q = stub.calls.upserts[0];
  assert.deepEqual(q.where, { accountId_msisdn: { accountId: 'acc1', msisdn: '0798743910' } });
  assert.equal(q.create.name, 'Philly', 'name is trimmed');
  assert.equal(q.update.name, 'Philly', 'a learned name is written on update too');
  assert.deepEqual(q.update.timesUsed, { increment: 1 });
});

test('remember: a known name is never overwritten with null', async () => {
  const stub = stubPrisma();
  await rememberBeneficiary({ prisma: stub, accountId: 'acc1', msisdn: '0798743910' });
  const q = stub.calls.upserts[0];
  assert.ok(!('name' in q.update), 'no-name use must not clear the stored name');
  assert.equal(q.create.name, null);
});

test('remember: invalid numbers and missing account are rejected without a DB call', async () => {
  const stub = stubPrisma();
  assert.equal(await rememberBeneficiary({ prisma: stub, accountId: 'acc1', msisdn: '12345' }), null);
  assert.equal(await rememberBeneficiary({ prisma: stub, accountId: '', msisdn: '0798743910' }), null);
  assert.equal(stub.calls.upserts.length, 0);
});

test('remember: swallows DB failures (best-effort around money flows)', async () => {
  const boom = { beneficiary: { upsert: async () => { throw new Error('db down'); } } };
  const out = await rememberBeneficiary({ prisma: boom, accountId: 'acc1', msisdn: '0798743910' });
  assert.equal(out, null);
});

// ---------------------------------------------------------------------------
// findBeneficiariesByName
// ---------------------------------------------------------------------------

test('find: case-insensitive contains, recent first; short queries return [] without a DB call', async () => {
  const stub = stubPrisma();
  await findBeneficiariesByName({ prisma: stub, accountId: 'acc1', query: 'philly' });
  const q = stub.calls.findManys[0];
  assert.deepEqual(q.where, { accountId: 'acc1', name: { contains: 'philly', mode: 'insensitive' } });
  assert.deepEqual(q.orderBy, { lastUsedAt: 'desc' });

  stub.calls.findManys.length = 0;
  assert.deepEqual(await findBeneficiariesByName({ prisma: stub, accountId: 'acc1', query: 'p' }), []);
  assert.equal(stub.calls.findManys.length, 0, 'single-letter query must not hit the DB');
});

test('formatBeneficiary shows name (number) or bare number', () => {
  assert.equal(formatBeneficiary({ name: 'Philly', msisdn: '0798743910' }), 'Philly (0798743910)');
  assert.equal(formatBeneficiary({ name: null, msisdn: '0798743910' }), '0798743910');
});

// ---------------------------------------------------------------------------
// Static wiring
// ---------------------------------------------------------------------------

test('static: webhook handles contacts-type messages and passes sharedContact', () => {
  assert.match(webhookSource, /messageType === 'contacts'/);
  assert.match(webhookSource, /phone\.wa_id \|\| phone\.phone/);
  assert.match(webhookSource, /sharedContact,?\s*\}\)/);
});

test('static: processor routes sharedContact before text handling', () => {
  assert.match(processorSource, /if \(sharedContact\) \{\s*\n\s*return await handleSharedContact/);
  const start = processorSource.indexOf('async function handleSharedContact');
  assert.ok(start > -1);
  const body = processorSource.slice(start, processorSource.indexOf('\nasync function ', start));
  assert.match(body, /rememberBeneficiary\(\{ accountId: account\.id, msisdn, name \}\)/);
  assert.match(body, /VOUCHER_GIFT_RECIPIENT' \|\| state === 'AIRTIME_MSISDN'/, 'mid-flow shares fill the waiting number');
  assert.match(body, /'VOUCHER_GIFT_AMOUNT', \{ recipientMsisdn: msisdn \}/, 'fresh shares start a send-money ask');
  assert.match(body, /isValidSaMsisdn\(msisdn\)/, 'the contact number is validated');
});

test('static: every successful gift remembers the recipient', () => {
  const start = processorSource.indexOf('async function notifyGiftRecipient');
  const body = processorSource.slice(start, processorSource.indexOf('\nasync function ', start));
  assert.match(body, /rememberBeneficiary\(\{ accountId: account\?\.id, msisdn: targetMsisdn \}\)/);
});

test('static: the recipient state resolves beneficiary names', () => {
  const start = processorSource.indexOf("case 'VOUCHER_GIFT_RECIPIENT':");
  const body = processorSource.slice(start, processorSource.indexOf("case 'VOUCHER_GIFT_CONFIRM':", start));
  assert.match(body, /findBeneficiariesByName\(\{ accountId: account\.id, query: text \}\)/);
  assert.match(body, /STATE_VOUCHER_GIFT_RECIPIENT_BENEFICIARY/);
});

test('static: SEND_VOUCHER dispatch resolves recipientName through beneficiaries', () => {
  const start = processorSource.indexOf('async function dispatchOrchestratorAction');
  const body = processorSource.slice(start, processorSource.indexOf('\nasync function ', start));
  assert.match(body, /findBeneficiariesByName\(\{ accountId: account\.id, query: recipientName \}\)/);
  assert.match(body, /msisdn: recipientMsisdn, productHint: 'SEND_MONEY'/, 'the resolved number feeds resolveGift');
});
