/**
 * Meta Direct Send (beta, announced Sept 2026) — see
 * docs/providers/whatsapp-direct-send-2026-09.md.
 *
 * The contract under test: notification fallback is text → Direct Send
 * (only when WHATSAPP_DIRECT_SEND=true) → approved template, and the
 * package only ever stamps category:"utility" when explicitly asked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { directSendEnabled } from '../packages/whatsapp/dist/send.js';
import { deliverRequestPaidNotifications } from '../lib/request-notify.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function mockPrisma(meta) {
  return {
    paymentRequest: { findUnique: async () => ({ id: 'PRABCDEF', status: 'PAID', amountCents: 2000 }) },
    providerRequest: {
      findUnique: async () => ({ idemKey: 'wapay-payreq-PRABCDEF', providerRef: 'pf1', metadata: meta }),
      update: async () => ({}),
    },
    wallet: { findFirst: async () => null },
    account: { findUnique: async () => ({ displayName: 'Niev' }) },
  };
}

function spies({ textOk, directOk, templateOk }) {
  const calls = [];
  return {
    calls,
    send: {
      text: async () => { calls.push('text'); return { ok: textOk, error: textOk ? undefined : 'window closed' }; },
      direct: async () => { calls.push('direct'); return { ok: directOk, error: directOk ? undefined : 'not eligible' }; },
      template: async () => { calls.push('template'); return { ok: templateOk }; },
    },
  };
}

const META = { waId: '27787051175', accountId: 'a1', amountCents: 2000, grossCents: 2000 };

test('directSendEnabled follows the env flag', () => {
  delete process.env.WHATSAPP_DIRECT_SEND;
  assert.equal(directSendEnabled(), false);
  process.env.WHATSAPP_DIRECT_SEND = 'true';
  assert.equal(directSendEnabled(), true);
  delete process.env.WHATSAPP_DIRECT_SEND;
});

test('enabled: text fails → Direct Send delivers → template never fires', async () => {
  process.env.WHATSAPP_DIRECT_SEND = 'true';
  process.env.WAPAY_TEMPLATE_REQUEST_PAID = 'request_paid';
  const { calls, send } = spies({ textOk: false, directOk: true, templateOk: true });
  const out = await deliverRequestPaidNotifications({ code: 'PRABCDEF', prisma: mockPrisma(META), send });
  assert.equal(out.requester, 'sent');
  assert.deepEqual(calls, ['text', 'direct']);
  delete process.env.WHATSAPP_DIRECT_SEND;
});

test('enabled: direct also fails → template is still the last rail', async () => {
  process.env.WHATSAPP_DIRECT_SEND = 'true';
  process.env.WAPAY_TEMPLATE_REQUEST_PAID = 'request_paid';
  const { calls, send } = spies({ textOk: false, directOk: false, templateOk: true });
  const out = await deliverRequestPaidNotifications({ code: 'PRABCDEF', prisma: mockPrisma(META), send });
  assert.equal(out.requester, 'sent');
  assert.deepEqual(calls, ['text', 'direct', 'template']);
  delete process.env.WHATSAPP_DIRECT_SEND;
});

test('disabled: direct is never attempted', async () => {
  delete process.env.WHATSAPP_DIRECT_SEND;
  process.env.WAPAY_TEMPLATE_REQUEST_PAID = 'request_paid';
  const { calls, send } = spies({ textOk: false, directOk: true, templateOk: true });
  const out = await deliverRequestPaidNotifications({ code: 'PRABCDEF', prisma: mockPrisma(META), send });
  assert.equal(out.requester, 'sent');
  assert.deepEqual(calls, ['text', 'template']);
});

test('payer receipt leg gets the same chain', async () => {
  process.env.WHATSAPP_DIRECT_SEND = 'true';
  process.env.WAPAY_TEMPLATE_PAYMENT_RECEIPT = 'payment_receipt';
  const meta = { ...META, waId: null, requesterNotifiedAt: '2026-09-01', payerMsisdn: '0781234567' };
  const { calls, send } = spies({ textOk: false, directOk: true, templateOk: true });
  const out = await deliverRequestPaidNotifications({ code: 'PRABCDEF', prisma: mockPrisma(meta), send });
  assert.equal(out.payer, 'sent');
  assert.deepEqual(calls, ['text', 'direct']);
  delete process.env.WHATSAPP_DIRECT_SEND;
});

test('package: category is stamped only when explicitly asked', () => {
  const dist = read('../packages/whatsapp/dist/send.js');
  assert.match(dist, /if \(args\.category\)\s*\n?\s*payload\.category = args\.category;/, 'category is conditional');
  assert.match(dist, /sendWhatsAppText\(\{ \.\.\.args, category: 'utility' \}\)/, 'direct wrapper pins utility');
  // The utility category must never leak into ordinary sends: no other
  // assignment path exists.
  assert.equal(dist.split('payload.category').length, 2, 'exactly one category assignment');
});

test('never used for marketing: only transactional call sites exist', () => {
  const notify = read('../lib/request-notify.js');
  assert.match(notify, /send\.direct\(/);
  const grep = ['../lib/request-notify.js'];
  for (const f of grep) {
    const s = read(f);
    assert.ok(!/marketing/i.test(s.split('send.direct')[1]?.slice(0, 400) || ''), 'no marketing near direct send');
  }
});
