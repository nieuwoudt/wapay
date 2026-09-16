#!/usr/bin/env node
/**
 * Eval runner for the v1.4 Pay agent (AGENT_ARCHITECTURE_V2 §3 C18).
 *
 * Runs the golden corpus (tests/fixtures/orchestrator-golden.json) plus the
 * agent cases (tests/fixtures/agent-eval-cases.json) through the REAL agent
 * loop (runAgentTurn from @wapay/ai, the real prompt assembler, the real tool
 * definitions from lib/agent/tools/index.js) against a SYNTHETIC customer:
 * a fixed record with balances, three movements (a PENDING PayShap R50
 * pay-out ref WPC15800A7BD6637, a SUCCESS R20 deposit, a SUCCESS R20
 * airtime), one open pay link and two saved people. Read tools are answered
 * from that record by a fake executor; start_* tools return proposals.
 * Nothing here touches the database, a provider or the processor: the only
 * network call is the model.
 *
 * Scores: proposal action accuracy (with the ACCEPTABLE tolerance map from
 * scripts/eval-orchestrator.mjs), outcome accuracy, slot exactness, text
 * shape (line count, list markers, expectText / rejectText regexes),
 * latency p50/p95 per language, tokens and cost.
 *
 * Usage:
 *   node --env-file=.env scripts/eval-agent.mjs
 *   node --env-file=.env scripts/eval-agent.mjs --limit 20 --lang en,zu,af
 *   node --env-file=.env scripts/eval-agent.mjs --model gpt-5.4-mini
 *   node --env-file=.env scripts/eval-agent.mjs --baseline docs/testing/agent-eval-2026-09-16.json
 *   node scripts/eval-agent.mjs --smoke          # stub model, no key, plumbing only
 *
 * Flags: --limit N, --lang a,b, --model id, --baseline path, --concurrency N
 * (default 4; 1 = sequential), --withdraw on|off|env (default on: the
 * synthetic customer may withdraw), --out dir (default docs/testing), --smoke.
 * Prices: WAPAY_EVAL_PRICE_INPUT_USD_PER_M / WAPAY_EVAL_PRICE_OUTPUT_USD_PER_M
 * (USD per million tokens, default 0).
 *
 * Writes docs/testing/agent-eval-<date>.json and .md. With --baseline it
 * compares and exits 1 on regression: action accuracy down by more than
 * REGRESSION.accuracyPoints or p95 latency up by more than
 * REGRESSION.p95Ratio. Exit 2 = configuration error.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

import { renderCustomerRecord, maskMsisdn } from '../lib/context-pack.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GOLDEN = path.join(ROOT, 'tests/fixtures/orchestrator-golden.json');
const AGENT_CASES = path.join(ROOT, 'tests/fixtures/agent-eval-cases.json');

// ---------------------------------------------------------------------------
// Tolerances (kept identical to scripts/eval-orchestrator.mjs)
// ---------------------------------------------------------------------------

/**
 * Per-scenario tolerance: actions that are also acceptable besides the
 * canonical expectAction. Kept deliberately tight: commerce and money
 * scenarios allow nothing else. 'NONE' means a plain reply with no proposal.
 */
export const ACCEPTABLE = {
  'data-want': ['BUY_DATA', 'LIST_CATEGORY'],
  help: ['HELP', 'LIST_PRODUCTS', 'NONE'],
  greeting: ['NONE', 'HELP', 'HOME'],
};

/** Actions a start_* / show_* tool may propose (contract (1)). */
export const PROPOSAL_ACTIONS = [
  'BUY_AIRTIME', 'BUY_DATA', 'BUY_ELECTRICITY', 'SEND_VOUCHER', 'REQUEST_MONEY', 'DEPOSIT_START',
  'WITHDRAW', 'BUY_FUEL', 'REDEEM_VOUCHER', 'HOME', 'HELP',
];

/** Proposal tool name -> action (contract (1)). */
export const TOOL_ACTIONS = {
  start_buy_airtime: 'BUY_AIRTIME',
  start_buy_data: 'BUY_DATA',
  start_buy_electricity: 'BUY_ELECTRICITY',
  start_send: 'SEND_VOUCHER',
  start_pay_link: 'REQUEST_MONEY',
  start_deposit: 'DEPOSIT_START',
  start_withdraw: 'WITHDRAW',
  start_fuel: 'BUY_FUEL',
  start_voucher_load: 'REDEEM_VOUCHER',
  show_home: 'HOME',
  show_help: 'HELP',
};

export const READ_TOOLS = [
  'get_transactions', 'get_products', 'get_fee_quote', 'where_accepted', 'get_payout_status', 'get_pay_links', 'how_it_works',
];

/**
 * Golden actions the agent answers from the record instead of proposing:
 * the expectation becomes a reply that quotes the synthetic fact.
 */
export const READ_ONLY_GOLDEN = {
  CHECK_BALANCE: { expectText: ['R150'] },
  DEPOSIT_STATUS: { expectText: ['R20|R50|WPC15800A7BD6637'] },
  NONE: {},
};

export const REGRESSION = { accuracyPoints: 2, p95Ratio: 0.25 };

// ---------------------------------------------------------------------------
// Arguments and cases
// ---------------------------------------------------------------------------

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    limit: null, langs: null, model: null, baseline: null, concurrency: 4, withdraw: 'on',
    out: path.join(ROOT, 'docs/testing'), smoke: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--lang') out.langs = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--model') out.model = argv[++i] || null;
    else if (a === '--baseline') out.baseline = argv[++i] || null;
    else if (a === '--concurrency') out.concurrency = Math.max(1, Number(argv[++i]) || 4);
    else if (a === '--sequential') out.concurrency = 1;
    else if (a === '--withdraw') out.withdraw = argv[++i] || 'on';
    else if (a === '--out') out.out = path.resolve(argv[++i] || out.out);
    else if (a === '--smoke') out.smoke = true;
  }
  return out;
}

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** One shape for both fixtures. Golden cases carry the orchestrator's expectAction. */
export function normaliseCase(raw, source) {
  const c = { ...raw, source };
  c.expectOutcome = asList(c.expectOutcome);
  c.expectText = asList(c.expectText);
  c.rejectText = asList(c.rejectText);
  c.rejectAction = asList(c.rejectAction);
  c.acceptActions = asList(c.acceptActions);
  c.history = Array.isArray(c.history) ? c.history : [];
  if (source === 'golden') {
    const action = c.expectAction;
    if (PROPOSAL_ACTIONS.includes(action)) {
      // A proposal, or a clarify that already holds the intent (the flow asks the rest).
      c.expectOutcome = ['proposal', 'clarify'];
    } else if (action in READ_ONLY_GOLDEN) {
      c.expectAction = null;
      c.expectOutcome = ['reply'];
      c.expectText = READ_ONLY_GOLDEN[action].expectText || [];
    } else {
      c.expectOutcome = ['reply'];
    }
  }
  if (!c.expectOutcome.length) c.expectOutcome = c.expectAction ? ['proposal'] : ['reply'];
  c.key = `${c.source}/${c.language}/${c.id}`;
  return c;
}

/** When the synthetic customer may not withdraw, a withdraw ask must end in words, not a proposal. */
export function withdrawOffExpectation(c) {
  if (c.expectAction !== 'WITHDRAW') return c;
  return { ...c, expectAction: null, expectOutcome: ['reply', 'clarify'], rejectAction: ['WITHDRAW'], amountCents: null };
}

export function loadCases({ limit = null, langs = null, withdrawLive = true } = {}) {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')).map((c) => normaliseCase(c, 'golden'));
  const agent = JSON.parse(readFileSync(AGENT_CASES, 'utf8')).map((c) => normaliseCase(c, 'agent'));
  let cases = [...golden, ...agent];
  if (!withdrawLive) cases = cases.map(withdrawOffExpectation);
  if (langs && langs.length) cases = cases.filter((c) => langs.includes(c.language));
  if (limit != null) cases = cases.slice(0, limit);
  return cases;
}

// ---------------------------------------------------------------------------
// The synthetic customer
// ---------------------------------------------------------------------------

export const NOW = new Date('2026-09-16T07:30:00.000Z'); // 09:30 SAST
const H = 3600 * 1000;
const ago = (ms) => new Date(NOW.getTime() - ms);

export const SYNTHETIC = {
  waId: '27787051175',
  msisdn: '0787051175',
  accountId: 'eval-acc-1',
  displayName: 'Thabo',
  payoutReference: 'WPC15800A7BD6637',
};

export function buildSyntheticAccount(language = 'en') {
  return {
    id: SYNTHETIC.accountId,
    waId: SYNTHETIC.waId,
    msisdn: SYNTHETIC.msisdn,
    displayName: SYNTHETIC.displayName,
    profile: { language, kyc: { status: 'VERIFIED' } },
    kycStatus: 'VERIFIED',
  };
}

/** The same shape lib/context-pack.js loadContextPack returns, with fixed facts. */
export function buildSyntheticPack({ language = 'en', now = NOW } = {}) {
  const src = (id) => ({ table: 'providerRequest', id });
  const movements = [
    {
      kind: 'PAYOUT', amountCents: 5000, feeCents: 500, status: 'PENDING', counterparty: 'Thabo M',
      reference: SYNTHETIC.payoutReference, at: new Date(now.getTime() - 2 * H), source: src('pr-payout'),
      note: 'PayShap pay-out, waiting on the bank rail', method: 'PAYSHAP', reconcileRequired: false, providerStatus: 'PENDING',
    },
    {
      kind: 'DEPOSIT', amountCents: 2000, feeCents: 300, status: 'SUCCESS', counterparty: 'PayFast',
      reference: '2179045', at: new Date(now.getTime() - 5 * H), source: src('pr-dep'), note: 'card deposit',
    },
    {
      kind: 'AIRTIME', amountCents: 2000, feeCents: 0, status: 'SUCCESS', counterparty: `Vodacom ${maskMsisdn('0834561234')}`,
      reference: 'BLU-77', at: new Date(now.getTime() - 26 * H), source: src('prev-air'), note: 'airtime',
    },
  ];
  const pending = movements[0];
  return {
    accountId: SYNTHETIC.accountId,
    waId: SYNTHETIC.waId,
    msisdn: SYNTHETIC.msisdn,
    displayName: SYNTHETIC.displayName,
    language,
    kyc: 'VERIFIED',
    balances: { spendCents: 15000, cashCents: 8000, heldSpendCents: 0, heldCashCents: 5500 },
    movements,
    movementsTotal: movements.length,
    pendingPayout: {
      reference: pending.reference, method: 'PAYSHAP', amountCents: 5000, feeCents: 500, heldCents: 5500, holdFound: true,
      counterparty: pending.counterparty, at: pending.at, reconcileRequired: false, providerStatus: 'PENDING', source: pending.source,
    },
    openPayLinks: [
      { code: 'PR7K2FQ4', amountCents: 8000, note: 'Lunch', createdAt: new Date(now.getTime() - 9 * H), expiresAt: new Date(now.getTime() + 6 * 24 * H) },
    ],
    vouchersWaiting: 0,
    beneficiaries: [
      { name: 'Philly', msisdnTail: '3910' },
      { name: 'Mom', msisdnTail: '2222' },
    ],
    turns: [],
    warnings: [],
    loadedAt: now,
  };
}

/** A small catalogue so get_products answers without the VAS table. */
export const SYNTHETIC_PRODUCTS = [
  { id: 'air-vod-10', name: 'Vodacom Airtime R10', priceCents: 1000, network: 'VODACOM', category: 'AIRTIME' },
  { id: 'air-vod-20', name: 'Vodacom Airtime R20', priceCents: 2000, network: 'VODACOM', category: 'AIRTIME' },
  { id: 'air-mtn-20', name: 'MTN Airtime R20', priceCents: 2000, network: 'MTN', category: 'AIRTIME' },
  { id: 'air-cellc-30', name: 'Cell C Airtime R30', priceCents: 3000, network: 'CELLC', category: 'AIRTIME' },
  { id: 'data-mtn-1gb', name: 'MTN 1GB 30 days', priceCents: 8500, network: 'MTN', category: 'DATA' },
  { id: 'data-vod-500mb', name: 'Vodacom 500MB 7 days', priceCents: 4900, network: 'VODACOM', category: 'DATA' },
  { id: 'data-vod-2gb', name: 'Vodacom 2GB 30 days', priceCents: 14900, network: 'VODACOM', category: 'DATA' },
  { id: 'data-telkom-1gb', name: 'Telkom 1GB 30 days', priceCents: 7900, network: 'TELKOM', category: 'DATA' },
  { id: 'elec-prepaid', name: 'Prepaid electricity', priceCents: 0, network: null, category: 'ELECTRICITY' },
];

const SAST_OFFSET_MS = 2 * H;
function rangeStart(range, now) {
  if (range === 'today') {
    const sast = new Date(now.getTime() + SAST_OFFSET_MS);
    sast.setUTCHours(0, 0, 0, 0);
    return sast.getTime() - SAST_OFFSET_MS;
  }
  if (range === 'week') return now.getTime() - 7 * 24 * H;
  if (range === 'month') return now.getTime() - 30 * 24 * H;
  return -Infinity;
}

const SLOT_KEYS = ['amountCents', 'msisdn', 'recipientName', 'self', 'meterNumber', 'productQuery', 'category', 'method'];
function slotsFrom(args = {}) {
  const slots = {};
  for (const k of SLOT_KEYS) slots[k] = args[k] === undefined ? null : args[k];
  return slots;
}

/** Number-free, short, about the customer (contract (1) propose_note). */
export function noteAcceptable(note) {
  const s = String(note || '').trim();
  if (!s || s.length > 120 || /\d/.test(s)) return false;
  return /\b(i|i'm|i've|my|me|you|your|you're|jy|jou|ek|my|wena|mina|ngi|u)\b/i.test(s);
}

/**
 * The fake executor: read tools answered from the synthetic pack, start_*
 * tools turned into proposals, reply passed through. `deps` carries the
 * pure fact helpers (feeAnswer, feeSchedule, howItWorksAnswer, ottAccepted,
 * ottAcceptedFacts, fuelPartners) so this module has no lib imports beyond
 * the context pack.
 */
export function makeFakeExecuteTool({ pack, now = NOW, withdrawLive = true, deps = {} }) {
  const calls = [];
  const fn = async (name, args = {}) => {
    calls.push({ name, args });
    const a = args && typeof args === 'object' ? args : {};
    try {
      switch (name) {
        case 'get_transactions': {
          const since = rangeStart(a.range || 'all', now);
          const kind = a.kind ? String(a.kind).toUpperCase() : null;
          const rows = pack.movements
            .filter((m) => m.at.getTime() >= since && (!kind || m.kind === kind))
            .slice(0, 20)
            .map((m) => ({ kind: m.kind, amountCents: m.amountCents, feeCents: m.feeCents, status: m.status, counterparty: m.counterparty, reference: m.reference, at: m.at.toISOString() }));
          const byKind = {};
          let sumCents = 0;
          for (const r of rows) {
            sumCents += r.amountCents;
            byKind[r.kind] = byKind[r.kind] || { count: 0, sumCents: 0 };
            byKind[r.kind].count += 1;
            byKind[r.kind].sumCents += r.amountCents;
          }
          return { ok: true, result: { rows, totals: { count: rows.length, sumCents, byKind } } };
        }
        case 'get_products': {
          const cat = String(a.category || '').toUpperCase();
          const net = a.network ? String(a.network).toUpperCase().replace(/\s+/g, '') : null;
          const q = a.query ? String(a.query).toLowerCase() : null;
          const products = SYNTHETIC_PRODUCTS
            .filter((p) => !cat || p.category === cat)
            .filter((p) => !net || (p.network && p.network.includes(net)))
            .filter((p) => !q || p.name.toLowerCase().includes(q))
            .slice(0, 8);
          return { ok: true, result: { products } };
        }
        case 'get_fee_quote': {
          const kind = a.kind || 'general';
          const amount = Number.isInteger(a.amountCents) ? a.amountCents : null;
          const text = deps.feeAnswer ? deps.feeAnswer(kind, amount, { withdrawLive }) : `Fees for ${kind}: see the FEES block.`;
          const schedule = deps.feeSchedule ? deps.feeSchedule({ withdrawLive }) : {};
          return { ok: true, result: { text, schedule } };
        }
        case 'where_accepted': {
          const merchant = a.merchant ? String(a.merchant).trim() : null;
          const list = Array.isArray(deps.ottAccepted) ? deps.ottAccepted : [];
          const facts = deps.ottAcceptedFacts ? deps.ottAcceptedFacts() : list.map((m) => m.name).join(', ');
          if (!merchant) return { ok: true, result: { accepted: null, name: null, note: 'no merchant named', facts } };
          const q = merchant.toLowerCase();
          const hit = list.find((m) => m.name.toLowerCase() === q || (m.aliases || []).some((al) => al.toLowerCase() === q));
          return { ok: true, result: { accepted: hit ? true : null, name: hit ? hit.name : merchant, note: hit ? hit.what || null : 'not on the partner list; never claimed as accepting', facts } };
        }
        case 'get_payout_status': {
          const pp = pack.pendingPayout;
          if (!pp) return { ok: true, result: { status: 'NONE', reference: null, amountCents: null, feeCents: null, method: null, checked: false } };
          if (a.reference && String(a.reference).toUpperCase() !== pp.reference) {
            return { ok: true, result: { status: 'UNKNOWN', reference: String(a.reference), amountCents: null, feeCents: null, method: null, checked: false } };
          }
          return { ok: true, result: { status: 'PENDING', reference: pp.reference, amountCents: pp.amountCents, feeCents: pp.feeCents, method: pp.method, checked: false } };
        }
        case 'get_pay_links': {
          const recent = pack.movements.filter((m) => m.kind === 'PAY_LINK').map((m) => ({ amountCents: m.amountCents, status: m.status, reference: m.reference, at: m.at.toISOString() }));
          const open = pack.openPayLinks.map((l) => ({ code: l.code, amountCents: l.amountCents, note: l.note, expiresAt: l.expiresAt ? l.expiresAt.toISOString() : null }));
          return { ok: true, result: { open, recent } };
        }
        case 'how_it_works': {
          const topic = String(a.topic || '');
          const ctx = { wicodeLive: false, withdrawLive, fuelPartners: deps.fuelPartners || [], ottFacts: deps.ottAcceptedFacts ? deps.ottAcceptedFacts() : '' };
          const text = deps.howItWorksAnswer ? deps.howItWorksAnswer(topic, ctx) : null;
          if (!text) return { ok: false, error: `unknown topic ${topic}` };
          return { ok: true, result: { text } };
        }
        case 'propose_note': {
          const note = String(a.note || '').trim();
          const accepted = noteAcceptable(note);
          return { ok: true, accepted, note: accepted ? { text: note, at: now.toISOString() } : null };
        }
        case 'reply': {
          const kind = a.kind === 'clarify' ? 'clarify' : 'reply';
          return { ok: true, reply: { kind, text: String(a.text || ''), pendingIntent: a.pendingIntent || null } };
        }
        default: {
          if (name in TOOL_ACTIONS) {
            if (name === 'start_withdraw' && !withdrawLive) return { ok: false, error: 'withdrawals are not open for this customer' };
            return { ok: true, proposal: { action: TOOL_ACTIONS[name], slots: slotsFrom(a) } };
          }
          return { ok: false, error: `unknown tool ${name}` };
        }
      }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const normaliseMsisdnLoose = (m) => String(m || '').replace(/^\+?27/, '0').replace(/\D/g, '');
const LIST_MARKER = /^\s*(?:[-•*]|\d+[.)])\s+\S/m;

export function actionOf(r) {
  return r?.proposal?.action || r?.pendingIntent?.action || 'NONE';
}

export function slotsOf(r) {
  return r?.proposal?.slots || r?.pendingIntent?.slots || {};
}

export function lineCount(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).length;
}

/** One case against one agent result: every check named, one pass flag. */
export function scoreCase(c, r) {
  const checks = {};
  const error = !r || r.outcome === 'error' ? (r?.error || 'no result') : null;
  const action = actionOf(r);
  const slots = slotsOf(r);

  const okActions = c.expectAction ? [...(ACCEPTABLE[c.id] || [c.expectAction]), ...c.acceptActions] : ['NONE', ...c.acceptActions];
  const rejected = c.rejectAction.includes('*') ? action !== 'NONE' : c.rejectAction.includes(action);
  checks.action = okActions.includes(action) && !rejected;

  const allowedOutcomes = new Set(c.expectOutcome);
  if (okActions.some((x) => PROPOSAL_ACTIONS.includes(x))) allowedOutcomes.add('proposal');
  if (okActions.includes('NONE')) allowedOutcomes.add('reply');
  checks.outcome = !!r && allowedOutcomes.has(r.outcome);

  checks.amount = c.amountCents == null || slots.amountCents === c.amountCents;
  checks.msisdn = c.msisdn == null || normaliseMsisdnLoose(slots.msisdn) === normaliseMsisdnLoose(c.msisdn);

  const text = String(r?.text || '');
  const textual = !!r && (r.outcome === 'reply' || r.outcome === 'clarify');
  checks.maxLines = !textual || c.maxLines == null || lineCount(text) <= c.maxLines;
  checks.list = !textual || !c.expectList || LIST_MARKER.test(text);
  checks.expectText = !textual || c.expectText.every((re) => new RegExp(re, 'i').test(text));
  checks.rejectText = !textual || !c.rejectText.some((re) => new RegExp(re, 'i').test(text));
  checks.shape = checks.maxLines && checks.list && checks.expectText && checks.rejectText;

  const pass = !error && checks.action && checks.outcome && checks.amount && checks.msisdn && checks.shape;
  return {
    key: c.key, source: c.source, language: c.language, id: c.id, group: c.group || null, text: c.text,
    want: { outcome: c.expectOutcome, action: c.expectAction, amountCents: c.amountCents ?? null, msisdn: c.msisdn ?? null },
    got: {
      outcome: r?.outcome || 'error', action, amountCents: slots.amountCents ?? null, msisdn: slots.msisdn ? maskMsisdn(slots.msisdn) || '***' : null,
      text: text.slice(0, 400), toolCalls: (r?.toolCalls || []).map((t) => t.name), model: r?.model || null,
    },
    checks, pass, error,
    ms: r?.timings?.totalMs ?? null,
    modelMs: r?.timings?.modelMs || [],
    inputTokens: r?.usage?.inputTokens || 0,
    outputTokens: r?.usage?.outputTokens || 0,
  };
}

export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[idx];
}

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : 0);

function bucket() {
  return { total: 0, pass: 0, action: 0, outcome: 0, shape: 0, errors: 0, ms: [], inputTokens: 0, outputTokens: 0 };
}
function add(b, s) {
  b.total += 1;
  if (s.pass) b.pass += 1;
  if (s.checks.action) b.action += 1;
  if (s.checks.outcome) b.outcome += 1;
  if (s.checks.shape) b.shape += 1;
  if (s.error) b.errors += 1;
  if (s.ms != null) b.ms.push(s.ms);
  b.inputTokens += s.inputTokens;
  b.outputTokens += s.outputTokens;
}
function finish(b, prices) {
  const costUsd = (b.inputTokens * prices.inputUsdPerM + b.outputTokens * prices.outputUsdPerM) / 1e6;
  return {
    total: b.total, pass: b.pass, errors: b.errors,
    passPct: pct(b.pass, b.total), actionPct: pct(b.action, b.total), outcomePct: pct(b.outcome, b.total), shapePct: pct(b.shape, b.total),
    p50Ms: percentile(b.ms, 50), p95Ms: percentile(b.ms, 95),
    inputTokens: b.inputTokens, outputTokens: b.outputTokens, costUsd: Math.round(costUsd * 1e4) / 1e4,
  };
}

export function pricesFromEnv(env = process.env) {
  return {
    inputUsdPerM: Number(env.WAPAY_EVAL_PRICE_INPUT_USD_PER_M) || 0,
    outputUsdPerM: Number(env.WAPAY_EVAL_PRICE_OUTPUT_USD_PER_M) || 0,
  };
}

export function summarise(scored, { prices = pricesFromEnv() } = {}) {
  const overall = bucket();
  const byLanguage = {};
  const bySource = {};
  const byGroup = {};
  for (const s of scored) {
    add(overall, s);
    add((byLanguage[s.language] ||= bucket()), s);
    add((bySource[s.source] ||= bucket()), s);
    if (s.group) add((byGroup[s.group] ||= bucket()), s);
  }
  const fin = (m) => Object.fromEntries(Object.entries(m).sort().map(([k, b]) => [k, finish(b, prices)]));
  return { overall: finish(overall, prices), byLanguage: fin(byLanguage), bySource: fin(bySource), byGroup: fin(byGroup), prices };
}

/** Regression = action accuracy down by more than 2 points or p95 up by more than 25%. */
export function compareBaseline(summary, baseline, rule = REGRESSION) {
  const cur = summary.overall;
  const base = baseline?.summary?.overall || baseline?.overall || null;
  if (!base) return { compared: false, regressions: ['baseline has no overall summary'], lines: [] };
  const regressions = [];
  const lines = [];
  const accDelta = Math.round((cur.actionPct - base.actionPct) * 10) / 10;
  lines.push(`action accuracy: ${base.actionPct}% -> ${cur.actionPct}% (${accDelta >= 0 ? '+' : ''}${accDelta} points)`);
  if (accDelta < -rule.accuracyPoints) regressions.push(`action accuracy fell ${Math.abs(accDelta)} points (limit ${rule.accuracyPoints})`);
  if (Number.isFinite(base.p95Ms) && Number.isFinite(cur.p95Ms) && base.p95Ms > 0) {
    const ratio = Math.round(((cur.p95Ms - base.p95Ms) / base.p95Ms) * 1000) / 10;
    lines.push(`p95 latency: ${base.p95Ms} ms -> ${cur.p95Ms} ms (${ratio >= 0 ? '+' : ''}${ratio}%)`);
    if (cur.p95Ms > base.p95Ms * (1 + rule.p95Ratio)) regressions.push(`p95 latency rose ${ratio}% (limit ${rule.p95Ratio * 100}%)`);
  } else {
    lines.push('p95 latency: not comparable');
  }
  for (const [lang, b] of Object.entries(summary.byLanguage)) {
    const bl = baseline?.summary?.byLanguage?.[lang] || baseline?.byLanguage?.[lang];
    if (bl) lines.push(`  ${lang}: action ${bl.actionPct}% -> ${b.actionPct}%, p95 ${bl.p95Ms ?? '?'} -> ${b.p95Ms ?? '?'} ms`);
  }
  return { compared: true, regressions, lines };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function row(label, b) {
  return `| ${label} | ${b.total} | ${b.passPct}% | ${b.actionPct}% | ${b.outcomePct}% | ${b.shapePct}% | ${b.errors} | ${b.p50Ms ?? ''} | ${b.p95Ms ?? ''} | ${b.inputTokens} | ${b.outputTokens} | $${b.costUsd} |`;
}

export function renderMarkdown({ date, model, summary, scored, args, withdrawLive, baselineReport, jsonName }) {
  const header = '| slice | cases | pass | action | outcome | shape | errors | p50 ms | p95 ms | tokens in | tokens out | cost |\n|---|---|---|---|---|---|---|---|---|---|---|---|';
  const misses = scored.filter((s) => !s.pass);
  const lines = [
    `# Agent eval ${date}`,
    '',
    `Model: \`${model}\`. Cases: ${summary.overall.total} (golden ${summary.bySource.golden?.total || 0}, agent ${summary.bySource.agent?.total || 0}).`,
    `Synthetic customer: withdraw ${withdrawLive ? 'live' : 'off'}; PENDING PayShap R50 ref ${SYNTHETIC.payoutReference}; SUCCESS R20 deposit; one open pay link; two saved people.`,
    `Flags: limit ${args.limit ?? 'none'}, lang ${args.langs ? args.langs.join(',') : 'all'}, concurrency ${args.concurrency}${args.smoke ? ', SMOKE (stub model, numbers meaningless)' : ''}.`,
    `Prices: $${summary.prices.inputUsdPerM}/M in, $${summary.prices.outputUsdPerM}/M out (env WAPAY_EVAL_PRICE_*).`,
    `Raw results: \`${jsonName}\`.`,
    '',
    '## Overall',
    '',
    header,
    row('all', summary.overall),
    '',
    '## By language',
    '',
    header,
    ...Object.entries(summary.byLanguage).map(([k, b]) => row(k, b)),
    '',
    '## By source',
    '',
    header,
    ...Object.entries(summary.bySource).map(([k, b]) => row(k, b)),
  ];
  if (Object.keys(summary.byGroup).length) {
    lines.push('', '## By group (agent cases)', '', header, ...Object.entries(summary.byGroup).map(([k, b]) => row(k, b)));
  }
  if (baselineReport) {
    lines.push('', `## Baseline: \`${args.baseline}\``, '');
    lines.push(...baselineReport.lines.map((l) => `- ${l}`));
    lines.push('', baselineReport.regressions.length ? `**REGRESSION**: ${baselineReport.regressions.join('; ')}` : 'No regression.');
  }
  lines.push('', `## Misses (${misses.length})`, '');
  if (!misses.length) lines.push('None.');
  for (const s of misses) {
    const failed = Object.entries(s.checks).filter(([k, v]) => !v && k !== 'shape').map(([k]) => k);
    lines.push(`- **${s.key}** "${s.text}"`);
    lines.push(`  want ${s.want.outcome.join('|')} ${s.want.action || 'NONE'}${s.want.amountCents != null ? ` amount=${s.want.amountCents}` : ''}${s.want.msisdn ? ` msisdn=${s.want.msisdn}` : ''}`);
    lines.push(`  got  ${s.got.outcome} ${s.got.action}${s.got.amountCents != null ? ` amount=${s.got.amountCents}` : ''}${s.got.msisdn ? ` msisdn=${s.got.msisdn}` : ''} tools=[${s.got.toolCalls.join(',')}] failed=[${failed.join(',')}]${s.error ? ` error=${s.error}` : ''}`);
    if (s.got.text) lines.push(`  text: ${s.got.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return `${lines.join('\n')}\n`;
}

function printTable(summary) {
  console.log('slice | cases | pass    | action  | outcome | shape   | err | p50 ms | p95 ms | tok in | tok out | cost');
  console.log('------|-------|---------|---------|---------|---------|-----|--------|--------|--------|---------|------');
  const line = (label, b) => console.log(
    `${label.padEnd(5)} | ${String(b.total).padEnd(5)} | ${`${b.passPct}%`.padEnd(7)} | ${`${b.actionPct}%`.padEnd(7)} | ${`${b.outcomePct}%`.padEnd(7)} | ${`${b.shapePct}%`.padEnd(7)} | ${String(b.errors).padEnd(3)} | ${String(b.p50Ms ?? '').padEnd(6)} | ${String(b.p95Ms ?? '').padEnd(6)} | ${String(b.inputTokens).padEnd(6)} | ${String(b.outputTokens).padEnd(7)} | $${b.costUsd}`,
  );
  for (const [k, b] of Object.entries(summary.byLanguage)) line(k, b);
  line('ALL', summary.overall);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** A stand-in model for --smoke: one plain reply per call, no network. */
function smokeClient() {
  return {
    chat: {
      completions: {
        create: async (params) => ({
          id: 'smoke', model: params.model || 'smoke', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Smoke reply. Nothing was called.', tool_calls: [] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      },
    },
  };
}

function openAiClient(timeoutMs) {
  // The openai package lives under packages/ai, not the workspace root.
  const req = createRequire(path.join(ROOT, 'packages/ai/package.json'));
  const mod = req('openai');
  const OpenAI = mod.default || mod.OpenAI || mod;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: timeoutMs, maxRetries: 0 });
}

async function runAll(cases, runOne, concurrency) {
  const results = new Array(cases.length);
  let idx = 0;
  const worker = async () => {
    while (idx < cases.length) {
      const i = idx++;
      results[i] = await runOne(cases[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  return results;
}

async function main() {
  const args = parseArgs();
  if (!args.smoke && !process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not set: run with node --env-file=.env (or --smoke for plumbing only).');
    process.exit(2);
  }

  // The synthetic customer may withdraw unless told otherwise; set before the
  // lib modules read the gate (they read env at call time, so this is safe).
  if (args.withdraw === 'on') {
    process.env.WAPAY_PAYOUT_ENABLED = 'true';
    const list = String(process.env.WAPAY_PAYOUT_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length && !list.includes(SYNTHETIC.waId)) process.env.WAPAY_PAYOUT_ALLOWLIST = [...list, SYNTHETIC.waId].join(',');
  } else if (args.withdraw === 'off') {
    process.env.WAPAY_PAYOUT_ENABLED = 'false';
  }

  let ai, tools, capabilities, feeFacts, howItWorks, ottAcceptance, spendCatalogue, payouts;
  try {
    [ai, tools, capabilities, feeFacts, howItWorks, ottAcceptance, spendCatalogue, payouts] = await Promise.all([
      import('@wapay/ai'),
      import('../lib/agent/tools/index.js'),
      import('../lib/capabilities.js'),
      import('../lib/fee-facts.js'),
      import('../lib/how-it-works.js'),
      import('../lib/ott-acceptance.js'),
      import('../lib/spend-catalogue.js'),
      import('../lib/payouts.js'),
    ]);
  } catch (e) {
    console.error(`Cannot load the agent: ${e?.message || e}\n(@wapay/ai must be built: pnpm --filter @wapay/ai build; lib/agent/tools/index.js must exist.)`);
    process.exit(2);
  }
  const { runAgentTurn, buildAgentSystemPrompt } = ai;
  const { buildToolDefinitions } = tools;
  if (typeof runAgentTurn !== 'function' || typeof buildAgentSystemPrompt !== 'function' || typeof buildToolDefinitions !== 'function') {
    console.error('The agent exports are incomplete (runAgentTurn, buildAgentSystemPrompt, buildToolDefinitions).');
    process.exit(2);
  }

  const withdrawLive = !!payouts.payoutAllowedFor(SYNTHETIC.waId);
  const cases = loadCases({ limit: args.limit, langs: args.langs, withdrawLive });
  if (!cases.length) {
    console.error('No cases selected.');
    process.exit(2);
  }
  const deps = {
    feeAnswer: feeFacts.feeAnswer,
    feeSchedule: feeFacts.feeSchedule,
    howItWorksAnswer: howItWorks.howItWorksAnswer,
    ottAccepted: ottAcceptance.OTT_ACCEPTED || [],
    ottAcceptedFacts: spendCatalogue.ottAcceptedFacts,
    fuelPartners: (spendCatalogue.advertisedFuelPartners?.() || []).map((p) => p.name),
  };
  const client = args.smoke ? smokeClient() : openAiClient(8000);
  const feesBlock = feeFacts.feeFacts({ withdrawLive });

  const model = args.model || (ai.AGENT_MODEL ? ai.AGENT_MODEL() : process.env.WAPAY_AGENT_MODEL || 'default');
  console.log(`Agent eval: ${cases.length} cases, model ${model}, concurrency ${args.concurrency}, withdraw ${withdrawLive ? 'live' : 'off'}${args.smoke ? ', SMOKE' : ''}\n`);

  const runOne = async (c, i) => {
    const account = buildSyntheticAccount(c.language);
    const pack = buildSyntheticPack({ language: c.language });
    const registryLines = capabilities.promptLines({ waId: SYNTHETIC.waId, account }).map((l) => l.replace(/^-\s*/, ''));
    const system = buildAgentSystemPrompt({
      registryLines, feesBlock, customerRecord: renderCustomerRecord(pack, { now: NOW }), focusKnowledge: null, language: c.language,
    });
    const toolDefs = buildToolDefinitions({ waId: SYNTHETIC.waId, account, pack });
    const executeTool = makeFakeExecuteTool({ pack, now: NOW, withdrawLive, deps });
    const messages = [...c.history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: c.text }];
    let r;
    try {
      r = await runAgentTurn({ system, messages, tools: toolDefs, executeTool: (name, a) => executeTool(name, a), client, model: args.model || undefined });
    } catch (e) {
      r = { outcome: 'error', error: e?.message || String(e), text: '', proposal: null, pendingIntent: null, toolCalls: [], timings: { totalMs: 0, modelMs: [] }, usage: { inputTokens: 0, outputTokens: 0 }, model };
    }
    const s = scoreCase(c, r);
    process.stdout.write(`${s.pass ? 'ok  ' : 'MISS'} [${i + 1}/${cases.length}] ${c.key} ${s.ms ?? '?'}ms ${s.got.outcome}/${s.got.action}\n`);
    return s;
  };

  const scored = await runAll(cases, runOne, args.concurrency);
  const summary = summarise(scored);
  console.log('');
  printTable(summary);

  const misses = scored.filter((s) => !s.pass);
  if (misses.length) {
    console.log(`\n--- ${misses.length} misses ---`);
    for (const s of misses) {
      const failed = Object.entries(s.checks).filter(([k, v]) => !v && k !== 'shape').map(([k]) => k);
      console.log(`[${s.key}] "${s.text}"\n  want ${s.want.outcome.join('|')} ${s.want.action || 'NONE'}${s.want.amountCents != null ? ` amount=${s.want.amountCents}` : ''}${s.want.msisdn ? ` msisdn=${s.want.msisdn}` : ''}\n  got  ${s.got.outcome} ${s.got.action}${s.got.amountCents != null ? ` amount=${s.got.amountCents}` : ''} tools=[${s.got.toolCalls.join(',')}] failed=[${failed.join(',')}]${s.error ? ` error=${s.error}` : ''}${s.got.text ? `\n  text: ${s.got.text.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
    }
  }

  let baselineReport = null;
  if (args.baseline) {
    let baseline = null;
    try { baseline = JSON.parse(readFileSync(path.resolve(args.baseline), 'utf8')); } catch (e) {
      console.error(`Cannot read baseline ${args.baseline}: ${e?.message || e}`);
      process.exit(2);
    }
    baselineReport = compareBaseline(summary, baseline);
    console.log(`\n--- baseline ${args.baseline} ---`);
    for (const l of baselineReport.lines) console.log(l);
    if (baselineReport.regressions.length) console.log(`REGRESSION: ${baselineReport.regressions.join('; ')}`);
    else console.log('No regression.');
  }

  const date = new Date().toISOString().slice(0, 10);
  const partial = args.limit != null || (args.langs && args.langs.length) ? '-partial' : '';
  const stem = `agent-eval-${date}${partial}${args.smoke ? '-smoke' : ''}`;
  if (!existsSync(args.out)) mkdirSync(args.out, { recursive: true });
  const jsonPath = path.join(args.out, `${stem}.json`);
  const mdPath = path.join(args.out, `${stem}.md`);
  const report = {
    date, model, smoke: args.smoke, withdrawLive, args: { limit: args.limit, langs: args.langs, concurrency: args.concurrency, baseline: args.baseline },
    regression: REGRESSION, summary, baseline: baselineReport, cases: scored,
  };
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, renderMarkdown({ date, model, summary, scored, args, withdrawLive, baselineReport, jsonName: path.basename(jsonPath) }));
  console.log(`\nWrote ${jsonPath}\n      ${mdPath}`);

  if (baselineReport && baselineReport.regressions.length) {
    console.error('Exit 1: regression against baseline.');
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e?.stack || e);
    process.exit(2);
  });
}
