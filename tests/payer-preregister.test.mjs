/**
 * C. Payer pre-registration and the receipt reply (WAPAY_PAYER_PREREGISTER and
 * WAPAY_TEMPLATE_PAYMENT_RECEIPT_V2, 2026-10-22; docs/ONBOARDING.md §5,
 * docs/templates/wapay_payment_receipt_v2.md).
 *
 * Locks:
 * - a paid link whose card payer has no account makes an S0 record with
 *   profile.origin { kind: PAYER, requestCode, paidAt } and the loop's paylink
 *   attribution; an existing number (either stored form) is never touched;
 *   with the switch off nothing is made;
 * - no message beyond the receipt; the v2 template only when its name is set
 *   AND the switch covers the payer, with the "My receipt" payload; else the
 *   current template exactly as before;
 * - the button reply: the webhook hands the payload over as the turn's text,
 *   the processor routes it to the one-step sign-up with the receipt on top.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { preRegisterPayer, receiptV2TemplateMessage, receiptV2Name } from '../lib/payer-preregister.js';
import { deliverRequestPaidNotifications } from '../lib/request-notify.js';
import { receiptV2TemplateFor, payerPreregisterFor, oneStepSignupFor, FLAGS, RECEIPT_V2_ENV } from '../lib/onboarding-flags.js';
import { payerReceiptLine, payerPendingLine, receiptButtonPayload, receiptCodeFromPayload, RECEIPT_BUTTON_PAYLOAD, shortSastDate } from '../lib/one-step-signup.js';
import { parseReferralCode } from '../lib/referrals.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');
const webhook = read('../pages/api/webhooks/whatsapp.js');
const notifySource = read('../lib/request-notify.js');
const spec = read('../docs/templates/wapay_payment_receipt_v2.md');

const CODE = 'PRKWXQZM';
const PAYER_LOCAL = '0600000905';
const PAYER_WA = '27600000905';

function accountsDb(existing = []) {
  const rows = [...existing];
  const wallets = [];
  return {
    rows,
    wallets,
    account: {
      findFirst: async ({ where }) => rows.find((a) => where.OR.some((w) => (w.waId && w.waId === a.waId) || (w.msisdn && w.msisdn === a.msisdn))) || null,
      upsert: async ({ where, create }) => {
        const hit = rows.find((a) => a.waId === where.waId);
        if (hit) return hit;
        const row = { id: `acc_${rows.length + 1}`, ...create };
        rows.push(row);
        return row;
      },
    },
    wallet: { upsert: async ({ create }) => { wallets.push(create); return create; } },
  };
}

// ---------------------------------------------------------------- pre-registration

test('pre-registration: a payer with no account gets an S0 record with the origin, the loop attribution and a zero wallet', async () => {
  const db = accountsDb();
  const paidAt = new Date('2026-10-22T09:30:00.000Z');
  const out = await preRegisterPayer({ prisma: db, payerMsisdn: PAYER_LOCAL, requestCode: CODE, paidAt, referrerAccountId: 'acc_requester', now: new Date('2026-10-22T09:31:00.000Z') });
  assert.equal(out.ok, true);
  assert.equal(out.created, true);
  const row = db.rows[0];
  assert.equal(row.waId, PAYER_WA);
  assert.equal(row.msisdn, PAYER_WA, 'stored as getOrCreateUser stores it');
  assert.equal(row.onboardingState, 'S0_INITIAL');
  assert.deepEqual(row.profile.origin, { kind: 'PAYER', requestCode: CODE, paidAt: paidAt.toISOString() });
  assert.equal(row.profile.acquisitionSource, 'paylink');
  assert.equal(row.profile.attribution.referrerAccountId, 'acc_requester');
  assert.equal(row.profile.onboarding, undefined, 'the sign-up path is stamped when they first write, not before');
  assert.deepEqual(db.wallets, [{ accountId: row.id, balanceType: 'SPEND', currency: 'ZAR', availableCents: 0, pendingCents: 0 }]);
  assert.deepEqual(Object.keys(row.profile).sort(), ['acquisitionSource', 'attribution', 'origin'], 'nothing else is kept about them');
});

test('pre-registration: a number that already has an account, in either stored form, is never touched; junk is refused', async () => {
  for (const existing of [{ id: 'a1', waId: PAYER_WA, msisdn: PAYER_WA }, { id: 'a2', waId: 'other', msisdn: PAYER_LOCAL }]) {
    const db = accountsDb([existing]);
    const out = await preRegisterPayer({ prisma: db, payerMsisdn: PAYER_LOCAL, requestCode: CODE });
    assert.deepEqual(out, { ok: true, existed: true, accountId: existing.id });
    assert.equal(db.rows.length, 1);
    assert.equal(db.wallets.length, 0);
  }
  assert.equal((await preRegisterPayer({ prisma: accountsDb(), payerMsisdn: '12345', requestCode: CODE })).reason, 'BAD_NUMBER');
  assert.equal((await preRegisterPayer({ prisma: accountsDb(), payerMsisdn: PAYER_LOCAL, requestCode: 'nope' })).reason, 'BAD_CODE');
  const broken = await preRegisterPayer({ prisma: { account: { findFirst: async () => { throw new Error('down'); } } }, payerMsisdn: PAYER_LOCAL, requestCode: CODE });
  assert.deepEqual(broken, { ok: false, reason: 'ERROR' }, 'never throws into the receipt');
});

// ---------------------------------------------------------------- the receipt leg

function notifyPrisma() {
  return {
    paymentRequest: { findUnique: async () => ({ id: CODE, status: 'PAID', amountCents: 25000, paidAt: new Date('2026-10-22T09:30:00Z'), accountId: 'acc_requester' }) },
    providerRequest: {
      findUnique: async () => ({ idemKey: `wapay-payreq-${CODE}`, providerRef: 'pf777', metadata: { accountId: 'acc_requester', amountCents: 23000, grossCents: 25000, payerMsisdn: PAYER_LOCAL, requesterNotifiedAt: '2026-10-22T09:30:05Z' } }),
      update: async () => ({}),
    },
    wallet: { findFirst: async () => null },
    account: { findUnique: async () => ({ id: 'acc_requester', displayName: 'Thandi Nkosi' }) },
  };
}
function sends() {
  const calls = [];
  return {
    calls,
    send: {
      text: async (a) => { calls.push({ rail: 'text', ...a }); return { ok: false, error: 'window closed' }; },
      direct: async (a) => { calls.push({ rail: 'direct', ...a }); return { ok: false }; },
      template: async (a) => { calls.push({ rail: 'template', ...a }); return { ok: true }; },
    },
  };
}
const withEnv = async (env, fn) => {
  const keys = [...Object.values(FLAGS), RECEIPT_V2_ENV, 'WAPAY_TEMPLATE_PAYMENT_RECEIPT', 'WHATSAPP_DIRECT_SEND'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
};

test('the receipt leg, switch off: nothing is pre-registered and the current template goes exactly as before', async () => {
  await withEnv({ WAPAY_TEMPLATE_PAYMENT_RECEIPT: 'wapay_payment_receipt', [RECEIPT_V2_ENV]: 'wapay_payment_receipt_v2' }, async () => {
    const pre = [];
    const { calls, send } = sends();
    const out = await deliverRequestPaidNotifications({ code: CODE, prisma: notifyPrisma(), send, preRegisterPayer: async (a) => { pre.push(a); return { ok: true }; } });
    assert.equal(out.payer, 'sent');
    assert.equal(pre.length, 0, 'no record is made with the switch off');
    const tpl = calls.find((c) => c.rail === 'template');
    assert.equal(tpl.templateName, 'wapay_payment_receipt', 'the v2 name alone does not switch the template');
    assert.deepEqual(tpl.components, [{ type: 'body', parameters: [{ type: 'text', text: 'R250.00' }, { type: 'text', text: 'Thandi Nkosi' }, { type: 'text', text: 'pf777' }] }]);
  });
});

test('the receipt leg, switch on: the payer is pre-registered; the v2 template goes only when its name is set, with the "My receipt" payload', async () => {
  await withEnv({ [FLAGS.PAYER_PREREGISTER]: PAYER_LOCAL, WAPAY_TEMPLATE_PAYMENT_RECEIPT: 'wapay_payment_receipt' }, async () => {
    const pre = [];
    const { calls, send } = sends();
    await deliverRequestPaidNotifications({ code: CODE, prisma: notifyPrisma(), send, preRegisterPayer: async (a) => { pre.push(a); return { ok: true }; } });
    assert.equal(pre.length, 1);
    assert.equal(pre[0].payerMsisdn, PAYER_LOCAL);
    assert.equal(pre[0].requestCode, CODE);
    assert.equal(pre[0].referrerAccountId, 'acc_requester');
    assert.equal(calls.filter((c) => c.rail === 'template')[0].templateName, 'wapay_payment_receipt', 'no v2 name set: the current template');
    assert.equal(calls.filter((c) => c.to === PAYER_WA).length, calls.length, 'nothing goes anywhere but the payer');
  });
  await withEnv({ [FLAGS.PAYER_PREREGISTER]: 'on', [RECEIPT_V2_ENV]: 'wapay_payment_receipt_v2', WAPAY_TEMPLATE_PAYMENT_RECEIPT: 'wapay_payment_receipt' }, async () => {
    const { calls, send } = sends();
    await deliverRequestPaidNotifications({ code: CODE, prisma: notifyPrisma(), send, preRegisterPayer: async () => ({ ok: true }) });
    const templates = calls.filter((c) => c.rail === 'template');
    assert.equal(templates.length, 1, 'one receipt, never two');
    assert.equal(templates[0].templateName, 'wapay_payment_receipt_v2');
    assert.deepEqual(templates[0].components, [
      { type: 'body', parameters: [{ type: 'text', text: 'R250.00' }, { type: 'text', text: 'Thandi' }, { type: 'text', text: 'pf777' }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: `WAPAY_RECEIPT:${CODE}` }] },
    ], 'the first name only, and the payload the tap brings back');
  });
});

test('the v2 rule: the name set AND the switch covering the payer; a failed v2 send falls back to the current template', async () => {
  assert.equal(receiptV2TemplateFor(PAYER_WA, {}), null);
  assert.equal(receiptV2TemplateFor(PAYER_WA, { [RECEIPT_V2_ENV]: 'wapay_payment_receipt_v2' }), null);
  assert.equal(receiptV2TemplateFor(PAYER_WA, { [RECEIPT_V2_ENV]: 'wapay_payment_receipt_v2', [FLAGS.PAYER_PREREGISTER]: '0600000905' }), 'wapay_payment_receipt_v2');
  assert.equal(receiptV2TemplateFor(PAYER_WA, { [RECEIPT_V2_ENV]: 'off', [FLAGS.PAYER_PREREGISTER]: 'on' }), null);
  assert.equal(payerPreregisterFor(PAYER_WA, { [FLAGS.PAYER_PREREGISTER]: '+27 60 000 0905' }), true);
  await withEnv({ [FLAGS.PAYER_PREREGISTER]: 'on', [RECEIPT_V2_ENV]: 'wapay_payment_receipt_v2', WAPAY_TEMPLATE_PAYMENT_RECEIPT: 'wapay_payment_receipt' }, async () => {
    const calls = [];
    const send = {
      text: async () => ({ ok: false }),
      direct: async () => ({ ok: false }),
      template: async (a) => { calls.push(a.templateName); return { ok: a.templateName !== 'wapay_payment_receipt_v2' }; },
    };
    const out = await deliverRequestPaidNotifications({ code: CODE, prisma: notifyPrisma(), send, preRegisterPayer: async () => ({ ok: true }) });
    assert.deepEqual(calls, ['wapay_payment_receipt_v2', 'wapay_payment_receipt']);
    assert.equal(out.payer, 'sent');
  });
  assert.equal(receiptV2Name({ requester: { displayName: 'Thandi Nkosi' } }), 'Thandi');
  assert.equal(receiptV2Name({ requester: { displayName: '🔥' } }), 'a WaPay user');
  assert.equal(receiptV2Name({ businessName: 'Spaza Mama' }), 'Spaza Mama');
  assert.deepEqual(receiptV2TemplateMessage({ to: 'x', templateName: 't', amount: 'R1', requesterFirstName: null, reference: 'r', code: CODE }).components[0].parameters[1], { type: 'text', text: 'a WaPay user' });
});

test('the receipt leg: the POPIA note sits with the pre-registration, which never blocks the receipt', () => {
  const at = notifySource.indexOf('if (payerPreregisterFor(payerWaId)) {');
  const firstSend = notifySource.indexOf('const sent = await send.text({', at);
  assert.ok(at > 0 && firstSend > at, 'the record is made before the receipt goes, so a tap finds it');
  assert.match(notifySource.slice(at - 600, at), /POPIA: the number was given for this receipt; it is used for nothing else until they\s*\n?\s*\/\/ write to WaPay\./);
  assert.match(notifySource, /\.catch\(\(error\) => log\('request_notify_preregister_error'/);
  const lib = read('../lib/payer-preregister.js');
  assert.match(lib, /POPIA: the payer gave this number for their receipt/);
  assert.ok(!/sendWhatsApp|notifyCustomer|@wapay\/whatsapp|say\.js/.test(lib), 'the pre-registration sends nothing');
});

// ---------------------------------------------------------------- the button reply

test('the button reply: the webhook hands a receipt payload over as the text; every other button keeps its title', () => {
  assert.match(webhook, /const receiptTap = \/\^WAPAY_RECEIPT:PR\[A-HJKMNP-Z\]\{6\}\$\/\.test\(String\(buttonPayload\)\);\s*await runTurn\(\{ text: receiptTap \? buttonPayload : buttonText \|\| buttonPayload \|\| 'continue' \}\);/);
  assert.match(webhook, /const receiptTap = \/\^WAPAY_RECEIPT:PR\[A-HJKMNP-Z\]\{6\}\$\/\.test\(String\(buttonId\)\);\s*await runTurn\(\{ text: receiptTap \? buttonId : buttonTitle \|\| buttonId \|\| 'continue' \}\);/);
  assert.equal(receiptButtonPayload('prkwxqzm'), `WAPAY_RECEIPT:${CODE}`);
  assert.equal(receiptCodeFromPayload(`WAPAY_RECEIPT:${CODE}`), CODE);
  assert.equal(receiptCodeFromPayload('WAPAY_RECEIPT:PRIIIIII'), null, 'only the code alphabet');
  assert.equal(receiptCodeFromPayload('My receipt'), null);
  assert.ok(RECEIPT_BUTTON_PAYLOAD.test(`WAPAY_RECEIPT:${CODE}`));
  assert.equal(parseReferralCode(`WAPAY_RECEIPT:${CODE}`), null, 'never read as an invite code');
});

test('the button reply routes to the one-step sign-up with the receipt on top; a member gets the receipt', () => {
  const hook = processor.indexOf("const receiptMatch = String(text || '').match(RECEIPT_CODE_PATTERN) || String(text || '').trim().match(RECEIPT_BUTTON_PAYLOAD);");
  const oneStep = processor.indexOf("return await oneStepSignupTurn({ from, account, profile, text, messageId, onboardingState, via: 'RECEIPT', receiptCode: receiptMatch[1].toUpperCase() });", hook);
  const member = processor.indexOf('await handlePaymentReceiptAsk({ from, code: receiptMatch[1].toUpperCase() });', hook);
  const gate = processor.indexOf("if (onboardingState !== 'S5_COMPLETED') {");
  assert.ok(hook > 0 && oneStep > hook && member > oneStep && gate > member);
  // Any first message from a payer C made (not only the tap) opens it with their receipt.
  const turn = processor.slice(processor.indexOf('async function oneStepSignupTurn('), processor.indexOf('async function oneStepReceiptLead('));
  assert.match(turn, /const code = receiptCode \|\| \(isPayerOrigin\(account\) \? account\.profile\?\.origin\?\.requestCode \|\| null : null\);/);
  assert.match(turn, /const top = lead \|\| receipt\?\.line \|\| null;/);
  assert.match(turn, /if \(!lead && receipt\?\.memory\) recordLead = receipt\.memory;/, 'memory keeps the receipt without the requester\'s name');
  const lead = processor.slice(processor.indexOf('async function oneStepReceiptLead('), processor.indexOf('async function pinSetupGate('));
  assert.match(lead, /memory: payerReceiptLine\(\{ \.\.\.receipt, requesterLabel: null \}\)/);
  assert.match(lead, /normaliseMsisdn\(from\) === meta\.payerMsisdn/, 'the PayFast reference only to the number that paid');
  assert.match(lead, /if \(request\.status === 'PENDING'\) return \{ line: payerPendingLine/);
  const payer = { waId: PAYER_WA, profile: { origin: { kind: 'PAYER', requestCode: CODE } } };
  assert.equal(oneStepSignupFor({ waId: PAYER_WA, account: payer }, { [FLAGS.PAYER_PREREGISTER]: 'on' }), true);
  assert.equal(oneStepSignupFor({ waId: PAYER_WA, account: payer }, {}), false, 'switched off: the classic path, with the receipt answered first as before');
});

test('the receipt line, as the brief shapes it', () => {
  assert.equal(shortSastDate('2026-10-22T09:30:00Z'), '22 Oct');
  assert.equal(shortSastDate('2026-10-21T23:30:00Z'), '22 Oct', 'South African date');
  assert.equal(payerReceiptLine({ amountCents: 25000, requesterLabel: 'Thandi', paidAt: '2026-10-22T09:30:00Z', reference: `PF 777 · ${CODE}` }), `🧾 You paid R250 to Thandi on 22 Oct, reference PF 777 · ${CODE}.`);
  assert.equal(payerReceiptLine({ amountCents: 2550, requesterLabel: '', reference: CODE }), `🧾 You paid R25.50 to a WaPay user, reference ${CODE}.`);
  assert.match(payerPendingLine({ requesterLabel: 'Thandi' }), /not confirmed yet/);
});

test('the v2 template spec: UTILITY, the neutral closing line, one "My receipt" quick reply, no promotional word', () => {
  assert.match(spec, /wapay_payment_receipt_v2/);
  assert.match(spec, /"category": "UTILITY"/);
  assert.match(spec, /Reply to this message to see your receipt and your options\./);
  assert.match(spec, /"type": "QUICK_REPLY", "text": "My receipt"/);
  assert.match(spec, /POST \/api\/internal\/template-create/);
  assert.match(spec, /WAPAY_TEMPLATE_PAYMENT_RECEIPT_V2=wapay_payment_receipt_v2/);
  const body = JSON.parse(spec.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(body.category, 'UTILITY');
  const text = body.components.find((c) => c.type === 'BODY').text;
  assert.ok(!/\b(free|offer|join|sign up|open (an|your) account|discount|deal|promo|win|reward|invite|download|new)\b/i.test(text), `no selling: ${text}`);
  assert.ok(!/—/.test(text));
  assert.equal((text.match(/\{\{\d\}\}/g) || []).length, 3);
  assert.deepEqual(body.components.find((c) => c.type === 'BUTTONS').buttons, [{ type: 'QUICK_REPLY', text: 'My receipt' }]);
});
