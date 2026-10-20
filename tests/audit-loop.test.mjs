/**
 * The daily conversation audit loop (CHANGELOG 99, docs/audits/DAILY_AUDIT.md):
 * the export's redaction, the rules on fixtures (eWallet, R20, loop,
 * unanswered, example echo), the generated brief in both switch worlds,
 * fingerprint stability and recurrence over four runs, the review parser on
 * good, partial and bad JSON, the privacy path through the real boundary,
 * the routes refusing without the key or a session, and the cron step that
 * never throws. No database: every prisma is a stub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { redactText, maskNameAnswers, nameParts, maskNames, exportTurns } from '../lib/audit/export.js';
import { scanExport, RULES, CATEGORIES } from '../lib/audit/rules.js';
import { truthBlock, buildReviewBrief, liveProviders, FALLBACK_PROVIDERS, minWithdrawCents } from '../lib/audit/brief.js';
import { parseReviewOutput, chunkAccounts, renderAccount, reviewAccounts, defaultReviewModel, reviewConcurrency, REVIEW_SCHEMA } from '../lib/audit/review.js';
import { fingerprintOf, normaliseTitle, groupFindings, mergeAccounts, toAdminFinding, RESOLVED_BY_RULE_NOTE } from '../lib/audit/store.js';
import { runDailyAudit, opsSummary, scrubText, normaliseFinding, severityCounts } from '../lib/audit/run.js';
import { guardChatMessages } from '@wapay/ai';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const NO_DATE = /\b(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|tomorrow|20\d\d)\b/i;
const BANNED = /\b(bet|bets|betting|wager|casino|odds|gambl\w*)\b|[—–]/i;

function withEnv(env, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const SWITCHES = ['VAS_LIVE_AIRTIME', 'VAS_LIVE_DATA', 'VAS_LIVE_ELECTRICITY', 'VAS_LIVE_BLU_LOAD', 'VAS_LIVE_OTT_LOAD', 'VAS_LIVE_OTT_VOUCHER', 'VAS_ALLOWLIST_AIRTIME', 'VAS_ALLOWLIST_DATA', 'VAS_ALLOWLIST_ELECTRICITY', 'VAS_ALLOWLIST_BLU_LOAD', 'VAS_ALLOWLIST_OTT_LOAD', 'VAS_ALLOWLIST_OTT_VOUCHER', 'WAPAY_LAUNCH_HOLD', 'OTT_MERCHANT_API_KEY', 'WAPAY_PAYOUT_ALLOWLIST', 'WAPAY_WICODE_LIVE', 'VAS_ALLOWLIST_FUEL'];
const NEUTRAL = Object.fromEntries(SWITCHES.map((k) => [k, undefined]));

// --- Fixtures ----------------------------------------------------------------

const T0 = Date.parse('2026-10-19T09:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const ACC = (id, turns, extra = {}) => ({ id, state: 'S5_COMPLETED', source: 'organic', entry: null, ad: false, created: '2026-10-10', links: { made: 0, paid: 0 }, turnsInWindow: turns.length, turns: turns.map((t) => ({ kind: t.role === 'assistant' ? 'flow' : null, refs: null, context: false, ...t })), privacyNames: [], ...extra });
const U = (text, min, more = {}) => ({ role: 'user', text, at: at(min), ...more });
const B = (text, min, more = {}) => ({ role: 'assistant', text, at: at(min), ...more });

function fixtureExport() {
  return {
    since: at(-60), until: at(120),
    accounts: [
      ACC('acc_ewallet0000000000000001', [U('how do I withdraw', 1), B('You can withdraw by PayShap, Nedbank cash or FNB eWallet. Which one?', 2)], { privacyNames: ['Thabo'] }),
      ACC('acc_r20000000000000000000002', [U('withdraw', 1), B('You can withdraw between R20 and R3000 to your bank.', 2)]),
      ACC('acc_loop000000000000000000003', [U('1', 1), B('Sorry, I did not catch that. Reply 1 or 2.', 2), U('1', 3), B('Sorry, I did not catch that. Reply 1 or 2.', 4), U('one', 5), B('Sorry, I did not catch that. Reply 1 or 2.', 6)]),
      ACC('acc_unans00000000000000000004', [B('How much would you like to deposit?', 1), U('R500', 2)]),
      ACC('acc_echo000000000000000000005', [B('Who owes you, and how much? Just type it like this: R250 from Thandi for the birthday gift.', 1), U('R250 from Thandi for the birthday gift', 2), B('Here is your link for R250 from Thandi: https://pleasepayme.co.za/PRABCDEF', 3)]),
      ACC('acc_echook0000000000000000006', [B('Who owes you, and how much? Just type it like this: R250 from Thandi for the birthday gift.', 1), U('R250 from Thandi for the birthday gift', 2), B('That was my example 😊 Who really owes you money, and how much?', 3)]),
      ACC('acc_soon000000000000000000007', [U('buy airtime', 1), B('📱 *Buy Airtime*\n\nHow much airtime would you like to buy?\n\nReply with an amount (e.g., R10, R50, R100)', 2), U('data please', 3), B('Data is coming soon on WaPay.', 4)]),
      ACC('acc_gate000000000000000000008', [U('withdraw', 1), B('Your balance is R0, so there is nothing to withdraw yet.', 2, { refs: { gate: 'w', tier: 2, personAsked: true } })]),
      ACC('acc_long000000000000000000009', [U('what can I do', 1), B('x'.repeat(1300), 2)]),
      ACC('acc_clean00000000000000000010', [U('hi', 1), B('Hi! Say "please pay me R50" to make a link.', 2), U('thanks', 3), B('Any time.', 4)]),
    ],
    counts: { accounts: 10, turns: 0, windowTurns: 0, contextTurns: 0 },
    truncated: 0,
  };
}
const SCOPE_OFF = { airtime: false, data: false, electricity: false, bluLoad: false, ottLoad: false, voucher: false };

// --- Export ------------------------------------------------------------------

test('export: the script\'s redaction, the full-name answer by position, name parts and masking', () => {
  assert.equal(redactText('call me on 082 123 4567 or 27821234567'), 'call me on [number] or [number]');
  assert.equal(redactText('my id 8001015009087 please'), 'my id [number] please');
  assert.equal(redactText('Name on the account: Ruth Mahlangu\nDone'), 'Name on the account: [name]\nDone');
  assert.equal(redactText('R50 and 1234'), 'R50 and 1234', 'short digits stay (the rules need amounts)');
  const turns = maskNameAnswers([{ role: 'assistant', text: 'What is your full name, as on the account?' }, { role: 'user', text: 'Ruth M' }, { role: 'assistant', text: 'ok' }, { role: 'user', text: 'Ruth M' }]);
  assert.equal(turns[1].text, '[name]'); assert.equal(turns[3].text, 'Ruth M', 'only the answer to the ask');
  assert.deepEqual(nameParts('Thabo Mokoena'), ['Thabo Mokoena', 'Mokoena', 'Thabo']);
  assert.deepEqual(nameParts('Gift'), [], 'an everyday word is never a name on its own');
  assert.deepEqual(nameParts('+27 82 123'), []);
  assert.equal(maskNames('Hi Thabo, thabo here. Thabos', ['Thabo']), 'Hi [name], [name] here. Thabos');
});

test('export: accounts with turns in the window, ten turns of context, facts without a name or number, display names apart', async () => {
  const since = new Date('2026-10-19T02:00:00Z'); const until = new Date('2026-10-20T02:00:00Z');
  const rows = [];
  for (let i = 0; i < 14; i++) rows.push({ accountId: 'acc_a', role: i % 2 ? 'assistant' : 'user', kind: i % 2 ? 'flow' : null, text: `old ${i}`, createdAt: new Date(since.getTime() - (14 - i) * 3600000), refs: null });
  rows.push({ accountId: 'acc_a', role: 'assistant', kind: 'flow', text: 'What is your full name?', createdAt: new Date(since.getTime() + 60000), refs: null });
  rows.push({ accountId: 'acc_a', role: 'user', kind: null, text: 'Ruth Mahlangu', createdAt: new Date(since.getTime() + 120000), refs: null });
  rows.push({ accountId: 'acc_a', role: 'user', kind: null, text: 'send R50 to 0821234567', createdAt: new Date(since.getTime() + 180000), refs: { x: 1 } });
  rows.push({ accountId: 'acc_b', role: 'user', kind: null, text: 'hi', createdAt: new Date(since.getTime() + 240000), refs: null });
  rows.push({ accountId: 'acc_c', role: 'user', kind: null, text: 'too late', createdAt: new Date(until.getTime() + 1000), refs: null });
  const calls = [];
  const prisma = {
    conversationTurn: { findMany: async ({ where, orderBy }) => {
      calls.push(where);
      let out = rows.filter((r) => (!where.accountId || where.accountId.in.includes(r.accountId)) && (!where.createdAt.gte || r.createdAt >= where.createdAt.gte) && r.createdAt < where.createdAt.lt);
      const desc = orderBy[1]?.createdAt === 'desc';
      out = out.sort((x, y) => x.accountId.localeCompare(y.accountId) || (desc ? y.createdAt - x.createdAt : x.createdAt - y.createdAt));
      return out;
    } },
    account: { findMany: async ({ where }) => [{ id: 'acc_a', displayName: 'Ruth Mahlangu', onboardingState: 'S5_COMPLETED', createdAt: new Date('2026-10-01T00:00:00Z'), profile: { acquisitionSource: 'ad', attribution: { ctwaClid: 'x', entry: 'Q2' } } }, { id: 'acc_b', displayName: 'User', onboardingState: 'S0_INITIAL', createdAt: new Date('2026-10-19T02:04:00Z'), profile: null }].filter((a) => where.id.in.includes(a.id)) },
    paymentRequest: { groupBy: async () => [{ accountId: 'acc_a', status: 'PAID', _count: 1 }, { accountId: 'acc_a', status: 'PENDING', _count: 2 }] },
  };
  const exp = await exportTurns({ prisma, since, until });
  assert.equal(exp.accounts.length, 2, 'the account after the window is not exported');
  const a = exp.accounts[0];
  assert.equal(a.id, 'acc_a');
  assert.deepEqual({ state: a.state, source: a.source, entry: a.entry, ad: a.ad, created: a.created, links: a.links, turnsInWindow: a.turnsInWindow }, { state: 'S5_COMPLETED', source: 'ad', entry: 'Q2', ad: true, created: '2026-10-01', links: { made: 3, paid: 1 }, turnsInWindow: 3 });
  assert.equal(a.turns.filter((t) => t.context).length, 10, 'ten turns of context, not fourteen');
  assert.equal(a.turns[0].text, 'old 4');
  assert.equal(a.turns[11].text, '[name]', 'the name typed after the ask is masked by position');
  assert.equal(a.turns[12].text, 'send R50 to [number]');
  assert.deepEqual(a.turns[12].refs, { x: 1 });
  assert.deepEqual(a.privacyNames, ['Ruth Mahlangu', 'Mahlangu', 'Ruth']);
  assert.deepEqual(exp.accounts[1].privacyNames, [], '"User" is not a name');
  assert.ok(!JSON.stringify(exp.accounts.map(({ privacyNames, ...rest }) => rest)).includes('Ruth'), 'no display name in the facts or the turns');
  assert.ok(!JSON.stringify(exp).includes('0821234567'));
  assert.equal(calls.length, 2, 'two bounded queries, never one per account');
  assert.ok(calls[1].createdAt.gte instanceof Date && calls[1].createdAt.lt.getTime() === since.getTime(), 'context is bounded in time');
  const capped = await exportTurns({ prisma, since, until, maxAccounts: 1 });
  assert.equal(capped.accounts.length, 1); assert.equal(capped.truncated, 1);
  const empty = await exportTurns({ prisma: { ...prisma, conversationTurn: { findMany: async () => [] } }, since, until });
  assert.deepEqual(empty.accounts, []); assert.equal(empty.counts.accounts, 0);
});

// --- Rules -------------------------------------------------------------------

test('rules: eWallet, R20, loop, unanswered, example echo, coming-soon started, long reply, patterns', () => {
  const now = new Date(T0 + 3 * 3600000);
  const { findings, counts, patterns } = scanExport(fixtureExport(), { now, scope: SCOPE_OFF });
  const by = (rule) => findings.filter((f) => f.rule === rule);
  assert.equal(by('ewallet').length, 1); assert.equal(by('ewallet')[0].severity, 'P1'); assert.equal(by('ewallet')[0].category, 'wrong-fact');
  assert.equal(by('ewallet')[0].accountId, 'acc_ewallet0000000000000001');
  assert.match(by('ewallet')[0].botQuote, /FNB eWallet/); assert.equal(by('ewallet')[0].userQuote, 'how do I withdraw'); assert.equal(by('ewallet')[0].at, at(2));
  assert.equal(by('r20').length, 1); assert.equal(by('r20')[0].title, 'Quotes a R20 withdrawal minimum');
  assert.equal(by('loop').length, 1); assert.equal(by('loop')[0].category, 'stuck-loop'); assert.equal(by('loop')[0].at, at(6), 'the third repeat');
  assert.equal(by('clarifyRun').length, 1, 'two "did not catch" in a row');
  assert.equal(by('unanswered').length, 1); assert.equal(by('unanswered')[0].accountId, 'acc_unans00000000000000000004'); assert.equal(by('unanswered')[0].userQuote, 'R500'); assert.equal(by('unanswered')[0].botQuote, '');
  assert.equal(by('exampleEcho').length, 1, 'the example answered with a link is flagged, the example-echo ask is not'); assert.equal(by('exampleEcho')[0].accountId, 'acc_echo000000000000000000005');
  assert.equal(by('comingSoonStarted').length, 1); assert.match(by('comingSoonStarted')[0].title, /airtime purchase while airtime is coming soon/);
  assert.equal(by('longReply').length, 1); assert.equal(by('longReply')[0].botQuote.length, 200, 'quotes are cut at 200 characters');
  assert.equal(findings.filter((f) => f.accountId === 'acc_clean00000000000000000010').length, 0, 'a clean conversation gives nothing');
  assert.equal(findings.filter((f) => f.accountId === 'acc_gate000000000000000000008').length, 0, 'the third tier is correct behaviour');
  assert.equal(patterns.gateTier3, 1); assert.equal(patterns.unanswered, 1); assert.equal(patterns.loops, 1); assert.equal(patterns.clarifyRuns, 1); assert.equal(patterns.longReplies, 1);
  assert.deepEqual(patterns.comingSoonAsks, { airtime: 1, data: 1 }); assert.equal(patterns.accounts, 10);
  assert.equal(counts.ewallet, 1); assert.equal(counts.r20, 1);
  for (const f of findings) {
    assert.ok(['P1', 'P2', 'P3'].includes(f.severity)); assert.ok(CATEGORIES.includes(f.category));
    assert.ok(f.title && f.why && f.fix && f.rule); assert.ok(f.botQuote.length <= 200 && f.userQuote.length <= 200);
    assert.doesNotMatch(`${f.title} ${f.why} ${f.fix}`, BANNED, 'no em dash or betting word in the audit\'s own copy');
  }
  // The unanswered rule waits ten minutes; a scope with airtime on starts no coming-soon finding.
  assert.equal(scanExport(fixtureExport(), { now: new Date(T0 + 5 * 60000), scope: SCOPE_OFF }).findings.filter((f) => f.rule === 'unanswered').length, 0);
  assert.equal(scanExport(fixtureExport(), { now, scope: { ...SCOPE_OFF, airtime: true } }).findings.filter((f) => f.rule === 'comingSoonStarted').length, 0);
  assert.equal(scanExport(fixtureExport(), { now }).findings.filter((f) => f.rule === 'comingSoonStarted').length, 0, 'no scope, no rule');
  // Context turns are never re-flagged, and a known name is masked in the quotes.
  const ctx = fixtureExport(); ctx.accounts = [ACC('acc_ctx', [B('FNB eWallet is one option', 1, { context: true }), U('ok', 2), B('Hi Thabo, your link is ready', 3)], { privacyNames: ['Thabo'] })];
  const r = scanExport(ctx, { now, scope: SCOPE_OFF });
  assert.equal(r.findings.filter((f) => f.rule === 'ewallet').length, 0);
  const masked = scanExport({ accounts: [ACC('acc_m', [U('hi Thabo here', 1), B('Thabo, you can use FNB eWallet', 2)], { privacyNames: ['Thabo'] })] }, { now });
  assert.equal(masked.findings[0].botQuote, '[name], you can use FNB eWallet'); assert.equal(masked.findings[0].userQuote, 'hi [name] here');
  assert.ok(Object.keys(RULES).length >= 8);
});

// --- Brief -------------------------------------------------------------------

test('brief: the truth block follows the switches, both worlds, and never a date, a dash or a betting word', () => {
  const hold = withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true' }, () => truthBlock());
  assert.match(hold, /Coming soon, not available today: airtime, data, electricity, fuel vouchers, cash deposits with a Blu or OTT voucher and a virtual card\./);
  assert.doesNotMatch(hold, /buying airtime/);
  assert.match(hold, /Withdrawal methods on production \(the rail list could not be read; these are the production methods of record\): PayShap, Cash at an Absa ATM \(CashSend\) and Cash at a Nedbank ATM\./);
  assert.match(hold, /do NOT exist on production[^\n]*FNB eWallet/);
  assert.match(hold, /R8 by PayShap/); assert.doesNotMatch(hold, /by bank transfer/, 'no fee for a method the list does not carry');
  assert.match(hold, /Minimum R50 \(the rail floor\)/); assert.match(hold, /\(R50 to R3000;/, 'the live line and the fee line agree');
  assert.match(hold, /business accounts by invitation only/);
  const open = withEnv({ ...NEUTRAL, WAPAY_LAUNCH_HOLD: 'off', VAS_LIVE_AIRTIME: 'true', VAS_LIVE_BLU_LOAD: 'true', WAPAY_PAYOUT_ENABLED: 'true' }, () => truthBlock());
  assert.match(open, /buying airtime \(no WaPay fee, the product price\)/);
  assert.match(open, /adding cash with a Blu voucher from a till/);
  assert.match(open, /Coming soon, not available today: data, electricity, fuel vouchers, top-ups with an OTT voucher and a virtual card\./);
  assert.match(open, /Right now you can [^\n]*buy airtime/);
  const off = withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: undefined }, () => truthBlock());
  assert.match(off, /withdrawals are NOT live/); assert.doesNotMatch(off, /Withdrawal fees/);
  for (const t of [hold, open, off]) { assert.doesNotMatch(t, NO_DATE); assert.doesNotMatch(t, BANNED); }
  // The live list from the rail is used when it is there, with its own floor.
  const live = withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true' }, () => truthBlock({ providers: [{ method: 'PAYSHAP', label: 'PayShap', minCents: 5000 }, { method: 'RTC', label: 'Bank transfer (RTC)', minCents: 5000 }] }));
  assert.match(live, /read from the rail at run time\): PayShap and Bank transfer \(RTC\)\./); assert.match(live, /R10 by bank transfer/); assert.match(live, /do NOT exist[^\n]*Cash at a Nedbank ATM/);
  assert.equal(minWithdrawCents(null), 5000); assert.equal(minWithdrawCents([{ method: 'PAYSHAP', minCents: 2000 }]), 2000);
  assert.deepEqual(FALLBACK_PROVIDERS.map((p) => p.method), ['PAYSHAP', 'CASHSEND', 'NEDCASH']);
});

test('brief: deterministic, carries the rubric, the process checks and the known titles; liveProviders is best effort', async () => {
  const truth = withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true' }, () => truthBlock());
  const a = buildReviewBrief({ truth, processChecks: '## Pay links\nCorrect: one link.', knownTitles: ['Quotes a R20 withdrawal minimum'] });
  const b = buildReviewBrief({ truth, processChecks: '## Pay links\nCorrect: one link.', knownTitles: ['Quotes a R20 withdrawal minimum'] });
  assert.equal(a, b);
  assert.match(a, /SEVERITY:\n- P1:/); assert.match(a, /CORRECT BEHAVIOUR THAT IS NOT A BUG/); assert.match(a, /PROCESS CHECKS \(what correct looks like[\s\S]*## Pay links/);
  assert.match(a, /KNOWN FINDINGS[\s\S]*- Quotes a R20 withdrawal minimum/);
  assert.match(a, /category is one of: wrong-fact, money/);
  assert.match(buildReviewBrief({ truth, processChecks: '' }), /PROCESS CHECKS: unavailable in this run/);
  const real = buildReviewBrief({ truth });
  assert.match(real, /## Withdraw/, 'docs/audits/PROCESS_CHECKS.md is read from the repo');
  assert.doesNotMatch(read('../docs/audits/PROCESS_CHECKS.md'), BANNED);
  assert.doesNotMatch(read('../docs/audits/PROCESS_CHECKS.md'), NO_DATE);
  assert.equal(await liveProviders({ enabled: false }), null);
  assert.equal(await liveProviders({ enabled: true, resolve: async () => { throw new Error('OTT down'); } }), null);
  assert.equal(await liveProviders({ enabled: true, resolve: () => new Promise(() => {}), timeoutMs: 20 }), null, 'a slow rail is not waited for');
  assert.deepEqual(await liveProviders({ enabled: true, resolve: async () => [{ method: 'PAYSHAP', label: 'PayShap', minCents: 5000, maxCents: 300000 }] }), [{ method: 'PAYSHAP', label: 'PayShap', minCents: 5000, maxCents: 300000 }]);
});

// --- Store: fingerprints and grouping ----------------------------------------

test('fingerprint: stable across case, punctuation and amounts; different per category', () => {
  assert.equal(normaliseTitle('Quotes a R20 withdrawal minimum!'), 'quotes a r# withdrawal minimum');
  assert.equal(fingerprintOf('wrong-fact', 'Quotes a R20 withdrawal minimum'), fingerprintOf('WRONG-FACT', '  quotes a R 50 withdrawal   MINIMUM. '));
  assert.notEqual(fingerprintOf('wrong-fact', 'Quotes a R20 withdrawal minimum'), fingerprintOf('money', 'Quotes a R20 withdrawal minimum'));
  assert.match(fingerprintOf('x', 'y'), /^[0-9a-f]{40}$/);
  const groups = groupFindings([
    { severity: 'P2', category: 'wrong-fact', title: 'FNB eWallet offered', accountId: 'a', at: at(1), botQuote: 'q1', userQuote: 'u1', rule: 'ewallet' },
    { severity: 'P1', category: 'wrong-fact', title: 'fnb ewallet offered', accountId: 'b', at: at(2), botQuote: 'q2', userQuote: 'u2', rule: 'review' },
    { severity: 'P1', category: 'wrong-fact', title: 'fnb ewallet offered', accountId: 'b', at: null, botQuote: '', rule: 'review' },
    { severity: 'P3', category: 'tone', title: 'Other', accountId: 'c', at: at(3), rule: 'review' },
  ]);
  assert.equal(groups.length, 2);
  const g = groups[0];
  assert.equal(g.severity, 'P1', 'the highest severity wins'); assert.equal(g.hits, 3); assert.deepEqual(g.accounts.map((x) => x.id), ['b', 'a']); assert.equal(g.sampleBotQuote, 'q1'); assert.deepEqual(g.rules, ['ewallet', 'review']);
  assert.deepEqual(mergeAccounts([{ id: 'a', at: at(1) }], [{ id: 'a', at: null }, { id: 'z', at: at(9) }], 2).map((x) => x.id), ['z', 'a']);
  assert.equal(mergeAccounts([], Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, at: at(i) }))).length, 20);
});

// --- An in-memory store for the run ------------------------------------------

function memDb({ turns = [], accounts = [], links = [] } = {}) {
  const runs = []; const findings = []; let seq = 0;
  const id = (p) => `${p}${String(++seq).padStart(4, '0')}`;
  const ok = (row, where = {}) => Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return v.some((w) => ok(row, w));
    const val = row[k];
    if (v === null) return val == null;
    if (v instanceof Date || typeof v !== 'object') return val instanceof Date ? val.getTime() === new Date(v).getTime() : val === v;
    if ('not' in v) return v.not === null ? val != null : val !== v.not;
    if ('in' in v) return v.in.includes(val);
    if ('notIn' in v) return !v.notIn.includes(val);
    if ('gt' in v) return val > v.gt;
    if ('gte' in v && 'lt' in v) return val >= v.gte && val < v.lt;
    if ('gte' in v) return val >= v.gte;
    if ('lt' in v) return val < v.lt;
    return false;
  });
  const sort = (rows, orderBy) => { const o = [].concat(orderBy || []); return rows.slice().sort((a, b) => { for (const spec of o) { const [k, dir] = Object.entries(spec)[0]; const x = a[k] instanceof Date ? a[k].getTime() : a[k]; const y = b[k] instanceof Date ? b[k].getTime() : b[k]; if (x === y) continue; return (x > y ? 1 : -1) * (dir === 'desc' ? -1 : 1); } return 0; }); };
  const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : row);
  return {
    runs, findings, calls: { writes: 0 },
    conversationTurn: { findMany: async ({ where, orderBy, select }) => sort(turns.filter((r) => ok(r, where)), orderBy).map((r) => pick(r, select)) },
    account: { findMany: async ({ where }) => accounts.filter((a) => ok(a, where)) },
    paymentRequest: { groupBy: async ({ where }) => links.filter((l) => ok(l, where)).map((l) => ({ accountId: l.accountId, status: l.status, _count: l.n })) },
    auditRun: {
      findFirst: async ({ where, orderBy } = {}) => sort(runs.filter((r) => ok(r, where || {})), orderBy)[0] || null,
      findMany: async ({ where, orderBy, take, select } = {}) => sort(runs.filter((r) => ok(r, where || {})), orderBy).slice(0, take || 1000).map((r) => pick(r, select)),
      create: async ({ data }) => { runs.push({ id: id('run'), finishedAt: null, error: null, accounts: 0, turns: 0, p1: 0, p2: 0, p3: 0, reviewed: false, summary: null, ...data }); return runs[runs.length - 1]; },
      update: async ({ where, data }) => { const r = runs.find((x) => x.id === where.id); Object.assign(r, data); return r; },
    },
    auditFinding: {
      findUnique: async ({ where }) => findings.find((f) => f.fingerprint === where.fingerprint) || null,
      findMany: async ({ where, orderBy, take, select } = {}) => sort(findings.filter((f) => ok(f, where || {})), orderBy).slice(0, take || 1000).map((f) => pick(f, select)),
      create: async ({ data }) => { const row = { id: id('fnd'), resolvedAt: null, resolvedNote: null, ...data }; findings.push(row); return row; },
      update: async ({ where, data }) => { const f = findings.find((x) => x.fingerprint === where.fingerprint); Object.assign(f, data); return f; },
      updateMany: async ({ where, data }) => { const hit = findings.filter((f) => ok(f, where)); for (const f of hit) Object.assign(f, data); return { count: hit.length }; },
      groupBy: async () => { const c = {}; for (const f of findings) c[f.status] = (c[f.status] || 0) + 1; return Object.entries(c).map(([status, n]) => ({ status, _count: { _all: n } })); },
    },
  };
}
const DAY = 86400000;
const turnRow = (accountId, role, text, createdAt, refs = null) => ({ accountId, role, kind: role === 'assistant' ? 'flow' : null, text, createdAt: new Date(createdAt), refs });

test('run: dry writes and sends nothing; a real run stores the run and the findings and sends the summary without a name or a number', async () => {
  const D1 = Date.parse('2026-10-19T02:00:00Z');
  const db = memDb({
    turns: [turnRow('acc_a', 'user', 'how do I withdraw to Thabo', D1 - 3600000), turnRow('acc_a', 'assistant', 'Hi Thabo, you can withdraw by FNB eWallet or PayShap, call 0821234567', D1 - 3500000)],
    accounts: [{ id: 'acc_a', displayName: 'Thabo Mokoena', onboardingState: 'S5_COMPLETED', createdAt: new Date(D1 - 10 * DAY), profile: null }],
  });
  const sent = { wa: [], mail: [] };
  const deps = { model: null, processChecks: '## Withdraw\nCorrect: the live methods.', opsPersonAlert: async (a) => { sent.wa.push(a); return { sent: 1 }; }, sendOpsAlert: async (a) => { sent.mail.push(a); return { success: true }; } };
  const dry = await runDailyAudit({ prisma: db, now: new Date(D1), dry: true, deps, env: {} });
  assert.equal(dry.ok, true); assert.equal(dry.dry, true); assert.equal(dry.accounts, 1); assert.equal(dry.turns, 2);
  assert.equal(dry.reviewed, false); assert.equal(dry.review.skipped, 'NO_MODEL');
  assert.deepEqual(dry.counts, { p1: 1, p2: 0, p3: 0, distinct: 1, hits: 1 });
  assert.equal(dry.findings[0].botQuote, 'Hi [name], you can withdraw by FNB eWallet or PayShap, call [number]');
  assert.equal(dry.findings[0].userQuote, 'how do I withdraw to [name]');
  assert.match(dry.findings[0].fingerprint, /^[0-9a-f]{40}$/);
  assert.equal(db.runs.length, 0); assert.equal(db.findings.length, 0); assert.equal(sent.wa.length + sent.mail.length, 0);
  assert.equal(dry.since, new Date(D1 - DAY).toISOString(), 'no earlier run: 24 hours'); assert.equal(dry.until, new Date(D1).toISOString());

  const run = await runDailyAudit({ prisma: db, now: new Date(D1), deps, env: { WAPAY_ADMIN_URL: 'https://mc.example/admin' } });
  assert.equal(run.ok, true); assert.ok(run.runId);
  assert.equal(db.runs.length, 1);
  const row = db.runs[0];
  assert.ok(row.finishedAt instanceof Date); assert.equal(row.error, null); assert.equal(row.accounts, 1); assert.equal(row.p1, 1); assert.equal(row.reviewed, false);
  assert.deepEqual(row.summary.counts, { open: 1, recurring: 0, resolved: 0 }); assert.equal(row.summary.resolvedInRun, 0); assert.equal(row.summary.processChecks, true);
  assert.equal(db.findings.length, 1);
  const f = db.findings[0];
  assert.equal(f.status, 'open'); assert.equal(f.firstSeenRunId, run.runId); assert.equal(f.lastSeenRunId, run.runId); assert.equal(f.occurrences, 1); assert.equal(f.accountCount, 1);
  assert.deepEqual(f.accountsJson, [{ id: 'acc_a', at: new Date(D1 - 3500000).toISOString() }]);
  assert.deepEqual(run.status, { open: 1, recurring: 0, resolved: 0 });
  assert.deepEqual(run.trend, [{ date: '2026-10-19', found: 1, resolved: 0, open: 1 }]);
  assert.equal(sent.wa.length, 1); assert.equal(sent.mail.length, 1);
  assert.equal(sent.wa[0].key, `audit:${run.runId}`);
  const text = sent.wa[0].text;
  assert.match(text, /^🧪 Daily conversation audit, 2026-10-19 02:00 UTC: 1 account, 2 turns since 2026-10-18 02:00 UTC\./);
  assert.match(text, /Found 1 distinct: P1 1, P2 0, P3 0\. Reviewer: off \(no model key\), rules only\./);
  assert.match(text, /Backlog: open 1, recurring 0, resolved 0 \(0 in this run\)\./);
  assert.match(text, /Mission Control, Health tab: https:\/\/mc\.example\/admin/);
  assert.doesNotMatch(text, /Thabo|acc_a|\d{6,}|\[\[/, 'counts only');
  assert.doesNotMatch(sent.mail[0].detailsHtml, /Thabo|acc_a/);
  assert.match(sent.mail[0].subject, /^Daily conversation audit: 1 found \(P1 1\), 1 unresolved$/);
  assert.ok(run.ops.whatsapp && run.ops.email);
});

test('run: recurrence over the runs: open, recurring, resolved after two runs without it, reopened on a regression, resolved by hand', async () => {
  const D1 = Date.parse('2026-10-19T02:00:00Z');
  const db = memDb({ accounts: [{ id: 'acc_a', displayName: null, onboardingState: 'S5_COMPLETED', createdAt: new Date(D1 - 10 * DAY), profile: null }, { id: 'acc_b', displayName: null, onboardingState: 'S5_COMPLETED', createdAt: new Date(D1 - 10 * DAY), profile: null }] });
  const deps = { model: null, processChecks: 'x', opsPersonAlert: async () => ({ sent: 1 }), sendOpsAlert: async () => ({ success: true }) };
  const turns = db.conversationTurn; void turns;
  const push = (...rows) => { for (const r of rows) db._turns.push(r); };
  db._turns = []; db.conversationTurn.findMany = async ({ where, orderBy }) => {
    const desc = orderBy?.[1]?.createdAt === 'desc';
    return db._turns.filter((r) => (!where.accountId || where.accountId.in.includes(r.accountId)) && (!where.createdAt.gte || r.createdAt >= where.createdAt.gte) && r.createdAt < where.createdAt.lt)
      .sort((x, y) => x.accountId.localeCompare(y.accountId) || (desc ? y.createdAt - x.createdAt : x.createdAt - y.createdAt));
  };
  const ewallet = fingerprintOf('wrong-fact', RULES.ewallet.title);
  const r20 = fingerprintOf('wrong-fact', RULES.r20.title);
  const find = (fp) => db.findings.find((f) => f.fingerprint === fp);
  // Run 1: eWallet on acc_a -> open.
  push(turnRow('acc_a', 'assistant', 'Use FNB eWallet', D1 - 3600000));
  const run1 = await runDailyAudit({ prisma: db, now: new Date(D1), deps, env: {} });
  assert.equal(find(ewallet).status, 'open');
  // Run 2: eWallet again on acc_b, and a R20 line -> recurring; R20 open. The window starts where run 1 ended.
  push(turnRow('acc_b', 'assistant', 'Use FNB eWallet', D1 + DAY - 3600000), turnRow('acc_b', 'assistant', 'between R20 and R3000', D1 + DAY - 3000000));
  const run2 = await runDailyAudit({ prisma: db, now: new Date(D1 + DAY), deps, env: {} });
  assert.equal(run2.since, new Date(D1).toISOString(), 'since = the last run\'s until');
  assert.equal(find(ewallet).status, 'recurring'); assert.equal(find(ewallet).occurrences, 2); assert.equal(find(ewallet).accountCount, 2); assert.equal(find(ewallet).firstSeenRunId, run1.runId); assert.equal(find(ewallet).lastSeenRunId, run2.runId);
  assert.equal(find(r20).status, 'open');
  assert.deepEqual(run2.status, { open: 1, recurring: 1, resolved: 0 });
  // Run 3: a quiet night (no turns): nothing resolves, nothing changes.
  const run3 = await runDailyAudit({ prisma: db, now: new Date(D1 + 2 * DAY), deps, env: {} });
  assert.equal(run3.accounts, 0); assert.equal(find(ewallet).status, 'recurring'); assert.equal(find(r20).status, 'open');
  // Run 4: conversations, but neither line: one miss, nothing resolves yet.
  push(turnRow('acc_a', 'user', 'hi', D1 + 3 * DAY - 3600000), turnRow('acc_a', 'assistant', 'Hello! How can I help?', D1 + 3 * DAY - 3500000));
  const run4 = await runDailyAudit({ prisma: db, now: new Date(D1 + 3 * DAY), deps, env: {} });
  assert.equal(run4.resolvedInRun, 0); assert.equal(find(ewallet).status, 'recurring');
  // Run 5: a second miss: both resolve by the rule.
  push(turnRow('acc_b', 'user', 'hi', D1 + 4 * DAY - 3600000), turnRow('acc_b', 'assistant', 'Hello!', D1 + 4 * DAY - 3500000));
  const run5 = await runDailyAudit({ prisma: db, now: new Date(D1 + 4 * DAY), deps, env: {} });
  assert.equal(run5.resolvedInRun, 2); assert.equal(find(ewallet).status, 'resolved'); assert.equal(find(ewallet).resolvedNote, RESOLVED_BY_RULE_NOTE); assert.ok(find(ewallet).resolvedAt);
  assert.deepEqual(run5.status, { open: 0, recurring: 0, resolved: 2 });
  assert.deepEqual(run5.trend.map((t) => [t.date, t.found, t.resolved, t.open]), [['2026-10-19', 1, 0, 1], ['2026-10-20', 2, 0, 2], ['2026-10-21', 0, 0, 2], ['2026-10-22', 0, 0, 2], ['2026-10-23', 0, 2, 0]]);
  // Run 6: the eWallet line is back: reopened as recurring, the note kept, resolvedAt cleared.
  push(turnRow('acc_a', 'assistant', 'FNB eWallet works too', D1 + 5 * DAY - 3600000));
  await runDailyAudit({ prisma: db, now: new Date(D1 + 5 * DAY), deps, env: {} });
  assert.equal(find(ewallet).status, 'recurring'); assert.equal(find(ewallet).resolvedAt, null); assert.equal(find(ewallet).resolvedNote, RESOLVED_BY_RULE_NOTE); assert.equal(find(ewallet).occurrences, 3);
  // By hand.
  const { resolveFinding } = await import('../lib/audit/store.js');
  const done = await resolveFinding({ prisma: db, fingerprint: ewallet, note: 'BUGLOG #119, build 7b3f753' });
  assert.equal(done.status, 'resolved'); assert.equal(done.resolvedNote, 'BUGLOG #119, build 7b3f753');
  assert.equal(await resolveFinding({ prisma: db, fingerprint: 'f'.repeat(40), note: 'x' }), null);
  const admin = toAdminFinding(find(ewallet));
  assert.deepEqual(Object.keys(admin), ['id', 'fingerprint', 'severity', 'category', 'title', 'occurrences', 'firstSeenAt', 'lastSeenAt', 'status', 'accounts', 'sampleBotQuote', 'sampleUserQuote', 'why', 'fix']);
  assert.equal(admin.accounts, 2); assert.equal(admin.status, 'resolved');
});

test('run: the review\'s findings join the rules\' with the boundary\'s tokens masked; the review is budgeted; a broken database never throws', async () => {
  const D1 = Date.parse('2026-10-19T02:00:00Z');
  const db = memDb({ turns: [turnRow('acc_a', 'user', 'hello', D1 - 3600000), turnRow('acc_a', 'assistant', 'Your money will arrive tomorrow', D1 - 3500000)], accounts: [{ id: 'acc_a', displayName: 'Lerato', onboardingState: 'S5_COMPLETED', createdAt: new Date(D1 - DAY), profile: null }] });
  const seen = [];
  const model = async ({ system, user, names }) => {
    seen.push({ system, user, names });
    return { findings: [{ severity: 'P2', category: 'promise', title: 'Promises [[N1]] a time', accountId: 'acc_a', alsoAccountIds: ['acc_made_up'], at: new Date(D1 - 3500000).toISOString(), botQuote: 'Your money will arrive tomorrow, [[N1]]', userQuote: 'hello', why: 'no time promises', fix: 'say what happens' }], patterns: ['people ask when'], workedWell: ['the greeting'] };
  };
  const deps = { model, processChecks: 'x', opsPersonAlert: async () => ({ sent: 1 }), sendOpsAlert: async () => ({ success: true }) };
  const out = await runDailyAudit({ prisma: db, now: new Date(D1), dry: true, deps, env: {} });
  assert.equal(out.reviewed, true); assert.equal(out.review.chunks, 1); assert.equal(out.review.chunksReviewed, 1);
  assert.deepEqual(seen[0].names, ['Lerato'], 'the names go to the boundary, apart from the text');
  assert.match(seen[0].system, /WHAT IS TRUE TODAY/); assert.match(seen[0].user, /## Account acc_a/);
  const review = out.findings.filter((f) => f.rule === 'review');
  assert.equal(review.length, 1, 'the invented account is dropped');
  assert.equal(review[0].title, 'Promises [name] a time'); assert.equal(review[0].botQuote, 'Your money will arrive tomorrow, [name]');
  assert.deepEqual(out.review.patterns, ['people ask when']); assert.deepEqual(out.review.workedWell, ['the greeting']);
  assert.equal(out.findings.filter((f) => f.rule === 'date').length, 1, 'the rule found the same line');
  // A model that throws costs the review, never the run.
  const bad = await runDailyAudit({ prisma: db, now: new Date(D1), dry: true, deps: { ...deps, model: async () => { throw new Error('AI_UNAVAILABLE'); } }, env: {} });
  assert.equal(bad.ok, true); assert.equal(bad.reviewed, false); assert.deepEqual(bad.review.errors, ['chunk 0: AI_UNAVAILABLE']);
  // A deadline too short for a call skips the chunk and says so.
  const late = await runDailyAudit({ prisma: db, now: new Date(D1), dry: true, deps, deadlineMs: 5000, env: {} });
  assert.equal(late.reviewed, false); assert.equal(late.review.chunksSkipped, 1); assert.equal(late.review.skipped, 'DEADLINE');
  // The database is down: ok:false, no throw, the row (if one was made) carries the error.
  const broken = memDb(); broken.conversationTurn.findMany = async () => { throw new Error('pooler closed'); };
  const failed = await runDailyAudit({ prisma: broken, now: new Date(D1), deps, env: {} });
  assert.equal(failed.ok, false); assert.equal(failed.error, 'pooler closed'); assert.equal(broken.runs[0].error, 'pooler closed'); assert.ok(broken.runs[0].finishedAt);
  const noTables = memDb(); noTables.auditRun.findFirst = async () => { throw new Error('relation "audit_runs" does not exist'); }; noTables.auditRun.create = async () => { throw new Error('relation "audit_runs" does not exist'); };
  const nt = await runDailyAudit({ prisma: noTables, now: new Date(D1), deps, env: {} });
  assert.equal(nt.ok, false); assert.match(nt.error, /does not exist/);
  // Pure helpers.
  assert.equal(scrubText('[[N1]] on [[P1]] ref [[S2]] mail [[E1]] id 8001015009087', ['Zola']), '[name] on [number] ref [reference] mail [email] id [number]');
  assert.deepEqual(severityCounts([{ fingerprint: 'a', severity: 'P1' }, { fingerprint: 'a', severity: 'P1' }, { fingerprint: 'b', severity: 'P3' }]), { p1: 1, p2: 0, p3: 1, distinct: 2, hits: 3 });
  assert.equal(normaliseFinding({ severity: 'P9', category: 'tone', title: 'x'.repeat(300) }).title.length, 160);
  const s = opsSummary({ since: new Date(D1 - DAY), until: new Date(D1), accounts: 3, turns: 40, counts: { p1: 0, p2: 2, p3: 1, distinct: 3, hits: 5 }, status: { open: 2, recurring: 1, resolved: 4 }, resolvedInRun: 1, reviewed: false, review: { chunks: 2, chunksReviewed: 1 }, topRecurring: [{ title: 'Two clarifications in a row', severity: 'P2', occurrences: 7 }], truncated: 2, url: 'https://x/admin' });
  assert.match(s.text, /3 accounts, 40 turns[^\n]*\(2 accounts over the cap were not read; raise WAPAY_AUDIT_MAX_ACCOUNTS\)/); assert.match(s.text, /Reviewer: partial \(1 of 2 chunks\)/); assert.match(s.text, /Top recurring: "Two clarifications in a row" \(P2, 7x\)\./);
  assert.doesNotMatch(s.text, BANNED);
});

// --- Review: rendering, chunking, parsing, the boundary -----------------------

test('review: renderAccount and chunkAccounts cut by accounts and by characters, names collected apart', () => {
  const acc = fixtureExport().accounts[0];
  const text = renderAccount(acc);
  assert.match(text, /^## Account acc_ewallet0000000000000001 · created 2026-10-10 · state S5_COMPLETED · source organic · links made 0 paid 0 · 2 turns in the window\n/);
  assert.match(text, /\[2026-10-19T09:01Z\] USER: how do I withdraw\n\[2026-10-19T09:02Z\] BOT\(flow\): You can withdraw/);
  assert.doesNotMatch(text, /Thabo/, 'the display name is not in the transcript header');
  const ctx = renderAccount(ACC('a', [B('x', 1, { context: true, refs: { gate: 'w', tier: 1 } }), U('y', 2)]));
  assert.match(ctx, /\[context\] BOT\(flow\): x \{refs: \{"gate":"w","tier":1\}\}/);
  const many = Array.from({ length: 60 }, (_, i) => ACC(`acc_${i}`, [U('hi', 1), B('hello', 2)], { privacyNames: [`Name${i}`] }));
  const chunks = chunkAccounts(many);
  assert.deepEqual(chunks.map((c) => c.ids.length), [25, 25, 10]);
  assert.equal(chunks[0].names.length, 25); assert.ok(chunks[0].names.includes('Name3'));
  const small = chunkAccounts(many.slice(0, 6), { maxChars: 400 });
  assert.ok(small.length > 1 && small.every((c) => c.chars <= 400 || c.ids.length === 1), 'by characters too');
  const huge = ACC('big', Array.from({ length: 2000 }, (_, i) => B(`line ${i} ${'y'.repeat(50)}`, i)));
  const cut = renderAccount(huge, { maxChars: 3000 });
  assert.ok(cut.length <= 3100); assert.match(cut, /\(earlier turns cut for length: \d+\)/); assert.match(cut, /line 1999/, 'the newest turns are kept');
  assert.deepEqual(chunkAccounts([]), []);
});

test('review: the parser on good, partial and bad JSON; unknown accounts dropped; alsoAccountIds expanded; defaults filled', () => {
  const good = { findings: [{ severity: 'P1', category: 'wrong-fact', title: 'FNB eWallet offered', accountId: 'a', alsoAccountIds: ['b', 'a', ''], at: '2026-10-19T09:02:00Z', botQuote: 'q', userQuote: 'u', why: 'w', fix: 'f' }], patterns: ['p'], workedWell: ['ok'] };
  const g = parseReviewOutput(good, { accountIds: ['a', 'b'] });
  assert.equal(g.error, null); assert.equal(g.findings.length, 2);
  assert.deepEqual(g.findings.map((f) => [f.accountId, f.at]), [['a', '2026-10-19T09:02:00.000Z'], ['b', null]]);
  assert.equal(g.findings[0].rule, 'review'); assert.deepEqual(g.patterns, ['p']); assert.deepEqual(g.workedWell, ['ok']);
  const str = parseReviewOutput('```json\n' + JSON.stringify(good) + '\n```', { accountIds: ['a'] });
  assert.equal(str.findings.length, 1, 'a fenced string parses; the unknown account is dropped');
  const partialFields = parseReviewOutput({ findings: [{ title: 'No fix given', accountId: 'a' }, { accountId: 'a' }, null] }, { accountIds: ['a'] });
  assert.equal(partialFields.findings.length, 1); assert.deepEqual([partialFields.findings[0].severity, partialFields.findings[0].category, partialFields.findings[0].fix, partialFields.findings[0].at], ['P3', 'other', '', null]);
  const cutOff = '{"findings": [{"severity":"P2","category":"tone","title":"First","accountId":"a","alsoAccountIds":[],"at":"","botQuote":"b","userQuote":"u","why":"w","fix":"f"}, {"severity":"P2","category":"tone","title":"Second cut';
  const p = parseReviewOutput(cutOff, { accountIds: ['a'] });
  assert.equal(p.error, 'PARTIAL_JSON'); assert.equal(p.findings.length, 1); assert.equal(p.findings[0].title, 'First');
  const bad = parseReviewOutput('I could not review this.', { accountIds: ['a'] });
  assert.equal(bad.error, 'BAD_JSON'); assert.deepEqual(bad.findings, []);
  assert.equal(parseReviewOutput(null).error, 'BAD_JSON'); assert.equal(parseReviewOutput({ nope: 1 }).error, 'NO_FINDINGS_ARRAY');
  assert.equal(parseReviewOutput({ findings: [{ title: 'x'.repeat(500), accountId: 'a', botQuote: 'y'.repeat(500) }] }).findings[0].title.length, 160);
  assert.equal(parseReviewOutput({ findings: [{ title: 'x', accountId: 'a', botQuote: 'y'.repeat(500) }] }).findings[0].botQuote.length, 200);
  assert.deepEqual(REVIEW_SCHEMA.required, ['findings', 'patterns', 'workedWell']); assert.equal(REVIEW_SCHEMA.additionalProperties, false);
  assert.deepEqual(REVIEW_SCHEMA.properties.findings.items.properties.category.enum, CATEGORIES);
});

test('review: reviewAccounts without a model skips cleanly; with one it chunks, passes names and timeouts, and never throws', async () => {
  const none = await reviewAccounts({ brief: 'b', accounts: fixtureExport().accounts, model: null });
  assert.deepEqual([none.reviewed, none.skipped, none.chunks, none.findings], [false, 'NO_MODEL', 1, []]);
  assert.equal(defaultReviewModel({ env: {} }), null, 'no key, no model');
  assert.equal(typeof defaultReviewModel({ env: { OPENAI_API_KEY: 'k' } }), 'function');
  const calls = [];
  const model = async (args) => { calls.push(args); return { findings: [{ severity: 'P3', category: 'tone', title: 'Tone', accountId: args.user.match(/## Account (\S+)/)[1], alsoAccountIds: [], at: '', botQuote: '', userQuote: '', why: '', fix: '' }], patterns: [], workedWell: [] }; };
  const many = Array.from({ length: 30 }, (_, i) => ACC(`acc_${i}`, [U('hi', 1), B('hello', 2)], { privacyNames: i === 0 ? ['Thabo'] : [] }));
  const out = await reviewAccounts({ brief: 'the brief', accounts: many, model });
  assert.equal(out.reviewed, true); assert.equal(out.chunks, 2); assert.equal(out.chunksReviewed, 2); assert.equal(out.findings.length, 2);
  assert.equal(calls[0].system, 'the brief'); assert.deepEqual(calls[0].names, ['Thabo']); assert.deepEqual(calls[1].names, []);
  assert.ok(calls[0].timeoutMs >= 5000 && calls[0].timeoutMs <= 45000);
  const empty = await reviewAccounts({ brief: 'b', accounts: [], model });
  assert.equal(empty.reviewed, true); assert.equal(empty.chunks, 0);
  let n = 0;
  const flaky = async () => { n += 1; if (n === 1) throw Object.assign(new Error('AI_PRIVACY_BLOCK'), { code: 'AI_PRIVACY_BLOCK', kinds: ['NUMBER'] }); return 'garbage'; };
  const mixed = await reviewAccounts({ brief: 'b', accounts: many, model: flaky });
  assert.equal(mixed.reviewed, false); assert.equal(mixed.chunksReviewed, 1); assert.deepEqual(mixed.errors, ['chunk 0: AI_PRIVACY_BLOCK:NUMBER', 'chunk 1: BAD_JSON']);
  const clock = { t: 0 };
  const timed = await reviewAccounts({ brief: 'b', accounts: many, model, deadlineAt: 6000, now: () => (clock.t += 5000) });
  assert.equal(timed.chunksSkipped, 2); assert.equal(timed.skipped, 'DEADLINE');
  // Chunks are read in parallel, bounded by the concurrency, and the results keep the chunk order.
  let running = 0; let peak = 0; const order = [];
  const slow = async ({ user }) => { running += 1; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running -= 1; const id = user.match(/## Account (\S+)/)[1]; order.push(id); return { findings: [{ severity: 'P3', category: 'tone', title: `T ${id}`, accountId: id, alsoAccountIds: [], at: '', botQuote: '', userQuote: '', why: '', fix: '' }], patterns: [], workedWell: [] }; };
  const lots = Array.from({ length: 9 }, (_, i) => ACC(`acc_${i}`, [U('hi', 1), B('hello', 2)]));
  const par = await reviewAccounts({ brief: 'b', accounts: lots, model: slow, maxAccounts: 1, concurrency: 3 });
  assert.equal(par.chunks, 9); assert.equal(par.chunksReviewed, 9); assert.equal(peak, 3, 'three at a time');
  assert.deepEqual(par.findings.map((f) => f.accountId), lots.map((a) => a.id), 'chunk order, whatever finished first');
  assert.equal(reviewConcurrency({}), 4); assert.equal(reviewConcurrency({ WAPAY_AUDIT_REVIEW_CONCURRENCY: '20' }), 8); assert.equal(reviewConcurrency({ WAPAY_AUDIT_REVIEW_CONCURRENCY: 'x' }), 4);
});

test('privacy: a chunk crosses the real boundary with the names tokenised and a surviving secret turned into a token, never sent', () => {
  const exp = fixtureExport();
  exp.accounts[0].turns.push(U('my id is 8001015009087 and mail me at thabo@example.com', 5));
  const chunk = chunkAccounts([exp.accounts[0]])[0];
  const truth = withEnv({ ...NEUTRAL, WAPAY_PAYOUT_ENABLED: 'true' }, () => truthBlock());
  const brief = buildReviewBrief({ truth, processChecks: 'x' });
  const { messages } = guardChatMessages([{ role: 'system', content: brief }, { role: 'user', content: chunk.text }], { names: chunk.names });
  const sent = messages.map((m) => m.content).join('\n');
  assert.doesNotMatch(sent, /Thabo/, 'the known name is a token');
  assert.doesNotMatch(sent, /8001015009087|thabo@example\.com/, 'a secret the redaction missed never leaves');
  assert.match(sent, /\[\[N\d+\]\]/); assert.match(sent, /\[\[S\d+\]\]/);
  assert.match(sent, /## Account acc_ewallet0000000000000001/, 'the account id survives');
  assert.match(sent, /\[2026-10-19T09:01Z\] USER: how do I withdraw/, 'timestamps are not secrets');
});

// --- Routes, cron, the single door -------------------------------------------

const mkRes = () => ({ statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

test('routes: audit-run and audit-resolve refuse without the internal key, admin/audit without a session; wrong methods are 405', async () => {
  const prevKey = process.env.WAPAY_INTERNAL_API_KEY;
  process.env.WAPAY_INTERNAL_API_KEY = 'k-test-audit';
  delete process.env.WAPAY_ADMIN_MSISDNS; delete process.env.WAPAY_ADMIN_SESSION_SECRET;
  try {
    const { default: runHandler } = await import('../pages/api/internal/audit-run.js');
    const { default: resolveHandler } = await import('../pages/api/internal/audit-resolve.js');
    const { default: adminHandler } = await import('../pages/api/admin/audit.js');
    for (const [name, h, method] of [['audit-run', runHandler, 'POST'], ['audit-resolve', resolveHandler, 'POST'], ['admin/audit', adminHandler, 'GET']]) {
      const r1 = mkRes(); await h({ method, headers: {}, query: {}, body: {}, cookies: {} }, r1); assert.equal(r1.statusCode, 401, `${name} without the key or a session`);
      const r2 = mkRes(); await h({ method: method === 'POST' ? 'GET' : 'POST', headers: {}, query: {}, body: {}, cookies: {} }, r2); assert.equal(r2.statusCode, 405, `${name} wrong method`);
      assert.equal(r1.headers['Cache-Control'], 'private, no-store');
    }
    const r3 = mkRes(); await resolveHandler({ method: 'POST', headers: { 'x-internal-api-key': 'k-test-audit' }, query: {}, body: { fingerprint: 'nope' } }, r3);
    assert.equal(r3.statusCode, 400); assert.equal(r3.body.error, 'BAD_FINGERPRINT');
    const r4 = mkRes(); await runHandler({ method: 'POST', headers: { 'x-internal-api-key': 'k-test-audit' }, query: { since: 'not-a-date' }, body: {} }, r4);
    assert.equal(r4.statusCode, 400); assert.equal(r4.body.error, 'BAD_SINCE');
  } finally {
    if (prevKey === undefined) delete process.env.WAPAY_INTERNAL_API_KEY; else process.env.WAPAY_INTERNAL_API_KEY = prevKey;
  }
  const admin = read('../pages/api/admin/audit.js');
  const start = admin.indexOf('export default async function handler');
  assert.ok(admin.indexOf('requireAdmin(req)', start) < admin.indexOf('prisma.', start), 'auth before any query');
  assert.match(admin, /latestRun: toAdminRun\(latest\),\n\s+counts,\n\s+trend: trendRows \|\| \[\],\n\s+findings,\n\s+recurring,/, 'the Health tab contract');
  assert.doesNotMatch(admin.slice(admin.indexOf('return res.status(200)')), /msisdn|waId|displayName/i);
  for (const f of ['../pages/api/internal/audit-run.js', '../pages/api/internal/audit-resolve.js']) {
    const src = read(f);
    assert.match(src, /if \(!requireInternalAuth\(req, res\)\) return;/); assert.match(src, /if \(req\.method !== 'POST'\)/);
    const h = src.indexOf('export default async function handler');
    assert.ok(src.indexOf('requireInternalAuth(req, res)', h) < src.indexOf('prisma', h), 'the key before the database');
  }
});

test('cron: one capped audit call inside its own try/catch, logged, never in the response', () => {
  const cron = read('../pages/api/cron/daily-vas-sync.js');
  const i = cron.indexOf("await import('../../../lib/audit/run.js')");
  assert.ok(i > 0, 'the cron imports the audit lazily');
  const before = cron.slice(0, i);
  assert.ok(before.lastIndexOf('try {') > before.lastIndexOf('catch'), 'inside its own try');
  const block = cron.slice(i, cron.indexOf('return res.status(200)'));
  assert.match(block, /Promise\.race\(\[\s*runDailyAudit\(\{ prisma, deadlineMs: auditCapMs - 3 \* 1000 \}\)/);
  assert.match(block, /Math\.min\(45 \* 1000/); assert.match(block, /clearTimeout\(auditTimer\)/);
  assert.match(block, /type: 'cron_daily_audit'/); assert.match(block, /catch \(e\) \{[\s\S]*cron_daily_audit_failed/);
  assert.doesNotMatch(block, /accountId|text:|quote/i, 'the cron log carries counts only');
  assert.match(cron, /return res\.status\(200\)\.json\(\{ \.\.\.out, turnsPurged, integrity: .*?, embeddings, payoutSweep, jobs \}\)/, 'the response literal is unchanged');
  assert.ok(cron.indexOf('cron_daily_audit') > cron.indexOf('cron_jobs_drained'), 'after the money steps');
});

test('the single door: the review calls packages/ai, never a provider; callStructuredOnce reuses callStructured with the tokens kept', () => {
  const review = read('../lib/audit/review.js');
  assert.doesNotMatch(review, /chat\.completions\.create|api\.openai\.com|new OpenAI\(|responses\.create/);
  assert.match(review, /callStructuredOnce\(\{ model, system, user, names, schemaName: 'audit_review', schema: REVIEW_SCHEMA, maxTokens: 6000, timeoutMs, restore: false \}\)/);
  const orch = read('../packages/ai/src/orchestrator.ts');
  const fn = orch.slice(orch.indexOf('export async function callStructuredOnce'));
  assert.match(fn, /await callStructured<T>\(\{/); assert.match(fn, /restore: args\.restore,/); assert.match(fn, /names: args\.names \|\| \[\],/);
  assert.match(orch, /return args\.restore === false \? parsed : restoreDeep\(parsed, args\.vault\);/);
  assert.match(orch, /\}, args\.timeoutMs \? \{ timeout: args\.timeoutMs \} : undefined\);/, 'the per-request timeout rides the same create call');
  for (const f of ['../lib/audit/export.js', '../lib/audit/rules.js', '../lib/audit/brief.js', '../lib/audit/review.js', '../lib/audit/store.js', '../lib/audit/run.js']) {
    assert.doesNotMatch(read(f), /[—–]/, `${f} carries an em dash`);
  }
  assert.match(read('../env.template'), /WAPAY_AUDIT_MAX_ACCOUNTS/); assert.match(read('../env.template'), /WAPAY_AUDIT_REVIEW_MODEL/);
  assert.match(read('../packages/domain/prisma/schema.prisma'), /model AuditFinding \{[\s\S]*fingerprint\s+String\s+@unique/);
  assert.match(read('../packages/domain/prisma/migrations/20261019_audit_loop/migration.sql'), /CREATE TABLE IF NOT EXISTS "audit_findings"/);
});
