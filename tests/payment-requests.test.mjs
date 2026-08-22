/**
 * Payment requests ("please pay me") — lib semantics + flow wiring.
 *
 * Locks:
 * - request codes are letters-only (immune to the ledger's timestamp-
 *   lookalike idemKey guard BY CONSTRUCTION) with the PR prefix;
 * - amount caps R5..R3000; lazy expiry at read; PAID exactly once
 *   (atomic PENDING->PAID); cancel scoped to the owner;
 * - matchers: get-paid asks create a request, "pay request <code>" pays
 *   one, and neither collides with deposits or send-money;
 * - static wiring: short-circuits run before the AI; the in-chat pay leg
 *   is PIN-gated buildSend with the request code as idemKey (exactly one
 *   payer can ever pay); the ITN marks card-paid requests atomically; the
 *   checkout route charges GROSS with m_payment_id = intent id.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  newRequestCode,
  createPaymentRequest,
  getPaymentRequest,
  markRequestPaid,
  cancelPaymentRequest,
  MIN_REQUEST_CENTS,
  MAX_REQUEST_CENTS,
} from '../lib/payment-requests.js';

const processorSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);
const itnSource = readFileSync(
  fileURLToPath(new URL('../pages/api/payfast/itn.js', import.meta.url)),
  'utf8'
);
const checkoutSource = readFileSync(
  fileURLToPath(new URL('../pages/api/pay/checkout.js', import.meta.url)),
  'utf8'
);

function stubPrisma() {
  const rows = [];
  return {
    _rows: rows,
    paymentRequest: {
      async create({ data }) {
        if (rows.some((r) => r.id === data.id)) {
          const err = new Error('unique');
          err.code = 'P2002';
          throw err;
        }
        const row = { status: 'PENDING', payerRef: null, paidAt: null, note: null, createdAt: new Date(), ...data };
        rows.push(row);
        return { ...row };
      },
      async findUnique({ where }) {
        const hit = rows.find((r) => r.id === where.id);
        return hit ? { ...hit } : null;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const r of rows) {
          if (r.id !== where.id) continue;
          if (where.status && r.status !== where.status) continue;
          if (where.accountId && r.accountId !== where.accountId) continue;
          Object.assign(r, data);
          count += 1;
        }
        return { count };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The lib
// ---------------------------------------------------------------------------

test('request codes: PR prefix, letters-only, no ambiguous glyphs', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = newRequestCode();
    assert.match(code, /^PR[A-Z]{6}$/, code);
    assert.ok(!/[OIL01]/.test(code), `ambiguous glyph in ${code}`);
    assert.ok(!/\d/.test(code), 'letters-only means the idemKey guard can never fire');
  }
});

test('create: caps R5..R3000, note trimmed, 7-day expiry', async () => {
  const prisma = stubPrisma();
  const r = await createPaymentRequest({ prisma, accountId: 'acc1', amountCents: 15000, note: '  braai money  ' });
  assert.equal(r.status, 'PENDING');
  assert.equal(r.note, 'braai money');
  assert.ok(r.expiresAt > new Date(Date.now() + 6 * 24 * 3600 * 1000));
  await assert.rejects(() => createPaymentRequest({ prisma, accountId: 'acc1', amountCents: MIN_REQUEST_CENTS - 1 }), /between/);
  await assert.rejects(() => createPaymentRequest({ prisma, accountId: 'acc1', amountCents: MAX_REQUEST_CENTS + 1 }), /between/);
  await assert.rejects(() => createPaymentRequest({ prisma, accountId: 'acc1', amountCents: 10.5 }), /integer/);
});

test('expiry is enforced lazily at read', async () => {
  const prisma = stubPrisma();
  const r = await createPaymentRequest({ prisma, accountId: 'acc1', amountCents: 1000 });
  prisma._rows[0].expiresAt = new Date(Date.now() - 1000);
  const read = await getPaymentRequest({ prisma, code: r.id });
  assert.equal(read.status, 'EXPIRED');
  assert.equal(prisma._rows[0].status, 'EXPIRED', 'lazy mark persisted');
});

test('markRequestPaid wins exactly once', async () => {
  const prisma = stubPrisma();
  const r = await createPaymentRequest({ prisma, accountId: 'acc1', amountCents: 1000 });
  assert.equal(await markRequestPaid({ prisma, code: r.id, payerRef: 'WAPAY:p1' }), true);
  assert.equal(await markRequestPaid({ prisma, code: r.id, payerRef: 'WAPAY:p2' }), false, 'second payer loses');
  assert.equal(prisma._rows[0].payerRef, 'WAPAY:p1');
});

test('cancel is scoped to the owner and PENDING only', async () => {
  const prisma = stubPrisma();
  const r = await createPaymentRequest({ prisma, accountId: 'acc1', amountCents: 1000 });
  assert.equal(await cancelPaymentRequest({ prisma, code: r.id, accountId: 'someone-else' }), false);
  assert.equal(await cancelPaymentRequest({ prisma, code: r.id, accountId: 'acc1' }), true);
  assert.equal(await markRequestPaid({ prisma, code: r.id, payerRef: 'x' }), false, 'cancelled cannot be paid');
});

// ---------------------------------------------------------------------------
// Matchers (extracted from the shipped processor)
// ---------------------------------------------------------------------------

function extractFn(name) {
  const start = processorSource.indexOf(`function ${name}(`);
  assert.ok(start > -1, `processor must define ${name}`);
  const end = processorSource.indexOf('\n}', start);
  const preamble = "const PAY_REQUEST_CODE_PATTERN = /\\bpay\\s+request\\s+([A-Z]{6,12})\\b/i;";
  // eslint-disable-next-line no-new-func
  return new Function(`${preamble}; ${processorSource.slice(start, end + 2)}; return ${name};`)();
}

test('get-paid asks match; paying-someone and deposits do not', () => {
  const m = extractFn('matchRequestMoneyAsk');
  for (const text of [
    'please pay me',
    'Can you create a payme link of r100 for someone',
    'I want to get paid by someone',
    'request R150',
    'payment request',
    'pay me link',
  ]) {
    assert.ok(m(text), `should match: "${text}"`);
  }
  for (const text of [
    'Pay request PRKWXQZM',
    'pay my sister 0841234567',
    'deposit R100',
    'send R50 to 083',
  ]) {
    assert.ok(!m(text), `must NOT match: "${text}"`);
  }
  // A named product wins — these are purchases/gifts, not payment requests.
  assert.ok(!m('request R100 airtime', { productHint: 'AIRTIME' }));
  assert.ok(!m('please pay me R50 airtime', { productHint: 'AIRTIME' }));
  assert.ok(m('request R100', { productHint: null }), 'bare request still matches');
});

// ---------------------------------------------------------------------------
// Static wiring
// ---------------------------------------------------------------------------

test('static: both short-circuits run before the AI path', () => {
  const payIdx = processorSource.indexOf("intent: 'PAY_REQUEST'");
  const reqIdx = processorSource.indexOf("intent: 'REQUEST_MONEY'");
  const aiIdx = processorSource.indexOf('await orchestrate(');
  assert.ok(payIdx > -1 && reqIdx > -1 && aiIdx > -1);
  assert.ok(payIdx < aiIdx && reqIdx < aiIdx);
});

test('static: the in-chat pay leg is PIN-gated buildSend, code = idemKey', () => {
  const start = processorSource.indexOf("case 'PAYREQ_PIN':");
  const body = processorSource.slice(start, processorSource.indexOf("case 'DEPOSIT_CARD_AMOUNT':", start));
  assert.match(body, /verifyPIN\(\{ accountId: account\.id/, 'the wallet PIN gates the send');
  assert.match(body, /buildSend\(\{/);
  assert.match(body, /idemKey: `wapay-payreq-\$\{request\.id\}`/, 'the request code is the idempotency key');
  assert.match(body, /posted\.replayed/, 'a racing payer is told, never double-charged');
  assert.match(body, /markRequestPaid\(\{ code: request\.id, payerRef: `WAPAY:/);
  assert.match(body, /Your payment request was PAID/, 'the requester gets notified');
});

test('static: card leg — one intent per code, unified idemKey, unconditional mark-paid', () => {
  assert.match(checkoutSource, /route: 'payrequest'/);
  // Fee direction (2026-08-22): the PAYER pays exactly the request amount;
  // the fee comes out of the REQUESTER's credit.
  assert.match(checkoutSource, /const creditCents = amountCents - feeCents/);
  assert.match(checkoutSource, /amountCents: creditCents/, 'requester is credited amount minus fee');
  assert.ok(!/amountCents: grossCents/.test(checkoutSource), 'payer is never charged a fee on top');
  // ONE idemKey shared with the balance leg: exactly-once across BOTH rails.
  assert.match(checkoutSource, /const idemKey = `wapay-payreq-\$\{code\}`/);
  assert.match(checkoutSource, /findUnique\(\{ where: \{ idemKey \} \}\)/, 'checkout reuses the existing intent');
  // The QA bug: mark-paid must NOT be gated on !replayed — redeliveries
  // repair a crash-stranded PENDING (markRequestPaid is atomic anyway).
  assert.ok(!/requestCode && !posted\.replayed/.test(itnSource), 'no replay gate on mark-paid');
  assert.match(itnSource, /wonRequestTransition = await markRequestPaid/);
  assert.match(itnSource, /requestCode \? wonRequestTransition : !posted\.replayed/, 'confirmation gated on winning the transition');
  assert.match(itnSource, /payfast_overpayment_detected/, 'a second card charge screams for a refund');
});

test('static: the public page exists and offers both legs', () => {
  const pagePath = fileURLToPath(new URL('../pages/pay/[code].js', import.meta.url));
  assert.ok(existsSync(pagePath));
  const page = readFileSync(pagePath, 'utf8');
  assert.match(page, /Pay from my WaPay — free/);
  // The card leg became a payer-number form (auto-registration,
  // 2026-08-22) — same endpoint, GET form instead of a bare link.
  assert.match(page, /action="\/api\/pay\/checkout"/);
  assert.match(page, /wa\.me/);
});

test('amount-change swap: change-phrasings match, product words and no-amount do not', () => {
  const start = processorSource.indexOf('function matchChangeRequestAmount(');
  const end = processorSource.indexOf('\n}', start);
  // eslint-disable-next-line no-new-func
  const m = new Function(`${processorSource.slice(start, end + 2)}; return matchChangeRequestAmount;`)();
  assert.ok(m('Can I change my amount to 1000', { amountCents: 100000 }));
  assert.ok(m('change my request to R500', { amountCents: 50000 }));
  assert.ok(m('make it R200', { amountCents: 20000 }));
  assert.ok(!m('change my amount', { amountCents: null }), 'no amount, no swap');
  assert.ok(!m('change it to R50 airtime', { amountCents: 5000, productHint: 'AIRTIME' }), 'product wins');
  assert.ok(!m('please pay me R100', { amountCents: 10000 }), 'plain create is not a change');
});

test('static: the swap cancels the newest PENDING request then creates fresh', () => {
  const start = processorSource.indexOf('async function handleChangeRequestAmount');
  const body = processorSource.slice(start, processorSource.indexOf('\n}', start) + 2);
  assert.match(body, /getLatestPendingRequest\(\{ accountId: account\.id \}\)/);
  assert.match(body, /cancelPaymentRequest\(\{ code: latest\.id, accountId: account\.id \}\)/);
  assert.match(body, /that link no longer works/i, 'old link death is announced');
  assert.match(body, /handleCreatePaymentRequest\(\{ from, account, amountCents, rawText \}\)/);
  const sc = processorSource.indexOf("intent: 'REQUEST_MONEY_CHANGE'");
  const create = processorSource.indexOf("intent: 'REQUEST_MONEY'");
  assert.ok(sc > -1 && sc < create, 'change short-circuit runs before plain create');
});

test('static: dispatch handles REQUEST_MONEY', () => {
  assert.match(processorSource, /case 'REQUEST_MONEY':\s*\n\s*return await handleCreatePaymentRequest/);
});
