/**
 * Static and unit locks for the agent eval runner (AGENT_ARCHITECTURE_V2 C18):
 * the fixture is valid and wide enough, the script never imports the
 * processor or a live provider other than the model, it honours --limit and
 * exits non-zero on regression; and the pure helpers score the way the
 * report claims (tolerance map, complaint never a purchase, regression rule).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  ACCEPTABLE, PROPOSAL_ACTIONS, REGRESSION, parseArgs, normaliseCase, loadCases, buildSyntheticPack,
  makeFakeExecuteTool, scoreCase, summarise, compareBaseline, noteAcceptable, percentile, withdrawOffExpectation,
} from '../scripts/eval-agent.mjs';

const root = process.cwd();
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const SCRIPT = read('scripts/eval-agent.mjs');
const FIXTURE_TEXT = read('tests/fixtures/agent-eval-cases.json');
const OUTCOMES = ['reply', 'clarify', 'proposal'];
const BETTING = /\b(bet|betting|wager|casino|odds|gamble|hollywoodbets|betway|supabets|sportingbet|lottostar)\b/i;

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

test('agent-eval-cases.json is valid JSON with the required keys, >= 24 cases across >= 3 languages', () => {
  const cases = JSON.parse(FIXTURE_TEXT);
  assert.ok(Array.isArray(cases));
  assert.ok(cases.length >= 24, `expected >= 24 cases, got ${cases.length}`);
  const languages = new Set(cases.map((c) => c.language));
  assert.ok(languages.size >= 3, `expected >= 3 languages, got ${[...languages].join(',')}`);
  for (const lang of ['en', 'af', 'zu']) assert.ok(languages.has(lang), `missing language ${lang}`);
  const keys = new Set();
  for (const c of cases) {
    for (const k of ['language', 'id', 'text', 'expectOutcome']) assert.ok(k in c, `${c.id}: missing ${k}`);
    assert.ok(typeof c.text === 'string' && c.text.trim().length > 0, `${c.id}: empty text`);
    const outcomes = Array.isArray(c.expectOutcome) ? c.expectOutcome : [c.expectOutcome];
    for (const o of outcomes) assert.ok(OUTCOMES.includes(o), `${c.id}: bad expectOutcome ${o}`);
    if (c.expectAction) assert.ok(PROPOSAL_ACTIONS.includes(c.expectAction), `${c.id}: unknown expectAction ${c.expectAction}`);
    if (outcomes.length === 1 && outcomes[0] === 'proposal') assert.ok(c.expectAction, `${c.id}: a proposal case needs expectAction`);
    for (const re of [...(c.expectText || []), ...(c.rejectText || [])]) assert.doesNotThrow(() => new RegExp(re, 'i'), `${c.id}: bad regex ${re}`);
    assert.ok(!BETTING.test(c.text), `${c.id}: betting word in text`);
    assert.ok(!/[—–]/.test(c.text), `${c.id}: em or en dash in text`);
    const key = `${c.language}/${c.id}`;
    assert.ok(!keys.has(key), `duplicate case ${key}`);
    keys.add(key);
  }
});

test('the fixture covers every brief group: withdraw, fees, status, discovery, disambiguation, complaint, aside, ack', () => {
  const groups = new Set(JSON.parse(FIXTURE_TEXT).map((c) => c.group));
  for (const g of ['withdraw', 'fees', 'status', 'discovery', 'disambiguation', 'complaint', 'aside', 'ack']) assert.ok(groups.has(g), `missing group ${g}`);
  const complaints = JSON.parse(FIXTURE_TEXT).filter((c) => c.group === 'complaint');
  for (const c of complaints) assert.ok((c.rejectAction || []).length, `${c.id}: a complaint must reject the purchase action`);
});

// ---------------------------------------------------------------------------
// The script, as text
// ---------------------------------------------------------------------------

test('the runner never imports the processor, the ledger, prisma or a live provider other than the model', () => {
  const imports = SCRIPT.match(/(?:^|\n)\s*import[^;]*from\s+['"][^'"]+['"]|\b(?:import|require|req)\(\s*['"][^'"]+['"]\s*\)/g) || [];
  const specs = imports.map((s) => /['"]([^'"]+)['"]\s*\)?;?$/.exec(s)?.[1] || s);
  const forbidden = [
    /message-processor/, /pages\/api\//, /ott-payout/, /providers-/, /@wapay\/providers/, /@wapay\/whatsapp/, /lib\/whatsapp/,
    /lib\/blu/, /lib\/prisma/, /@prisma\/client/, /@wapay\/ledger/, /ledger-post/, /lib\/say\.js/, /undici/, /node:https?/,
  ];
  for (const spec of specs) for (const re of forbidden) assert.ok(!re.test(spec), `forbidden import ${spec}`);
  assert.ok(specs.some((s) => s === 'openai'), 'the model client is the openai package');
  assert.ok(specs.some((s) => s === '@wapay/ai'), 'runAgentTurn comes from @wapay/ai');
  assert.ok(specs.some((s) => s.endsWith('lib/agent/tools/index.js')), 'tool definitions come from lib/agent/tools/index.js');
  assert.ok(!/fetch\(/.test(SCRIPT), 'no raw fetch');
  assert.ok(!/OttPayoutClient|reconcilePayout|requestPayout|getPaymentStatus/.test(SCRIPT), 'never a pay-out call');
  assert.ok(!/execSync|spawn\(|child_process/.test(SCRIPT), 'never shells out');
});

test('the runner honours --limit, --lang, --model and --baseline, and exits non-zero on regression', () => {
  for (const flag of ['--limit', '--lang', '--model', '--baseline']) assert.ok(SCRIPT.includes(`'${flag}'`), `flag ${flag} parsed`);
  assert.ok(/cases\.slice\(0,\s*limit\)/.test(SCRIPT), '--limit slices the case list');
  assert.ok(/regressions\.length\)\s*\{\s*\n\s*console\.error\([^)]*regression[^)]*\);\s*\n\s*process\.exit\(1\)/i.test(SCRIPT), 'exit 1 on regression');
  assert.ok(SCRIPT.includes("process.exit(2)"), 'configuration errors exit 2');
  assert.ok(/agent-eval-\$\{date\}/.test(SCRIPT), 'writes docs/testing/agent-eval-<date>');
  assert.ok(SCRIPT.includes("'docs/testing'"), 'default output directory is docs/testing');
  assert.ok(SCRIPT.includes('WPC15800A7BD6637'), 'the synthetic pending pay-out reference is fixed');
});

test('the ACCEPTABLE tolerance map is byte-identical to scripts/eval-orchestrator.mjs', () => {
  const src = read('scripts/eval-orchestrator.mjs');
  const m = /const ACCEPTABLE = \{([\s\S]*?)\};/.exec(src);
  assert.ok(m, 'eval-orchestrator has ACCEPTABLE');
  const mine = /export const ACCEPTABLE = \{([\s\S]*?)\};/.exec(SCRIPT);
  assert.ok(mine);
  assert.equal(mine[1].trim(), m[1].trim());
  assert.deepEqual(ACCEPTABLE['data-want'], ['BUY_DATA', 'LIST_CATEGORY']);
});

// ---------------------------------------------------------------------------
// The helpers
// ---------------------------------------------------------------------------

test('parseArgs reads the documented flags', () => {
  const a = parseArgs(['--limit', '5', '--lang', 'en,zu', '--model', 'gpt-x', '--baseline', 'b.json', '--concurrency', '2', '--smoke']);
  assert.equal(a.limit, 5);
  assert.deepEqual(a.langs, ['en', 'zu']);
  assert.equal(a.model, 'gpt-x');
  assert.equal(a.baseline, 'b.json');
  assert.equal(a.concurrency, 2);
  assert.equal(a.smoke, true);
  assert.equal(parseArgs([]).concurrency, 4);
  assert.equal(parseArgs(['--sequential']).concurrency, 1);
});

test('loadCases merges the golden corpus with the agent cases and honours limit and lang', () => {
  const all = loadCases();
  const golden = JSON.parse(read('tests/fixtures/orchestrator-golden.json'));
  const agent = JSON.parse(FIXTURE_TEXT);
  assert.equal(all.length, golden.length + agent.length);
  assert.equal(loadCases({ limit: 7 }).length, 7);
  assert.ok(loadCases({ langs: ['zu'] }).every((c) => c.language === 'zu'));
  // Golden read-only actions become reply expectations that quote the record.
  const bal = all.find((c) => c.source === 'golden' && c.id === 'balance-plain');
  assert.equal(bal.expectAction, null);
  assert.deepEqual(bal.expectOutcome, ['reply']);
  assert.deepEqual(bal.expectText, ['R150']);
  const air = all.find((c) => c.source === 'golden' && c.id === 'airtime-gift');
  assert.equal(air.expectAction, 'BUY_AIRTIME');
  assert.deepEqual(air.expectOutcome, ['proposal', 'clarify']);
  // Withdraw off: a withdraw ask must end in words.
  const w = withdrawOffExpectation(normaliseCase({ language: 'en', id: 'w', text: 'withdraw R200', expectOutcome: 'proposal', expectAction: 'WITHDRAW', amountCents: 20000 }, 'agent'));
  assert.equal(w.expectAction, null);
  assert.deepEqual(w.rejectAction, ['WITHDRAW']);
});

const result = (patch) => ({
  outcome: 'reply', text: '', pendingIntent: null, proposal: null, toolCalls: [], timings: { totalMs: 1200, modelMs: [1200] },
  usage: { inputTokens: 100, outputTokens: 20 }, model: 'test', ...patch,
});

test('scoreCase: a complaint that proposes a purchase is a miss; a reply is a pass', () => {
  const c = normaliseCase({ language: 'en', id: 'complaint-airtime', text: "I didn't get my airtime", expectOutcome: ['reply', 'clarify'], expectAction: null, rejectAction: ['BUY_AIRTIME'] }, 'agent');
  const bad = scoreCase(c, result({ outcome: 'proposal', proposal: { action: 'BUY_AIRTIME', slots: { amountCents: 2000 } } }));
  assert.equal(bad.pass, false);
  assert.equal(bad.checks.action, false);
  const good = scoreCase(c, result({ text: 'I see the R20 Vodacom airtime from yesterday went through. Which number was it for?' }));
  assert.equal(good.pass, true);
});

test('scoreCase: proposals check action, amount and msisdn; a clarify holding the intent counts for the action', () => {
  const c = normaliseCase({ language: 'en', id: 'airtime-gift', text: 'send R20 airtime to 0837654321', expectAction: 'BUY_AIRTIME', amountCents: 2000, msisdn: '0837654321' }, 'golden');
  const ok = scoreCase(c, result({ outcome: 'proposal', proposal: { action: 'BUY_AIRTIME', slots: { amountCents: 2000, msisdn: '+27837654321' } } }));
  assert.equal(ok.pass, true);
  const wrongAmount = scoreCase(c, result({ outcome: 'proposal', proposal: { action: 'BUY_AIRTIME', slots: { amountCents: 2500, msisdn: '0837654321' } } }));
  assert.equal(wrongAmount.checks.amount, false);
  assert.equal(wrongAmount.pass, false);
  const clarify = scoreCase(c, result({ outcome: 'clarify', text: 'For which network?', pendingIntent: { action: 'BUY_AIRTIME', slots: { amountCents: 2000, msisdn: '0837654321' } } }));
  assert.equal(clarify.checks.action, true);
  assert.equal(clarify.pass, true);
  assert.equal(scoreCase(c, result({ outcome: 'error', error: 'timeout' })).pass, false);
});

test('scoreCase: the tolerance map and the shape checks (line count, list markers, expectText, rejectText)', () => {
  const help = normaliseCase({ language: 'en', id: 'help', text: 'help', expectAction: 'HELP' }, 'golden');
  assert.equal(scoreCase(help, result({ text: 'You can buy airtime, send money or get paid. What do you need?' })).checks.action, true);
  assert.equal(scoreCase(help, result({ outcome: 'proposal', proposal: { action: 'HELP', slots: {} } })).pass, true);

  const cap = normaliseCase({ language: 'af', id: 'withdraw-can-i', text: 'Kan ek geld onttrek?', expectOutcome: ['reply', 'clarify'], maxLines: 3, rejectAction: ['WITHDRAW'] }, 'agent');
  assert.equal(scoreCase(cap, result({ text: 'Ja.\nPayShap of kontant.\nWatter een?' })).pass, true);
  assert.equal(scoreCase(cap, result({ text: 'a\nb\nc\nd' })).checks.maxLines, false);

  const list = normaliseCase({ language: 'en', id: 'discovery', text: 'what can i do', expectOutcome: 'reply', expectList: true }, 'agent');
  assert.equal(scoreCase(list, result({ text: 'Here is what you can do:\n- buy airtime\n- send money\n- get paid' })).checks.list, true);
  assert.equal(scoreCase(list, result({ text: 'You can buy airtime and send money and get paid.' })).checks.list, false);

  const status = normaliseCase({ language: 'en', id: 'status', text: 'is my payshap done', expectOutcome: 'reply', expectText: ['WPC15800A7BD6637|R50'], rejectText: ['\\bR20\\b'] }, 'agent');
  assert.equal(scoreCase(status, result({ text: 'Your R50 PayShap pay-out is still with the bank.' })).pass, true);
  assert.equal(scoreCase(status, result({ text: 'Your R20 deposit landed.' })).pass, false);

  const ack = normaliseCase({ language: 'en', id: 'ack-okay', text: 'Okay', expectOutcome: 'reply', maxLines: 2, rejectAction: ['*'] }, 'agent');
  assert.equal(scoreCase(ack, result({ outcome: 'proposal', proposal: { action: 'HOME', slots: {} } })).checks.action, false);
  assert.equal(scoreCase(ack, result({ text: 'Sure. I am here when you need me.' })).pass, true);
});

test('summarise and compareBaseline: p50/p95 per language, tokens, cost, and the regression rule', () => {
  const mk = (lang, pass, ms) => scoreCase(
    normaliseCase({ language: lang, id: `c${ms}`, text: 'x', expectOutcome: 'reply' }, 'agent'),
    result({ outcome: pass ? 'reply' : 'proposal', proposal: pass ? null : { action: 'HOME', slots: {} }, timings: { totalMs: ms, modelMs: [ms] } }),
  );
  const scored = [mk('en', true, 1000), mk('en', true, 2000), mk('en', false, 3000), mk('zu', true, 1500)];
  const s = summarise(scored, { prices: { inputUsdPerM: 1, outputUsdPerM: 10 } });
  assert.equal(s.overall.total, 4);
  assert.equal(s.overall.actionPct, 75);
  assert.equal(s.byLanguage.en.p50Ms, 2000);
  assert.equal(s.byLanguage.en.p95Ms, 3000);
  assert.equal(s.byLanguage.zu.p50Ms, 1500);
  assert.equal(s.overall.inputTokens, 400);
  assert.equal(s.overall.costUsd, 0.0012);
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([], 95), null);

  const same = compareBaseline(s, { summary: s });
  assert.equal(same.regressions.length, 0);
  const better = { summary: { overall: { ...s.overall, actionPct: 78, p95Ms: 3000 }, byLanguage: s.byLanguage } };
  assert.ok(compareBaseline(s, better).regressions.some((r) => /accuracy/.test(r)), 'down 3 points regresses');
  const within = { summary: { overall: { ...s.overall, actionPct: 77, p95Ms: 2500 }, byLanguage: {} } };
  assert.equal(compareBaseline(s, within).regressions.length, 0, 'down 2 points and p95 +20% is within tolerance');
  const faster = { summary: { overall: { ...s.overall, p95Ms: 2000 }, byLanguage: {} } };
  assert.ok(compareBaseline(s, faster).regressions.some((r) => /p95/.test(r)), 'p95 +50% regresses');
  assert.equal(REGRESSION.accuracyPoints, 2);
  assert.equal(REGRESSION.p95Ratio, 0.25);
});

test('the fake executor answers read tools from the synthetic pack and turns start_* into proposals, never a provider call', async () => {
  const pack = buildSyntheticPack({ language: 'en' });
  assert.equal(pack.pendingPayout.reference, 'WPC15800A7BD6637');
  assert.equal(pack.movements.length, 3);
  assert.equal(pack.openPayLinks.length, 1);
  assert.equal(pack.beneficiaries.length, 2);
  const exec = makeFakeExecuteTool({ pack, withdrawLive: true, deps: { feeAnswer: () => 'R2 fee', feeSchedule: () => ({ send: {} }), howItWorksAnswer: (t) => (t === 'withdraw' ? 'steps' : null) } });

  const status = await exec('get_payout_status', { reference: null });
  assert.deepEqual(status, { ok: true, result: { status: 'PENDING', reference: 'WPC15800A7BD6637', amountCents: 5000, feeCents: 500, method: 'PAYSHAP', checked: false } });

  const tx = await exec('get_transactions', { range: 'today', kind: null });
  assert.equal(tx.ok, true);
  assert.equal(tx.result.rows.length, 2, 'the pay-out and the deposit are today; the airtime is yesterday');
  assert.equal(tx.result.totals.byKind.DEPOSIT.sumCents, 2000);
  const all = await exec('get_transactions', { range: 'all', kind: 'AIRTIME' });
  assert.equal(all.result.rows.length, 1);

  const prod = await exec('get_products', { category: 'DATA', query: null, network: 'vodacom' });
  assert.ok(prod.result.products.length >= 1 && prod.result.products.every((p) => p.category === 'DATA' && p.network === 'VODACOM'));

  assert.equal((await exec('get_fee_quote', { kind: 'send', amountCents: null })).result.text, 'R2 fee');
  assert.equal((await exec('how_it_works', { topic: 'withdraw' })).result.text, 'steps');
  assert.equal((await exec('how_it_works', { topic: 'nope' })).ok, false);
  const links = await exec('get_pay_links', {});
  assert.equal(links.result.open[0].code, 'PR7K2FQ4');
  const where = await exec('where_accepted', { merchant: 'Checkers' });
  assert.equal(where.result.accepted, null, 'an unknown name is never claimed as accepting');

  const w = await exec('start_withdraw', { amountCents: 20000, method: 'PAYSHAP' });
  assert.equal(w.ok, true);
  assert.equal(w.proposal.action, 'WITHDRAW');
  assert.equal(w.proposal.slots.amountCents, 20000);
  assert.equal(w.proposal.slots.method, 'PAYSHAP');
  assert.equal(w.proposal.slots.msisdn, null);
  const off = makeFakeExecuteTool({ pack, withdrawLive: false });
  assert.equal((await off('start_withdraw', { amountCents: 20000 })).ok, false);

  const reply = await exec('reply', { kind: 'clarify', text: 'Which one?', pendingIntent: { action: 'WITHDRAW', slots: {} } });
  assert.equal(reply.reply.kind, 'clarify');
  // propose_note proposes; nothing is accepted until the customer says yes.
  const noteOk = await exec('propose_note', { note: 'I usually buy airtime for my mom' });
  assert.equal(noteOk.accepted, false);
  assert.deepEqual(noteOk.pendingNote, { text: 'I usually buy airtime for my mom' });
  const noteBad = await exec('propose_note', { note: 'my meter is 01234567890' });
  assert.equal(noteBad.accepted, false);
  assert.equal(noteBad.pendingNote, undefined, 'a rejected note is not pending either');
  assert.equal((await exec('no_such_tool', {})).ok, false);
  assert.equal(exec.calls.length, 14);
  assert.equal(noteAcceptable('x'.repeat(121)), false);
});
