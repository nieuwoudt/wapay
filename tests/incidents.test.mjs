/**
 * Live incidents (lib/incidents.js, lib/incident-kinds.js, lib/incidents-api.js, lib/responder-auth.js):
 * an alert's facts are kept as a row an agent can pick up, masked like the audit's own rows, counted
 * when they repeat, reopened when they come back, never closed by the daily run, and readable through a
 * route whose key opens nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { incidentRow, recordIncident, incidentLine, toResponderFinding, LIVE_RUN_ID } from '../lib/incidents.js';
import { echoLoopIncident, ownStrangerSendIncident, otherSenderVolumeIncident } from '../lib/incident-kinds.js';
import { listForResponder, resolveForResponder, NOTE_MIN } from '../lib/incidents-api.js';
import { responderAuth, RESPONDER_KEY_MIN } from '../lib/responder-auth.js';
import { settleStatuses, resolveFinding, fingerprintOf } from '../lib/audit/store.js';
import { loopedPhrases, echoLoop } from '../lib/loop-guard.js';
import { strangerCheck, OTHER_SENDER_ALARM_AT } from '../lib/meta-alerts.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const NOW = new Date('2026-11-18T12:14:20Z');

function findingsStore(seed = []) {
  const rows = seed.map((r) => ({ ...r }));
  const calls = { updateMany: [] };
  return {
    rows, calls,
    auditFinding: {
      findUnique: async ({ where }) => rows.find((r) => r.fingerprint === where.fingerprint) || null,
      create: async ({ data }) => { const row = { id: `f${rows.length + 1}`, ...data }; rows.push(row); return row; },
      update: async ({ where, data }) => { const row = rows.find((r) => r.fingerprint === where.fingerprint); Object.assign(row, data); return row; },
      updateMany: async (args) => { calls.updateMany.push(args); return { count: 0 }; },
      findMany: async ({ where }) => rows.filter((r) => where.status.in.includes(r.status)),
    },
  };
}

// ------------------------------------------------------------------ the row

test('an incident row is masked like an audit row: no long number, no known name, clamped quotes', () => {
  const row = incidentRow({
    category: 'stuck-loop', title: 'The chat asked twice for words nothing handles: "business login"',
    why: 'Customer Thandi Mokoena on 27821234567 was asked again.', fix: 'Handle it.',
    accountId: 'acc1', displayName: 'Thandi Mokoena',
    botQuote: `Hi Thandi! Say *business login* for your code. Call 0821234567. ${'x'.repeat(400)}`, userQuote: 'business login', now: NOW,
  });
  assert.equal(row.fingerprint, fingerprintOf('stuck-loop', row.title));
  assert.match(row.fingerprint, /^[0-9a-f]{40}$/);
  assert.equal(row.severity, 'P1');
  assert.ok(!/Thandi|Mokoena/.test(JSON.stringify(row)), 'the display name and its parts are masked everywhere');
  assert.ok(!/\d{6,}/.test(`${row.why} ${row.sampleBotQuote}`), 'no number of six digits or more');
  assert.match(row.why, /\[name\]/); assert.match(row.why, /\[number\]/);
  assert.ok(row.sampleBotQuote.length <= 200);
  assert.deepEqual(row.account, { id: 'acc1', at: NOW.toISOString() });
  assert.equal(incidentRow({ title: '' }), null);
  assert.equal(incidentRow({ title: 'x', severity: 'URGENT' }).severity, 'P2', 'an unknown severity is not promoted');
  assert.equal(incidentRow({ title: 'x', category: 'Stuck Loop!' }).category, 'stuckloop');
});

test('the same incident is one row, counted; a resolved one that returns reopens as recurring and keeps its note', async () => {
  const db = findingsStore();
  const incident = echoLoopIncident({ phrases: ['business login'], reply: 'Say *business login* for your code.', accountId: 'acc1', displayName: 'Thandi' });
  const first = await recordIncident({ prisma: db, now: NOW, ...incident });
  assert.equal(first.ok, true); assert.equal(first.created, true); assert.equal(first.status, 'open');
  assert.equal(first.ref, first.fingerprint.slice(0, 10));
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].firstSeenRunId, LIVE_RUN_ID); assert.equal(db.rows[0].lastSeenRunId, LIVE_RUN_ID);
  assert.equal(db.rows[0].occurrences, 1); assert.equal(db.rows[0].accountCount, 1);

  const second = await recordIncident({ prisma: db, now: new Date(NOW.getTime() + 60_000), ...echoLoopIncident({ phrases: ['business login'], reply: 'Say *business login*.', accountId: 'acc2' }) });
  assert.equal(second.created, false);
  assert.equal(db.rows.length, 1, 'another customer, the same words: the same row');
  assert.equal(db.rows[0].occurrences, 2); assert.equal(db.rows[0].accountCount, 2);
  assert.deepEqual(db.rows[0].accountsJson.map((a) => a.id), ['acc2', 'acc1'], 'newest first');

  await resolveFinding({ prisma: db, fingerprint: first.fingerprint, note: 'Fixed in abc1234, BUGLOG #153' });
  assert.equal(db.rows[0].status, 'resolved');
  const third = await recordIncident({ prisma: db, now: new Date(NOW.getTime() + 120_000), ...incident });
  assert.equal(third.status, 'recurring');
  assert.equal(db.rows[0].resolvedAt, null);
  assert.equal(db.rows[0].resolvedNote, 'Fixed in abc1234, BUGLOG #153', 'the note stays, so the regression is visible');

  const other = await recordIncident({ prisma: db, now: NOW, ...echoLoopIncident({ phrases: ['reset PIN'], reply: 'Type *reset PIN*.', accountId: 'acc1' }) });
  assert.equal(other.created, true, 'other words are another incident');
  assert.equal(db.rows.length, 2);
});

test('recording never throws and never waits long: no store, a failing store and a slow one all return', async () => {
  assert.deepEqual(await recordIncident({ prisma: {}, title: 'x' }), { ok: false, error: 'NO_STORE' });
  assert.deepEqual(await recordIncident({ prisma: findingsStore(), title: '' }), { ok: false, error: 'NO_TITLE' });
  const quiet = console.error; console.error = () => {};
  try {
    const failing = { auditFinding: { findUnique: async () => { throw new Error('down'); } } };
    assert.equal((await recordIncident({ prisma: failing, title: 'x' })).ok, false);
  } finally { console.error = quiet; }
  const slow = { auditFinding: { findUnique: () => new Promise((resolve) => setTimeout(() => resolve(null), 200)), create: async () => ({}) } };
  const started = Date.now();
  const timedOut = await recordIncident({ prisma: slow, title: 'x', capMs: 20 });
  assert.equal(timedOut.error, 'TIMEOUT'); assert.ok(Date.now() - started < 150);
  assert.match(timedOut.ref, /^[0-9a-f]{10}$/, 'the reference is known even when the write did not finish');
  assert.equal(incidentLine({ ok: false }), '');
  assert.match(incidentLine({ ok: true, ref: 'abcdef0123' }), /Recorded as finding abcdef0123/);
});

test('the daily run never closes a live row: only a note does', async () => {
  const db = findingsStore();
  await settleStatuses({ prisma: db, runId: 'run2', previousRunId: 'run1', now: NOW });
  assert.deepEqual(db.calls.updateMany[0].where.lastSeenRunId, { notIn: ['run2', 'run1', LIVE_RUN_ID] });
  assert.equal(LIVE_RUN_ID, 'live');
});

// ------------------------------------------------------------------ the kinds

test("a loop incident carries the product's own words, never the customer's message", () => {
  const previous = 'To reset it, type *reset PIN* and I will help.';
  const reply = 'Please type *reset PIN* to continue.';
  const inbound = 'Reset pin 2006';
  assert.equal(echoLoop(reply, inbound, previous), true);
  assert.deepEqual(loopedPhrases(reply, inbound, previous), ['reset PIN'], "the reply's phrase, not what the customer typed after it");
  assert.deepEqual(loopedPhrases(reply, 'balance', previous), []);
  assert.deepEqual(loopedPhrases(reply, inbound, 'Hello there'), [], 'not a loop when the previous reply never asked');
  const incident = echoLoopIncident({ phrases: loopedPhrases(reply, inbound, previous), reply, accountId: 'acc1', source: 'NONE' });
  assert.ok(!JSON.stringify(incident).includes('2006'), 'four digits typed after the phrase could be a PIN: never kept');
  assert.match(incident.title, /"reset PIN"/);
  assert.match(incident.fix, /message-processor-v2\.js/); assert.match(incident.fix, /how-it-works\.js/);
  assert.match(incident.why, /a person will write to them/, 'whoever fixes it knows the customer was promised a person');
  assert.equal(incident.userQuote, 'reset PIN');
  assert.equal(incident.category, 'stuck-loop');
});

test('the two send incidents say whose code sent the message and where to look, with no number in them', () => {
  const own = ownStrangerSendIncident({ category: 'utility', reason: 'NO_ACCOUNT' });
  assert.equal(own.severity, 'P1'); assert.equal(own.category, 'security');
  assert.match(own.title, /WaPay's own code sent a utility message/);
  assert.match(own.fix, /spam-strike-guard\.test\.mjs/);
  const volume = otherSenderVolumeIncident({ category: 'utility', minutes: 7 });
  assert.match(volume.why, /7 minutes/); assert.match(volume.why, /UniFuel/);
  assert.match(volume.fix, /replaces it in Meta and in Vercel/);
  for (const i of [own, volume]) assert.ok(!/\d{6,}/.test(JSON.stringify(i)));
  assert.notEqual(incidentRow(own).fingerprint, incidentRow(volume).fingerprint);
  assert.equal(incidentRow(ownStrangerSendIncident({ category: 'utility', reason: 'NO_ACCOUNT' })).fingerprint, incidentRow(ownStrangerSendIncident({ category: 'utility', reason: 'PRE_REGISTERED_ONLY' })).fingerprint, 'one incident whatever the reason');
});

test("the stranger check records an incident beside each alert, and none for another sender's single message", async () => {
  const rows = [];
  const db = {
    account: { findFirst: async () => null }, conversationTurn: { findFirst: async () => null },
    processedMessage: {
      create: async ({ data }) => { if (rows.some((r) => r.waMessageId === data.waMessageId)) { const e = new Error('dup'); e.code = 'P2002'; throw e; } rows.push(data); return data; },
      count: async ({ where }) => rows.filter((r) => r.waMessageId.startsWith(where.waMessageId.startsWith)).length,
    },
  };
  const mails = []; const recorded = [];
  const deps = { sendOpsAlert: async (a) => { mails.push(a); return { success: true }; }, opsPersonAlert: async () => ({ sent: 1 }), recordIncident: async (i) => { recorded.push(i); return { ok: true }; } };
  const status = (extra = {}) => ({ status: 'sent', recipient_id: '27830000099', pricing: { category: 'utility' }, ...extra });
  const t0 = Date.parse('2026-11-18T13:00:00Z');

  const single = await strangerCheck({ prisma: db, status: status(), now: t0, deps });
  assert.equal(single.external, true);
  assert.equal(recorded.length, 0, 'one voucher delivery from another product is not an incident');

  const own = await strangerCheck({ prisma: db, status: status({ biz_opaque_callback_data: 'wapay' }), now: t0 + 60_000, deps });
  assert.match(own.incident, /^[0-9a-f]{10}$/);
  assert.equal(recorded.length, 1);
  assert.match(recorded[0].title, /WaPay's own code sent a utility message/);
  assert.match(mails[0].detailsHtml, new RegExp(`Recorded as finding ${own.incident}`), 'the alert quotes the reference the row carries');
  assert.equal(incidentRow(recorded[0]).fingerprint.slice(0, 10), own.incident);

  for (let i = 2; i < OTHER_SENDER_ALARM_AT; i++) await strangerCheck({ prisma: db, status: status(), now: t0 + i * 60_000, deps });
  assert.equal(recorded.length, 1);
  const alarm = await strangerCheck({ prisma: db, status: status(), now: t0 + 20 * 60_000, deps });
  assert.equal(alarm.minutes, OTHER_SENDER_ALARM_AT);
  assert.equal(recorded.length, 2);
  assert.match(recorded[1].title, /Another sender on WaPay's number/);
  assert.match(mails[1].detailsHtml, new RegExp(`Recorded as finding ${alarm.incident}`));
});

// ------------------------------------------------------------------ the responder's route

const seed = () => findingsStore([
  { id: 'a', fingerprint: 'a'.repeat(40), severity: 'P2', category: 'tone', title: 'Old audit P2', status: 'recurring', firstSeenRunId: 'run1', lastSeenRunId: 'run9', lastSeenAt: new Date('2026-11-18T02:00:00Z'), occurrences: 9, accountCount: 4, accountsJson: [{ id: 'acc9', at: null }], why: 'w', fix: 'f' },
  { id: 'b', fingerprint: 'b'.repeat(40), severity: 'P1', category: 'wrong-fact', title: 'Audit P1', status: 'open', firstSeenRunId: 'run9', lastSeenRunId: 'run9', lastSeenAt: new Date('2026-11-18T02:00:00Z'), occurrences: 1, accountCount: 1, accountsJson: [{ id: 'acc7', at: null }] },
  { id: 'c', fingerprint: 'c'.repeat(40), severity: 'P1', category: 'stuck-loop', title: 'Live P1', status: 'open', firstSeenRunId: LIVE_RUN_ID, lastSeenRunId: LIVE_RUN_ID, lastSeenAt: new Date('2026-11-18T12:14:00Z'), occurrences: 1, accountCount: 1, accountsJson: [{ id: 'acc1', at: null }], sampleBotQuote: 'Say *business login*.' },
  { id: 'd', fingerprint: 'd'.repeat(40), severity: 'P1', category: 'money', title: 'Closed', status: 'resolved', firstSeenRunId: 'run1', lastSeenRunId: 'run1', lastSeenAt: new Date('2026-11-01T02:00:00Z') },
]);

test('the work list is every open and recurring finding, most urgent first, with no account id in it', async () => {
  const out = await listForResponder({ prisma: seed() });
  assert.deepEqual(out.findings.map((f) => f.title), ['Live P1', 'Audit P1', 'Old audit P2'], 'P1 first; a live alert before an audit finding');
  assert.deepEqual(out.counts, { open: 2, recurring: 1, live: 1, p1: 2 });
  assert.equal(out.findings[0].live, true); assert.equal(out.findings[1].live, false);
  assert.equal(out.findings[0].ref, 'c'.repeat(10));
  const body = JSON.stringify(out);
  assert.ok(!/acc1|acc7|acc9|accountsJson/.test(body), 'account ids stay in the database');
  assert.equal(out.findings[2].accounts, 4, 'a count is all that leaves');
  assert.deepEqual(Object.keys(toResponderFinding({ fingerprint: 'e'.repeat(40) })).sort(), ['accounts', 'category', 'fingerprint', 'firstSeenAt', 'fix', 'lastSeenAt', 'live', 'occurrences', 'ref', 'resolvedNote', 'sampleBotQuote', 'sampleUserQuote', 'severity', 'status', 'title', 'why']);
  assert.equal((await listForResponder({ prisma: seed(), limit: 1 })).findings.length, 1);
});

test('closing an item needs a real fingerprint and a note that says what fixed it', async () => {
  const db = seed();
  assert.deepEqual(await resolveForResponder({ prisma: db, fingerprint: 'nope', note: 'Fixed in abc1234, BUGLOG #153' }), { ok: false, status: 400, error: 'BAD_FINGERPRINT' });
  assert.deepEqual(await resolveForResponder({ prisma: db, fingerprint: 'c'.repeat(40), note: 'done' }), { ok: false, status: 400, error: 'BAD_NOTE' });
  assert.deepEqual(await resolveForResponder({ prisma: db, fingerprint: 'c'.repeat(40), note: 'x'.repeat(501) }), { ok: false, status: 400, error: 'BAD_NOTE' });
  assert.deepEqual(await resolveForResponder({ prisma: db, fingerprint: 'f'.repeat(40), note: 'Fixed in abc1234, BUGLOG #153' }), { ok: false, status: 404, error: 'NOT_FOUND' });
  assert.ok(NOTE_MIN >= 10);
  const ok = await resolveForResponder({ prisma: db, fingerprint: 'C'.repeat(40), note: 'Fixed in abc1234, BUGLOG #153' });
  assert.equal(ok.ok, true); assert.equal(ok.finding.status, 'resolved');
  assert.equal(ok.finding.resolvedNote, '[responder] Fixed in abc1234, BUGLOG #153', 'a note written with the responder key says so');
  const byOperator = await resolveForResponder({ prisma: db, fingerprint: 'b'.repeat(40), note: 'Checked by hand: the rail is live.', by: 'internal' });
  assert.equal(byOperator.finding.resolvedNote, 'Checked by hand: the rail is live.');
  assert.equal((await listForResponder({ prisma: db })).findings.length, 1);
});

test("the responder's key opens the incident route and the check fails closed", () => {
  const RESPONDER = 'r'.repeat(RESPONDER_KEY_MIN); const INTERNAL = 'i'.repeat(40);
  const env = { WAPAY_RESPONDER_KEY: RESPONDER, WAPAY_INTERNAL_API_KEY: INTERNAL };
  const req = (headers) => ({ headers });
  assert.deepEqual(responderAuth(req({ 'x-responder-key': RESPONDER }), env), { ok: true, as: 'responder' });
  assert.deepEqual(responderAuth(req({ 'x-internal-api-key': INTERNAL }), env), { ok: true, as: 'internal' });
  assert.deepEqual(responderAuth(req({}), env), { ok: false, status: 401, error: 'AUTH' });
  assert.equal(responderAuth(req({ 'x-responder-key': `${RESPONDER}x` }), env).ok, false);
  assert.equal(responderAuth(req({ 'x-responder-key': INTERNAL }), env).ok, false, 'a key is only good in its own header');
  assert.equal(responderAuth(req({ 'x-internal-api-key': RESPONDER }), env).ok, false);
  assert.equal(responderAuth(req({ 'x-responder-key': ['a', 'b'] }), env).ok, false);
  assert.deepEqual(responderAuth(req({ 'x-responder-key': 'short' }), { WAPAY_RESPONDER_KEY: 'short' }), { ok: false, status: 503, error: 'CONFIG' }, 'a short key is not a key, and with no other key nobody gets in');
  assert.equal(responderAuth(req({ 'x-responder-key': 'short' }), { WAPAY_RESPONDER_KEY: 'short', WAPAY_INTERNAL_API_KEY: INTERNAL }).status, 401);
  assert.deepEqual(responderAuth(req({ 'x-responder-key': RESPONDER }), {}), { ok: false, status: 503, error: 'CONFIG' });
  assert.equal(responderAuth(null, env).ok, false);
});

test("the responder's key is accepted by one route only", () => {
  const route = read('../pages/api/internal/incidents.js');
  assert.match(route, /const auth = responderAuth\(req\);\s*if \(!auth\.ok\)/, 'the check runs before anything is read');
  assert.ok(route.indexOf('responderAuth(req)') < route.indexOf('listForResponder({ prisma'), 'and before the database');
  assert.match(route, /Cache-Control', 'private, no-store'/);
  // No other file in the product reads the responder key or imports the check.
  const users = [];
  const walk = (dir) => {
    for (const name of readdirSyncSafe(dir)) {
      const rel = `${dir}/${name}`;
      if (/node_modules|\.next|\/tests$|\/docs$|\/\.git$/.test(rel)) continue;
      if (isDir(rel)) walk(rel);
      else if (/\.(js|mjs|ts)$/.test(name) && /WAPAY_RESPONDER_KEY|responder-auth\.js/.test(read(`../${rel}`))) users.push(rel);
    }
  };
  walk('lib'); walk('pages'); walk('packages'); walk('scripts');
  assert.deepEqual(users.sort(), ['lib/responder-auth.js', 'pages/api/internal/incidents.js']);
});

test('the loop guard records its incident beside the alert, and the customer is not kept waiting for it', () => {
  const processor = read('../pages/api/webhooks/message-processor-v2.js');
  const guard = processor.slice(processor.indexOf('async function breakEchoLoop('), processor.indexOf('// SMART PRODUCT QUERY HANDLER'));
  assert.match(guard, /const phrases = loopedPhrases\(reply, inbound, prev\?\.text \|\| ''\);\s*if \(!phrases\.length\) return null;/);
  assert.match(guard, /await Promise\.all\(\[\s*sendOpsAlert\(/, 'the mail and the row go together');
  assert.match(guard, /recordIncident\(\{ prisma, \.\.\.incident \}\)/);
  assert.ok(!/userQuote: inbound|botQuote: inbound|\$\{inbound\}|\$\{text\}/.test(guard), "the customer's message is not put in the mail or the row");
});

import { readdirSync, statSync } from 'node:fs';
function readdirSyncSafe(dir) { try { return readdirSync(fileURLToPath(new URL(`../${dir}`, import.meta.url))); } catch { return []; } }
function isDir(rel) { try { return statSync(fileURLToPath(new URL(`../${rel}`, import.meta.url))).isDirectory(); } catch { return false; } }
