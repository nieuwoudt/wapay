/**
 * Whose code sent a business-initiated WhatsApp message (BUGLOG #154).
 *
 * WaPay's number is also used by UniFuel's voucher delivery, which sends its own templates with its own
 * code. WaPay marks the templates and Direct Sends its own code sends (Meta's biz_opaque_callback_data,
 * returned on every delivery status), so the check on Meta's statuses can say "WaPay's code sent this past
 * its gate" (a bug, alert now) apart from "another holder of the number sent this" (counted, alarm on
 * volume). The sender is exercised against a mocked Graph API: nothing is sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from '../packages/whatsapp/node_modules/undici/index.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const wa = await import('@wapay/whatsapp');
const { strangerCheck, sentByWaPay, OTHER_SENDER_ALARM_AT, MARK_LIVE_SINCE } = await import('../lib/meta-alerts.js');
const { measurePulses, complianceVerdict, summaryText } = await import('../lib/meta-compliance.js');

const NOW = Date.parse('2026-11-18T13:00:00Z');
const MEMBER = '27830000001';
const NEVER_WROTE = '27830000099';

function store({ accounts = [{ id: 'm', waId: MEMBER, msisdn: MEMBER, profile: {} }], failRead = false } = {}) {
  const rows = [];
  return {
    rows,
    account: { findFirst: async ({ where }) => { if (failRead) throw new Error('down'); return accounts.find((a) => where.OR.some((w) => (w.waId && w.waId === a.waId) || (w.msisdn && w.msisdn === a.msisdn))) || null; } },
    conversationTurn: { findFirst: async () => null },
    processedMessage: {
      create: async ({ data }) => { if (rows.some((r) => r.waMessageId === data.waMessageId)) { const e = new Error('dup'); e.code = 'P2002'; throw e; } rows.push({ ...data, processedAt: new Date(NOW) }); return data; },
      count: async ({ where }) => rows.filter((r) => r.waMessageId.startsWith(where.waMessageId.startsWith)).length,
    },
  };
}
const mailbox = () => { const mails = []; return { mails, deps: { sendOpsAlert: async (a) => { mails.push(a); return { success: true }; }, opsPersonAlert: async () => ({ sent: 1 }) } }; };
const sent = (extra = {}) => ({ status: 'sent', recipient_id: NEVER_WROTE, pricing: { category: 'utility' }, ...extra });

// ------------------------------------------------------------------ the mark

test("WaPay's mark is read the same way by the sender and by the check", () => {
  assert.equal(wa.WAPAY_SEND_TAG, 'wapay');
  for (const yes of ['wapay', 'wapay:payer-receipt', 'wapay ops']) {
    assert.equal(sentByWaPay({ biz_opaque_callback_data: yes }), true, yes);
    assert.equal(wa.sentByWaPay({ biz_opaque_callback_data: yes }), true, yes);
  }
  for (const no of [undefined, null, '', 'unifuel', 'wapayments', 'x wapay', 7, {}]) {
    assert.equal(sentByWaPay({ biz_opaque_callback_data: no }), false, String(no));
    assert.equal(wa.sentByWaPay({ biz_opaque_callback_data: no }), false, String(no));
  }
  assert.equal(sentByWaPay(null), false);
  assert.equal(sentByWaPay({}), false);
  assert.equal(sentByWaPay({ biz_opaque_callback_data: wa.WAPAY_SEND_TAG }), true, 'what the sender writes is what the check accepts');
});

test('a template leaves with the mark and with its components untouched', () => {
  const components = [{ type: 'body', parameters: [{ type: 'text', text: 'R450' }, { type: 'text', text: 'PRABCDEF' }] }];
  const payload = wa.buildTemplatePayload({ to: MEMBER, templateName: 'wapay_request_paid_util', languageCode: 'en', components });
  assert.deepEqual(payload, {
    messaging_product: 'whatsapp',
    to: MEMBER,
    type: 'template',
    template: { name: 'wapay_request_paid_util', language: { code: 'en' }, components },
    biz_opaque_callback_data: 'wapay',
  });
  assert.deepEqual(wa.buildTemplatePayload({ to: MEMBER, templateName: 't', languageCode: 'en' }).template.components, []);
});

test('only an invalid-parameter refusal counts as a refusal of the mark', () => {
  assert.equal(wa.invalidParameter(400, { error: { code: 100 } }), true);
  assert.equal(wa.invalidParameter(400, { error: { code: '100' } }), true);
  assert.equal(wa.invalidParameter(400, { error: { code: 131047 } }), false, 'outside the 24-hour window is not about the mark');
  assert.equal(wa.invalidParameter(401, { error: { code: 100 } }), false);
  assert.equal(wa.invalidParameter(200, {}), false);
  assert.equal(wa.invalidParameter(400, null), false);
});

// ------------------------------------------------------------------ the sender, against a mocked Graph API

async function withGraph(replies, run) {
  const before = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  const seen = [];
  const pool = agent.get('https://graph.facebook.com');
  for (const r of replies) {
    pool.intercept({ path: '/v21.0/123456/messages', method: 'POST' }).reply((opts) => {
      seen.push(JSON.parse(opts.body));
      return { statusCode: r.status, data: r.body, responseOptions: { headers: { 'content-type': 'application/json' } } };
    });
  }
  setGlobalDispatcher(agent);
  const saved = { t: process.env.META_WHATSAPP_TOKEN, p: process.env.META_WHATSAPP_PHONE_NUMBER_ID, d: process.env.WHATSAPP_DIRECT_SEND };
  process.env.META_WHATSAPP_TOKEN = 'test-token';
  process.env.META_WHATSAPP_PHONE_NUMBER_ID = '123456';
  const quiet = { log: console.log, error: console.error, warn: console.warn };
  const errors = [];
  console.log = () => {}; console.warn = () => {}; console.error = (...a) => { errors.push(a.map(String).join(' ')); };
  try {
    const out = await run();
    return { out, seen, errors, pending: agent.pendingInterceptors().length };
  } finally {
    Object.assign(console, quiet);
    setGlobalDispatcher(before);
    await agent.close();
    for (const [k, env] of [['t', 'META_WHATSAPP_TOKEN'], ['p', 'META_WHATSAPP_PHONE_NUMBER_ID'], ['d', 'WHATSAPP_DIRECT_SEND']]) { if (saved[k] === undefined) delete process.env[env]; else process.env[env] = saved[k]; }
  }
}
const OK = { status: 200, body: { messages: [{ id: 'wamid.TEST' }] } };

test('a template is sent once, marked', async () => {
  const r = await withGraph([OK], () => wa.sendWhatsAppTemplate({ to: MEMBER, templateName: 'wapay_money_received', language: 'en', components: [{ type: 'body', parameters: [{ type: 'text', text: 'A friend' }] }] }));
  assert.equal(r.out.ok, true);
  assert.equal(r.seen.length, 1);
  assert.equal(r.seen[0].biz_opaque_callback_data, 'wapay');
  assert.equal(r.seen[0].type, 'template');
  assert.equal(r.seen[0].template.name, 'wapay_money_received');
  assert.deepEqual(r.seen[0].template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'A friend' }] }]);
});

test('if Meta refuses the mark, the message still goes, unmarked, and the refusal is logged', async () => {
  const r = await withGraph([{ status: 400, body: { error: { code: 100, message: '(#100) Unexpected key "biz_opaque_callback_data"' } } }, OK],
    () => wa.sendWhatsAppTemplate({ to: MEMBER, templateName: 'wapay_money_received', language: 'en', components: [] }));
  assert.equal(r.out.ok, true, 'the notice is not lost');
  assert.equal(r.seen.length, 2);
  assert.equal(r.seen[0].biz_opaque_callback_data, 'wapay');
  assert.ok(!('biz_opaque_callback_data' in r.seen[1]), 'the second attempt carries no mark');
  assert.deepEqual({ ...r.seen[0], biz_opaque_callback_data: undefined }, { ...r.seen[1], biz_opaque_callback_data: undefined }, 'and is otherwise the same message');
  assert.ok(r.errors.some((e) => /wa_send_tag_rejected/.test(e)), 'so the mark is fixed, not silently lost');
});

test('a refusal that is not about a parameter is not retried, and a refusal of both attempts reports the first', async () => {
  const outside = await withGraph([{ status: 400, body: { error: { code: 131047, message: 'Re-engagement message' } } }],
    () => wa.sendWhatsAppTemplate({ to: MEMBER, templateName: 't', language: 'en', components: [] }));
  assert.equal(outside.out.ok, false);
  assert.equal(outside.seen.length, 1, 'one attempt: nobody is messaged twice');
  const both = await withGraph([{ status: 400, body: { error: { code: 100, message: 'first refusal' } } }, { status: 400, body: { error: { code: 100, message: 'second refusal' } } }],
    () => wa.sendWhatsAppTemplate({ to: MEMBER, templateName: 't', language: 'en', components: [] }));
  assert.equal(both.out.ok, false);
  assert.equal(both.out.error, 'first refusal');
  assert.equal(both.seen.length, 2);
  assert.ok(!both.errors.some((e) => /wa_send_tag_rejected/.test(e)), 'the mark is not blamed for a template that is wrong either way');
});

test('a Direct Send is marked; a plain reply is exactly as it was', async () => {
  const direct = await withGraph([OK], () => wa.sendWhatsAppUtilityDirect({ to: MEMBER, text: 'Your pay-out went through.' }));
  assert.equal(direct.out.ok, true);
  assert.deepEqual(direct.seen[0], { messaging_product: 'whatsapp', to: MEMBER, type: 'text', text: { body: 'Your pay-out went through.' }, category: 'utility', biz_opaque_callback_data: 'wapay' });
  const reply = await withGraph([OK], () => wa.sendWhatsAppText({ to: MEMBER, text: 'Hello' }));
  assert.equal(reply.out.ok, true);
  assert.deepEqual(reply.seen[0], { messaging_product: 'whatsapp', to: MEMBER, type: 'text', text: { body: 'Hello' } });
  const refused = await withGraph([{ status: 400, body: { error: { code: 100, message: 'bad' } } }], () => wa.sendWhatsAppText({ to: MEMBER, text: 'Hello' }));
  assert.equal(refused.out.ok, false);
  assert.equal(refused.seen.length, 1, 'an unmarked message is never sent twice');
});

// ------------------------------------------------------------------ the check on Meta's statuses

test("a marked message to a number that never wrote is WaPay's own bug: counted RED and alerted at once", async () => {
  const db = store();
  const { mails, deps } = mailbox();
  const hit = await strangerCheck({ prisma: db, status: sent({ biz_opaque_callback_data: 'wapay' }), now: NOW, deps });
  assert.equal(hit.stranger, true); assert.equal(hit.external, false);
  assert.deepEqual(db.rows.map((r) => r.waMessageId).filter((k) => /^(stranger|external)-/.test(k)), ['stranger-utility:2026-11-18T13:00']);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /ACTION NOW: WaPay's code sent a WhatsApp utility message to a number that never wrote/);
  assert.match(mails[0].detailsHtml, /•••0099/);
  assert.ok(!mails[0].detailsHtml.includes(NEVER_WROTE), 'last four digits only');
});

test('an unmarked one came from another holder of the number: counted apart, no alert, no hunt for a missing gate', async () => {
  const db = store();
  const { mails, deps } = mailbox();
  const hit = await strangerCheck({ prisma: db, status: sent(), now: NOW, deps });
  assert.equal(hit.stranger, true); assert.equal(hit.external, true); assert.equal(hit.told, false);
  assert.deepEqual(db.rows.map((r) => r.waMessageId), ['external-utility:2026-11-18T13:00'], 'one row, with no number in it');
  assert.equal(mails.length, 0);
  // Another product's mark is not WaPay's mark.
  const other = await strangerCheck({ prisma: db, status: sent({ biz_opaque_callback_data: 'unifuel' }), now: NOW + 60_000, deps });
  assert.equal(other.external, true);
  assert.equal(mails.length, 0);
});

test('a member is never a stranger, whoever sent the message, and replies are never checked', async () => {
  const db = store();
  const { mails, deps } = mailbox();
  assert.deepEqual(await strangerCheck({ prisma: db, status: sent({ recipient_id: MEMBER }), now: NOW, deps }), { stranger: false });
  assert.deepEqual(await strangerCheck({ prisma: db, status: sent({ recipient_id: MEMBER, biz_opaque_callback_data: 'wapay' }), now: NOW, deps }), { stranger: false });
  assert.deepEqual(await strangerCheck({ prisma: db, status: sent({ pricing: { category: 'service' } }), now: NOW, deps }), { skipped: true });
  assert.deepEqual(await strangerCheck({ prisma: db, status: sent({ status: 'delivered' }), now: NOW, deps }), { skipped: true });
  assert.deepEqual(db.rows.map((r) => r.waMessageId), ['marked-utility:2026-11-18T13:00'], 'nothing about a stranger; only the proof that the mark came back');
  assert.equal(mails.length, 0);
});

test('a marked status leaves proof that Meta returns the mark, once a minute, with no number in it', async () => {
  const db = store();
  const { deps } = mailbox();
  const marked = sent({ recipient_id: MEMBER, biz_opaque_callback_data: 'wapay' });
  await strangerCheck({ prisma: db, status: marked, now: NOW, deps });
  await strangerCheck({ prisma: db, status: marked, now: NOW + 20_000, deps });
  await strangerCheck({ prisma: db, status: { ...marked, pricing: { category: 'authentication' } }, now: NOW + 60_000, deps });
  assert.deepEqual(db.rows.map((r) => r.waMessageId), ['marked-utility:2026-11-18T13:00', 'marked-authentication:2026-11-18T13:01']);
  // An unmarked status, a reply and a status for another number leave none.
  const other = store();
  await strangerCheck({ prisma: other, status: sent({ recipient_id: MEMBER }), now: NOW, deps });
  await strangerCheck({ prisma: other, status: sent({ recipient_id: MEMBER, biz_opaque_callback_data: 'wapay', pricing: { category: 'service' } }), now: NOW, deps });
  await strangerCheck({ prisma: other, status: marked, phoneNumberId: '222', env: { META_WHATSAPP_PHONE_NUMBER_ID: '111' }, now: NOW, deps });
  assert.equal(other.rows.length, 0);
  // The daily check counts them and they change no verdict.
  const day = verdictFor(['marked-utility:2026-11-21T09:10', 'marked-utility:2026-11-21T09:11', 'marked-authentication:2026-11-21T09:12']);
  assert.deepEqual(day.pulses.marked, { utility: 2, authentication: 1 });
  assert.equal(day.verdict, 'GREEN');
});

test('a status for another phone number on the account is skipped; with no number to compare, the check runs', async () => {
  const db = store();
  const { mails, deps } = mailbox();
  const env = { META_WHATSAPP_PHONE_NUMBER_ID: '111' };
  assert.deepEqual(await strangerCheck({ prisma: db, status: sent({ biz_opaque_callback_data: 'wapay' }), phoneNumberId: '222', env, now: NOW, deps }), { skipped: 'OTHER_NUMBER' });
  assert.equal(db.rows.length, 0);
  assert.equal((await strangerCheck({ prisma: db, status: sent(), phoneNumberId: '111', env, now: NOW, deps })).external, true);
  assert.equal((await strangerCheck({ prisma: db, status: sent(), phoneNumberId: null, env, now: NOW + 60_000, deps })).external, true);
  assert.equal((await strangerCheck({ prisma: db, status: sent(), phoneNumberId: '222', env: {}, now: NOW + 120_000, deps })).external, true, 'no configured number: nothing to compare with');
  assert.equal(mails.length, 0);
});

test('a recipient that could not be read is not called a stranger; the blind spot is recorded', async () => {
  const db = store({ failRead: true });
  const { mails, deps } = mailbox();
  const quiet = console.error; console.error = () => {};
  let r;
  try { r = await strangerCheck({ prisma: db, status: sent({ biz_opaque_callback_data: 'wapay' }), now: NOW, deps }); } finally { console.error = quiet; }
  assert.deepEqual(r, { skipped: 'UNREADABLE' });
  assert.deepEqual(db.rows.map((x) => x.waMessageId).sort(), ['marked-utility:2026-11-18T13:00', 'stranger-unread-utility:2026-11-18T13:00']);
  assert.equal(mails.length, 0);
});

test('volume from another sender is the alarm: once, on the day it is reached', async () => {
  const db = store();
  const { mails, deps } = mailbox();
  for (let i = 0; i < OTHER_SENDER_ALARM_AT - 1; i++) {
    const r = await strangerCheck({ prisma: db, status: sent(), now: NOW + i * 60_000, deps });
    assert.equal(r.told, false, `minute ${i + 1}`);
  }
  assert.equal(mails.length, 0);
  const alarm = await strangerCheck({ prisma: db, status: sent(), now: NOW + OTHER_SENDER_ALARM_AT * 60_000, deps });
  assert.equal(alarm.minutes, OTHER_SENDER_ALARM_AT);
  assert.equal(alarm.mail, true);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, new RegExp(`ACTION NOW: ${OTHER_SENDER_ALARM_AT} WhatsApp messages in a day that WaPay's code did not send`));
  assert.match(mails[0].detailsHtml, /UniFuel/); assert.match(mails[0].detailsHtml, /replace the WhatsApp token/);
  assert.ok(!mails[0].detailsHtml.includes(NEVER_WROTE));
  const again = await strangerCheck({ prisma: db, status: sent(), now: NOW + 30 * 60_000, deps });
  assert.equal(again.told, false);
  assert.equal(mails.length, 1, 'one alarm a day');
});

// ------------------------------------------------------------------ the daily compliance check

const verdictFor = (rows, previousCodes = []) => {
  const pulses = measurePulses(rows.map((waMessageId) => ({ waMessageId })));
  return { pulses, ...complianceVerdict({ meta: { ok: true, quality: 'GREEN' }, pulses, behaviour: {}, previousCodes }) };
};

test("the daily check reports another sender's messages apart from WaPay's own", () => {
  const one = verdictFor(['external-utility:2026-11-17T15:35', 'price-utility:2026-11-17T15:35']);
  assert.deepEqual(one.pulses.external, { utility: 1 });
  assert.deepEqual(one.pulses.strangers, {});
  assert.equal(one.verdict, 'AMBER');
  assert.deepEqual(one.reasons.map((r) => r.code), ['OTHER_SENDER_ON_NUMBER']);
  assert.match(one.reasons[0].text, /that WaPay's code did not send/);
  assert.match(one.reasons[0].text, /UniFuel/);
  assert.ok(!/missing lib\/outbound-guard/.test(one.reasons[0].text), 'no one is sent to look for a gate that is not missing');

  const own = verdictFor(['stranger-utility:2026-11-21T09:10']);
  assert.equal(own.verdict, 'RED');
  assert.deepEqual(own.reasons.map((r) => r.code), ['SENT_TO_STRANGER']);
  assert.match(own.reasons[0].text, /WaPay's own code sent/);

  const many = verdictFor([...Array.from({ length: OTHER_SENDER_ALARM_AT }, (_, i) => `external-utility:2026-11-17T15:${10 + i}`), 'stranger-unread-utility:2026-11-17T16:00']);
  assert.equal(many.verdict, 'RED');
  assert.equal(many.reasons[0].code, 'OTHER_SENDER_VOLUME', 'volume leads the list');
  assert.ok(many.reasons.some((r) => r.code === 'STRANGER_CHECK_BLIND' && r.level === 'AMBER'));
  assert.equal(many.pulses.unread, 1);
  assert.deepEqual(many.pulses.strangers, {}, 'an unread row is never counted as a stranger');

  const text = summaryText({ verdict: one.verdict, reasons: one.reasons, newCodes: one.newCodes, meta: { quality: 'GREEN' }, pulses: one.pulses, behaviour: {}, at: '2026-11-18T02:00:00Z' });
  assert.match(text, /0 minute\(s\) of WaPay's own messages to numbers that never wrote, 1 minute\(s\) of such messages from another sender on the number/);
  assert.equal(verdictFor([]).verdict, 'GREEN');
});

test("a record written before WaPay marked its sends is not called WaPay's own send", () => {
  // 20 November 2026: the build that tells senders apart went live at 14:54 UTC. The row for that
  // morning's message was written by the build before it, under the name the new build keeps for
  // WaPay's own sends, and the next daily check would have said "WaPay's own code sent".
  const old = verdictFor(['stranger-utility:2026-11-20T11:55', 'price-utility:2026-11-20T11:55']);
  assert.deepEqual(old.pulses.unattributed, { utility: 1 });
  assert.deepEqual(old.pulses.strangers, {});
  assert.equal(old.verdict, 'AMBER');
  assert.deepEqual(old.reasons.map((r) => r.code), ['STRANGER_SENDER_NOT_RECORDED']);
  assert.match(old.reasons[0].text, /does not say whose code sent it/);
  assert.ok(!/WaPay's own code sent|missing lib\/outbound-guard/.test(old.reasons[0].text));

  // The boundary: the last minute before the build is unattributed, its first minute is WaPay's own.
  assert.equal(MARK_LIVE_SINCE, '2026-11-20T14:55');
  assert.deepEqual(verdictFor(['stranger-utility:2026-11-20T14:54']).reasons.map((r) => r.code), ['STRANGER_SENDER_NOT_RECORDED']);
  assert.deepEqual(verdictFor(['stranger-utility:2026-11-20T14:55']).reasons.map((r) => r.code), ['SENT_TO_STRANGER']);
  // A row with no readable minute is not excused.
  assert.deepEqual(verdictFor(['stranger-utility']).reasons.map((r) => r.code), ['SENT_TO_STRANGER']);
  // Both in one day: WaPay's own send is still RED and leads.
  const both = verdictFor(['stranger-utility:2026-11-20T11:55', 'stranger-marketing:2026-11-20T16:00']);
  assert.equal(both.verdict, 'RED');
  assert.equal(both.reasons[0].code, 'SENT_TO_STRANGER');
  assert.deepEqual(both.pulses.strangers, { marketing: 1 });
  assert.deepEqual(both.pulses.unattributed, { utility: 1 });
});

// ------------------------------------------------------------------ the wiring

test('the sender marks templates and Direct Sends, the webhook passes the sending number, the daily check reads the new rows', () => {
  const send = read('../packages/whatsapp/src/send.ts');
  assert.match(send, /const payload = buildTemplatePayload\(\{ to, templateName, languageCode: resolvedLanguage, components \}\);/);
  assert.match(send, /if \(args\.category\) \{\s*payload\.category = args\.category;\s*payload\.biz_opaque_callback_data = WAPAY_SEND_TAG;/);
  assert.equal((send.match(/biz_opaque_callback_data: WAPAY_SEND_TAG/g) || []).length, 1, 'templates are marked in one place');
  assert.equal((send.match(/await postMessage\(url, accessToken, payload\)/g) || []).length, 2, 'the template and the text sender, nothing else');
  const hook = read('../pages/api/webhooks/whatsapp.js');
  assert.match(hook, /phoneNumberId: change\.value\?\.metadata\?\.phone_number_id \|\| null/);
  const daily = read('../lib/meta-compliance.js');
  assert.match(daily, /waMessageId: \{ startsWith: 'external-' \}/);
  assert.match(daily, /waMessageId: \{ startsWith: 'stranger-' \}/);
  assert.match(daily, /waMessageId: \{ startsWith: 'marked-' \}/);
});
