/**
 * The programme board (2026-11-13): one consolidated picture of every
 * workstream, thread and open item, for the founder (management view) and for
 * whoever builds next (build view).
 *
 * WHERE THE DATA LIVES. The repository is public, and the board carries
 * things that must not be: security findings, fraud specifics, what is
 * waiting on whom. So the CONTENT never enters git:
 *   - the master is WAPAY_PROGRAMME_BOARD.json in the private workspace
 *     folder that holds this repo (outside the repository);
 *   - a published snapshot is stored in production as ONE finished job row
 *     (agent_jobs, kind "programme-board", key "current", status DONE, the
 *     board in `result`). A DONE row is never claimed by the job drain
 *     (lib/jobs.js claims PENDING and stale RUNNING only) and nothing purges
 *     the table, so this needs no migration and touches no money path.
 * Mission Control reads the snapshot (GET /api/admin/programme, admin
 * session); sessions publish it (POST /api/internal/programme, internal key)
 * with scripts/programme-board.mjs. docs/programme/README.md has the rules.
 *
 * This module is pure apart from saveBoard / loadBoard, which take the
 * database client as an argument.
 */

export const BOARD_SCHEMA = 1;
export const BOARD_JOB = Object.freeze({ kind: 'programme-board', key: 'current' });
export const BOARD_MAX_BYTES = 1_500_000;

export const ITEM_STATUS = Object.freeze(['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DECISION', 'WATCH', 'PARKED', 'DONE']);
export const ITEM_PRIORITY = Object.freeze(['P0', 'P1', 'P2', 'P3']);
export const ITEM_KIND = Object.freeze(['decision', 'action', 'build', 'verify', 'supplier', 'security', 'ops', 'legal']);
export const WS_STATE = Object.freeze(['green', 'amber', 'red', 'parked']);
export const THREAD_STATE = Object.freeze(['active', 'idle', 'closed']);
export const PULSE_STATE = Object.freeze(['good', 'warn', 'crit', 'info']);
export const FINDING_SEVERITY = Object.freeze(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
export const FINDING_STATUS = Object.freeze(['OPEN', 'FIXED', 'ACCEPTED', 'KNOWN']);
export const DOC_STATE = Object.freeze(['current', 'stale', 'new']);

const OWNER_RE = /^(founder|main|thread:[A-Za-z0-9_-]{3,80}|supplier:[^\n]{1,60})$/;
// Addresses are held to exact shapes, because they are the one place a long run of digits is
// legitimate (a session id) and so the one field the digit rule below does not read.
const SESSION_LINK_RE = /^claude:\/\/claude\.ai\/epitaxy\/local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAUDE_URL_RE = /^https:\/\/claude\.ai\/[A-Za-z0-9_/-]{1,200}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,39}$/;

/**
 * Things the board must never carry, whatever the author intended. A run of
 * nine or more digits is a phone, account, ID or voucher number: write the
 * masked tail (•••1332) instead. The rest are the shapes of live secrets.
 */
const FORBIDDEN = Object.freeze([
  [/\d{9,}/, 'a run of nine or more digits (mask numbers as •••1234)'],
  [/postgres(?:ql)?:\/\//i, 'a database connection string'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{12,}/, 'a payment-provider key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\bEAA[A-Za-z0-9]{24,}/, 'a Meta access token'],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}/, 'a bearer token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
]);

const isStr = (v, max = 4000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const optStr = (v, max = 4000) => v == null || (typeof v === 'string' && v.length <= max);
const isArr = (v) => Array.isArray(v);

/**
 * Validate a board. Returns { ok, errors, counts }. Never throws.
 * @param {unknown} board
 */
export function validateBoard(board) {
  const errors = [];
  const err = (m) => { if (errors.length < 60) errors.push(m); };
  const b = board && typeof board === 'object' && !isArr(board) ? board : null;
  if (!b) return { ok: false, errors: ['the board is not an object'], counts: null };

  let text = '';
  let scanned = '';
  try {
    text = JSON.stringify(b);
    // Everything is scanned except the three address fields, which have their own exact shapes.
    scanned = JSON.stringify({
      ...b,
      boardUrl: undefined,
      threads: isArr(b.threads) ? b.threads.map((t) => (t && typeof t === 'object' ? { ...t, link: undefined } : t)) : b.threads,
      architecture: b.architecture && typeof b.architecture === 'object' && !isArr(b.architecture) ? { ...b.architecture, mapUrl: undefined } : b.architecture,
    });
  } catch { return { ok: false, errors: ['the board is not serialisable'], counts: null }; }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > BOARD_MAX_BYTES) err(`the board is ${bytes} bytes; the limit is ${BOARD_MAX_BYTES}`);
  for (const [re, what] of FORBIDDEN) {
    const m = scanned.match(re);
    if (m) err(`the board contains ${what} near "${scanned.slice(Math.max(0, m.index - 24), m.index + 6).replace(/[\n"]/g, ' ')}…"`);
  }

  if (b.schema !== BOARD_SCHEMA) err(`schema must be ${BOARD_SCHEMA}`);
  if (!isStr(b.asOf, 40) || Number.isNaN(Date.parse(b.asOf))) err('asOf must be an ISO date-time');
  if (!optStr(b.build, 60)) err('build must be a short string');
  if (!optStr(b.updatedBy, 120)) err('updatedBy must be a short string');
  if (b.boardUrl != null && !CLAUDE_URL_RE.test(String(b.boardUrl))) err('boardUrl must be an https://claude.ai/ address');

  const wsIds = new Set();
  if (!isArr(b.workstreams) || !b.workstreams.length) err('workstreams must be a non-empty list');
  for (const w of isArr(b.workstreams) ? b.workstreams : []) {
    const at = `workstream ${w?.id || '?'}`;
    if (!w || !ID_RE.test(String(w.id || ''))) { err(`${at}: bad id`); continue; }
    if (wsIds.has(w.id)) err(`${at}: duplicate id`);
    wsIds.add(w.id);
    if (!isStr(w.name, 80)) err(`${at}: name`);
    if (!WS_STATE.includes(w.state)) err(`${at}: state must be one of ${WS_STATE.join(', ')}`);
    if (!isStr(w.summary, 1200)) err(`${at}: summary`);
    if (w.live != null && !(isArr(w.live) && w.live.every((x) => isStr(x, 400)))) err(`${at}: live must be a list of short strings`);
    if (!optStr(w.next, 400)) err(`${at}: next`);
    if (w.threads != null && !(isArr(w.threads) && w.threads.every((x) => isStr(x, 80)))) err(`${at}: threads`);
  }

  const threadIds = new Set();
  for (const t of isArr(b.threads) ? b.threads : []) {
    const at = `thread ${t?.id || '?'}`;
    if (!t || !isStr(t.id, 80)) { err(`${at}: id`); continue; }
    if (threadIds.has(t.id)) err(`${at}: duplicate id`);
    threadIds.add(t.id);
    if (!isStr(t.title, 140)) err(`${at}: title`);
    if (!THREAD_STATE.includes(t.state)) err(`${at}: state must be one of ${THREAD_STATE.join(', ')}`);
    if (!isStr(t.lastActive, 40) || !DATE_RE.test(String(t.lastActive).slice(0, 10))) err(`${at}: lastActive must start YYYY-MM-DD`);
    if (!optStr(t.role, 300) || !optStr(t.leftOff, 900)) err(`${at}: role / leftOff`);
    if (t.link != null && !SESSION_LINK_RE.test(String(t.link)) && !CLAUDE_URL_RE.test(String(t.link))) err(`${at}: link must be a claude:// session address or an https://claude.ai/ address`);
  }
  if (b.threads != null && !isArr(b.threads)) err('threads must be a list');
  for (const w of isArr(b.workstreams) ? b.workstreams : []) {
    for (const id of isArr(w?.threads) ? w.threads : []) if (!threadIds.has(id)) err(`workstream ${w.id}: unknown thread ${id}`);
  }

  const itemIds = new Set();
  const counts = { items: 0, open: 0, p0: 0, founder: 0, done: 0 };
  if (!isArr(b.items)) err('items must be a list');
  for (const it of isArr(b.items) ? b.items : []) {
    const at = `item ${it?.id || '?'}`;
    if (!it || !ID_RE.test(String(it.id || ''))) { err(`${at}: bad id`); continue; }
    if (itemIds.has(it.id)) err(`${at}: duplicate id`);
    itemIds.add(it.id);
    if (!wsIds.has(it.ws)) err(`${at}: unknown workstream "${it.ws}"`);
    if (!isStr(it.title, 160)) err(`${at}: title (1 to 160 characters)`);
    if (!ITEM_STATUS.includes(it.status)) err(`${at}: status must be one of ${ITEM_STATUS.join(', ')}`);
    if (!OWNER_RE.test(String(it.owner || ''))) err(`${at}: owner must be founder, main, thread:<id> or supplier:<name>`);
    if (String(it.owner || '').startsWith('thread:') && !threadIds.has(String(it.owner).slice(7))) err(`${at}: owner names an unknown thread`);
    if (!ITEM_KIND.includes(it.kind)) err(`${at}: kind must be one of ${ITEM_KIND.join(', ')}`);
    if (!ITEM_PRIORITY.includes(it.priority)) err(`${at}: priority must be P0 to P3`);
    if (it.due != null && !DATE_RE.test(String(it.due))) err(`${at}: due must be YYYY-MM-DD or null`);
    if (!optStr(it.blockedOn, 400) || !optStr(it.detail, 1500) || !optStr(it.evidence, 600)) err(`${at}: blockedOn / detail / evidence too long or not text`);
    if (it.asOf != null && !DATE_RE.test(String(it.asOf))) err(`${at}: asOf must be YYYY-MM-DD`);
    if (it.thread != null && !threadIds.has(it.thread)) err(`${at}: unknown thread ${it.thread}`);
    counts.items += 1;
    if (it.status === 'DONE') counts.done += 1; else counts.open += 1;
    if (it.status !== 'DONE' && it.priority === 'P0') counts.p0 += 1;
    if (it.status !== 'DONE' && it.owner === 'founder') counts.founder += 1;
  }

  for (const p of isArr(b.pulse) ? b.pulse : []) {
    if (!p || !isStr(p.label, 60) || !isStr(String(p.value ?? ''), 80) || !PULSE_STATE.includes(p.state) || !optStr(p.note, 400)) err(`pulse "${p?.label || '?'}": label, value, state (${PULSE_STATE.join(', ')}), note`);
  }
  if (b.pulse != null && !isArr(b.pulse)) err('pulse must be a list');

  if (b.security != null) {
    const s = b.security;
    if (typeof s !== 'object' || isArr(s)) err('security must be an object');
    else {
      if (!optStr(s.sweptAt, 40) || !optStr(s.summary, 1500)) err('security: sweptAt / summary');
      const seen = new Set();
      for (const f of isArr(s.findings) ? s.findings : []) {
        const at = `finding ${f?.id || '?'}`;
        if (!f || !ID_RE.test(String(f.id || ''))) { err(`${at}: bad id`); continue; }
        if (seen.has(f.id)) err(`${at}: duplicate id`);
        seen.add(f.id);
        if (!isStr(f.title, 200)) err(`${at}: title`);
        if (!FINDING_SEVERITY.includes(f.severity)) err(`${at}: severity`);
        if (!FINDING_STATUS.includes(f.status)) err(`${at}: status must be one of ${FINDING_STATUS.join(', ')}`);
        if (!optStr(f.verdict, 20) || !optStr(f.where, 600) || !optStr(f.scenario, 1500) || !optStr(f.fix, 1200) || !optStr(f.fixRisk, 400) || !optStr(f.commit, 60)) err(`${at}: a text field is too long or not text`);
      }
      if (s.findings != null && !isArr(s.findings)) err('security.findings must be a list');
    }
  }

  if (b.architecture != null) {
    const a = b.architecture;
    if (typeof a !== 'object' || isArr(a)) err('architecture must be an object');
    else {
      if (!optStr(a.mapUrl, 300) || !optStr(a.mapVersion, 40) || !optStr(a.phase, 900)) err('architecture: mapUrl / mapVersion / phase');
      if (a.mapUrl != null && !CLAUDE_URL_RE.test(String(a.mapUrl))) err('architecture.mapUrl must be an https://claude.ai/ address');
      for (const c of isArr(a.components) ? a.components : []) if (!c || !isStr(c.id, 40) || !isStr(c.name, 120) || !isStr(c.state, 20) || !optStr(c.note, 500)) err(`architecture component "${c?.id || '?'}"`);
      for (const c of isArr(a.subsystems) ? a.subsystems : []) if (!c || !isStr(c.name, 120) || !isStr(c.state, 30) || !optStr(c.doc, 200) || !optStr(c.note, 500)) err(`architecture subsystem "${c?.name || '?'}"`);
    }
  }

  for (const d of isArr(b.docs) ? b.docs : []) if (!d || !isStr(d.doc, 160) || !DOC_STATE.includes(d.state) || !optStr(d.note, 500)) err(`doc "${d?.doc || '?'}": doc, state (${DOC_STATE.join(', ')}), note`);
  for (const s of isArr(b.shipped) ? b.shipped : []) if (!s || !DATE_RE.test(String(s.date || '')) || !isStr(s.what, 400) || !optStr(s.ref, 120)) err(`shipped "${String(s?.what || '?').slice(0, 30)}": date, what, ref`);

  return { ok: errors.length === 0, errors, counts: { ...counts, workstreams: wsIds.size, threads: threadIds.size, bytes } };
}

/** Store a validated board as the current snapshot. Returns { ok, error?, counts? }. */
export async function saveBoard({ prisma, board, by = 'unknown', now = new Date() } = {}) {
  const v = validateBoard(board);
  if (!v.ok) return { ok: false, error: 'INVALID_BOARD', errors: v.errors };
  const meta = { by: String(by).slice(0, 120), storedAt: now.toISOString(), bytes: v.counts.bytes };
  await prisma.agentJob.upsert({
    where: { kind_key: { kind: BOARD_JOB.kind, key: BOARD_JOB.key } },
    create: { kind: BOARD_JOB.kind, key: BOARD_JOB.key, status: 'DONE', payload: meta, result: board, runAfter: now },
    // Never PENDING: the job drain must have nothing to claim here.
    update: { status: 'DONE', payload: meta, result: board, lockedAt: null, lastError: null },
  });
  return { ok: true, counts: v.counts, storedAt: meta.storedAt };
}

/** The current snapshot: { board, storedAt, by } or null when none was published. Never throws. */
export async function loadBoard({ prisma } = {}) {
  try {
    const row = await prisma.agentJob.findUnique({
      where: { kind_key: { kind: BOARD_JOB.kind, key: BOARD_JOB.key } },
      select: { result: true, payload: true, updatedAt: true },
    });
    if (!row || !row.result || typeof row.result !== 'object') return null;
    const meta = row.payload && typeof row.payload === 'object' ? row.payload : {};
    return { board: row.result, storedAt: meta.storedAt || row.updatedAt?.toISOString?.() || null, by: meta.by || null };
  } catch (error) {
    console.log(JSON.stringify({ type: 'programme_board_read_failed', error: String(error?.message || error).slice(0, 160), timestamp: new Date().toISOString() }));
    return null;
  }
}
