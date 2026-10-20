/**
 * WhatsApp Business Messaging Policy compliance (2026-10-20, after Meta's "sending spam" notice
 * and a RED quality rating; BUGLOG #130): nothing WaPay starts, one message per turn, stop for
 * everyone, the ops reply honours a stop, the rating is read and alerted daily.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sendAdReminders, adRemindersEnabled } from '../lib/ad-reminders.js';
import { opsReply } from '../lib/ops-reply.js';
import { readWhatsAppQuality, qualityAlertText, qualityCheck } from '../lib/whatsapp-quality.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

test('ad reminders are OFF unless WAPAY_AD_REMINDERS=on; off means nothing is read or sent', async () => {
  const prev = process.env.WAPAY_AD_REMINDERS;
  delete process.env.WAPAY_AD_REMINDERS;
  assert.equal(adRemindersEnabled(), false);
  for (const v of ['', 'true', '1', 'yes', 'off']) assert.equal(adRemindersEnabled({ WAPAY_AD_REMINDERS: v }), false, v);
  assert.equal(adRemindersEnabled({ WAPAY_AD_REMINDERS: 'on' }), true);
  const prisma = { $queryRaw: async () => { throw new Error('must not read'); }, account: { findMany: async () => { throw new Error('must not read'); } } };
  const out = await sendAdReminders({ prisma, send: async () => { throw new Error('must not send'); } });
  assert.equal(out.skipped, 'OFF'); assert.equal(out.sent, 0);
  if (prev === undefined) delete process.env.WAPAY_AD_REMINDERS; else process.env.WAPAY_AD_REMINDERS = prev;
});

test('the processor: stop for everyone before any flow, no trailer after a receipt, no interim "Sending" message', () => {
  const p = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(p, /if \(matchesStop\(text\)\) \{\s*const \{ state: stopState \} = await getConversationState\(from\);\s*if \(!\/_PIN\$\|PIN_RESEND_AUTH\|AWAITING_VOUCHER_PIN\|\^PIN_RESET_\|CONFIRM\/\.test\(String\(stopState \|\| ''\)\)\) return await handleStopAsk\(\{ from, account \}\);/);
  assert.ok(p.indexOf('if (matchesStop(text)) {') < p.indexOf('if (matchCloseAccountAsk(text))'), 'stop is read before the other commands');
  assert.match(p, /const STOP_ALL_REPLY = 'Okay\. WaPay will not message you unless you write first\. Your account and balance stay as they are, and you can say \*hi\* any time\.';/);
  assert.match(p, /key: 'messaging', patch: \{ optOut: true, optOutAt: new Date\(\)\.toISOString\(\) \}/);
  assert.match(p, /async function sendPostTransactionCta\(\) \{[\s\S]{0,400}return \{ ok: true, skipped: 'NO_TRAILER' \};/);
  assert.ok(!p.includes('If you have any questions or get stuck anywhere, just tell me. I am right here.'), 'the trailer line is gone');
  assert.ok(!p.includes('`⏳ Sending...`') && !p.includes('⏳ Sending your WaPay voucher...'), 'no interim send before a receipt');
});

test('the ops reply refuses a customer who said stop unless they wrote again afterwards', async () => {
  const ID = 'cmvezlqma00hbi5od3b5anvv5';
  const mk = ({ lastUserAt, optOutAt }) => ({
    account: { findUnique: async () => ({ id: ID, waId: '27600000919', profile: optOutAt ? { messaging: { optOut: true, optOutAt } } : {} }) },
    conversationTurn: { findFirst: async () => (lastUserAt ? { createdAt: new Date(lastUserAt) } : null) },
  });
  const now = Date.parse('2026-10-20T10:00:00Z');
  const sent = []; const send = async (a) => { sent.push(a); return { ok: true, data: { messages: [{ id: 'w1' }] } }; };
  const refused = await opsReply({ prisma: mk({ lastUserAt: '2026-10-20T08:00:00Z', optOutAt: '2026-10-20T09:00:00Z' }), send, accountId: ID, text: 'hi', now });
  assert.equal(refused.status, 409); assert.equal(refused.body.error, 'OPTED_OUT'); assert.equal(sent.length, 0);
  const ok = await opsReply({ prisma: mk({ lastUserAt: '2026-10-20T09:30:00Z', optOutAt: '2026-10-20T09:00:00Z' }), send, accountId: ID, text: 'hi', now });
  assert.equal(ok.status, 200, 'they wrote again after the stop: a reply is a reply');
});

test('the quality reader parses Meta, the alert text names the rule, the check alerts only when not GREEN', async () => {
  const env = { META_WHATSAPP_TOKEN: 't', META_WHATSAPP_PHONE_NUMBER_ID: '123' };
  const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('whatsapp_business_profile') ? { data: [{ email: 'help@wapay.co.za', websites: ['https://wapay.co.za'] }] } : { quality_rating: 'RED', messaging_limit_tier: 'TIER_250', status: 'CONNECTED', name_status: 'APPROVED' }) });
  const q = await readWhatsAppQuality({ env, fetchImpl, now: 1 });
  assert.equal(q.qualityRating, 'RED'); assert.equal(q.messagingLimitTier, 'TIER_250'); assert.equal(q.profile.hasSupportContact, true);
  const text = qualityAlertText(q);
  assert.match(text, /quality rating RED/); assert.match(text, /No business-initiated messages until it is GREEN/); assert.ok(!/[—–]/.test(text));
  assert.match(qualityAlertText({ qualityRating: 'YELLOW', profile: { hasSupportContact: false } }), /no support e-mail or website/);
  const alerts = [];
  const deps = { read: async () => q, opsPersonAlert: async (a) => { alerts.push(a); return { sent: 1 }; }, sendOpsAlert: async () => ({ success: true }) };
  const r = await qualityCheck({ deps, now: new Date('2026-10-20T02:00:00Z') });
  assert.equal(r.alerted, true); assert.equal(alerts.length, 1); assert.match(alerts[0].key, /^wa-quality:2026-10-20$/);
  const green = await qualityCheck({ deps: { ...deps, read: async () => ({ ...q, qualityRating: 'GREEN' }) } });
  assert.equal(green.alerted, false); assert.equal(alerts.length, 1, 'GREEN raises nothing');
  assert.equal((await readWhatsAppQuality({ env: {}, now: 10 * 60 * 1000 })).configured, false, 'past the one-minute cache, no credentials means not configured');
});

test('the cron reads the rating daily, the flags and the Health tab show it, the admin route is guarded', () => {
  const cron = read('../pages/api/cron/daily-vas-sync.js');
  assert.match(cron, /const \{ qualityCheck \} = await import\('\.\.\/\.\.\/\.\.\/lib\/whatsapp-quality\.js'\);/);
  assert.ok(cron.indexOf('qualityCheck()') < cron.indexOf("await import('../../../lib/audit/run.js')"), 'before the audit');
  const flags = read('../pages/api/internal/flags.js');
  assert.match(flags, /adReminders: adRemindersEnabled\(\)/); assert.match(flags, /whatsapp: quality \? \{ qualityRating: quality\.qualityRating \|\| null/);
  const route = read('../pages/api/admin/whatsapp-quality.js');
  assert.match(route, /if \(!requireAdmin\(req\)\.ok\) return res\.status\(401\)/);
  const page = read('../pages/admin/index.js');
  assert.match(page, /function QualityCard\(\{ tick = 0 \}\)/); assert.match(page, /<QualityCard tick=\{tick\} \/>/); assert.match(page, /fetch\('\/api\/admin\/whatsapp-quality'\)/);
});
