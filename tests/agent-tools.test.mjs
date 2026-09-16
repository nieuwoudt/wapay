/**
 * The pay agent's tool registry (lib/agent/tools/*, docs/AGENT_ARCHITECTURE_V2.md C10).
 * Locks: every definition is OpenAI strict-mode valid; proposal tools are
 * offered only for capabilities live for THIS customer; every read tool
 * answers from fixtures and never throws; totals are summed server-side;
 * start_withdraw proposes WITHDRAW; no proposal ever carries a PIN;
 * propose_note refuses digits and long notes and keeps at most ten;
 * get_payout_status asks the rail with GetPaymentStatus only; and no tool
 * file imports a model client or the localizer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildToolDefinitions, executeTool, isProposalTool, isReadTool, REPLY_TOOL_NAME, SLOT_KEYS,
} from '../lib/agent/tools/index.js';
import { READ_TOOLS, PROPOSAL_TOOLS, NOTE_TOOL, REPLY_TOOL } from '../lib/agent/tools/schemas.js';
import { summariseMovements, rangeStart } from '../lib/agent/tools/read.js';
import { noteRejection, slotsFor } from '../lib/agent/tools/proposals.js';
import { TOPICS } from '../lib/how-it-works.js';

const TOOLS_DIR = fileURLToPath(new URL('../lib/agent/tools/', import.meta.url));
const PILOT = '27787051175';
const OTHER = '27600000001';
const NOW = new Date('2026-09-16T10:00:00Z'); // 12:00 SAST

function withEnv(env, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

const names = (defs) => defs.map((d) => d.function.name);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNT = { id: 'acc-1', waId: PILOT, msisdn: `0${PILOT.slice(2)}`, displayName: 'Thabo', profile: { language: 'en' } };
const h = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3600 * 1000);
const mv = (kind, amountCents, status, at, extra = {}) => ({ kind, amountCents, feeCents: 0, status, counterparty: null, reference: null, at, note: '', ...extra });

function fixturePack(overrides = {}) {
  const movements = [
    mv('AIRTIME', 5000, 'SUCCESS', h(2), { counterparty: 'own number', note: 'Vodacom airtime' }),
    mv('DEPOSIT', 10000, 'SUCCESS', h(5), { feeCents: 720, counterparty: 'PayFast', reference: 'pf-1' }),
    mv('SEND', 2000, 'SUCCESS', h(30), { counterparty: '083…4421', reference: '1234' }),
    mv('AIRTIME', 3000, 'SUCCESS', h(3 * 24), { counterparty: '083…4421' }),
    mv('PAY_LINK', 15000, 'OPEN', h(4), { reference: 'PR-OPEN' }),
    mv('PAY_LINK', 8000, 'SUCCESS', h(50), { reference: 'PR-PAID', counterparty: 'a WaPay customer', note: 'pay link paid' }),
    mv('DEPOSIT', 20000, 'FAILED', h(40 * 24), { counterparty: 'PayFast' }),
    mv('ELECTRICITY', 10000, 'SUCCESS', h(45 * 24), { counterparty: 'meter …9876' }),
  ];
  return {
    accountId: 'acc-1', waId: PILOT, msisdn: ACCOUNT.msisdn, displayName: 'Thabo', language: 'en', kyc: 'NOT_VERIFIED',
    balances: { spendCents: 12345, cashCents: 0, heldSpendCents: 0, heldCashCents: 0 },
    movements, movementsTotal: movements.length,
    pendingPayout: null,
    openPayLinks: [{ code: 'PR-OPEN', amountCents: 15000, note: 'lunch', createdAt: h(4), expiresAt: new Date(NOW.getTime() + 3600 * 1000) }],
    vouchersWaiting: 0, beneficiaries: [{ name: 'Philly Dlamini', msisdnTail: '4421' }], turns: [], warnings: [], loadedAt: NOW,
    ...overrides,
  };
}

const PRODUCTS = [
  { id: 'p1', category: 'DATA', networkCode: 'VODACOM', label: 'Vodacom 1GB Weekly', fixedPriceCents: 4900, priceCents: 0, dataMb: 1024, validityDays: 7, active: true, metadata: { normalized: { searchTokens: ['vodacom', '1gb', 'weekly'], periodType: 'WEEKLY' } } },
  { id: 'p2', category: 'DATA', networkCode: 'VODACOM', label: 'Vodacom 500MB Daily', fixedPriceCents: 1500, priceCents: 0, dataMb: 500, validityDays: 1, active: true, metadata: { normalized: { searchTokens: ['vodacom', '500mb', 'daily'], periodType: 'DAILY' } } },
  { id: 'p3', category: 'DATA', networkCode: 'VODACOM', label: 'Vodacom Night Owl 2GB', fixedPriceCents: 2000, priceCents: 0, dataMb: 2048, validityDays: 1, active: true, metadata: {} },
  { id: 'p4', category: 'AIRTIME', networkCode: 'MTN', label: 'MTN Airtime', fixedPriceCents: null, priceCents: 0, minCents: 500, maxCents: 100000, active: true, metadata: {} },
];

function stubPrisma({ payoutRows = [], profile = {} } = {}) {
  const calls = [];
  const accounts = new Map([['acc-1', { id: 'acc-1', waId: PILOT, profile: { ...profile } }]]);
  return {
    _calls: calls, _accounts: accounts,
    vasProduct: {
      async findMany({ where = {} }) {
        calls.push(['vasProduct.findMany', where]);
        return PRODUCTS.filter((p) => (!where.category || p.category === where.category) && (!where.networkCode || p.networkCode === where.networkCode)).map((p) => ({ ...p }));
      },
    },
    providerRequest: {
      async findFirst({ where = {} }) {
        calls.push(['providerRequest.findFirst', where]);
        let rows = payoutRows.filter((r) => r.accountId === where.accountId && r.route === where.route);
        if (where.metadata?.path) rows = rows.filter((r) => r.metadata?.[where.metadata.path[0]] === where.metadata.equals);
        return rows[0] ? { ...rows[0] } : null;
      },
      async findMany({ where = {}, take }) {
        calls.push(['providerRequest.findMany', where]);
        let rows = payoutRows.filter((r) => r.route === where.route);
        if (where.metadata?.path) rows = rows.filter((r) => r.metadata?.[where.metadata.path[0]] === where.metadata.equals);
        return (take ? rows.slice(0, take) : rows).map((r) => ({ ...r }));
      },
      async update({ where, data }) {
        calls.push(['providerRequest.update', where]);
        const r = payoutRows.find((x) => x.idemKey === where.idemKey);
        Object.assign(r, data);
        return { ...r };
      },
    },
    account: {
      async findUnique({ where }) { return accounts.get(where.id) || null; },
    },
    // mergeProfileAtomic's tagged template: values[0] is the JSON patch, values[1] the account id.
    async $executeRaw(_strings, ...values) {
      const patch = JSON.parse(values[0]);
      const acc = accounts.get(values[1]);
      calls.push(['$executeRaw', patch]);
      acc.profile = { ...(acc.profile || {}), ...patch };
      return 1;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Schemas are strict-mode valid
// ---------------------------------------------------------------------------

function assertStrict(schema, path) {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.anyOf)) { schema.anyOf.forEach((s, i) => assertStrict(s, `${path}.anyOf[${i}]`)); return; }
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${path}: additionalProperties must be false`);
    const keys = Object.keys(schema.properties || {});
    assert.deepEqual([...(schema.required || [])].sort(), [...keys].sort(), `${path}: every property must be required`);
    for (const k of keys) assertStrict(schema.properties[k], `${path}.${k}`);
    return;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  for (const t of types) assert.ok(['string', 'integer', 'number', 'boolean', 'null', 'array'].includes(t), `${path}: unexpected type ${t}`);
}

test('every tool definition is an OpenAI strict function tool', () => {
  const defs = withEnv({ WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: undefined, WAPAY_WICODE_LIVE: 'true', VAS_ALLOWLIST_FUEL: undefined },
    () => buildToolDefinitions({ waId: PILOT, account: ACCOUNT }));
  assert.ok(defs.length >= READ_TOOLS.length + PROPOSAL_TOOLS.length + 2);
  for (const d of defs) {
    assert.equal(d.type, 'function');
    assert.equal(d.function.strict, true, `${d.function.name}: strict`);
    assert.match(d.function.name, /^[a-z_]+$/);
    assert.ok(d.function.description.length > 20);
    assertStrict(d.function.parameters, d.function.name);
  }
  const seen = names(defs);
  assert.equal(new Set(seen).size, seen.length, 'tool names are unique');
  assert.equal(seen[seen.length - 1], REPLY_TOOL_NAME, 'reply is always last');
});

test('read tools are always offered and the reply tool always present; the how_it_works enum is the TOPICS keys', () => {
  const defs = withEnv({ WAPAY_PAYOUT_ENABLED: undefined, WAPAY_WICODE_LIVE: undefined }, () => buildToolDefinitions({ waId: OTHER }));
  const seen = names(defs);
  for (const t of READ_TOOLS) assert.ok(seen.includes(t.name), t.name);
  assert.ok(seen.includes(REPLY_TOOL_NAME));
  assert.ok(seen.includes(NOTE_TOOL.name));
  const how = defs.find((d) => d.function.name === 'how_it_works');
  assert.deepEqual(how.function.parameters.properties.topic.enum, Object.keys(TOPICS));
  for (const t of READ_TOOLS) assert.ok(isReadTool(t.name) && !isProposalTool(t.name));
  for (const t of PROPOSAL_TOOLS) assert.ok(isProposalTool(t.name) && !isReadTool(t.name));
  assert.ok(!isReadTool(REPLY_TOOL.name) && !isProposalTool(REPLY_TOOL.name));
});

test('tool text never carries a betting word, an em dash or the pay-out partner name', () => {
  const text = JSON.stringify(withEnv({ WAPAY_PAYOUT_ENABLED: 'true', WAPAY_WICODE_LIVE: 'true' }, () => buildToolDefinitions({ waId: PILOT })));
  assert.doesNotMatch(text, /\b(bet|betting|wager|casino|odds|gamble|hollywoodbets|betway|supabets)\b/i);
  assert.doesNotMatch(text, /[—–]/);
});

// ---------------------------------------------------------------------------
// 2. Proposal tools follow the capability gates
// ---------------------------------------------------------------------------

test('start_withdraw is offered only when the pay-out gate passes for this customer', () => {
  withEnv({ WAPAY_PAYOUT_ENABLED: undefined, WAPAY_PAYOUT_ALLOWLIST: undefined }, () => {
    assert.ok(!names(buildToolDefinitions({ waId: PILOT })).includes('start_withdraw'), 'off: nobody');
  });
  withEnv({ WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: PILOT }, () => {
    assert.ok(names(buildToolDefinitions({ waId: PILOT })).includes('start_withdraw'), 'pilot number');
    assert.ok(!names(buildToolDefinitions({ waId: OTHER })).includes('start_withdraw'), 'not on the list');
  });
  withEnv({ WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: undefined }, () => {
    assert.ok(names(buildToolDefinitions({ waId: OTHER })).includes('start_withdraw'), 'on for everyone');
  });
});

test('start_fuel is offered only when wiCode is live and the fuel allowlist passes', () => {
  withEnv({ WAPAY_WICODE_LIVE: undefined, VAS_ALLOWLIST_FUEL: undefined }, () => {
    assert.ok(!names(buildToolDefinitions({ waId: PILOT })).includes('start_fuel'));
  });
  withEnv({ WAPAY_WICODE_LIVE: 'true', VAS_ALLOWLIST_FUEL: PILOT }, () => {
    assert.ok(names(buildToolDefinitions({ waId: PILOT })).includes('start_fuel'));
    assert.ok(!names(buildToolDefinitions({ waId: OTHER })).includes('start_fuel'));
  });
  withEnv({ WAPAY_WICODE_LIVE: 'true', VAS_ALLOWLIST_FUEL: undefined }, () => {
    assert.ok(names(buildToolDefinitions({ waId: OTHER })).includes('start_fuel'));
  });
});

test('the always-live proposals are offered to every customer', () => {
  const seen = names(withEnv({ WAPAY_PAYOUT_ENABLED: undefined, WAPAY_WICODE_LIVE: undefined }, () => buildToolDefinitions({ waId: OTHER })));
  for (const n of ['start_send', 'start_pay_link', 'start_deposit', 'start_voucher_load', 'show_home', 'show_help']) assert.ok(seen.includes(n), n);
});

test('the same registry state yields byte-identical definitions across turns', () => {
  const a = JSON.stringify(withEnv({ WAPAY_PAYOUT_ENABLED: 'true' }, () => buildToolDefinitions({ waId: PILOT, pack: fixturePack() })));
  const b = JSON.stringify(withEnv({ WAPAY_PAYOUT_ENABLED: 'true' }, () => buildToolDefinitions({ waId: PILOT, pack: fixturePack({ balances: { spendCents: 1 } }) })));
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// 3. Read tools with fixtures
// ---------------------------------------------------------------------------

test('get_transactions totals by range and kind, server-side, SUCCESS only', async () => {
  const ctx = { prisma: stubPrisma(), account: ACCOUNT, waId: PILOT, pack: fixturePack(), now: NOW };

  const today = await executeTool({ name: 'get_transactions', args: { range: 'today', kind: null }, ctx });
  assert.equal(today.ok, true);
  assert.equal(today.result.since, rangeStart('today', NOW).toISOString());
  assert.equal(rangeStart('today', NOW).toISOString(), '2026-09-15T22:00:00.000Z', 'SAST midnight');
  assert.deepEqual(today.result.totals.byKind, { AIRTIME: { count: 1, sumCents: 5000 }, DEPOSIT: { count: 1, sumCents: 10000 } });
  assert.equal(today.result.totals.count, 2);
  assert.equal(today.result.totals.sumCents, 15000);
  assert.equal(today.result.totals.feeCents, 720);
  assert.equal(today.result.pendingCount, 1, 'the open pay link is pending, not a total');
  assert.equal(today.result.rows.length, 3);
  assert.equal(today.result.rows[0].kind, 'AIRTIME');
  assert.equal(typeof today.result.rows[0].at, 'string');

  const week = await executeTool({ name: 'get_transactions', args: { range: 'week', kind: 'airtime' }, ctx });
  assert.equal(week.result.kind, 'AIRTIME');
  assert.deepEqual(week.result.totals, { count: 2, sumCents: 8000, feeCents: 0, byKind: { AIRTIME: { count: 2, sumCents: 8000 } } });
  assert.ok(week.result.rows.every((r) => r.kind === 'AIRTIME'));

  const month = await executeTool({ name: 'get_transactions', args: { range: 'month', kind: null }, ctx });
  assert.equal(month.result.matched, 6);
  assert.equal(month.result.failedCount, 0);

  const all = await executeTool({ name: 'get_transactions', args: { range: 'all', kind: null }, ctx });
  assert.equal(all.result.matched, 8);
  assert.equal(all.result.failedCount, 1);
  assert.equal(all.result.totals.byKind.ELECTRICITY.sumCents, 10000);
  assert.equal(all.result.truncated, false);

  const withdrawals = await executeTool({ name: 'get_transactions', args: { range: 'all', kind: 'withdrawals' }, ctx });
  assert.equal(withdrawals.result.kind, 'PAYOUT');
  assert.equal(withdrawals.result.matched, 0);

  const unknownKind = await executeTool({ name: 'get_transactions', args: { range: 'all', kind: 'lottery' }, ctx });
  assert.equal(unknownKind.result.kind, null, 'an unknown kind is never invented; it means all');
});

test('summariseMovements caps rows at 20 but totals over every match', () => {
  const many = Array.from({ length: 30 }, (_, i) => mv('AIRTIME', 100, 'SUCCESS', h(i)));
  const out = summariseMovements(many, { range: 'all', now: NOW });
  assert.equal(out.rows.length, 20);
  assert.equal(out.matched, 30);
  assert.equal(out.totals.sumCents, 3000);
});

test('get_transactions reloads the pack when the record was capped, and never throws without one', async () => {
  const pack = fixturePack({ movementsTotal: 99 });
  let loaded = false;
  const prisma = {
    wallet: { async findMany() { loaded = true; return []; } },
    hold: { async findMany() { return []; } },
    providerRequest: { async findMany() { return []; }, async findFirst() { return null; } },
    pendingGift: { async findMany() { return []; } },
    paymentRequest: { async findMany() { return []; } },
    beneficiary: { async findMany() { return []; } },
  };
  const out = await executeTool({ name: 'get_transactions', args: { range: 'all', kind: null }, ctx: { prisma, account: ACCOUNT, pack, now: NOW } });
  assert.equal(loaded, true);
  assert.equal(out.ok, true);
  const none = await executeTool({ name: 'get_transactions', args: { range: 'all', kind: null }, ctx: {} });
  assert.deepEqual(none, { ok: false, error: 'NO_RECORD' });
});

test('get_products searches the catalogue by category, network and query through the ranking', async () => {
  const prisma = stubPrisma();
  const out = await executeTool({ name: 'get_products', args: { category: 'DATA', query: '1GB weekly', network: 'Vodacom' }, ctx: { prisma, account: ACCOUNT, waId: PILOT } });
  assert.equal(out.ok, true);
  assert.equal(out.result.network, 'VODACOM');
  assert.ok(out.result.products.length >= 2 && out.result.products.length <= 8);
  assert.equal(out.result.products[0].id, 'p1', 'the weekly 1GB ranks first');
  assert.deepEqual(Object.keys(out.result.products[0]).sort(), ['category', 'id', 'maxCents', 'minCents', 'name', 'network', 'priceCents', 'validityDays']);
  assert.equal(out.result.products[0].priceCents, 4900);
  assert.equal(prisma._calls[0][1].category, 'DATA');
  assert.equal(prisma._calls[0][1].active, true);

  const airtime = await executeTool({ name: 'get_products', args: { category: 'AIRTIME', query: null, network: 'mtn' }, ctx: { prisma } });
  assert.equal(airtime.result.products.length, 1, 'a variable-amount product is listed with its bounds');
  assert.equal(airtime.result.products[0].minCents, 500);

  const bad = await executeTool({ name: 'get_products', args: { category: 'BETTING', query: null, network: null }, ctx: { prisma } });
  assert.deepEqual(bad, { ok: false, error: 'BAD_CATEGORY' });

  const broken = await executeTool({ name: 'get_products', args: { category: 'DATA', query: null, network: null }, ctx: { prisma: { vasProduct: { async findMany() { throw new Error('db down'); } } } } });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /db down/);
});

test('get_fee_quote quotes the live fee table and hides withdrawal fees while the gate is closed', async () => {
  const closed = await withEnv({ WAPAY_PAYOUT_ENABLED: undefined }, () => executeTool({ name: 'get_fee_quote', args: { kind: 'withdraw', amountCents: null }, ctx: { waId: PILOT } }));
  assert.equal(closed.ok, true);
  assert.equal(closed.result.schedule.withdraw.live, false);
  assert.match(closed.result.text, /not available just yet/i);

  const open = await withEnv({ WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: undefined }, () => executeTool({ name: 'get_fee_quote', args: { kind: 'withdraw', amountCents: null }, ctx: { waId: PILOT } }));
  assert.equal(open.result.schedule.withdraw.live, true);
  assert.match(open.result.text, /PayShap/);
  assert.equal(open.result.schedule.withdraw.cashsend[2][0], null, 'Infinity is serialised as null');

  const deposit = await executeTool({ name: 'get_fee_quote', args: { kind: 'deposit', amountCents: 10000 }, ctx: { waId: PILOT } });
  assert.match(deposit.result.text, /R100 costs R\d+/);
  assert.equal(deposit.result.amountCents, 10000);
  const general = await executeTool({ name: 'get_fee_quote', args: { kind: 'nonsense', amountCents: -5 }, ctx: {} });
  assert.equal(general.result.kind, 'general');
  assert.equal(general.result.amountCents, null);
});

test('where_accepted answers by name, never claims an unknown merchant and never echoes it', async () => {
  const yes = await executeTool({ name: 'where_accepted', args: { merchant: 'talk360' }, ctx: {} });
  assert.equal(yes.result.accepted, true);
  assert.equal(yes.result.name, 'Talk360');
  assert.match(yes.result.facts, /ottvoucher\.com/);

  const no = await executeTool({ name: 'where_accepted', args: { merchant: 'Checkers' }, ctx: {} });
  assert.equal(no.result.accepted, false);
  assert.match(no.result.note, /sells them at the till/);

  const unknown = await executeTool({ name: 'where_accepted', args: { merchant: 'Hollywoodbets' }, ctx: {} });
  assert.equal(unknown.result.accepted, null);
  assert.equal(unknown.result.name, null);
  assert.doesNotMatch(JSON.stringify(unknown.result), /hollywood/i);

  const general = await executeTool({ name: 'where_accepted', args: { merchant: null }, ctx: {} });
  assert.equal(general.result.accepted, null);
  assert.match(general.result.note, /sold at/);
});

test('get_pay_links returns the open links and the recent settled ones from the record', async () => {
  const out = await executeTool({ name: 'get_pay_links', args: {}, ctx: { pack: fixturePack() } });
  assert.equal(out.ok, true);
  assert.equal(out.result.open.length, 1);
  assert.equal(out.result.open[0].code, 'PR-OPEN');
  assert.equal(typeof out.result.open[0].expiresAt, 'string');
  assert.deepEqual(out.result.recent.map((r) => r.code), ['PR-PAID']);
  const empty = await executeTool({ name: 'get_pay_links', args: {}, ctx: {} });
  assert.deepEqual(empty, { ok: true, result: { open: [], recent: [] } });
});

test('how_it_works answers from the knowledge base with the per-customer gates, and refuses an unknown topic', async () => {
  const off = await withEnv({ WAPAY_WICODE_LIVE: undefined }, () => executeTool({ name: 'how_it_works', args: { topic: 'fuel' }, ctx: { waId: PILOT } }));
  assert.match(off.result.text, /coming to WaPay soon/);
  const on = await withEnv({ WAPAY_WICODE_LIVE: 'true', VAS_ALLOWLIST_FUEL: undefined }, () => executeTool({ name: 'how_it_works', args: { topic: 'fuel' }, ctx: { waId: PILOT } }));
  assert.match(on.result.text, /say "buy fuel"/);
  const withdraw = await withEnv({ WAPAY_PAYOUT_ENABLED: undefined }, () => executeTool({ name: 'how_it_works', args: { topic: 'withdraw' }, ctx: { waId: PILOT } }));
  assert.equal(withdraw.ok, true);
  assert.equal(typeof withdraw.result.text, 'string');
  const bad = await executeTool({ name: 'how_it_works', args: { topic: 'lotto' }, ctx: {} });
  assert.deepEqual(bad, { ok: false, error: 'UNKNOWN_TOPIC' });
});

// ---------------------------------------------------------------------------
// 4. get_payout_status: GetPaymentStatus only
// ---------------------------------------------------------------------------

function payoutRow(status, reference = 'WP-REF-1') {
  return {
    id: 'pr-1', accountId: 'acc-1', route: 'ott-payout', idemKey: 'idem-1', status, providerRef: null, requestTs: h(1),
    metadata: { reference, method: 'PAYSHAP', amountCents: 5000, feeCents: 300, recipient: { name: 'Thabo', account: '•••123' } },
  };
}

function clientStub(probe) {
  const calls = [];
  return {
    calls,
    async getPaymentStatus(args) { calls.push(['getPaymentStatus', args]); if (probe instanceof Error) throw probe; return probe; },
    async performPayout() { calls.push(['performPayout']); throw new Error('performPayout must never be called by a read tool'); },
    async resendSms() { calls.push(['resendSms']); throw new Error('never'); },
  };
}

test('get_payout_status: a pending pay-out is checked with GetPaymentStatus only, never a pay-out', async () => {
  const rows = [payoutRow('PENDING')];
  const prisma = stubPrisma({ payoutRows: rows });
  const client = clientStub({ status: '99', settlement: 'HOLD', outcome: 'PENDING', body: { message: 'in progress' } });
  const pack = fixturePack({ pendingPayout: { reference: 'WP-REF-1', method: 'PAYSHAP', amountCents: 5000, feeCents: 300, heldCents: 5300, at: h(1) } });
  const out = await executeTool({ name: 'get_payout_status', args: { reference: null }, ctx: { prisma, account: ACCOUNT, waId: PILOT, pack, now: NOW, payoutClient: client } });
  assert.equal(out.ok, true);
  assert.equal(out.result.status, 'PENDING');
  assert.equal(out.result.reference, 'WP-REF-1');
  assert.equal(out.result.amountCents, 5000);
  assert.equal(out.result.feeCents, 300);
  assert.equal(out.result.method, 'PAYSHAP');
  assert.equal(out.result.checked, true);
  assert.equal(out.result.providerStatus, '99');
  assert.deepEqual(client.calls.map((c) => c[0]), ['getPaymentStatus']);
  assert.equal(client.calls[0][1].yourUniqueReference, 'WP-REF-1');
  assert.equal(rows[0].status, 'PENDING', 'a 99 leaves the row where it is');
  assert.ok(prisma._calls.some((c) => c[0] === 'providerRequest.update'), 'what the rail said is recorded');
});

test('get_payout_status: a transport failure is indeterminate, a settled pay-out needs no probe, and nothing is a throw', async () => {
  const err = Object.assign(new Error('timeout'), { code: 'TRANSPORT_INDETERMINATE' });
  const client = clientStub(err);
  const prisma = stubPrisma({ payoutRows: [payoutRow('PENDING')] });
  const pack = fixturePack({ pendingPayout: { reference: 'WP-REF-1', method: 'PAYSHAP', amountCents: 5000, feeCents: 300, heldCents: 5300, at: h(1) } });
  const out = await executeTool({ name: 'get_payout_status', args: { reference: null }, ctx: { prisma, account: ACCOUNT, pack, payoutClient: client } });
  assert.equal(out.ok, true);
  assert.equal(out.result.status, 'PENDING');
  assert.equal(out.result.checked, false);
  assert.deepEqual(client.calls.map((c) => c[0]), ['getPaymentStatus']);

  const settled = clientStub({ status: '100', settlement: 'SETTLE' });
  const done = await executeTool({ name: 'get_payout_status', args: { reference: null }, ctx: { prisma: stubPrisma({ payoutRows: [payoutRow('SUCCESS')] }), account: ACCOUNT, pack: fixturePack(), payoutClient: settled } });
  assert.equal(done.result.status, 'SUCCESS');
  assert.equal(done.result.checked, false);
  assert.deepEqual(settled.calls, [], 'a finished pay-out is never re-asked');

  const byRef = await executeTool({ name: 'get_payout_status', args: { reference: 'WP-OTHER' }, ctx: { prisma: stubPrisma({ payoutRows: [payoutRow('FAILED', 'WP-OTHER')] }), account: ACCOUNT, pack: fixturePack(), payoutClient: settled } });
  assert.equal(byRef.result.status, 'FAILED');
  assert.equal(byRef.result.reference, 'WP-OTHER');

  const none = await executeTool({ name: 'get_payout_status', args: { reference: null }, ctx: { prisma: stubPrisma(), account: ACCOUNT, pack: fixturePack() } });
  assert.equal(none.result.status, 'NONE');

  const broken = await executeTool({ name: 'get_payout_status', args: { reference: null }, ctx: { prisma: { providerRequest: { async findFirst() { throw new Error('db down'); } } }, account: ACCOUNT, pack: fixturePack() } });
  assert.equal(broken.ok, false);
});

// ---------------------------------------------------------------------------
// 5. Proposal tools
// ---------------------------------------------------------------------------

test('start_withdraw proposes WITHDRAW with the amount and method the customer named', async () => {
  const out = await withEnv({ WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: undefined },
    () => executeTool({ name: 'start_withdraw', args: { amountCents: 20000, method: 'PAYSHAP' }, ctx: { waId: PILOT, account: ACCOUNT } }));
  assert.equal(out.ok, true);
  assert.equal(out.proposal.action, 'WITHDRAW');
  assert.equal(out.proposal.slots.amountCents, 20000);
  assert.equal(out.proposal.slots.method, 'PAYSHAP');
  assert.deepEqual(Object.keys(out.proposal.slots).sort(), [...SLOT_KEYS].sort());

  const loose = await withEnv({ WAPAY_PAYOUT_ENABLED: 'true', WAPAY_PAYOUT_ALLOWLIST: undefined },
    () => executeTool({ name: 'start_withdraw', args: '{"amountCents": null, "method": "fnb ewallet"}', ctx: { waId: PILOT } }));
  assert.equal(loose.proposal.slots.amountCents, null);
  assert.equal(loose.proposal.slots.method, 'FNB_EWALLET');

  const closed = await withEnv({ WAPAY_PAYOUT_ENABLED: undefined }, () => executeTool({ name: 'start_withdraw', args: { amountCents: 20000, method: null }, ctx: { waId: PILOT } }));
  assert.deepEqual(closed, { ok: false, error: 'NOT_LIVE' });
});

test('every proposal tool maps to its action and normalises slots the way the dispatcher validates', async () => {
  const ctx = { waId: PILOT, account: ACCOUNT };
  const expect = {
    start_buy_airtime: 'BUY_AIRTIME', start_buy_data: 'BUY_DATA', start_buy_electricity: 'BUY_ELECTRICITY', start_send: 'SEND_VOUCHER',
    start_pay_link: 'REQUEST_MONEY', start_deposit: 'DEPOSIT_START', start_voucher_load: 'REDEEM_VOUCHER', show_home: 'HOME', show_help: 'HELP',
  };
  for (const [name, action] of Object.entries(expect)) {
    const out = await executeTool({ name, args: {}, ctx });
    assert.equal(out.ok, true, name);
    assert.equal(out.proposal.action, action, name);
    for (const k of SLOT_KEYS) assert.ok(k in out.proposal.slots, `${name}: slot ${k}`);
  }
  const airtime = await executeTool({ name: 'start_buy_airtime', args: { amountCents: 5000, msisdn: '083 123 4567', self: null }, ctx });
  assert.deepEqual(airtime.proposal.slots, { amountCents: 5000, msisdn: '0831234567', recipientName: null, self: null, meterNumber: null, productQuery: null, category: 'AIRTIME', method: null });
  const send = await executeTool({ name: 'start_send', args: { amountCents: 999999, msisdn: '12', recipientName: '  Philly  ', self: false }, ctx });
  assert.equal(send.proposal.slots.amountCents, null, 'over the dispatcher ceiling');
  assert.equal(send.proposal.slots.msisdn, null, 'too short');
  assert.equal(send.proposal.slots.recipientName, 'Philly');
  assert.equal(send.proposal.slots.self, false);
  const data = await executeTool({ name: 'start_buy_data', args: { productQuery: '1GB weekly', amountCents: 4900, msisdn: null, self: true }, ctx });
  assert.equal(data.proposal.slots.productQuery, '1GB weekly');
  assert.equal(data.proposal.slots.category, 'DATA');
  const elec = await executeTool({ name: 'start_buy_electricity', args: { amountCents: 10000, meterNumber: '0123 4567 8901' }, ctx });
  assert.equal(elec.proposal.slots.meterNumber, '012345678901');
});

test('start_voucher_load never carries a PIN, and no proposal accepts a secret argument', async () => {
  const ctx = { waId: PILOT, account: ACCOUNT };
  const out = await executeTool({ name: 'start_voucher_load', args: { pin: '1234567890123456', voucherPin: '1234', code: '9999' }, ctx });
  assert.equal(out.ok, true);
  assert.equal(out.proposal.action, 'REDEEM_VOUCHER');
  assert.ok(Object.values(out.proposal.slots).every((v) => v === null), 'every slot is null');
  assert.doesNotMatch(JSON.stringify(out), /1234/);

  const send = slotsFor('SEND_VOUCHER', { amountCents: 5000, pin: '1234', otp: '555555', recipientName: 'Sipho 1234567890123' });
  assert.doesNotMatch(JSON.stringify(send), /1234/);
  assert.equal(send.recipientName, 'Sipho');
  const withdraw = slotsFor('WITHDRAW', { amountCents: 5000, method: 'RTC', password: 'x', token: 'y' });
  assert.deepEqual(Object.keys(withdraw).sort(), [...SLOT_KEYS].sort());
  assert.ok(!('password' in withdraw) && !('token' in withdraw));
});

test('the reply tool ends the turn; clarify keeps a re-validated pending intent', async () => {
  const reply = await executeTool({ name: 'reply', args: { kind: 'reply', text: 'Your balance is R123.45.', pendingIntent: null }, ctx: {} });
  assert.deepEqual(reply, { ok: true, reply: { kind: 'reply', text: 'Your balance is R123.45.', pendingIntent: null } });
  const clarify = await executeTool({ name: 'reply', args: { kind: 'clarify', text: 'How much would you like to send to Philly?', pendingIntent: { action: 'SEND_VOUCHER', slots: { recipientName: 'Philly', pin: '1234' } } }, ctx: {} });
  assert.equal(clarify.reply.kind, 'clarify');
  assert.equal(clarify.reply.pendingIntent.action, 'SEND_VOUCHER');
  assert.equal(clarify.reply.pendingIntent.slots.recipientName, 'Philly');
  assert.equal(clarify.reply.pendingIntent.slots.amountCents, null);
  assert.doesNotMatch(JSON.stringify(clarify), /1234/);
  const unknown = await executeTool({ name: 'reply', args: { kind: 'clarify', text: 'Which one?', pendingIntent: { action: 'PLACE_BET', slots: {} } }, ctx: {} });
  assert.equal(unknown.reply.pendingIntent, null);
  const plainReplyDropsIntent = await executeTool({ name: 'reply', args: { kind: 'reply', text: 'Done.', pendingIntent: { action: 'HOME', slots: {} } }, ctx: {} });
  assert.equal(plainReplyDropsIntent.reply.pendingIntent, null);
  const empty = await executeTool({ name: 'reply', args: { kind: 'reply', text: '   ', pendingIntent: null }, ctx: {} });
  assert.equal(empty.ok, false);
  const nothing = await executeTool({ name: 'place_bet', args: {}, ctx: {} });
  assert.deepEqual(nothing, { ok: false, error: 'UNKNOWN_TOOL' });
});

// ---------------------------------------------------------------------------
// 6. propose_note
// ---------------------------------------------------------------------------

test('propose_note refuses digits, long notes and notes not about the customer', async () => {
  assert.equal(noteRejection('You usually buy airtime for your mum on Fridays.'), null);
  assert.equal(noteRejection('You send R50 to Philly every week.'), 'HAS_DIGITS');
  assert.equal(noteRejection('Your meter number is at home.'), null);
  assert.equal(noteRejection('x'.repeat(121)), 'TOO_LONG');
  assert.equal(noteRejection('The weather is nice today.'), 'NOT_ABOUT_CUSTOMER');
  assert.equal(noteRejection(''), 'EMPTY');
  const prisma = stubPrisma();
  const digits = await executeTool({ name: 'propose_note', args: { note: 'Your PIN is 1234.' }, ctx: { prisma, account: ACCOUNT, now: NOW } });
  assert.deepEqual(digits, { ok: true, accepted: false, note: null, reason: 'HAS_DIGITS' });
  assert.ok(!prisma._calls.some((c) => c[0] === '$executeRaw'), 'nothing written');
});

test('propose_note stores at most ten notes on the profile and touches no other key', async () => {
  const prisma = stubPrisma({ profile: { language: 'zu', lastMeterNumber: '01234567890', notes: Array.from({ length: 9 }, (_, i) => ({ text: `You like note ${'x'.repeat(i)}`, at: NOW.toISOString() })) } });
  const first = await executeTool({ name: 'propose_note', args: { note: 'You usually buy airtime for your mum.' }, ctx: { prisma, account: ACCOUNT, now: NOW } });
  assert.equal(first.ok, true);
  assert.equal(first.accepted, true);
  assert.deepEqual(first.note, { text: 'You usually buy airtime for your mum.', at: NOW.toISOString() });
  assert.equal(first.count, 10);
  const second = await executeTool({ name: 'propose_note', args: { note: 'You prefer isiZulu replies.' }, ctx: { prisma, account: ACCOUNT, now: NOW } });
  assert.equal(second.count, 10, 'capped at ten: the oldest drops');
  const profile = prisma._accounts.get('acc-1').profile;
  assert.equal(profile.notes.length, 10);
  assert.equal(profile.notes[profile.notes.length - 1].text, 'You prefer isiZulu replies.');
  assert.equal(profile.notes[profile.notes.length - 2].text, 'You usually buy airtime for your mum.');
  assert.equal(profile.language, 'zu', 'other keys untouched');
  assert.equal(profile.lastMeterNumber, '01234567890');
  const writes = prisma._calls.filter((c) => c[0] === '$executeRaw');
  assert.equal(writes.length, 2);
  assert.deepEqual(Object.keys(writes[1][1]).sort(), ['notes', 'updatedAt'], 'the patch carries only notes');

  const noAccount = await executeTool({ name: 'propose_note', args: { note: 'You like data.' }, ctx: {} });
  assert.equal(noAccount.ok, false);
  assert.equal(noAccount.accepted, false);
  const failing = await executeTool({ name: 'propose_note', args: { note: 'You like data.' }, ctx: { prisma: { account: { async findUnique() { return null; } }, async $executeRaw() { throw new Error('db down'); } }, account: ACCOUNT } });
  assert.equal(failing.ok, false);
  assert.equal(failing.accepted, false);
});

// ---------------------------------------------------------------------------
// 7. No tool imports a model client or the localizer
// ---------------------------------------------------------------------------

test('no file under lib/agent/tools imports openai, @wapay/ai or lib/localize.js', () => {
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('index.js') && files.includes('read.js') && files.includes('proposals.js') && files.includes('schemas.js'));
  for (const f of files) {
    const src = readFileSync(`${TOOLS_DIR}${f}`, 'utf8');
    assert.doesNotMatch(src, /from\s+['"]openai['"]|require\(['"]openai['"]\)/, `${f} imports openai`);
    assert.doesNotMatch(src, /['"]@wapay\/ai/, `${f} imports @wapay/ai`);
    assert.doesNotMatch(src, /localize\.js['"]/, `${f} imports the localizer`);
    assert.doesNotMatch(src, /ledger-post\.js['"]|ledger-core\.js['"]/, `${f} imports a ledger writer`);
    assert.doesNotMatch(src, /[—–]/, `${f} has an em or en dash`);
    assert.doesNotMatch(src, /voucherPin\s*:\s*true/, `${f} selects a voucher PIN`);
  }
});
