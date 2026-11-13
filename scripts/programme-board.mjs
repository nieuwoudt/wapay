/**
 * The programme board's command line (lib/programme-board.js, docs/programme/README.md).
 *
 *   node scripts/programme-board.mjs check   [master.json]             validate the master, print the counts
 *   node scripts/programme-board.mjs page    [master.json] [out.html]  build the private page from the master
 *   node scripts/programme-board.mjs publish [master.json]             validate, then store the snapshot in production
 *   node scripts/programme-board.mjs status                            what production holds now (counts only)
 *
 * The master is WAPAY_PROGRAMME_BOARD.json in the private workspace folder
 * that holds this repository (one level up), or the path in
 * WAPAY_PROGRAMME_BOARD, or the path given. It is never committed: the
 * repository is public and the board is not.
 *
 * publish / status need WAPAY_INTERNAL_API_KEY in the environment (run with
 * node --env-file=<your .env>). The call goes out through curl, which follows
 * the machine's proxy settings where Node's own fetch does not, and the key is
 * handed to curl on standard input so it never appears in a process list.
 * WAPAY_API_BASE overrides the address (default https://wapay-api.vercel.app).
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBoard } from '../lib/programme-board.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TEMPLATE = join(REPO, 'docs', 'programme', 'board-page.template.html');
const MARK = '/*__BOARD_JSON__*/null';

export function masterPath(arg) {
  if (arg) return resolve(arg);
  if (process.env.WAPAY_PROGRAMME_BOARD) return resolve(process.env.WAPAY_PROGRAMME_BOARD);
  return resolve(REPO, '..', 'WAPAY_PROGRAMME_BOARD.json');
}

export function readMaster(path) {
  if (!existsSync(path)) return { ok: false, errors: [`no master file at ${path}`], board: null };
  let board = null;
  try { board = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { ok: false, errors: [`the master is not valid JSON: ${e.message}`], board: null }; }
  const v = validateBoard(board);
  return { ok: v.ok, errors: v.errors, counts: v.counts, board };
}

/** The page: the template with the board inlined as data. Pure. */
export function renderPage(template, board) {
  if (!template.includes(MARK)) throw new Error('the page template has no board marker');
  // The board is data inside a script element: "<" is written as its escape so
  // no text in the board can close the element or open another.
  const data = JSON.stringify(board).replace(/</g, '\\u003c')
    .split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
  return template.replace(MARK, () => data);
}

function curl({ method, url, key, bodyFile }) {
  const safe = String(key).replace(/[\\"\r\n]/g, '');
  const cfg = [`header = "x-internal-api-key: ${safe}"`, 'header = "content-type: application/json"'].join('\n');
  const args = ['-sS', '--max-time', '45', '-X', method, '-K', '-', '-w', '\n%{http_code}', url];
  if (bodyFile) args.push('--data-binary', `@${bodyFile}`);
  const r = spawnSync('/usr/bin/curl', args, { input: cfg, encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, status: 0, body: null, error: (r.stderr || 'curl failed').trim().slice(0, 300) };
  const out = String(r.stdout || '');
  const cut = out.lastIndexOf('\n');
  const status = Number(out.slice(cut + 1));
  let body = null;
  try { body = JSON.parse(out.slice(0, cut)); } catch { body = { raw: out.slice(0, 300) }; }
  return { ok: status >= 200 && status < 300, status, body };
}

async function main(argv) {
  const [cmd, a, b] = argv;
  const base = String(process.env.WAPAY_API_BASE || 'https://wapay-api.vercel.app').replace(/\/+$/, '');
  const key = process.env.WAPAY_INTERNAL_API_KEY || '';

  if (cmd === 'status') {
    if (!key) { console.error('WAPAY_INTERNAL_API_KEY is not set'); return 2; }
    const r = curl({ method: 'GET', url: `${base}/api/internal/programme`, key });
    console.log(JSON.stringify({ status: r.status, ...(r.body || {}), error: r.error }, null, 2));
    return r.ok ? 0 : 1;
  }

  if (!['check', 'page', 'publish'].includes(cmd)) {
    console.error('usage: node scripts/programme-board.mjs check|page|publish|status [master.json] [out.html]');
    return 2;
  }
  const path = masterPath(a);
  const m = readMaster(path);
  if (!m.ok) {
    console.error(`The board is not valid (${path}):`);
    for (const e of m.errors) console.error(`  - ${e}`);
    return 1;
  }
  if (cmd === 'check') { console.log(JSON.stringify({ ok: true, master: path, asOf: m.board.asOf, counts: m.counts }, null, 2)); return 0; }

  if (cmd === 'page') {
    const out = b ? resolve(b) : join(dirname(path), 'WAPAY_PROGRAMME_BOARD.html');
    writeFileSync(out, renderPage(readFileSync(TEMPLATE, 'utf8'), m.board));
    console.log(JSON.stringify({ ok: true, page: out, counts: m.counts }, null, 2));
    return 0;
  }

  if (!key) { console.error('WAPAY_INTERNAL_API_KEY is not set'); return 2; }
  const dir = mkdtempSync(join(tmpdir(), 'programme-'));
  try {
    const bodyFile = join(dir, 'board.json');
    writeFileSync(bodyFile, JSON.stringify({ board: m.board, by: m.board.updatedBy || 'session' }));
    const r = curl({ method: 'POST', url: `${base}/api/internal/programme`, key, bodyFile });
    console.log(JSON.stringify({ status: r.status, ...(r.body || {}), error: r.error }, null, 2));
    return r.ok ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
