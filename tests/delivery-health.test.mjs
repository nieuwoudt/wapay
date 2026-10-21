// Delivery health (BUGLOG #136): a restriction shows in Meta's delivery statuses long before anyone notices a silent chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deliveryCounts, verdictFor, deliveryHealth, deliveryStallCheck, deliveryAlertText, CODE_MEANING } from '../lib/delivery-health.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const NOW = Date.parse('2026-10-21T06:40:00Z');
const rowsFor = (minutes) => minutes <= 15
  ? [{ kind: 'status-failed-131031', n: 9, first_at: '2026-10-21T06:27:00Z', last_at: '2026-10-21T06:35:00Z' }]
  : minutes <= 60
    ? [{ kind: 'status-failed-131031', n: 23, first_at: '2026-10-21T05:41:00Z', last_at: '2026-10-21T06:35:00Z' }, { kind: 'status-delivered', n: 1, first_at: '2026-10-21T06:29:00Z', last_at: '2026-10-21T06:29:00Z' }]
    : [{ kind: 'status-failed-131031', n: 74, first_at: '2026-10-20T21:30:00Z', last_at: '2026-10-21T06:35:00Z' }, { kind: 'status-delivered', n: 12, first_at: '2026-10-20T20:00:00Z', last_at: '2026-10-21T06:29:00Z' }, { kind: 'status-sent', n: 37, first_at: '2026-10-20T20:00:00Z', last_at: '2026-10-20T20:59:00Z' }];
const prisma = { $queryRawUnsafe: async (sql) => { const m = sql.match(/"processedAt" >= '([^']+)'/); const since = Date.parse(m[1]); const minutes = Math.round((NOW - since) / 60000); return rowsFor(minutes); } };

test('counts: delivered, sent and read are ok; failures are grouped by code with the first failure time', async () => {
  const c = await deliveryCounts({ prisma, now: NOW, minutes: 24 * 60 });
  assert.equal(c.ok, 49); assert.equal(c.failed, 74); assert.deepEqual(c.byCode, { 131031: 74 }); assert.equal(c.firstFailAt, '2026-10-20T21:30:00Z');
});

test('the verdict: stalled when a code repeats with nothing delivered, degraded when failures outnumber successes, ok otherwise', () => {
  assert.deepEqual(verdictFor({ last15: { failed: 9, ok: 0, byCode: { 131031: 9 } }, last60: { failed: 23, ok: 1, byCode: { 131031: 23 } } }), { verdict: 'STALLED', code: '131031' });
  assert.deepEqual(verdictFor({ last15: { failed: 2, ok: 0, byCode: { 131026: 2 } }, last60: { failed: 4, ok: 1, byCode: { 131026: 4 } } }), { verdict: 'DEGRADED', code: '131026' });
  assert.deepEqual(verdictFor({ last15: { failed: 0, ok: 0, byCode: {} }, last60: { failed: 0, ok: 0, byCode: {} } }), { verdict: 'OK', code: null }, 'a quiet night is not a stall');
  assert.deepEqual(verdictFor({ last15: { failed: 1, ok: 6, byCode: { 131026: 1 } }, last60: { failed: 2, ok: 40, byCode: { 131026: 2 } } }), { verdict: 'OK', code: null }, 'one blocked number is normal');
});

test('deliveryHealth reads the three windows and the stall check alerts by e-mail and WhatsApp once per hour per code', async () => {
  const h = await deliveryHealth({ prisma, now: NOW });
  assert.equal(h.verdict, 'STALLED'); assert.equal(h.code, '131031'); assert.equal(h.last24h.failed, 74);
  const persons = []; const mails = [];
  const deps = { opsPersonAlert: async (a) => { persons.push(a); return { sent: 1 }; }, sendOpsAlert: async (a) => { mails.push(a); return { success: true }; } };
  const r = await deliveryStallCheck({ prisma, now: NOW, deps });
  assert.equal(r.alerted, true); assert.equal(r.key, 'wa-delivery:131031:2026-10-21T06'); assert.equal(r.mail, true);
  assert.match(persons[0].text, /^🚨 WhatsApp delivery STALLED: in the last 15 minutes 9 of WaPay's messages failed with code 131031 \(account locked or restricted by Meta/);
  assert.match(mails[0].subject, /WhatsApp delivery STALLED \(131031\)/);
  const quiet = { $queryRawUnsafe: async () => [] };
  const q = await deliveryStallCheck({ prisma: quiet, now: NOW, deps });
  assert.equal(q.alerted, false); assert.equal(q.verdict, 'OK');
  assert.ok(!/—/.test(deliveryAlertText(h))); assert.ok(CODE_MEANING[131047]);
});

test('the inbound webhook runs the check at most every ten minutes, the quality route and Health card show delivery, the cron alerts too', () => {
  const hook = read('../pages/api/webhooks/whatsapp.js');
  assert.match(hook, /delivery-check:/); assert.match(hook, /deliveryStallCheck/);
  assert.match(read('../pages/api/admin/whatsapp-quality.js'), /deliveryHealth/);
  assert.match(read('../pages/admin/index.js'), /Delivery, last hour/);
  assert.match(read('../pages/api/cron/daily-vas-sync.js'), /deliveryStallCheck/);
});
