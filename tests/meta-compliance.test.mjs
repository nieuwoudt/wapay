// The guardrails against another Meta restriction (2026-10-23): no marketing template can be sent,
// nobody hears from WaPay unless they wrote first, and a daily check measures every rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const { MARKETING_TEMPLATES, marketingTemplateBlocked, sendWhatsAppTemplate } = await import('../packages/whatsapp/dist/index.js');
const { measureTurns, measurePulses, complianceVerdict, templatesWeSend, summaryText, runComplianceCheck } = await import('../lib/meta-compliance.js');

test('every MARKETING template on the account is blocked at the sender unless explicitly allowed', async () => {
  for (const n of ['onboarding_step_1', 'wapay_voucher_received', 'consent_terms_', 'welcome_new_user_account_activation', 'wapay_request_paid', 'help_me_menu', 'deposit_options', 'welcome_new_user', 'bluvoucher_redeem_prompt', 'bluvoucher_redeem_success']) {
    assert.ok(MARKETING_TEMPLATES.has(n), n);
    assert.equal(marketingTemplateBlocked(n, {}), true, n);
    assert.equal(marketingTemplateBlocked(n, { WAPAY_ALLOW_MARKETING_TEMPLATES: 'on' }), false, n);
  }
  for (const n of ['wapay_payment_receipt', 'wapay_payment_receipt_v2', 'wapay_request_paid_util', 'wapay_support_followup', 'otp_register_step_2', 'onboarding_step_3_pin_creation']) {
    assert.equal(marketingTemplateBlocked(n, {}), false, `${n} is utility or authentication`);
  }
  delete process.env.WAPAY_ALLOW_MARKETING_TEMPLATES;
  const r = await sendWhatsAppTemplate({ to: '27830000000', templateName: 'wapay_voucher_received', language: 'en', components: [] });
  assert.deepEqual(r, { ok: false, error: 'MARKETING_TEMPLATE_BLOCKED' }, 'refused before any network call');
});

test('a money or gift recipient hears from WaPay only inside their own 24-hour window, never by template', () => {
  const src = read('../pages/api/webhooks/message-processor-v2.js');
  const start = src.indexOf('async function notifyGiftRecipient(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.ok(!/sendWhatsAppTemplate\(/.test(body), 'no template in the recipient notice');
  assert.match(body, /gift_notify_skipped_no_window/);
  assert.match(body, /24 \* 60 \* 60 \* 1000/);
  const receipt = read('../lib/send-money.js');
  assert.match(receipt, /WaPay does not message them, so let them know you sent it\./, 'the sender is told to tell them');
});

test('the webhook records what Meta bills each message as, and the cron runs the check daily', () => {
  assert.match(read('../pages/api/webhooks/whatsapp.js'), /webhookPulse\(`price-\$\{priceCat\}`\)/);
  const cron = read('../pages/api/cron/daily-vas-sync.js');
  assert.match(cron, /\/api\/internal\/compliance-check\?alert=1/);
  assert.match(read('../pages/api/admin/whatsapp-quality.js'), /runComplianceCheck\(\{ alert: false \}\)/);
});

const NOW = Date.parse('2026-10-23T02:00:00Z');
const t = (accountId, role, minsAgo, extra = {}) => ({ accountId, role, createdAt: new Date(NOW - minsAgo * 60e3), kind: role === 'assistant' ? 'flow' : null, text: '', ...extra });

test('behaviour: bursts, reminders, stop honoured, complaints', () => {
  const turns = [
    t('a', 'user', 100), t('a', 'assistant', 99),
    t('b', 'user', 90, { text: 'hi' }), t('b', 'assistant', 89), t('b', 'assistant', 89), t('b', 'assistant', 88),
    t('c', 'assistant', 80, { kind: 'ad_reminder' }),
    t('d', 'user', 70, { text: 'STOP' }), t('d', 'assistant', 69), t('d', 'assistant', 10),
    t('e', 'user', 60, { text: 'is this a scam?' }), t('e', 'assistant', 59),
    t('ops', 'user', 50), ...Array.from({ length: 20 }, () => t('ops', 'assistant', 40)),
  ];
  const m = measureTurns({ turns, excludeIds: new Set(['ops']), now: NOW });
  assert.equal(m.reminders, 1);
  assert.equal(m.stopViolations, 1, 'the reply to STOP is fine, the later one is not');
  assert.equal(m.complaints, 1);
  assert.equal(m.threePlus, 1);
  assert.equal(m.worstBurst, 3, 'ops alerts to the founder are excluded');
});

test('pulses: refusals by code, billed categories, account events', () => {
  const p = measurePulses([
    { waMessageId: 'status-failed-131031:2026-10-22T21:30' }, { waMessageId: 'status-failed-131047:2026-10-22T22:00' },
    { waMessageId: 'status-delivered:2026-10-22T22:01' }, { waMessageId: 'price-utility:2026-10-22T22:01' }, { waMessageId: 'price-marketing:2026-10-22T22:02' },
    { waMessageId: 'account-account_update:ACCOUNT_RESTRICTION:2026-10-22T21:29' },
  ]);
  assert.deepEqual(p.failures, { 131031: 1, 131047: 1 });
  assert.deepEqual(p.priced, { utility: 1, marketing: 1 });
  assert.equal(p.delivered, 1);
  assert.equal(p.accountEvents.length, 1);
});

test('verdict: RED on any red line, AMBER on drift, GREEN when every rule held, and what is new since yesterday', () => {
  const clean = { meta: { ok: true, quality: 'GREEN', tier: 'TIER_1K', canSend: 'AVAILABLE', templates: [{ name: 'wapay_payment_receipt', category: 'UTILITY', status: 'APPROVED' }] }, pulses: { failures: {}, priced: { service: 3 }, accountEvents: [] }, behaviour: { reminders: 0, stopViolations: 0, complaints: 0, threePlusPct: 2 }, weSend: ['wapay_payment_receipt'], marketingBlocked: new Set() };
  assert.equal(complianceVerdict(clean).verdict, 'GREEN');
  assert.equal(complianceVerdict({ ...clean, meta: { ...clean.meta, quality: 'RED' } }).verdict, 'RED');
  assert.equal(complianceVerdict({ ...clean, pulses: { ...clean.pulses, priced: { marketing: 1 } } }).verdict, 'RED');
  assert.equal(complianceVerdict({ ...clean, meta: { ...clean.meta, templates: [{ name: 'wapay_payment_receipt', category: 'MARKETING', status: 'APPROVED' }] } }).verdict, 'RED', 'a template we send re-filed as marketing');
  assert.equal(complianceVerdict({ ...clean, behaviour: { ...clean.behaviour, stopViolations: 1 } }).verdict, 'RED');
  assert.equal(complianceVerdict({ ...clean, meta: { ...clean.meta, tier: 'TIER_250' }, previousTier: 'TIER_1K' }).verdict, 'AMBER');
  assert.equal(complianceVerdict({ ...clean, behaviour: { ...clean.behaviour, complaints: 3 } }).verdict, 'AMBER');
  assert.equal(complianceVerdict({ ...clean, meta: { ...clean.meta, templates: [{ name: 'new_promo', category: 'MARKETING', status: 'APPROVED' }] } }).verdict, 'AMBER', 'a new marketing template must join the block list');
  const v = complianceVerdict({ ...clean, meta: { ...clean.meta, quality: 'RED' }, previousCodes: ['QUALITY_RED'] });
  assert.deepEqual(v.newCodes, [], 'yesterday already knew: no WhatsApp alert, the daily e-mail still goes');
  assert.ok(!/—/.test(summaryText({ ...v, meta: clean.meta, pulses: clean.pulses, behaviour: clean.behaviour, at: new Date(NOW).toISOString() })));
});

test('templates we send come from the code and from the env names', () => {
  const s = templatesWeSend({ WAPAY_TEMPLATE_REQUEST_PAID: 'wapay_request_paid_util', WAPAY_TEMPLATE_PAYMENT_RECEIPT: 'wapay_payment_receipt' });
  assert.ok(s.includes('wapay_request_paid_util') && s.includes('wapay_payment_receipt') && s.includes('otp_register_step_2'));
});

test('the run alerts once a day and on WhatsApp only for a new reason', async () => {
  const claimed = new Set(); const mails = []; const was = [];
  const prisma = {
    processedMessage: { findMany: async ({ where }) => (where.waMessageId?.startsWith ? [] : [{ waMessageId: 'price-marketing:2026-10-22T23:00' }]) },
    conversationTurn: { findMany: async () => [] },
    account: { findMany: async () => [] },
  };
  const deps = {
    whatsapp: { MARKETING_TEMPLATES: new Set() },
    readMetaSide: async () => ({ ok: true, quality: 'GREEN', tier: 'TIER_1K', canSend: 'AVAILABLE', templates: [] }),
    opsAlerts: { opsAlertRecipients: () => [], opsPersonAlert: async (a) => { was.push(a); return { sent: 1 }; } },
    email: { sendOpsAlert: async (a) => { mails.push(a); return { success: true }; } },
    ledger: { claimMessage: async ({ waMessageId }) => { if (claimed.has(waMessageId)) return false; claimed.add(waMessageId); return true; } },
  };
  const r = await runComplianceCheck({ prisma, now: NOW, env: {}, alert: true, deps });
  assert.equal(r.verdict, 'RED');
  assert.equal(mails.length, 1); assert.equal(was.length, 1);
  await runComplianceCheck({ prisma, now: NOW + 60e3, env: {}, alert: true, deps });
  assert.equal(mails.length, 1, 'one e-mail a day');
});
