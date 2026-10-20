/**
 * "Send money" moves balance, never a voucher (BUGLOG #116, founder
 * 2026-10-18). A member is paid at once (P2P_SEND, free); anyone else's money
 * is held (GIFT_HELD, free) and becomes their balance when they join, once;
 * unclaimed after 30 days it goes back to the sender. No rail on any path,
 * the sender's PIN proof before any write, and the sender's copy is the same
 * for a member and a non-member.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proofFor } from './helpers/pin-proof.mjs';
import { sendMoney, sendConfirmText, sendReceiptText, findMember } from '../lib/send-money.js';
import { claimHeldGiftsToBalance, refundExpiredHeldGifts, claimPendingGifts } from '../lib/pending-gifts.js';
import { buildGiftRefund } from '../lib/ledger-core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

function world({ members = [], spend = 50000 } = {}) {
  const entries = [];
  const gifts = [];
  const wallets = new Map([['acc-a', spend]]);
  const ledger = {
    entries,
    async ensureWallet({ accountId }) { if (!wallets.has(accountId)) wallets.set(accountId, 0); },
    async postEntry(e) {
      if (entries.some((x) => x.idemKey === e.idemKey)) return { replayed: true };
      for (const p of e.postings) {
        const m = /^WALLET:(.+):SPEND$/.exec(p.accountCode);
        if (!m) continue;
        const cur = wallets.get(m[1]) ?? 0;
        const next = cur - (p.debitCents || 0) + (p.creditCents || 0);
        if (next < 0) { const err = new Error('Insufficient funds'); err.name = 'InsufficientFundsError'; throw err; }
        wallets.set(m[1], next);
      }
      entries.push(e);
      return { replayed: false };
    },
  };
  const pendingGift = {
    async findUnique({ where }) { return gifts.find((g) => g.idemKey === where.idemKey) || null; },
    async create({ data }) { const g = { createdAt: new Date(), ...data }; gifts.push(g); return g; },
    async findMany({ where }) {
      return gifts.filter((g) => (!where.recipientMsisdn || g.recipientMsisdn === where.recipientMsisdn) && (!where.status || g.status === where.status)
        && (!where.rail || (typeof where.rail === 'string' ? g.rail === where.rail : where.rail.in.includes(g.rail)))
        && (!where.createdAt || g.createdAt < where.createdAt.lt));
    },
    async updateMany({ where, data }) { const g = gifts.find((x) => x.id === where.id && x.status === where.status); if (!g) return { count: 0 }; Object.assign(g, data); return { count: 1 }; },
  };
  const prisma = {
    gifts, wallets,
    pendingGift,
    account: { async findFirst({ where }) { return members.find((m) => where.OR.some((o) => (o.msisdn && (m.msisdn === o.msisdn)) || (o.waId && m.waId === o.waId))) || null; } },
    async $transaction(fn) { return fn({ pendingGift, journalEntry: {} }); },
  };
  return { prisma, ledger };
}
const sender = { id: 'acc-a', msisdn: '27600000901', waId: '27600000901' };
const thandi = { id: 'acc-b', displayName: 'Thandi', msisdn: '27600000902', waId: '27600000902' };

test('to a member: an immediate free transfer, no rail, replay moves nothing again', async () => {
  const { prisma, ledger } = world({ members: [thandi] });
  const out = await sendMoney({ prisma, ledger, sender, previewId: 'p1', recipientMsisdn: '0600000902', amountCents: 5000, authorization: proofFor(sender, { intentId: 'p1', amountCents: 5000 }) });
  assert.equal(out.delivered, 'BALANCE');
  assert.equal(ledger.entries[0].source, 'P2P_SEND');
  assert.equal(ledger.entries[0].idemKey, 'send-p1');
  assert.equal(prisma.wallets.get('acc-a'), 45000, 'R50, no fee');
  assert.equal(prisma.wallets.get('acc-b'), 5000);
  const again = await sendMoney({ prisma, ledger, sender, previewId: 'p1', recipientMsisdn: '0600000902', amountCents: 5000, authorization: proofFor(sender, { intentId: 'p1', amountCents: 5000 }) });
  assert.equal(again.replayed, true); assert.equal(prisma.wallets.get('acc-b'), 5000);
});

test('to a non-member: held free with a WAPAY row and no PIN; joining credits it once; a second claim is a no-op', async () => {
  const { prisma, ledger } = world();
  const out = await sendMoney({ prisma, ledger, sender, previewId: 'p2', recipientMsisdn: '0600000903', amountCents: 3000, authorization: proofFor(sender, { intentId: 'p2', amountCents: 3000 }) });
  assert.equal(out.delivered, 'HELD');
  assert.equal(ledger.entries[0].source, 'GIFT_HELD'); assert.equal(ledger.entries[0].idemKey, 'gift-held-gift-p2');
  assert.equal(prisma.wallets.get('acc-a'), 47000, 'R30, no fee');
  assert.equal(prisma.gifts[0].rail, 'WAPAY'); assert.equal(prisma.gifts[0].voucherPin, null);
  const c = { id: 'acc-c', msisdn: '27600000903' };
  const first = await claimHeldGiftsToBalance({ prisma, ledger, account: c });
  assert.equal(first.length, 1); assert.equal(prisma.wallets.get('acc-c'), 3000);
  assert.equal(ledger.entries.filter((e) => e.idemKey === 'gift-claim-balance-gift-p2').length, 1);
  assert.deepEqual(await claimHeldGiftsToBalance({ prisma, ledger, account: c }), [], 'a second claim does nothing');
  assert.equal(prisma.wallets.get('acc-c'), 3000);
});

test('the voucher hand-outs never pick up a held gift (no fake PIN from the fuel or self-purchase sweeps)', async () => {
  const { prisma, ledger } = world();
  await sendMoney({ prisma, ledger, sender, previewId: 'p3', recipientMsisdn: '0600000903', amountCents: 3000, authorization: proofFor(sender, { intentId: 'p3', amountCents: 3000 }) });
  assert.deepEqual(await claimPendingGifts({ prisma, recipientMsisdn: '0600000903' }), []);
  assert.equal(prisma.gifts[0].status, 'ISSUED', 'still waiting for its balance claim');
});

test('unclaimed after 30 days: back to the sender once', async () => {
  const { prisma, ledger } = world();
  await sendMoney({ prisma, ledger, sender, previewId: 'p4', recipientMsisdn: '0600000904', amountCents: 2000, authorization: proofFor(sender, { intentId: 'p4', amountCents: 2000 }) });
  prisma.gifts[0].createdAt = new Date(Date.now() - 31 * 86400 * 1000);
  const r = await refundExpiredHeldGifts({ prisma, ledger });
  assert.equal(r.length, 1); assert.equal(prisma.wallets.get('acc-a'), 50000);
  assert.deepEqual(await refundExpiredHeldGifts({ prisma, ledger }), []);
  assert.equal(buildGiftRefund({ senderAccountId: 'acc-a', amountCents: 2000, giftId: 'g' }).idemKey, 'gift-refund-g');
});

test('no PIN proof, a proof for another amount, or your own number: nothing moves', async () => {
  for (const authorization of [null, proofFor(sender, { intentId: 'p5', amountCents: 9999 })]) {
    const { prisma, ledger } = world({ members: [thandi] });
    const out = await sendMoney({ prisma, ledger, sender, previewId: 'p5', recipientMsisdn: '0600000902', amountCents: 5000, authorization });
    assert.equal(out.error, 'NOT_AUTHORISED'); assert.equal(ledger.entries.length, 0);
  }
  const { prisma, ledger } = world();
  const self = await sendMoney({ prisma, ledger, sender, previewId: 'p6', recipientMsisdn: '0600000901', amountCents: 5000, authorization: proofFor(sender, { intentId: 'p6', amountCents: 5000 }) });
  assert.equal(self.error, 'SELF');
});

test('the sender reads the same words for a member and a non-member (never an oracle for who is on WaPay)', () => {
  const c = sendConfirmText({ amountCents: 5000, recipientMsisdn: '0600000902' });
  assert.match(c, /straight away if they use WaPay, or when they join\. No fee\./);
  assert.doesNotMatch(c, /voucher|PIN of|does not have WaPay/i);
  assert.match(sendReceiptText({ amountCents: 5000, recipientMsisdn: '0600000902', newBalanceCents: 45000 }), /in their WaPay balance, or it waits there for them until they join WaPay/);
});

test('structure: no rail client in the send path; the route verifies the PIN with the approval; quoted fee = booked fee', () => {
  for (const f of ['lib/send-money.js', 'pages/api/wallet/send/execute.js', 'pages/api/wallet/send/preview.js']) {
    assert.doesNotMatch(read(f), /providers-ott|OttClient|ott-payout|providers-blu|requestPayout/, `${f} touches no rail`);
  }
  assert.match(read('pages/api/wallet/send/execute.js'), /verifyPIN\(\{ accountId, pin, approves: \{ intentId: previewId, amountCents: meta\.amountCents \} \}\)/);
  assert.match(read('lib/send-money.js'), /verifyPinProof\(authorization/);
  assert.match(read('lib/send-money.js'), /flatFeeCentsOverride: sendFeeCents\(\)/);
});

test('the daily refund tells each sender once, or writes it into their history when they cannot be reached', async () => {
  const { refundHeldGiftsAndNotify } = await import('../lib/send-money.js');
  const { prisma, ledger } = world();
  prisma.account.findUnique = async ({ where }) => (where.id === 'acc-a' ? { waId: '27600000901' } : null);
  await sendMoney({ prisma, ledger, sender, previewId: 'p7', recipientMsisdn: '0600000905', amountCents: 2000, authorization: proofFor(sender, { intentId: 'p7', amountCents: 2000 }) });
  prisma.gifts[0].createdAt = new Date(Date.now() - 31 * 86400 * 1000);
  const told = [];
  const counts = await refundHeldGiftsAndNotify({ prisma, ledger, deps: { notifyCustomer: async (a) => { told.push(a); return { ok: true }; } } });
  assert.deepEqual(counts, { refunded: 1, notified: 1, notifyFailed: 0 });
  assert.match(told[0].text, /The R20 you sent to 0600000905 was not collected in 30 days, so it is back in your WaPay balance/);
  assert.equal(prisma.wallets.get('acc-a'), 50000);
});

test('the chat wiring: a send to another number goes to the ledger routes; the self-purchase keeps its voucher route; held money is claimed before any voucher claim', () => {
  const proc = read('pages/api/webhooks/message-processor-v2.js');
  const start = proc.slice(proc.indexOf('async function startVoucherGiftPreviewAndConfirm('));
  assert.ok(start.indexOf("intent !== 'OTT_VOUCHER_SELF' && normaliseMsisdn(recipientMsisdn || '') !== normaliseMsisdn(account.msisdn || '')") < start.indexOf("apiUrl('/api/vas/voucher/preview')"), 'a send never reaches the voucher preview');
  assert.ok(start.indexOf("intent === 'OTT_VOUCHER_SELF' && !isRailLiveFor('OTT_VOUCHER', from)") >= 0, 'the launch-scope guard on the self-purchase stays');
  assert.match(proc, /apiUrl\(data\?\.send \? '\/api\/wallet\/send\/execute' : '\/api\/vas\/voucher\/execute'\)/);
  assert.match(proc, /await updateConversationState\(from, 'VOUCHER_GIFT_CONFIRM', \{ amountCents, feeCents: p\.feeCents \|\| 0, totalCents: p\.totalCents, recipientMsisdn: p\.recipientMsisdn, previewId: p\.previewId, send: true \}\)/);
  const post = proc.slice(proc.indexOf('async function handlePostOnboarding('));
  assert.ok(post.indexOf('claimHeldGiftsToBalance({ account })') > 0 && post.indexOf('claimHeldGiftsToBalance({ account })') < post.indexOf('claimPendingGifts({ recipientMsisdn: account.msisdn })'), 'held money lands before any voucher claim');
  assert.match(proc, /const resumeNeededCents = resumeAmountCents;/, 'a parked send needs no fee');
});
