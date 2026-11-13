/**
 * The programme board (founder 2026-11-13): every workstream, session and open
 * item in one place, in Mission Control and on a private page.
 *
 * What these lock:
 * - the board's CONTENT can never reach the public repository or carry a
 *   number or a secret: the checks refuse it in the script and at the route;
 * - the snapshot is one finished job row the drain can never claim, so the
 *   board touches no money path and needs no migration;
 * - reading needs an admin session, writing needs the internal key, and the
 *   internal read never returns the content;
 * - the tab is wired into Mission Control and holds no content of its own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateBoard, saveBoard, loadBoard, BOARD_JOB, BOARD_SCHEMA, BOARD_MAX_BYTES, ITEM_STATUS } from '../lib/programme-board.js';
import { claimJobs, jobStats } from '../lib/jobs.js';
import { renderPage, masterPath, readMaster } from '../scripts/programme-board.mjs';
import { createProgrammeStoreHandler } from '../pages/api/internal/programme.js';
import { createProgrammeReadHandler } from '../pages/api/admin/programme.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const board = (over = {}) => ({
  schema: BOARD_SCHEMA,
  asOf: '2026-11-13T14:00:00.000Z',
  build: '6df86a2',
  updatedBy: 'main session',
  boardUrl: 'https://claude.ai/artifact/example',
  pulse: [{ label: 'Books', value: 'balanced', state: 'good', note: null }],
  workstreams: [
    { id: 'payouts', name: 'Pay-outs', state: 'red', summary: 'Approval mode; the supplier gateway refuses us.', live: ['PayShap'], next: 'Supplier answer', threads: ['t-main'] },
    { id: 'security', name: 'Security', state: 'amber', summary: 'Swept on the 13th.' },
  ],
  threads: [{ id: 't-main', title: 'Main architecture session', state: 'active', lastActive: '2026-11-13', role: 'Coordinates', leftOff: 'Building the board', link: 'claude://claude.ai/epitaxy/local_1e7af5bf-19af-4bfa-9aef-6560381870ed' }],
  items: [
    { id: 'PAY-001', ws: 'payouts', title: 'Approve nothing until the supplier answers', status: 'BLOCKED', owner: 'founder', kind: 'action', priority: 'P0', due: '2026-11-14', blockedOn: 'the supplier', detail: 'Account •••1332 is waiting.', evidence: 'reading of 13 Nov', asOf: '2026-11-13', thread: 't-main' },
    { id: 'PAY-002', ws: 'payouts', title: 'Ask the supplier what changed', status: 'OPEN', owner: 'supplier:OTT', kind: 'supplier', priority: 'P0' },
    { id: 'SEC-001', ws: 'security', title: 'Rotate the leaked keys', status: 'DONE', owner: 'thread:t-main', kind: 'security', priority: 'P1' },
  ],
  security: { sweptAt: '2026-11-13', summary: 'Three lenses.', findings: [{ id: 'F-01', title: 'An example', severity: 'LOW', status: 'FIXED', verdict: 'CONFIRMED', where: 'lib/x.js', scenario: 's', fix: 'f', fixRisk: 'none', commit: 'abc1234' }] },
  architecture: { mapUrl: 'https://claude.ai/artifact/map', mapVersion: '16', phase: 'Phase 3', components: [{ id: 'C1', name: 'Orchestrator', state: 'live', note: null }], subsystems: [{ name: 'Ledger', state: 'live', doc: 'docs/x.md' }] },
  docs: [{ doc: 'docs/CAPABILITIES.md', state: 'stale', note: 'dated' }],
  shipped: [{ date: '2026-11-13', what: 'Two pay-out speeds', ref: '6df86a2' }],
  ...over,
});

/** The one table, in memory, with the unique index enforced (the shape tests/jobs.test.mjs uses). */
function fakeDb(rows = []) {
  const store = rows.map((r, i) => ({ id: `j${i}`, attempts: 0, maxAttempts: 5, status: 'PENDING', runAfter: new Date(0), lockedAt: null, ...r }));
  const match = (row, where) => {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'OR') { if (!v.some((w) => match(row, w))) return false; continue; }
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v && !v.in.includes(row[k])) return false;
        if ('lte' in v && !(new Date(row[k]) <= v.lte)) return false;
        if ('lt' in v && !(row[k] && new Date(row[k]) < v.lt)) return false;
        continue;
      }
      if (row[k] !== v) return false;
    }
    return true;
  };
  const find = (w) => store.find((r) => r.kind === w.kind_key.kind && r.key === w.kind_key.key);
  return {
    store,
    agentJob: {
      findUnique: async ({ where }) => { const r = find(where); return r ? { ...r, updatedAt: new Date('2026-11-13T14:01:00Z') } : null; },
      upsert: async ({ where, create, update }) => {
        const r = find(where);
        if (r) { Object.assign(r, update); return r; }
        const row = { id: `new${store.length}`, attempts: 0, maxAttempts: 5, lockedAt: null, ...create };
        store.push(row); return row;
      },
      findMany: async ({ where, take }) => store.filter((r) => match(r, where)).slice(0, take ?? store.length).map((r) => ({ ...r })),
      findFirst: async ({ where }) => store.filter((r) => match(r, where))[0] || null,
      updateMany: async ({ where, data }) => { const hit = store.filter((r) => match(r, where)); for (const r of hit) Object.assign(r, data); return { count: hit.length }; },
      groupBy: async () => { const by = {}; for (const r of store) by[r.status] = (by[r.status] || 0) + 1; return Object.entries(by).map(([status, n]) => ({ status, _count: { _all: n } })); },
    },
  };
}

function mockRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const KEY = 'test-internal-key-for-the-board';
const withKey = async (fn) => {
  const before = process.env.WAPAY_INTERNAL_API_KEY;
  process.env.WAPAY_INTERNAL_API_KEY = KEY;
  try { return await fn(); } finally { if (before === undefined) delete process.env.WAPAY_INTERNAL_API_KEY; else process.env.WAPAY_INTERNAL_API_KEY = before; }
};
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

test('a well-formed board passes and is counted', () => {
  const v = validateBoard(board());
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  assert.deepEqual({ items: v.counts.items, open: v.counts.open, done: v.counts.done, p0: v.counts.p0, founder: v.counts.founder, workstreams: v.counts.workstreams, threads: v.counts.threads },
    { items: 3, open: 2, done: 1, p0: 2, founder: 1, workstreams: 2, threads: 1 });
  assert.ok(v.counts.bytes > 0 && v.counts.bytes < BOARD_MAX_BYTES);
});

test('the board is refused when its shape is wrong, and the reason names the item', () => {
  const bad = (over, re) => { const v = validateBoard(board(over)); assert.equal(v.ok, false); assert.ok(v.errors.some((e) => re.test(e)), `${re} in ${JSON.stringify(v.errors)}`); };
  const items = (patch) => ({ items: [{ ...board().items[0], ...patch }] });
  bad({ schema: 2 }, /schema must be 1/);
  bad({ asOf: 'yesterday' }, /asOf/);
  bad({ workstreams: [] }, /workstreams must be a non-empty list/);
  bad(items({ ws: 'nowhere' }), /PAY-001: unknown workstream/);
  bad(items({ status: 'MAYBE' }), /PAY-001: status/);
  bad(items({ owner: 'someone' }), /PAY-001: owner/);
  bad(items({ owner: 'thread:t-gone' }), /PAY-001: owner names an unknown thread/);
  bad(items({ priority: 'P9' }), /PAY-001: priority/);
  bad(items({ kind: 'wish' }), /PAY-001: kind/);
  bad(items({ due: '14 Nov' }), /PAY-001: due/);
  bad(items({ thread: 't-gone' }), /PAY-001: unknown thread/);
  bad(items({ id: 'has space' }), /bad id/);
  bad({ items: [board().items[0], board().items[0]] }, /PAY-001: duplicate id/);
  bad({ threads: [{ ...board().threads[0], link: 'https://example.com/x' }] }, /link must be a claude/);
  bad({ threads: [{ ...board().threads[0], link: 'claude://claude.ai/epitaxy/local_' + '2'.repeat(11) }] }, /link must be a claude/);
  bad({ threads: [{ ...board().threads[0], link: 'https://claude.ai/x?n=' + '2'.repeat(11) }] }, /link must be a claude/);
  bad({ boardUrl: 'https://claude.ai/artifact/a b' }, /boardUrl/);
  bad({ threads: [{ ...board().threads[0], link: 'javascript:alert(1)' }] }, /link must be a claude/);
  bad({ boardUrl: 'https://evil.example/claude.ai/' }, /boardUrl/);
  bad({ architecture: { mapUrl: 'javascript:alert(1)' } }, /mapUrl must be/);
  bad({ architecture: { mapUrl: 'https://example.com/map' } }, /mapUrl must be/);
  bad({ pulse: [{ label: 'x', value: 'y', state: 'purple' }] }, /pulse "x"/);
  bad({ security: { findings: [{ id: 'F-01', title: 't', severity: 'SCARY', status: 'OPEN' }] } }, /F-01: severity/);
  bad({ docs: [{ doc: 'a.md', state: 'old' }] }, /doc "a.md"/);
  assert.equal(validateBoard(null).ok, false);
  assert.equal(validateBoard([]).ok, false);
  assert.equal(validateBoard('{}').ok, false);
  assert.deepEqual([...ITEM_STATUS], ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DECISION', 'WATCH', 'PARKED', 'DONE']);
});

test('a number or a secret anywhere in the board refuses it; a masked tail passes', () => {
  const inDetail = (text) => validateBoard(board({ items: [{ ...board().items[0], detail: text }] }));
  const digits = (n) => '2'.repeat(n);
  assert.equal(inDetail('Account •••1332 retried twice, R3,000 each, on 2026-11-07.').ok, true, 'masked tail, amounts and dates are fine');
  assert.equal(validateBoard(board()).ok, true, 'a session address may hold a long run of digits: addresses have their own exact shape and are the only field the digit rule skips');
  assert.equal(validateBoard(board({ threads: [{ ...board().threads[0], leftOff: `call ${digits(11)}` }] })).ok, false, 'every other thread field is still read');
  assert.equal(inDetail(`reference ${digits(8)}`).ok, true, 'eight digits is not a number we protect');
  for (const [text, what] of [
    [`call ${digits(11)}`, /nine or more digits/],
    [`ID ${digits(13)}`, /nine or more digits/],
    [`voucher ${digits(12)}`, /nine or more digits/],
    [['postgres', 'ql://user:pw@host/db'].join(''), /database connection string/],
    [['sk', 'live', 'a'.repeat(24)].join('_'), /payment-provider key/],
    [['gh', 'p_', 'A'.repeat(36)].join(''), /GitHub token/],
    [['EA', 'A', 'b'.repeat(40)].join(''), /Meta access token/],
    [['Bear', 'er ', 'x'.repeat(32)].join(''), /bearer token/],
    [['-----BEGIN RSA ', 'PRIVATE KEY-----'].join(''), /private key/],
  ]) {
    const v = inDetail(text);
    assert.equal(v.ok, false, text.slice(0, 12));
    assert.ok(v.errors.some((e) => what.test(e)), `${what}`);
    assert.ok(!v.errors.join(' ').includes(text.slice(-10)), 'the refusal does not repeat the value');
  }
  // Not only in items: anywhere in the document.
  assert.equal(validateBoard(board({ shipped: [{ date: '2026-11-13', what: `paid ${digits(10)}` }] })).ok, false);
  assert.equal(validateBoard(board({ security: { findings: [{ id: 'F-01', title: `tail ${digits(9)}`, severity: 'LOW', status: 'OPEN' }] } })).ok, false);
  const big = validateBoard(board({ shipped: [{ date: '2026-11-13', what: 'x'.repeat(300) }], pulse: Array.from({ length: 30000 }, (_, i) => ({ label: `l${i % 9}`, value: 'v'.repeat(60), state: 'info' })) }));
  assert.ok(big.errors.some((e) => /the limit is/.test(e)), 'an oversized board is refused');
});

test('the snapshot is one finished row: stored, replaced in place, never claimed by the job drain', async () => {
  const db = fakeDb([{ kind: 'fuel-reconcile', key: 'acct:1' }]);
  assert.equal(await loadBoard({ prisma: db }), null, 'nothing published yet');

  const refused = await saveBoard({ prisma: db, board: board({ schema: 9 }), by: 'x' });
  assert.equal(refused.ok, false);
  assert.equal(db.store.length, 1, 'an invalid board never reaches the table');

  const now = new Date('2026-11-13T14:00:00Z');
  const first = await saveBoard({ prisma: db, board: board(), by: 'main session', now });
  assert.equal(first.ok, true);
  const row = db.store.find((r) => r.kind === BOARD_JOB.kind);
  assert.equal(row.key, 'current'); assert.equal(row.status, 'DONE');
  assert.deepEqual(row.payload, { by: 'main session', storedAt: now.toISOString(), bytes: first.counts.bytes });

  const again = await saveBoard({ prisma: db, board: board({ build: 'abc1234' }), by: 'daily run', now: new Date('2026-11-14T05:00:00Z') });
  assert.equal(again.ok, true);
  assert.equal(db.store.filter((r) => r.kind === BOARD_JOB.kind).length, 1, 'one row, replaced');
  assert.equal(row.status, 'DONE');

  const cur = await loadBoard({ prisma: db });
  assert.equal(cur.board.build, 'abc1234'); assert.equal(cur.by, 'daily run'); assert.equal(cur.storedAt, '2026-11-14T05:00:00.000Z');

  // The drain takes the real job and leaves the board alone, however late it runs.
  const mine = await claimJobs({ prisma: db, limit: 10, now: new Date('2027-01-01T00:00:00Z') });
  assert.deepEqual(mine.map((j) => j.kind), ['fuel-reconcile']);
  assert.equal(row.status, 'DONE'); assert.equal(row.attempts, 0);
  const stats = await jobStats({ prisma: db });
  assert.equal(stats.failed, 0); assert.equal(stats.pending, 0);

  // A database that fails is a board that is not there, never an exception.
  const broken = { agentJob: { findUnique: async () => { throw new Error('down'); } } };
  assert.equal(await quiet(() => loadBoard({ prisma: broken })), null);
});

test('writing needs the internal key; the internal read returns counts and never the content', async () => {
  await withKey(() => quiet(async () => {
    const db = fakeDb();
    const store = createProgrammeStoreHandler({ prisma: db });
    const post = (headers, body) => { const res = mockRes(); return store({ method: 'POST', headers, body, url: '/api/internal/programme' }, res).then(() => res); };
    const json = { 'content-type': 'application/json' };

    let res = await post(json, { board: board() });
    assert.equal(res.statusCode, 401, 'no key');
    res = await post({ ...json, 'x-internal-api-key': 'wrong' }, { board: board() });
    assert.equal(res.statusCode, 401, 'wrong key');
    assert.equal(db.store.length, 0);

    res = await post({ 'x-internal-api-key': KEY, 'content-type': 'text/plain' }, { board: board() });
    assert.equal(res.statusCode, 415);
    res = await post({ ...json, 'x-internal-api-key': KEY }, { board: board({ items: [{ ...board().items[0], detail: `call ${'2'.repeat(11)}` }] }) });
    assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'INVALID_BOARD');
    res = await post({ ...json, 'x-internal-api-key': KEY }, {});
    assert.equal(res.statusCode, 400);
    assert.equal(db.store.length, 0, 'nothing invalid is stored');

    res = await post({ ...json, 'x-internal-api-key': KEY }, { board: board(), by: 'main session' });
    assert.equal(res.statusCode, 200); assert.equal(res.body.ok, true); assert.equal(res.body.counts.items, 3);
    assert.equal(res.headers['cache-control'], 'private, no-store');

    const got = mockRes();
    await store({ method: 'GET', headers: { 'x-internal-api-key': KEY }, url: '/api/internal/programme' }, got);
    assert.equal(got.statusCode, 200);
    assert.deepEqual(Object.keys(got.body).sort(), ['asOf', 'by', 'counts', 'ok', 'stored', 'storedAt', 'valid']);
    assert.ok(!JSON.stringify(got.body).includes('Approve nothing'), 'the internal read carries no content');

    const del = mockRes();
    await store({ method: 'DELETE', headers: { 'x-internal-api-key': KEY } }, del);
    assert.equal(del.statusCode, 405);

    const failing = createProgrammeStoreHandler({ prisma: { agentJob: { upsert: async () => { throw new Error('db down'); } } } });
    const f = mockRes();
    await failing({ method: 'POST', headers: { ...json, 'x-internal-api-key': KEY }, body: { board: board() } }, f);
    assert.equal(f.statusCode, 500); assert.equal(f.body.error, 'STORE_FAILED');
    assert.ok(!JSON.stringify(f.body).includes('db down'), 'the cause stays in the log');
  }));
});

test('reading the board needs an admin session', async () => {
  await withKey(() => quiet(async () => {
    const db = fakeDb();
    const readBoard = createProgrammeReadHandler({ prisma: db });
    const get = (headers = {}, method = 'GET') => { const res = mockRes(); return readBoard({ method, headers }, res).then(() => res); };

    assert.equal((await get()).statusCode, 401, 'no session');
    assert.equal((await get({ cookie: 'wapay_admin=forged.token.value' })).statusCode, 401, 'a forged cookie');
    assert.equal((await get({ 'x-internal-api-key': KEY }, 'POST')).statusCode, 405, 'read-only');

    let res = await get({ 'x-internal-api-key': KEY });
    assert.deepEqual(res.body, { ok: true, stored: false }, 'nothing published yet');

    await saveBoard({ prisma: db, board: board(), by: 'main session', now: new Date('2026-11-13T14:00:00Z') });
    res = await get({ 'x-internal-api-key': KEY });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.board.items.length, 3); assert.equal(res.body.by, 'main session');
    assert.equal(res.headers['cache-control'], 'private, no-store');
  }));
  const src = read('pages/api/admin/programme.js');
  const body = src.slice(src.indexOf('return async function handler'));
  assert.ok(body.indexOf('requireAdmin(req)') > -1 && body.indexOf('requireAdmin(req)') < body.indexOf('loadBoard('), 'the gate sits before the read');
  const store = read('pages/api/internal/programme.js');
  const sb = store.slice(store.indexOf('return async function handler'));
  assert.ok(sb.indexOf('requireInternalAuth(req, res)') < sb.indexOf('loadBoard('), 'the key is checked before anything is read');
});

test('Mission Control has the Programme tab, and the tab holds no content of its own', () => {
  const admin = read('pages/admin/index.js');
  assert.match(admin, /\['programme', 'Programme'\]/);
  assert.match(admin, /import ProgrammeTab from '\.\.\/\.\.\/components\/admin\/ProgrammeTab\.js'/);
  assert.match(admin, /tab === 'programme' \? <ProgrammeTab \/>/);
  const tab = read('components/admin/ProgrammeTab.js');
  assert.match(tab, /fetch\('\/api\/admin\/programme'\)/);
  assert.ok(!/dangerouslySetInnerHTML/.test(tab), 'board text is rendered as text, never as markup');
  assert.ok(!/href=\{(?!safeHref\()/.test(tab), 'every link taken from the board passes safeHref');
  assert.match(tab, /const safeHref = \(u\) => \(\/\^\(https:\\\/\\\/claude\\\.ai\\\/\|claude:\\\/\\\/\)/, 'and safeHref admits Claude addresses only');
  assert.ok(!/<script|cdnjs|unpkg|jsdelivr/.test(tab), 'nothing is fetched from a CDN into the admin console');
  assert.ok(!/\bbet(s|ting|tor)?\b|gambl|casino|wager/i.test(tab));
  assert.ok(!/cash\s?-?\s?out|withdraw/i.test(tab), 'the console copy rule holds here too');
  for (const view of ['Management', 'Build', 'Threads', 'Security', 'System']) assert.ok(tab.includes(`'${view}'`), view);
});

test('the page is built from the master with the board inlined as inert data', () => {
  const template = read('docs/programme/board-page.template.html');
  assert.match(template, /<title>WaPay Programme Board<\/title>/);
  assert.ok(!/innerHTML|document\.write|eval\(/.test(template), 'the page builds its content as text nodes');
  assert.ok(!/<!doctype|<html|<body/i.test(template), 'the publisher supplies the document skeleton');
  const hostile = board({ items: [{ ...board().items[0], title: 'x</script><script>alert(1)</script>', detail: 'a $& b $1 c' }] });
  const html = renderPage(template, hostile);
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'board text cannot close the script element');
  assert.ok(html.includes('\\u003c/script>'), 'the angle bracket is written as its escape');
  assert.ok(html.includes('a $& b $1 c'), 'replacement patterns in the board are kept as text');
  const data = html.slice(html.indexOf('const BOARD = ') + 14, html.indexOf(';\n(function'));
  assert.deepEqual(JSON.parse(data), hostile, 'the inlined board reads back exactly');
  assert.throws(() => renderPage('<p>no marker</p>', board()), /no board marker/);
});

test('the master lives outside the repository and no board content is committed', () => {
  assert.equal(masterPath('/x/y.json'), '/x/y.json');
  assert.ok(!masterPath().startsWith(ROOT.replace(/\/$/, '') + '/'), 'the default master path is one level above the repository');
  assert.equal(readMaster(join(ROOT, 'no-such-board.json')).ok, false);
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git' || name === '.next' || name === 'dist') continue;
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
  };
  const strays = walk(ROOT).filter((p) => /WAPAY_PROGRAMME_BOARD/i.test(p));
  assert.deepEqual(strays, [], 'the master and its page stay in the private workspace folder');
  assert.deepEqual(readdirSync(join(ROOT, 'docs/programme')).sort(), ['README.md', 'board-page.template.html'], 'docs/programme holds the machinery only');
  assert.ok(existsSync(join(ROOT, 'docs/programme/README.md')));
});

test('the command line checks a master and refuses a bad one without printing its content', () => {
  const run = (args, input) => {
    try { return { code: 0, out: execFileSync(process.execPath, [join(ROOT, 'scripts/programme-board.mjs'), ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, WAPAY_INTERNAL_API_KEY: '' } }) }; } catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
  };
  assert.equal(run([]).code, 2, 'no command');
  const missing = run(['check', join(ROOT, 'no-such-board.json')]);
  assert.equal(missing.code, 1); assert.match(missing.out, /no master file/);
  assert.equal(run(['publish', join(ROOT, 'no-such-board.json')]).code, 1, 'an invalid master is never sent');
  assert.equal(run(['status']).code, 2, 'no key, no call');
});
