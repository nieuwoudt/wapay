/**
 * Mission Control's support side (founder 2026-10-19): the inbox, one customer's
 * conversation, the tabs, the refresh, the period tiles, the links charts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { summariseTurns } from '../lib/inbox.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const at = (min) => new Date(Date.parse('2026-10-19T10:00:00Z') + min * 60000).toISOString();
const NOW = Date.parse('2026-10-19T11:00:00Z');

test('summariseTurns: flags, questions and counts an operator needs', () => {
  const turns = [
    { at: at(0), role: 'user', text: 'How do I withdraw?' },
    { at: at(1), role: 'assistant', kind: 'flow', text: 'You have R0 to withdraw…', refs: { gate: 'g', tier: 0 } },
    { at: at(2), role: 'user', text: 'withdraw' },
    { at: at(3), role: 'assistant', kind: 'flow', text: 'Let me explain…', refs: { gate: 'g', tier: 1 } },
    { at: at(4), role: 'user', text: 'yes' },
    { at: at(5), role: 'assistant', kind: 'flow', text: 'I have asked a person…', refs: { gate: 'g', tier: 2, personAsked: true } },
    { at: at(6), role: 'assistant', kind: 'ops', text: 'Hi, this is the WaPay team…' },
    { at: at(7), role: 'user', text: 'Close my account' },
  ];
  const s = summariseTurns(turns, { now: NOW });
  assert.equal(s.unanswered, true, 'the last turn is theirs and older than ten minutes');
  assert.equal(s.gateTier, 2); assert.equal(s.personAsked, true); assert.equal(s.closeAsk, true); assert.equal(s.opsReplies, 1); assert.equal(s.needsPerson, true);
  assert.deepEqual(s.counts, { user: 4, bot: 4 });
  assert.equal(s.questions.length, 1); assert.equal(s.questions[0].text, 'How do I withdraw?');
  assert.equal(s.lastUserText, 'Close my account');
  const fresh = summariseTurns([{ at: new Date(NOW - 60000).toISOString(), role: 'user', text: 'hi' }], { now: NOW });
  assert.equal(fresh.unanswered, false, 'a message a minute old is not unanswered yet');
  assert.equal(summariseTurns([], { now: NOW }).needsPerson, false);
});

test('the inbox and conversation routes are admin-guarded, bounded, and never log a customer', () => {
  for (const f of ['../pages/api/admin/inbox.js', '../pages/api/admin/customer-turns.js']) {
    const r = read(f);
    assert.match(r, /if \(!requireAdmin\(req\)\.ok\) return res\.status\(401\)/, f);
    assert.ok(!/console\.log|console\.error/.test(r), `${f}: no logging of conversation data`);
    assert.match(r, /summariseTurns/);
  }
  assert.match(read('../pages/api/admin/inbox.js'), /Math\.min\(300, Math\.max\(10, Number\(req\.query\.limit\) \|\| 100\)\)/);
  assert.match(read('../pages/api/admin/customer-turns.js'), /if \(!\/\^\[a-z0-9\]\{20,40\}\$\/i\.test\(id\)\) return res\.status\(400\)/);
});

test('Mission Control: six tabs, deep links, the refresh, the period tiles, the inbox, the conversation card, the health and floats tabs', () => {
  const page = read('../pages/admin/index.js');
  assert.match(page, /const TABS = \[\['dashboard', 'Dashboard'\], \['growth', 'Valuation Metrics'\], \['inbox', 'Inbox'\], \['customer', 'Customers'\], \['health', 'Health'\], \['floats', 'Supplier Floats'\]\];/);
  assert.match(page, /const c = q\.get\('customer'\); if \(c\) \{ setInitialCustomer\(c\); setTab\('customer'\); \}/);
  assert.match(page, /\['1', '7', '30', '90', 'all'\]\.map/);
  assert.match(page, /↻ Refresh/);
  assert.match(page, /function FloatTile\(\{ balancesCents, tick = 0 \}\)/);
  assert.match(page, /const p = range === '1' \? v\.today : \(v\.period \|\| v\.today\);/);
  assert.match(page, /function Inbox\(\)/); assert.match(page, /fetch\(`\/api\/admin\/inbox\?days=\$\{days\}&limit=150`\)/);
  assert.match(page, /function ConversationCard\(\{ accountId, tick = 0, compact = false \}\)/); assert.match(page, /\/api\/admin\/customer-turns\?id=/);
  assert.match(page, /<ConversationCard accountId=\{c\.account\.id\} \/>/, 'the profile carries the conversation');
  assert.match(page, /function Health\(\)/); assert.match(page, /<AuditPanel tick=\{tick\} \/>/); assert.match(page, /fetch\('\/api\/admin\/audit'\)/);
  assert.match(page, /function FloatsTab\(\)/);
  assert.match(page, /target="_blank" rel="noopener noreferrer" onClick=\{\(e\) => e\.stopPropagation\(\)\}/, 'a customer opens on its own page');
  assert.match(page, /function cumulativeLinks\(daily\)/); assert.match(page, /Fee outlook from every link made so far/);
  assert.match(page, /function insightFrom\(v, t\)/);
  assert.ok(!/<h2>Money-engine health<\/h2>[\s\S]*function LinksAndLoop/.test(page.slice(page.indexOf('function Dashboard()'), page.indexOf('function LinksAndLoop'))), 'the health cards left the Dashboard');
});

test('the routes behind the tabs: a 1-day range, the period money figures, links over time, paid links as a product, the all-time path', () => {
  const m = read('../pages/api/admin/metrics.js');
  assert.match(m, /const RANGES = \{ '1': 1, '7': 7, '30': 30, '90': 90, all: 3650 \};/);
  assert.match(m, /const period = await safe\(async \(\) => \{/); assert.match(m, /today,\s*period,/);
  assert.match(m, /daily: series,/); assert.match(m, /cashFeeCents: sum\(createdSoFar, \(r\) => cashoutFeeCents\('CASHSEND', Number\(r\.amountCents\)\)\)/);
  assert.match(m, /category: 'Please-pay-me links paid'/);
  const g = read('../pages/api/admin/growth.js');
  assert.match(g, /const pathSeries = \(\(\) => \{/); assert.match(g, /daily,\s*pathSeries,/);
});
