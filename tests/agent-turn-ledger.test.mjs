import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  recordAgentTurn,
  agentTurnsInLastHour,
  maskWaId,
  maskString,
  prepareJson,
} from '../lib/agent/turn-ledger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makePrisma({ failCreate = false, failCount = false, count = 0 } = {}) {
  const calls = { create: [], count: [] };
  return {
    calls,
    agentTurn: {
      async create(args) {
        calls.create.push(args);
        if (failCreate) throw new Error('db down');
        return { id: `turn_${calls.create.length}` };
      },
      async count(args) {
        calls.count.push(args);
        if (failCount) throw new Error('db down');
        return count;
      },
    },
  };
}

const baseRow = {
  accountId: 'acc_1',
  waId: '27831234567',
  path: 'agent',
  outcome: 'proposal',
  promptHash: 'sha256:abc',
  model: 'gpt-4.1-mini',
  toolCalls: [{ name: 'get_fee_quote', ms: 41, ok: true }],
  proposal: { action: 'SEND_VOUCHER', slots: { amountCents: 5000, msisdn: '0834567890' } },
  policyDecision: 'allow',
  gatesFired: ['dash_rewrite'],
  ms: 2310,
  inputTokens: 1820,
  outputTokens: 96,
  error: null,
};

// ---------------------------------------------------------------------------
// Insert shape
// ---------------------------------------------------------------------------

test('recordAgentTurn: inserts the contract shape with a masked waId', async () => {
  const prisma = makePrisma();
  const res = await recordAgentTurn({ prisma, row: baseRow });
  assert.deepEqual(res, { ok: true, id: 'turn_1' });
  assert.equal(prisma.calls.create.length, 1);
  const { data, select } = prisma.calls.create[0];
  assert.deepEqual(select, { id: true });
  assert.deepEqual(Object.keys(data).sort(), [
    'accountId', 'error', 'gatesFired', 'inputTokens', 'model', 'ms', 'outcome', 'outputTokens',
    'path', 'policyDecision', 'promptHash', 'proposal', 'toolCalls', 'waId',
  ]);
  assert.equal(data.accountId, 'acc_1');
  assert.equal(data.waId, '…4567');
  assert.equal(data.path, 'agent');
  assert.equal(data.outcome, 'proposal');
  assert.equal(data.promptHash, 'sha256:abc');
  assert.equal(data.model, 'gpt-4.1-mini');
  assert.deepEqual(data.toolCalls, [{ name: 'get_fee_quote', ms: 41, ok: true }]);
  assert.equal(data.policyDecision, 'allow');
  assert.deepEqual(data.gatesFired, ['dash_rewrite']);
  assert.equal(data.ms, 2310);
  assert.equal(data.inputTokens, 1820);
  assert.equal(data.outputTokens, 96);
  assert.equal(data.error, null);
});

test('recordAgentTurn: optional fields land as null / undefined, numbers are coerced to integers', async () => {
  const prisma = makePrisma();
  await recordAgentTurn({ prisma, row: { accountId: 'acc_1', path: 'guard', outcome: 'reply', ms: 12.7, inputTokens: 'x' } });
  const { data } = prisma.calls.create[0];
  assert.equal(data.waId, null);
  assert.equal(data.promptHash, null);
  assert.equal(data.model, null);
  assert.equal(data.toolCalls, undefined);
  assert.equal(data.proposal, undefined);
  assert.equal(data.gatesFired, undefined);
  assert.equal(data.ms, 12);
  assert.equal(data.inputTokens, null);
  assert.equal(data.outputTokens, null);
  assert.equal(data.error, null);
});

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

test('maskWaId keeps the last 4 digits only', () => {
  assert.equal(maskWaId('27831234567'), '…4567');
  assert.equal(maskWaId('+27 83 123 4567'), '…4567');
  assert.equal(maskWaId('0831234567'), '…4567');
  assert.equal(maskWaId('12'), null);
  assert.equal(maskWaId(null), null);
  assert.equal(maskWaId(undefined), null);
});

test('recordAgentTurn: masks msisdn runs inside proposal and toolCalls (keys and nested strings too)', async () => {
  const prisma = makePrisma();
  await recordAgentTurn({
    prisma,
    row: {
      ...baseRow,
      proposal: { action: 'SEND_VOUCHER', slots: { amountCents: 5000, msisdn: '0834567890', recipientName: 'Thabo' } },
      toolCalls: [
        { name: 'get_transactions', ok: true, args: { note: 'sent to 27834567890 and +27 83 456 7890' } },
        { name: 'start_send', ok: true, result: { rows: [{ counterparty: '0834567890' }], '0831112222': 'keyed' } },
      ],
      error: 'timeout talking to 27830001111',
    },
  });
  const { data } = prisma.calls.create[0];
  assert.deepEqual(data.proposal, { action: 'SEND_VOUCHER', slots: { amountCents: 5000, msisdn: '…7890', recipientName: 'Thabo' } });
  assert.equal(data.toolCalls[0].args.note, 'sent to …7890 and +27 83 456 7890');
  assert.equal(data.toolCalls[1].result.rows[0].counterparty, '…7890');
  assert.deepEqual(Object.keys(data.toolCalls[1].result), ['rows', '…2222']);
  assert.equal(data.error, 'timeout talking to …1111');
  const flat = JSON.stringify(data);
  assert.doesNotMatch(flat, /\d{10,}/, 'no 10+ digit run survives');
});

test('maskString: bearer digits never reach storage (PINs, tokens, IDs) and amounts survive', () => {
  assert.doesNotMatch(maskString('pin 1234567890123456'), /\d{5,}/);
  assert.doesNotMatch(maskString('token 1234-5678-9012-3456-7890'), /\d{5,}/);
  assert.doesNotMatch(maskString('id 9001015009087'), /\d{5,}/);
  assert.equal(maskString('R50 airtime for 0834567890'), 'R50 airtime for …7890');
  assert.equal(maskString('amountCents 5000'), 'amountCents 5000');
});

// ---------------------------------------------------------------------------
// Cap
// ---------------------------------------------------------------------------

test('recordAgentTurn: caps JSON payloads at 8,000 chars and keeps a labelled head', async () => {
  const prisma = makePrisma();
  const big = { rows: Array.from({ length: 600 }, (_, i) => ({ i, reference: `ref_${i}`, text: 'x'.repeat(20) })) };
  assert.ok(JSON.stringify(big).length > 8000);
  await recordAgentTurn({ prisma, row: { ...baseRow, toolCalls: big, proposal: { small: true } } });
  const { data } = prisma.calls.create[0];
  assert.equal(data.toolCalls.truncated, true);
  assert.equal(data.toolCalls.chars, JSON.stringify(big).length);
  assert.ok(JSON.stringify(data.toolCalls).length <= 8000, 'stored form stays under the cap');
  assert.ok(data.toolCalls.head.startsWith('{"rows":[{"i":0'));
  assert.deepEqual(data.proposal, { small: true }, 'a small payload is stored as-is');
});

test('prepareJson: nothing in, nothing out; small payloads pass through masked', () => {
  assert.equal(prepareJson(undefined), undefined);
  assert.equal(prepareJson(null), undefined);
  assert.deepEqual(prepareJson({ a: 1 }), { a: 1 });
  assert.deepEqual(prepareJson({ msisdn: '27831234567' }), { msisdn: '…4567' });
});

// ---------------------------------------------------------------------------
// Never throws
// ---------------------------------------------------------------------------

test('recordAgentTurn: never throws (db down, missing prisma, missing required fields, garbage)', async () => {
  const prisma = makePrisma({ failCreate: true });
  assert.deepEqual(await recordAgentTurn({ prisma, row: baseRow }), { ok: false });
  assert.deepEqual(await recordAgentTurn({ prisma: null, row: baseRow }), { ok: false });
  assert.deepEqual(await recordAgentTurn({ prisma: {}, row: baseRow }), { ok: false });
  assert.deepEqual(await recordAgentTurn({ prisma: makePrisma(), row: { accountId: 'acc_1' } }), { ok: false });
  assert.deepEqual(await recordAgentTurn({ prisma: makePrisma(), row: 'nope' }), { ok: false });
  assert.deepEqual(await recordAgentTurn({ prisma: makePrisma() }), { ok: false });
  assert.deepEqual(await recordAgentTurn(), { ok: false });
  const circular = { a: 1 };
  circular.self = circular;
  const prisma2 = makePrisma();
  const ok = await recordAgentTurn({ prisma: prisma2, row: { ...baseRow, toolCalls: circular } });
  assert.equal(ok.ok, true, 'a circular payload is bounded by the depth guard, not thrown');
  assert.ok(JSON.stringify(prisma2.calls.create[0].data.toolCalls).length <= 8000);
});

// ---------------------------------------------------------------------------
// Hour count
// ---------------------------------------------------------------------------

test('agentTurnsInLastHour: counts rows for the account since now-1h', async () => {
  const prisma = makePrisma({ count: 7 });
  const now = new Date('2026-09-16T10:00:00Z').getTime();
  assert.equal(await agentTurnsInLastHour({ prisma, accountId: 'acc_1', now }), 7);
  assert.equal(prisma.calls.count.length, 1);
  const { where } = prisma.calls.count[0];
  assert.equal(where.accountId, 'acc_1');
  assert.equal(where.createdAt.gte.toISOString(), '2026-09-16T09:00:00.000Z');
});

test('agentTurnsInLastHour: 0 on error, missing prisma or missing account', async () => {
  assert.equal(await agentTurnsInLastHour({ prisma: makePrisma({ failCount: true }), accountId: 'acc_1' }), 0);
  assert.equal(await agentTurnsInLastHour({ prisma: null, accountId: 'acc_1' }), 0);
  assert.equal(await agentTurnsInLastHour({ prisma: makePrisma({ count: 3 }) }), 0);
  assert.equal(await agentTurnsInLastHour(), 0);
});

// ---------------------------------------------------------------------------
// Schema + migration
// ---------------------------------------------------------------------------

test('schema.prisma has the AgentTurn model mapped to agent_turns with the (accountId, createdAt) index', () => {
  const schema = readFileSync(path.join(ROOT, 'packages/domain/prisma/schema.prisma'), 'utf8');
  const m = schema.match(/model AgentTurn \{([\s\S]*?)\n\}/);
  assert.ok(m, 'model AgentTurn present');
  const body = m[1];
  assert.match(body, /@@map\("agent_turns"\)/);
  assert.match(body, /@@index\(\[accountId, createdAt\]\)/);
  for (const field of [
    'accountId', 'waId', 'path', 'outcome', 'promptHash', 'model', 'toolCalls', 'proposal',
    'policyDecision', 'gatesFired', 'ms', 'inputTokens', 'outputTokens', 'error', 'createdAt',
  ]) {
    assert.match(body, new RegExp(`^\\s+${field}\\s`, 'm'), `field ${field}`);
  }
  assert.match(body, /toolCalls\s+Json\?/);
  assert.match(body, /proposal\s+Json\?/);
  assert.match(body, /gatesFired\s+Json\?/);
  assert.match(body, /createdAt\s+DateTime\s+@default\(now\(\)\)/);
  assert.equal((schema.match(/model AgentTurn \{/g) || []).length, 1, 'exactly one model');
});

test('migration SQL is idempotent and creates the table plus the index', () => {
  const sql = readFileSync(path.join(ROOT, 'packages/domain/prisma/migrations/20260916_agent_turns/migration.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "agent_turns"/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "agent_turns_accountId_createdAt_idx"\s+ON "agent_turns"\("accountId", "createdAt"\)/);
  assert.doesNotMatch(sql, /CREATE TABLE (?!IF NOT EXISTS)/);
  assert.doesNotMatch(sql, /CREATE INDEX (?!IF NOT EXISTS)/);
  assert.doesNotMatch(sql, /DROP|ALTER TABLE/);
  for (const col of ['"accountId"', '"waId"', '"path"', '"outcome"', '"promptHash"', '"model"', '"toolCalls"', '"proposal"', '"policyDecision"', '"gatesFired"', '"ms"', '"inputTokens"', '"outputTokens"', '"error"', '"createdAt"']) {
    assert.ok(sql.includes(col), `column ${col}`);
  }
  assert.match(sql, /"toolCalls"\s+JSONB/);
  assert.match(sql, /"createdAt"\s+TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
});
