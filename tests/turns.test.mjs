import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  redactForMemory,
  recordTurn,
  recentTurns,
  renderTurns,
  purgeOldTurns,
  eraseTurns,
} from '../lib/turns.js';
import { sendWhatsAppText, configureSay, recordInbound, splitForSend } from '../lib/say.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makePrisma({ rows = [], failCreate = false, failFind = false } = {}) {
  const calls = { create: [], findMany: [], deleteMany: [], findUnique: [] };
  return {
    calls,
    conversationTurn: {
      async create(args) {
        calls.create.push(args);
        if (failCreate) throw new Error('db down');
        return { id: `turn_${calls.create.length}` };
      },
      async findMany(args) {
        calls.findMany.push(args);
        if (failFind) throw new Error('db down');
        return rows;
      },
      async deleteMany(args) {
        calls.deleteMany.push(args);
        return { count: 3 };
      },
    },
    account: {
      async findUnique(args) {
        calls.findUnique.push(args);
        return args.where.waId === '27821234567' ? { id: 'acc_1' } : null;
      },
    },
  };
}

function makeTransport({ ok = true } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return ok
      ? { ok: true, data: { messages: [{ id: `wamid.out.${calls.length}` }] } }
      : { ok: false, error: 'boom' };
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// redactForMemory
// ---------------------------------------------------------------------------

test('redactForMemory: 13+ digit bearer runs (16-digit Blu PIN)', () => {
  const out = redactForMemory('my pin is 1234567890123456 thanks');
  assert.equal(out, 'my pin is [16-digit code …56] thanks');
  assert.ok(!out.includes('1234567890123456'));
});

test('redactForMemory: 12-digit OTT voucher PIN', () => {
  const out = redactForMemory('voucher 123456789012 please');
  assert.equal(out, 'voucher [voucher PIN …12] please');
});

test('redactForMemory: 20-digit STS token and 4-4-4-4-4 groups', () => {
  assert.equal(
    redactForMemory('token 12345678901234567890'),
    'token [electricity token …90]',
  );
  assert.equal(
    redactForMemory('Token: 1234-5678-9012-3456-7890 for meter'),
    'Token: [electricity token …90] for meter',
  );
  assert.equal(
    redactForMemory('1234 5678 9012 3456 7891'),
    '[electricity token …91]',
  );
});

test('redactForMemory: 13-digit SA ID', () => {
  assert.equal(redactForMemory('ID 9001015800083'), 'ID [ID number …83]');
});

test('redactForMemory: bank account numbers after account|acc|acct', () => {
  assert.equal(redactForMemory('account 62345678901'), 'account [account number …01]');
  assert.equal(redactForMemory('Acc no: 12345678'), 'Acc no: [account number …78]');
  assert.equal(redactForMemory('acct# 1234567890'), 'acct# [account number …90]');
  // 12 digits after "account" is an account number, not a voucher PIN
  assert.equal(redactForMemory('account 123456789012'), 'account [account number …12]');
});

test('redactForMemory: founder withdraw confirm text', () => {
  const text =
    'Withdraw R500 to FNB account 62345678901, ID 9001015800083, phone 0821234567. Reply YES to confirm.';
  const out = redactForMemory(text);
  assert.ok(!out.includes('62345678901'), out);
  assert.ok(!out.includes('9001015800083'), out);
  assert.ok(out.includes('R500'), out);
  assert.ok(out.includes('FNB'), out);
  assert.ok(out.includes('0821234567'), 'phone numbers survive for slot-filling');
  assert.ok(out.includes('[account number …01]'), out);
  assert.ok(out.includes('[ID number …83]'), out);
});

test('redactForMemory: phone numbers and rand amounts survive outside PIN state', () => {
  const s = 'send R150 airtime to 0821234567 and 27821234567';
  assert.equal(redactForMemory(s), s);
});

test('redactForMemory: inPinState hides 4-6 digit runs entirely', () => {
  assert.equal(redactForMemory('1234', { inPinState: true }), '[PIN]');
  assert.equal(redactForMemory('pin 987654 ok', { inPinState: true }), 'pin [PIN] ok');
  // not in PIN state: short runs stay (amounts, meter fragments)
  assert.equal(redactForMemory('pay 1234'), 'pay 1234');
  // a phone number is not a PIN even in PIN state
  assert.equal(redactForMemory('0821234567', { inPinState: true }), '0821234567');
});

test('redactForMemory: tolerates null/undefined', () => {
  assert.equal(redactForMemory(null), '');
  assert.equal(redactForMemory(undefined), '');
});

// ---------------------------------------------------------------------------
// recordTurn / recentTurns / render / purge / erase
// ---------------------------------------------------------------------------

test('recordTurn: redacts, caps at 1,500 chars, inserts one row', async () => {
  const prisma = makePrisma();
  const text = 'pin 1234567890123456 ' + 'x'.repeat(2000);
  const res = await recordTurn({ prisma, accountId: 'acc_1', role: 'user', text, kind: 'agent', lang: 'en', waMessageId: 'wamid.1' });
  assert.deepEqual(res, { ok: true, id: 'turn_1' });
  assert.equal(prisma.calls.create.length, 1);
  const data = prisma.calls.create[0].data;
  assert.equal(data.text.length, 1500);
  assert.ok(!data.text.includes('1234567890123456'));
  assert.equal(data.role, 'user');
  assert.equal(data.kind, 'agent');
  assert.equal(data.lang, 'en');
  assert.equal(data.waMessageId, 'wamid.1');
});

test('recordTurn: never throws when prisma throws or inputs are missing', async () => {
  const prisma = makePrisma({ failCreate: true });
  assert.deepEqual(await recordTurn({ prisma, accountId: 'acc_1', role: 'assistant', text: 'hi' }), { ok: false });
  assert.deepEqual(await recordTurn({ prisma: null, accountId: 'acc_1', role: 'user', text: 'hi' }), { ok: false });
  assert.deepEqual(await recordTurn({ prisma, accountId: 'acc_1', role: 'user', text: '   ' }), { ok: false });
  assert.deepEqual(await recordTurn(), { ok: false });
});

test('recentTurns: excludes the current waMessageId and returns oldest-first', async () => {
  const t0 = new Date('2026-09-16T08:00:00Z');
  const rows = [
    { role: 'user', text: 'current', kind: null, createdAt: new Date(t0.getTime() + 3000), waMessageId: 'wamid.now' },
    { role: 'assistant', text: 'second', kind: 'flow', createdAt: new Date(t0.getTime() + 2000), waMessageId: 'wamid.out.1' },
    { role: 'user', text: 'first', kind: null, createdAt: new Date(t0.getTime() + 1000), waMessageId: null },
  ];
  const prisma = makePrisma({ rows });
  const turns = await recentTurns({ prisma, accountId: 'acc_1', limit: 5, excludeWaMessageId: 'wamid.now' });
  assert.deepEqual(turns.map((t) => t.text), ['first', 'second']);
  assert.deepEqual(Object.keys(turns[0]).sort(), ['createdAt', 'kind', 'role', 'text']);

  const q = prisma.calls.findMany[0];
  assert.equal(q.take, 5);
  assert.deepEqual(q.orderBy, { createdAt: 'desc' });
  assert.equal(q.where.accountId, 'acc_1');
  assert.ok(q.where.createdAt.gte instanceof Date);
  assert.deepEqual(q.where.OR, [{ waMessageId: null }, { waMessageId: { not: 'wamid.now' } }]);
});

test('recentTurns: never throws', async () => {
  assert.deepEqual(await recentTurns({ prisma: makePrisma({ failFind: true }), accountId: 'acc_1' }), []);
  assert.deepEqual(await recentTurns({ prisma: null, accountId: 'acc_1' }), []);
});

test('renderTurns: labels and age markers', () => {
  const now = new Date('2026-09-16T14:00:00Z'); // 16:00 SAST
  const h = 60 * 60 * 1000;
  const turns = [
    { role: 'user', text: 'three days back', createdAt: new Date(now.getTime() - 72 * h) },
    { role: 'assistant', text: 'yesterday reply', createdAt: new Date(now.getTime() - 20 * h) },
    { role: 'event', text: 'Deposit R100 received', createdAt: new Date(now.getTime() - 7 * h) },
    { role: 'user', text: 'just now', createdAt: new Date(now.getTime() - 5 * 60 * 1000) },
  ];
  const out = renderTurns(turns, { now }).split('\n');
  assert.equal(out[0], 'User (3 days ago): three days back');
  assert.equal(out[1], 'Assistant (yesterday): yesterday reply');
  assert.equal(out[2], 'Event (earlier today): Deposit R100 received');
  assert.equal(out[3], 'User: just now');
  assert.equal(renderTurns([], { now }), '');
});

test('purgeOldTurns and eraseTurns use deleteMany and never throw', async () => {
  const prisma = makePrisma();
  const p = await purgeOldTurns({ prisma, olderThanDays: 30 });
  assert.deepEqual(p, { ok: true, count: 3 });
  assert.ok(prisma.calls.deleteMany[0].where.createdAt.lt instanceof Date);
  const e = await eraseTurns({ prisma, accountId: 'acc_1' });
  assert.deepEqual(e, { ok: true, count: 3 });
  assert.deepEqual(prisma.calls.deleteMany[1].where, { accountId: 'acc_1' });
  assert.deepEqual(await purgeOldTurns({ prisma: null }), { ok: false, count: 0 });
  assert.deepEqual(await eraseTurns({ prisma: null, accountId: 'x' }), { ok: false, count: 0 });
});

// ---------------------------------------------------------------------------
// say
// ---------------------------------------------------------------------------

test('say: records the assistant turn only when the transport returned ok, returns the transport result', async () => {
  const prisma = makePrisma();
  const okTransport = makeTransport({ ok: true });
  configureSay({ transport: okTransport, prisma });

  const res = await sendWhatsAppText({ to: '27821234567', text: 'Your balance is R50.', kind: 'home', lang: 'en' });
  assert.deepEqual(res, { ok: true, data: { messages: [{ id: 'wamid.out.1' }] } });
  assert.deepEqual(okTransport.calls, [{ to: '27821234567', text: 'Your balance is R50.' }]);
  assert.equal(prisma.calls.create.length, 1);
  const data = prisma.calls.create[0].data;
  assert.equal(data.accountId, 'acc_1');
  assert.equal(data.role, 'assistant');
  assert.equal(data.kind, 'home');
  assert.equal(data.lang, 'en');
  assert.equal(data.waMessageId, 'wamid.out.1');

  // default kind is 'flow'; category passes through to the transport
  await sendWhatsAppText({ to: '27821234567', text: 'hi', category: 'utility' });
  assert.deepEqual(okTransport.calls[1], { to: '27821234567', text: 'hi', category: 'utility' });
  assert.equal(prisma.calls.create[1].data.kind, 'flow');

  const failTransport = makeTransport({ ok: false });
  configureSay({ transport: failTransport, prisma });
  const bad = await sendWhatsAppText({ to: '27821234567', text: 'never remembered' });
  assert.deepEqual(bad, { ok: false, error: 'boom' });
  assert.equal(prisma.calls.create.length, 2, 'no turn recorded on a failed send');
});

test('say: splits a 9,000-char text into three sequential sends and records once', async () => {
  const prisma = makePrisma();
  const transport = makeTransport({ ok: true });
  configureSay({ transport, prisma });

  const para = 'a'.repeat(100);
  const text = Array.from({ length: 88 }, () => para).join('\n\n'); // ~8,974 chars
  assert.ok(text.length > 8900 && text.length < 9100);

  const res = await sendWhatsAppText({ to: '27821234567', text });
  assert.equal(res.ok, true);
  assert.equal(transport.calls.length, 3);
  for (const c of transport.calls) assert.ok(c.text.length <= 4000, `chunk ${c.text.length}`);
  // split on paragraph breaks: no chunk starts or ends mid-paragraph
  for (const c of transport.calls) assert.ok(/^a{100}(\n\na{100})*$/.test(c.text));
  assert.equal(transport.calls.map((c) => c.text).join('\n\n'), text);
  assert.equal(prisma.calls.create.length, 1, 'one turn for the whole message');
  assert.equal(prisma.calls.create[0].data.text.length, 1500);

  // a hard 9,000-char run with no breaks still becomes three sends
  assert.deepEqual(splitForSend('b'.repeat(9000)).map((c) => c.length), [4000, 4000, 1000]);
});

test('say: memoises the account lookup per waId', async () => {
  const prisma = makePrisma();
  configureSay({ transport: makeTransport({ ok: true }), prisma });
  await sendWhatsAppText({ to: '27821234567', text: 'one' });
  await sendWhatsAppText({ to: '27821234567', text: 'two' });
  await sendWhatsAppText({ to: '27821234567', text: 'three' });
  assert.equal(prisma.calls.findUnique.length, 1);
  assert.equal(prisma.calls.create.length, 3);

  // unknown waId: still sends, records nothing, and is not cached as a miss
  const t = makeTransport({ ok: true });
  configureSay({ transport: t, prisma });
  const res = await sendWhatsAppText({ to: '27000000000', text: 'hello stranger' });
  assert.equal(res.ok, true);
  assert.equal(t.calls.length, 1);
  assert.equal(prisma.calls.create.length, 3);
});

test('say: never throws when the transport throws', async () => {
  configureSay({
    transport: async () => {
      throw new Error('network');
    },
    prisma: makePrisma(),
  });
  const res = await sendWhatsAppText({ to: '27821234567', text: 'x' });
  assert.deepEqual(res, { ok: false, error: 'network' });
});

test('recordInbound: records the user side with redaction and PIN state', async () => {
  const prisma = makePrisma();
  configureSay({ transport: makeTransport(), prisma });
  const res = await recordInbound({ waId: '27821234567', text: '1234', waMessageId: 'wamid.in.1', inPinState: true });
  assert.deepEqual(res, { ok: true, id: 'turn_1' });
  const data = prisma.calls.create[0].data;
  assert.equal(data.role, 'user');
  assert.equal(data.accountId, 'acc_1');
  assert.equal(data.text, '[PIN]');
  assert.equal(data.waMessageId, 'wamid.in.1');
  assert.deepEqual(await recordInbound({ waId: '27000000000', text: 'hi' }), { ok: false });
});

// ---------------------------------------------------------------------------
// schema + migration
// ---------------------------------------------------------------------------

test('migration SQL is idempotent and creates both indexes', () => {
  const sql = readFileSync(
    path.join(ROOT, 'packages/domain/prisma/migrations/20260916_conversation_turns/migration.sql'),
    'utf8',
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "conversation_turns"/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "conversation_turns_accountId_createdAt_idx"\s+ON "conversation_turns"\("accountId", "createdAt"\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "conversation_turns_waMessageId_idx"\s+ON "conversation_turns"\("waMessageId"\)/);
  for (const col of ['"id"', '"accountId"', '"role"', '"kind"', '"text"', '"lang"', '"waMessageId"', '"refs"', '"createdAt"']) {
    assert.ok(sql.includes(col), `column ${col}`);
  }
  assert.ok(!sql.includes('DROP'));
});

test('schema contains the ConversationTurn model mapped to conversation_turns', () => {
  const schema = readFileSync(path.join(ROOT, 'packages/domain/prisma/schema.prisma'), 'utf8');
  const m = schema.match(/model ConversationTurn \{([\s\S]*?)\n\}/);
  assert.ok(m, 'model ConversationTurn present');
  const body = m[1];
  for (const line of [
    'id          String   @id @default(cuid())',
    'accountId   String',
    'text        String',
    'refs        Json?',
    'createdAt   DateTime @default(now())',
    '@@index([accountId, createdAt])',
    '@@index([waMessageId])',
    '@@map("conversation_turns")',
  ]) {
    assert.ok(body.includes(line), `schema line: ${line}`);
  }
  assert.match(body, /role\s+String/);
  assert.match(body, /kind\s+String\?/);
  assert.match(body, /lang\s+String\?/);
  assert.match(body, /waMessageId\s+String\?/);
});
