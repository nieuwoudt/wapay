/**
 * Paying your own link (founder decision 2026-11-10, lib/own-link.js): the first time is allowed with a
 * page that says we can see it; the second time, or from R1,000, a verified ID comes first; a verified
 * requester and any other payer number are never stopped. The block sits in /api/pay/checkout before
 * any intent or rail session, so nothing is charged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isOwnNumber, ownLinkDecision, ownLinkFirstThresholdCents, countPaidOwnLinks,
  ownLinkWarnHtml, ownLinkWarnLines, ownLinkBlockHtml, ownLinkBlockLines, ownLinkRequesterLine,
  OWN_LINK_KYC_FIRST_DEFAULT_CENTS,
} from '../lib/own-link.js';
import { deliverRequestPaidNotifications } from '../lib/request-notify.js';
import { claimTable, jsonbMerge } from './helpers/notify-claims.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const REQUESTER = { id: 'acc_req', waId: '27787051175', msisdn: '0787051175', profile: {} };
const T = OWN_LINK_KYC_FIRST_DEFAULT_CENTS;

test('own number: both stored forms of the requester match; another number does not', () => {
  assert.equal(isOwnNumber('0787051175', REQUESTER), true);
  assert.equal(isOwnNumber('27787051175', REQUESTER), true);
  assert.equal(isOwnNumber('+27 78 705 1175', REQUESTER), true);
  assert.equal(isOwnNumber('0726252243', REQUESTER), false);
  assert.equal(isOwnNumber('', REQUESTER), false);
  assert.equal(isOwnNumber(null, REQUESTER), false);
});

test('first own-link payment under the line: allowed, with the page that says we can see it', () => {
  const v = ownLinkDecision({ ownNumber: true, verified: false, priorPaid: 0, amountCents: 50000, thresholdCents: T });
  assert.deepEqual(v, { action: 'WARN', reason: 'FIRST' });
  const lines = ownLinkWarnLines({ amountCents: 50000 });
  assert.match(lines.join(' '), /your own link/);
  assert.match(lines.join(' '), /again needs a verified ID/);
  assert.match(lines.join(' '), /If this is not your number, go back and type your own\./);
  const html = ownLinkWarnHtml({ code: 'PRABCDEF', payer: '0787051175', rail: 'adumo', flow: 'CARD', amountCents: 50000 });
  assert.match(html, /name="ack" value="1"/);
  assert.match(html, /name="rail" value="adumo"/);
  assert.match(html, /name="flow" value="CARD"/);
  assert.match(html, /action="\/api\/pay\/checkout"/);
  assert.match(html, /Continue to pay R500/);
});

test('second own-link payment by an unverified requester: blocked until they verify', () => {
  assert.deepEqual(ownLinkDecision({ ownNumber: true, verified: false, priorPaid: 1, amountCents: 1000, thresholdCents: T }), { action: 'BLOCK', reason: 'REPEAT' });
  assert.deepEqual(ownLinkDecision({ ownNumber: true, verified: false, priorPaid: 4, amountCents: 1000, thresholdCents: null }), { action: 'BLOCK', reason: 'REPEAT' });
  const html = ownLinkBlockHtml({ code: 'PRABCDEF', reason: 'REPEAT', env: {} });
  assert.match(html, /Verify your ID first/);
  assert.match(html, /already paid this way/);
  assert.match(html, /app\.wapay\.co\.za\/app\/profile/);
  assert.match(html, /Nothing was charged\./);
  assert.ok(!/<form/.test(html), 'a block page offers no way to pay');
});

test('first own-link payment at or above R1,000 by an unverified requester: blocked', () => {
  assert.deepEqual(ownLinkDecision({ ownNumber: true, verified: false, priorPaid: 0, amountCents: T, thresholdCents: T }), { action: 'BLOCK', reason: 'AMOUNT' });
  assert.deepEqual(ownLinkDecision({ ownNumber: true, verified: false, priorPaid: 0, amountCents: 300000, thresholdCents: T }), { action: 'BLOCK', reason: 'AMOUNT' });
  assert.deepEqual(ownLinkDecision({ ownNumber: true, verified: false, priorPaid: 0, amountCents: T - 1, thresholdCents: T }), { action: 'WARN', reason: 'FIRST' });
  assert.match(ownLinkBlockLines({ reason: 'AMOUNT', thresholdCents: T, where: 'app.wapay.co.za/app/profile' })[1], /R1,000 or more needs a verified ID/);
});

test('the first-payment line: default R1,000, env-set, or off', () => {
  assert.equal(ownLinkFirstThresholdCents({}), 100000);
  assert.equal(ownLinkFirstThresholdCents({ WAPAY_OWN_LINK_KYC_FIRST_CENTS: '300000' }), 300000);
  assert.equal(ownLinkFirstThresholdCents({ WAPAY_OWN_LINK_KYC_FIRST_CENTS: 'off' }), null);
  assert.equal(ownLinkFirstThresholdCents({ WAPAY_OWN_LINK_KYC_FIRST_CENTS: 'nonsense' }), 100000);
  assert.deepEqual(ownLinkDecision({ ownNumber: true, verified: false, priorPaid: 0, amountCents: 300000, thresholdCents: null }), { action: 'WARN', reason: 'FIRST' });
});

test('a verified requester is never stopped; another payer number is never touched', () => {
  assert.deepEqual(ownLinkDecision({ ownNumber: true, verified: true, priorPaid: 9, amountCents: 300000, thresholdCents: T }), { action: 'PASS', reason: 'VERIFIED' });
  assert.deepEqual(ownLinkDecision({ ownNumber: false, verified: false, priorPaid: 9, amountCents: 300000, thresholdCents: T }), { action: 'PASS', reason: 'OTHER_PAYER' });
  assert.deepEqual(ownLinkDecision({ ownNumber: false, verified: false, priorPaid: null, amountCents: 300000, thresholdCents: T }), { action: 'PASS', reason: 'OTHER_PAYER' });
});

test('history unreadable: an unverified own-link payment is blocked, not treated as the first', () => {
  assert.deepEqual(ownLinkDecision({ ownNumber: true, verified: false, priorPaid: null, amountCents: 1000, thresholdCents: T }), { action: 'BLOCK', reason: 'UNKNOWN' });
});

test('counting: only SUCCESS links on this account paid with its own number, refunds excluded', async () => {
  let where = null;
  const prisma = {
    providerRequest: {
      findMany: async (args) => {
        where = args.where;
        return [
          { metadata: { payerMsisdn: '0787051175' } },
          { metadata: { payerMsisdn: '27787051175' } },
          { metadata: { payerMsisdn: '0787051175', refund: { at: '2026-11-09' } } },
          { metadata: { payerMsisdn: '0726252243' } },
          { metadata: { payerMsisdn: null } },
          { metadata: null },
        ];
      },
    },
  };
  assert.equal(await countPaidOwnLinks({ prisma, account: REQUESTER }), 2);
  assert.deepEqual(where, { route: 'payrequest', status: 'SUCCESS', accountId: 'acc_req' });
  assert.equal(await countPaidOwnLinks({ prisma: { providerRequest: { findMany: async () => { throw new Error('db down'); } } }, account: REQUESTER }), null);
  assert.equal(await countPaidOwnLinks({ prisma: {}, account: REQUESTER }), null);
});

test('checkout: the rule runs before any intent or rail session, and a block is a page with no payment', () => {
  const src = read('../pages/api/pay/checkout.js');
  const gate = src.indexOf('isOwnNumber(payerMsisdn, requester)');
  const create = src.indexOf('prisma.providerRequest.create(');
  const adumo = src.indexOf('buildVirtualCheckout(');
  const payfast = src.indexOf('buildCheckoutUrl({');
  assert.ok(gate > 0, 'checkout asks who the payer is');
  assert.ok(gate < create && gate < adumo && gate < payfast, 'decided before the intent and both rails');
  assert.match(src, /verdict\.action === 'BLOCK'[\s\S]{0,200}status\(403\)\.send\(ownLinkBlockHtml/);
  assert.match(src, /verdict\.action === 'WARN' && !acked/);
  assert.match(src, /payer: `…\$\{String\(payerMsisdn\)\.slice\(-4\)\}`/, 'the log carries a masked number only');
});

test('copy: no em dashes, nothing says whether a number is on WaPay', () => {
  const all = [
    ...ownLinkWarnLines({ amountCents: 50000 }),
    ...['REPEAT', 'AMOUNT', 'UNKNOWN'].flatMap((reason) => ownLinkBlockLines({ reason, thresholdCents: T, where: 'app.wapay.co.za/app/profile' })),
    ownLinkRequesterLine({}),
  ].join(' ');
  assert.ok(!/—/.test(all));
  assert.ok(!/not on WaPay|is a member|has an account|registered/i.test(all));
});

// The requester's one message after a first own-link payment carries the line; a paid link from someone
// else, or by a verified requester, does not.
function world({ payerMsisdn, profile = {} }) {
  const table = claimTable();
  const intentRow = { idemKey: 'wapay-payreq-PROWNAAA', providerRef: 'PF-1', metadata: { waId: '27787051175', accountId: 'acc_req', amountCents: 48000, grossCents: 50000, payerMsisdn, requestCode: 'PROWNAAA' } };
  return {
    paymentRequest: { findUnique: async () => ({ id: 'PROWNAAA', status: 'PAID', amountCents: 50000, accountId: 'acc_req' }) },
    providerRequest: { findUnique: async () => ({ ...intentRow, metadata: { ...intentRow.metadata } }) },
    wallet: { findFirst: async () => null },
    account: {
      findUnique: async () => ({ id: 'acc_req', displayName: 'Req', waId: '27787051175', profile }),
      findFirst: async () => ({ id: 'acc_any', profile: {}, createdAt: new Date() }),
    },
    conversationTurn: { findFirst: async () => ({ createdAt: new Date() }) },
    processedMessage: table.processedMessage,
    $executeRaw: jsonbMerge((k) => (k === intentRow.idemKey ? intentRow : null)),
  };
}
async function requesterText(args) {
  const texts = [];
  const send = { text: async (a) => { texts.push(a); return { ok: true }; }, template: async () => ({ ok: true }), direct: async () => ({ ok: true }) };
  await deliverRequestPaidNotifications({ code: 'PROWNAAA', prisma: world(args), send, preRegisterPayer: async () => ({ ok: true }), guard: async () => ({ ok: true }) });
  return texts.filter((t) => t.to === '27787051175').map((t) => t.text).join('\n');
}

test('requester notice: one extra line after an own-link payment by an unverified requester', async () => {
  for (const k of ['WAPAY_TEMPLATE_REQUEST_PAID', 'WAPAY_TEMPLATE_PAYMENT_RECEIPT', 'WAPAY_TEMPLATE_PAYMENT_RECEIPT_V2', 'WHATSAPP_DIRECT_SEND', 'WAPAY_PAYER_PREREGISTER']) delete process.env[k];
  assert.match(await requesterText({ payerMsisdn: '0787051175' }), /This link was paid with your own number\. Paying your own link again needs a verified ID/);
  assert.ok(!/own number/.test(await requesterText({ payerMsisdn: '0726252243' })), 'someone else paid: no line');
  assert.ok(!/own number/.test(await requesterText({ payerMsisdn: '0787051175', profile: { kyc: { status: 'VERIFIED' } } })), 'verified: no line');
});
