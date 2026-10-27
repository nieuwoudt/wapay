// BUGLOG #144 (2026-10-27): Meta's second "Sending spam" notice. Locks the three things that must
// not slip past again: nothing business-initiated goes to a number that never wrote to WaPay; a Meta
// enforcement event or a quality drop reaches the founder within minutes, not at the 02:00 run; and
// the compliance check counts strikes for seven days and any message to a stranger as RED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
const { numberForms, recipientHasWritten, businessInitiatedAllowed } = await import('../lib/outbound-guard.js');
const { eventBits, accountEventText, metaEventAlert, qualityWatch, qualityWorse, strangerCheck, SEVERE_EVENT_RE } = await import('../lib/meta-alerts.js');
const { measurePulses, measureStrikes, complianceVerdict, summaryText } = await import('../lib/meta-compliance.js');

const NOW = Date.parse('2026-10-27T13:00:00Z');

function store({ accounts = [], turns = [] } = {}) {
  const rows = [];
  return {
    rows,
    account: { findFirst: async ({ where }) => accounts.find((a) => where.OR.some((w) => (w.waId && w.waId === a.waId) || (w.msisdn && w.msisdn === a.msisdn))) || null },
    conversationTurn: { findFirst: async ({ where }) => turns.find((t) => t.accountId === where.accountId && t.role === where.role) || null },
    processedMessage: {
      create: async ({ data }) => { if (rows.some((r) => r.waMessageId === data.waMessageId)) { const e = new Error('dup'); e.code = 'P2002'; throw e; } rows.push({ ...data, processedAt: new Date(NOW) }); return data; },
      findMany: async ({ where }) => rows.filter((r) => r.waMessageId.startsWith(where.waMessageId?.startsWith || '')),
      findFirst: async ({ where }) => [...rows].reverse().find((r) => r.waMessageId.startsWith(where.waMessageId.startsWith)) || null,
    },
  };
}

// ------------------------------------------------------------------ who WaPay may write to first

test('a number has written to WaPay only when its account was opened by its own message, or a message from it is on record', async () => {
  assert.deepEqual(numberForms('0729990002'), ['27729990002', '0729990002']);
  assert.deepEqual(numberForms('+27 72 999 0002'), ['27729990002', '0729990002']);
  const db = store({
    accounts: [
      { id: 'member', waId: '27830000001', msisdn: '27830000001', profile: { acquisitionSource: 'ad' } },
      { id: 'payerRecord', waId: '27830000002', msisdn: '27830000002', profile: { origin: { kind: 'PAYER' } } },
      { id: 'payerWrote', waId: '27830000003', msisdn: '27830000003', profile: { origin: { kind: 'PAYER' } } },
    ],
    turns: [{ accountId: 'payerWrote', role: 'user' }],
  });
  assert.equal((await recipientHasWritten({ prisma: db, waId: '0830000001' })).wrote, true, 'either stored form');
  assert.deepEqual(await recipientHasWritten({ prisma: db, waId: '27830000002' }), { wrote: false, reason: 'PRE_REGISTERED_ONLY', accountId: 'payerRecord' });
  assert.equal((await recipientHasWritten({ prisma: db, waId: '27830000003' })).wrote, true);
  assert.deepEqual(await recipientHasWritten({ prisma: db, waId: '27830000009' }), { wrote: false, reason: 'NO_ACCOUNT' });
  assert.equal((await recipientHasWritten({ prisma: { account: { findFirst: async () => { throw new Error('down'); } } }, waId: '27830000001' })).wrote, false, 'unknown is not consent');
  assert.equal((await recipientHasWritten({ prisma: {}, waId: '27830000001' })).reason, 'UNKNOWN');
  const refused = await businessInitiatedAllowed({ prisma: db, to: '27830000009', purpose: 'payer-receipt', now: NOW });
  assert.equal(refused.ok, false);
  assert.deepEqual(db.rows.map((r) => r.waMessageId), ['bi-refused:payer-receipt:2026-10-27T13:00'], 'counted, with no number in the row');
});

test('every file that can send a template or a Direct Send is known, and the business-initiated ones pass the guard', () => {
  const SENDS = /sendWhatsAppTemplate\s*\(|sendWhatsAppUtilityDirect\s*\(|sendTemplate\s*\(|send\.template\s*\(|send\.direct\s*\(|\.sendWhatsAppTemplate\b|\.sendWhatsAppUtilityDirect\b/;
  // Authentication codes go only to an account's owner who asked for one on a web page; the admin test
  // route only to WAPAY_ADMIN_MSISDNS; onboarding templates only inside a sign-up the person started.
  const KNOWN = {
    'lib/notify.js': 'guarded', 'lib/request-notify.js': 'guarded', 'lib/ops-reply.js': 'guarded', 'lib/business.js': 'guarded',
    'lib/admin-auth.js': 'auth code to an admin', 'lib/business-auth.js': 'auth code to a business owner',
    'packages/auth/src/onboarding.ts': 'inside a sign-up the person started', 'packages/auth/src/otp.ts': 'auth code',
    'packages/whatsapp/src/send.ts': 'the transport', 'pages/api/admin/test-direct-send.js': 'admin numbers only',
  };
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      const rel = `${dir}/${name}`;
      if (name === 'node_modules' || name === 'dist' || rel === 'lib/us-finfy') continue; // lib/us-finfy: the separate US number (Finfy Pay)
      const st = statSync(join(root, rel));
      if (st.isDirectory()) walk(rel);
      else if (/\.(js|mjs|ts)$/.test(name) && SENDS.test(read(rel))) found.push(rel);
    }
  };
  for (const d of ['lib', 'pages', 'packages/auth/src', 'packages/whatsapp/src']) walk(d);
  for (const f of found) assert.ok(KNOWN[f], `${f} can send a template or Direct Send: gate it with lib/outbound-guard.js and add it here`);
  for (const [f, why] of Object.entries(KNOWN)) if (why === 'guarded') assert.match(read(f), /businessInitiatedAllowed|outbound-guard\.js/, `${f} must call the guard`);
});

test('the payer receipt asks the guard before any rail, after the pre-registration record', () => {
  const src = read('lib/request-notify.js');
  const pre = src.indexOf('if (payerPreregisterFor(payerWaId)) {');
  const gate = src.indexOf("const optIn = await guard({ prisma, to: payerWaId, purpose: 'payer-receipt' });");
  const firstSend = src.indexOf('await send.text({', gate);
  assert.ok(pre > 0 && gate > pre && firstSend > gate, 'record, then the gate, then the rails');
  assert.match(src.slice(gate, firstSend), /out\.payer = 'never_wrote';\s*return out;/);
});

// ------------------------------------------------------------------ told within minutes

test('an account_update is alerted at once, by e-mail and WhatsApp, with the outcome on record, once per event per hour', async () => {
  const db = store();
  db.rows.push({ waMessageId: 'account-account_update:ACCOUNT_VIOLATION:SPAM:2026-10-23T20:03' }, { waMessageId: 'account-account_update:ACCOUNT_VIOLATION:SPAM:2026-10-26T20:04' }, { waMessageId: 'price-referral_conversion:2026-10-27T12:00' }, { waMessageId: 'price-service:2026-10-27T12:01' });
  const mails = []; const was = [];
  const deps = { sendOpsAlert: async (a) => { mails.push(a); return { success: true }; }, opsPersonAlert: async (a) => { was.push(a); return { sent: 1 }; } };
  const value = { phone_number: '27760497624', event: 'ACCOUNT_VIOLATION', violation_info: { violation_type: 'SPAM' } };
  const out = await metaEventAlert({ field: 'account_update', value, prisma: db, now: NOW, deps });
  assert.equal(out.severe, true);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /ACTION NOW: Meta flagged the WhatsApp number for spam/);
  assert.match(out.text, /^🛑 META FLAGGED WAPAY'S WHATSAPP NUMBER FOR SPAM \(2026-10-27 13:00 UTC\)/);
  assert.match(out.text, /Enforcement events in the last 7 days: 2\./);
  assert.match(out.text, /referral_conversion 50%/);
  assert.ok(!/27760497624/.test(out.text), 'the event text carries Meta enum words, not the number');
  assert.equal(was.length, 1);
  assert.ok(db.rows.some((r) => r.waMessageId === 'alert-out:meta-strike:mail-1:wa-1:2026-10-27T13:00'), 'whether the founder was told is on record');
  const again = await metaEventAlert({ field: 'account_update', value, prisma: db, now: NOW + 60e3, deps });
  assert.equal(again.skipped, 'DUPLICATE', 'a Meta retry does not alert twice');
  assert.equal(eventBits({ field: 'account_update', value }), 'account_update:ACCOUNT_VIOLATION:SPAM', 'the same words the webhook stores');
  assert.equal(accountEventText({ bits: 'account_update:VERIFIED_ACCOUNT', at: '2026-10-27T13:00' }).severe, false);
  for (const w of ['ACCOUNT_VIOLATION', 'ACCOUNT_RESTRICTION', 'DISABLED_UPDATE', 'FLAGGED', 'DOWNGRADE']) assert.ok(SEVERE_EVENT_RE.test(w), w);
});

test('the webhook alerts on account events and checks business-initiated statuses at once, and watches quality every ten minutes', () => {
  const hook = read('pages/api/webhooks/whatsapp.js');
  const pulse = hook.indexOf("await webhookPulse(`account-${bits");
  const alert = hook.indexOf('metaEventAlert({ field: change.field, value: v, prisma })');
  assert.ok(pulse > 0 && alert > pulse && alert - pulse < 900, 'the alert follows the pulse row in the same block');
  assert.match(hook, /strangerCheck\(\{ prisma, status \}\)/);
  assert.match(hook, /priceCat !== 'service' && priceCat !== 'referral_conversion'/);
  assert.match(hook, /Promise\.all\(\[deliveryStallCheck\(\{ prisma \}\), qualityWatch\(\{ prisma \}\)\]\)/);
  assert.ok(!/res\.(status|send|json)\([^)]*\)[\s\S]{0,40}metaEventAlert/.test(hook), 'awaited before the ACK, never after it');
});

test('quality: the first reading is the baseline, a fall alerts at once, a recovery says so', async () => {
  const db = store();
  const mails = [];
  const deps = (q) => ({ read: async () => ({ configured: true, ...q }), sendOpsAlert: async (a) => { mails.push(a.subject); return { success: true }; }, opsPersonAlert: async () => ({ sent: 0 }) });
  assert.equal((await qualityWatch({ prisma: db, now: NOW, deps: deps({ qualityRating: 'YELLOW', messagingLimitTier: 'TIER_1K', status: 'CONNECTED' }) })).baseline, true);
  assert.equal((await qualityWatch({ prisma: db, now: NOW + 6e5, deps: deps({ qualityRating: 'YELLOW', messagingLimitTier: 'TIER_1K', status: 'CONNECTED' }) })).changed, false);
  const down = await qualityWatch({ prisma: db, now: NOW + 12e5, deps: deps({ qualityRating: 'RED', messagingLimitTier: 'TIER_1K', status: 'CONNECTED' }) });
  assert.equal(down.worse, true);
  assert.match(mails[0], /ACTION NOW: WhatsApp quality RED/);
  const up = await qualityWatch({ prisma: db, now: NOW + 18e5, deps: deps({ qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K', status: 'CONNECTED' }) });
  assert.equal(up.worse, false);
  assert.match(mails[1], /WhatsApp quality now GREEN/);
  assert.equal(qualityWorse({ rating: 'RED', tier: 'TIER_1K', status: 'CONNECTED' }, { rating: 'RED', tier: 'TIER_250', status: 'CONNECTED' }), true, 'a lower limit is worse');
  assert.equal(qualityWorse({ rating: 'RED', status: 'CONNECTED' }, { rating: 'RED', status: 'FLAGGED' }), true);
});

test('a business-initiated message Meta delivered to a number that never wrote is counted and alerted; replies are never checked', async () => {
  const db = store({ accounts: [{ id: 'm', waId: '27830000001', msisdn: '27830000001', profile: {} }] });
  const mails = [];
  const deps = { sendOpsAlert: async (a) => { mails.push(a); return { success: true }; }, opsPersonAlert: async () => ({ sent: 1 }) };
  assert.equal((await strangerCheck({ prisma: db, status: { status: 'sent', recipient_id: '27830000001', pricing: { category: 'utility' } }, now: NOW, deps })).stranger, false);
  assert.deepEqual(await strangerCheck({ prisma: db, status: { status: 'sent', recipient_id: '27830000099', pricing: { category: 'service' } }, now: NOW, deps }), { skipped: true });
  const hit = await strangerCheck({ prisma: db, status: { status: 'sent', recipient_id: '27830000099', pricing: { category: 'utility' } }, now: NOW, deps });
  assert.equal(hit.stranger, true);
  assert.ok(db.rows.some((r) => r.waMessageId === 'stranger-utility:2026-10-27T13:00'));
  assert.match(mails[0].detailsHtml, /•••0099/);
  assert.ok(!/27830000099/.test(mails[0].detailsHtml), 'last four digits only');
});

// ------------------------------------------------------------------ the daily check

test('compliance: strikes count for seven days with their dates and a code that is new for each strike; strangers are RED; the ad share is named', () => {
  const strikes = measureStrikes([
    { waMessageId: 'account-account_update:ACCOUNT_VIOLATION:SPAM:2026-10-23T20:03' },
    { waMessageId: 'account-account_update:VERIFIED_ACCOUNT:2026-10-24T10:00' },
    { waMessageId: 'account-account_update:ACCOUNT_VIOLATION:SPAM:2026-10-26T20:04' },
  ]);
  assert.deepEqual(strikes, [{ bits: 'account_update:ACCOUNT_VIOLATION:SPAM', at: '2026-10-23T20:03' }, { bits: 'account_update:ACCOUNT_VIOLATION:SPAM', at: '2026-10-26T20:04' }]);
  const pulses = measurePulses([{ waMessageId: 'stranger-utility:2026-10-27T01:00' }, { waMessageId: 'bi-refused:payer-receipt:2026-10-27T01:01' }, ...Array.from({ length: 17 }, (_, i) => ({ waMessageId: `price-referral_conversion:2026-10-27T0${i % 10}:${10 + i}` })), ...Array.from({ length: 3 }, (_, i) => ({ waMessageId: `price-service:2026-10-27T03:${10 + i}` }))]);
  assert.deepEqual(pulses.strangers, { utility: 1 });
  assert.deepEqual(pulses.refused, { 'payer-receipt': 1 });
  const v = complianceVerdict({ meta: { ok: true, quality: 'RED', templates: [] }, pulses, behaviour: {}, strikes, previousCodes: ['QUALITY_RED', 'META_STRIKE_202610232003'] });
  const codes = v.reasons.map((r) => r.code);
  assert.ok(codes.includes('META_STRIKE_202610262004'));
  assert.ok(v.newCodes.includes('META_STRIKE_202610262004'), 'the second strike is news even though the first was already reported');
  assert.ok(codes.includes('SENT_TO_STRANGER'));
  assert.ok(codes.includes('AD_TRAFFIC_WHILE_RED'));
  assert.equal(v.verdict, 'RED');
  const text = summaryText({ ...v, meta: { quality: 'RED' }, pulses, behaviour: {}, at: '2026-10-27T02:00:00Z' });
  assert.match(text.split('\n')[0], /NEW red reason/);
  assert.match(text.split('\n')[1], /^• NEW RED: Meta took 2 enforcement action\(s\)[^\n]*2026-10-23 20:03 UTC[^\n]*2026-10-26 20:04 UTC/, 'what is new leads, with dates');
  const quiet = summaryText({ ...complianceVerdict({ meta: { ok: true, quality: 'RED' }, pulses: {}, behaviour: {}, previousCodes: ['QUALITY_RED'] }), meta: { quality: 'RED' }, pulses: {}, behaviour: {}, at: '2026-10-28T02:00:00Z' });
  assert.match(quiet.split('\n')[0], /nothing new since yesterday/);
});

test('the daily e-mail names what is new in its subject and records whether it went', () => {
  const src = read('lib/meta-compliance.js');
  assert.match(src, /🛑 WhatsApp compliance RED, NEW: /);
  assert.match(src, /alert-out:compliance:mail-\$\{out\.mail \? 1 : 0\}/);
  assert.match(src, /waMessageId: \{ startsWith: 'stranger-' \}/);
  assert.match(src, /processedAt: \{ gte: new Date\(now - 7 \* DAY\) \}, waMessageId: \{ startsWith: 'account-' \}/);
});

test('the pay page no longer promises a message WaPay will not send, and keeps the tap that opens the payer\'s own chat', () => {
  const page = read('pages/pay/[code].js');
  assert.match(page, /WaPay never messages a number that has not written to it\./);
  assert.match(page, /Receipt \$\{code\}/);
});
