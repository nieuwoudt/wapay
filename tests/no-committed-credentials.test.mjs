/**
 * No credential is committed to the repository (2026-10-20, BUGLOG #132).
 *
 * The repository was public with live values pasted into setup docs and
 * scripts: Supabase connection strings carrying the database password, Meta
 * WhatsApp access tokens, the webhook verify token, Blu's QA basic-auth
 * password and API keys. This lock walks every tracked text file (`git
 * ls-files`; the fast working copy has no .git, so it falls back to walking the
 * tree minus the rsync excludes and every .env file) and fails on
 * credential-shaped strings. A placeholder passes: `<set in Vercel>`,
 * `[YOUR-PASSWORD]`, `${VAR}`, `your_…`, `changeme`, test values.
 *
 * Published test values are allowed by the SHA-256 of the value, with where
 * they are published; provider unit-test fixtures under
 * packages/providers/<name>/__tests__ are allowed by path. A failure names
 * file, line and rule, never the value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const fingerprint = (v) => createHash('sha256').update(v).digest('hex').slice(0, 16);

// Published test values, allowed wherever they appear: sha256 (first 16 hex) → where it is published.
const PUBLIC_VALUES = new Map([
  ['cfa389043cdd5c76', "Adumo staging JWT secret, from Adumo's sandbox docs (docs/ADUMO.md section 4, lib/adumo.js ADUMO_PUBLIC_TEST)"],
  ['4933c317fb9de58e', "Adumo staging OAuth client secret, published on Adumo's enterprise page (docs/ADUMO.md; scripts/dev-adumo-staging.sh)"],
  ['cc6f52a37899b015', "OTT's API-spec example key, the golden vector for hashParams (docs/OTT_PAYOUT_API.md; packages/providers/ott/src/client.ts)"],
]);
// Provider unit-test fixtures: fake credentials by construction.
const PUBLIC_PATHS = [/^packages\/providers\/[^/]+\/__tests__\//];

const SKIP_DIRS = new Set(['node_modules', '.next', '.pnpm-store', 'dist', '.git', '.turbo', '.vercel', 'out']);
const SKIP_FILE = /^\.env|\.log$|^\.ott-test-vouchers\.local\.json$|^\.wapay-pii-key\.txt$|^pnpm-lock\.yaml$/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|eot|zip|gz|mp4|mov|mp3|wav)$/i;
const CODE = /\.(m?js|cjs|jsx|ts|tsx)$/;

function repoFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split('\0').filter(Boolean);
  } catch {
    const out = [];
    (function walk(rel) {
      for (const name of readdirSync(path.join(root, rel))) {
        const r = rel ? `${rel}/${name}` : name;
        if (statSync(path.join(root, r)).isDirectory()) { if (!SKIP_DIRS.has(name)) walk(r); }
        else if (!SKIP_FILE.test(name)) out.push(r);
      }
    })('');
    return out;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER = /^[<[{(]|[>\]})]$|^\$|your|xxx|\.\.\.|…|\*{3}|changeme|placeholder|example|sample|dummy|fake|redacted|test|local|e2e|mock|stub|process\.env/i;
const WORD_PASSWORD = /^(?:pass(?:word)?|pwd|secret|postgres)$/i;

function looksSecret(v) {
  if (v.length < 8 || PLACEHOLDER.test(v)) return false;
  if (new Set(v.replace(/[^A-Za-z0-9]/g, '')).size < 6) return false; // 0000…, 1111…
  return UUID.test(v) || /^[A-Fa-f0-9]{24,}$/.test(v) || (/[A-Za-z]/.test(v) && /\d/.test(v))
    || (v.length >= 24 && /[a-z]/.test(v) && /[A-Z]/.test(v));
}

const VALUE = String.raw`[A-Za-z0-9_\-+/=.@%!*#~^]{8,}(?![A-Za-z0-9_\-+/=.@%!*#~^])`;
const RULES = [
  { id: 'postgres-url-password', re: /\bpostgres(?:ql)?:\/\/[^:\s/@'"`]+:([^\s'"`]+)@([A-Za-z0-9.-]+)/g,
    secret: (m) => !PLACEHOLDER.test(m[1]) && !WORD_PASSWORD.test(m[1]) && !/^(?:localhost|127\.0\.0\.1|db|postgres)$/.test(m[2]), value: (m) => m[1] },
  { id: 'meta-access-token', re: /\bEAA[A-Za-z0-9]{20,}/g, secret: (m) => !/x{4,}|X{4,}/.test(m[0]) },
  { id: 'provider-key', re: /\b(?:sk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|re_[A-Za-z0-9]{6,}_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,}|xox[abpr]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/g,
    secret: (m) => !PLACEHOLDER.test(m[0]) },
  { id: 'private-key', re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g, secret: () => true },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, secret: () => true },
  // NAME=value / name: 'value' / | `NAME` | `value` | where the name ends in key, secret, token, password, pass,
  // passphrase or pwd. In code an unquoted value is an identifier unless it is a UUID or long hex.
  { id: 'secret-assignment', re: new RegExp(String.raw`\b((?:[A-Za-z][A-Za-z0-9_]*?)?(?:api[_ -]?key|secret|token|passw(?:or)?d|pass|passphrase|pwd))\b["'\x60]?\s*[:=|]\s*(["'\x60]?)(${VALUE})`, 'gi'),
    secret: (m, file) => (!CODE.test(file) || m[2] !== '' || UUID.test(m[3]) || /^[A-Fa-f0-9]{24,}$/.test(m[3])) && looksSecret(m[3]),
    value: (m) => m[3] },
  // A UUID shortly after "API key", "secret", "token", "password" or "credential" in prose ("API key received: …").
  { id: 'uuid-near-key-word', re: /(?<![A-Za-z0-9])(?:api[_ -]?key|apikey|secret|token|passw(?:or)?d|credential)s?(?![A-Za-z0-9])[^\n]{0,40}?\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi,
    secret: (m) => looksSecret(m[1]), value: (m) => m[1] },
  { id: 'shell-default-secret', re: /\$\{([A-Za-z_]*(?:KEY|PASS|PASSWORD|SECRET|TOKEN)[A-Za-z_]*):-([^}\s]+)\}/g,
    secret: (m) => looksSecret(m[2]), value: (m) => m[2] },
  { id: 'basic-auth-literal', re: /Buffer\.from\(\s*['"`]([^:'"`\s$]+):([^'"`\s]+)['"`]/g,
    secret: (m) => looksSecret(m[2]), value: (m) => m[2] },
  // A precomputed `Authorization: Basic …` header is the password in base64.
  { id: 'basic-auth-header', re: /\bBasic\s+([A-Za-z0-9+/]{12,}={0,2})(?![A-Za-z0-9+/=])/g,
    secret: (m) => { const [user, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':'); return /^[\x20-\x7e]+$/.test(user) && looksSecret(rest.join(':')); },
    value: (m) => m[1] },
  // A long random token under any label (an access token pasted as "Value: …"): 32+ letters and digits, all three cases.
  { id: 'high-entropy-token', re: /(?<![A-Za-z0-9+/_-])[A-Za-z0-9]{32,}(?![A-Za-z0-9+/_-])/g,
    secret: (m) => /[A-Z]/.test(m[0]) && /[a-z]/.test(m[0]) && /\d/.test(m[0]) },
];

/** Findings for one file's text; allowlisted public values are counted in `used`, not reported. */
function scanText(file, text, used = new Set()) {
  if (PUBLIC_PATHS.some((re) => re.test(file))) return [];
  const findings = [];
  text.split('\n').forEach((line, i) => {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (let m; (m = rule.re.exec(line));) {
        if (!rule.secret(m, file)) continue;
        const value = rule.value ? rule.value(m) : m[0];
        const fp = fingerprint(value);
        if (PUBLIC_VALUES.has(fp)) { used.add(fp); continue; }
        findings.push(`${file}:${i + 1}  ${rule.id}  (${value.length} chars, sha256 ${fp.slice(0, 8)})`);
      }
    }
  });
  return findings;
}

test('no tracked file carries a credential', () => {
  const files = repoFiles().filter((f) => !BINARY.test(f) && !SKIP_FILE.test(path.basename(f)));
  assert.ok(files.length > 300, `expected the whole repository to be walked (got ${files.length} files)`);
  const used = new Set();
  const findings = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(path.join(root, f), 'utf8'); } catch { continue; } // deleted in the working tree
    if (text.includes('\0')) continue;
    findings.push(...scanText(f, text, used));
  }
  assert.deepEqual(findings, [],
    'credential-shaped values in the repository. Replace each with a placeholder such as <set in Vercel> and rotate it '
    + 'at the provider (a pushed value stays in git history). A published test value goes in PUBLIC_VALUES with its source.');
  for (const [fp, source] of PUBLIC_VALUES) assert.ok(used.has(fp), `PUBLIC_VALUES entry no longer in the repository, remove it: ${source}`);
});

test('the scanner catches every credential shape and passes placeholders', () => {
  // Built at runtime so this file never holds a credential-shaped literal of its own.
  const pw = 'k3j9x'.repeat(5) + 'q';
  const uuid = ['3f9c2a71', 'b6d4', '4e8a', '9c1f', '5a7e2d0b9c41'].join('-');
  const caught = {
    'postgres-url-password': `DATABASE_URL=postgresql://postgres.abcd:${'Qz7'}@${'x9Lm2'}@db.abcd.supabase.co:5432/postgres`,
    'meta-access-token': `TOKEN="${'EAA'}${'Gx7Kp2'.repeat(30)}"`,
    'provider-key': `OPENAI_KEY_VALUE ${'sk-'}proj-${'Ab3dE'.repeat(8)}`,
    'private-key': `${'-----BEGIN '}RSA ${'PRIVATE KEY-----'}`,
    jwt: ['eyJ' + 'hbGciOiJIUzI1', 'eyJ' + 'zdWIiOiIxMjM0', 'SflKxwRJSMeKKF2QT4fwpM'].join('.'),
    'shell-default-secret': `BLU_PASS="\${BLU_PASS:-${pw}}"`,
    'basic-auth-literal': `const basic = Buffer.from('bld:${pw}').toString('base64');`,
    'basic-auth-header': `-H "Authorization: Basic ${Buffer.from(`bld:${pw}`).toString('base64')}"`,
    'high-entropy-token': `   - Value: \`${'Qm7wZp3K'.repeat(6)}\``,
    'uuid-near-key-word': `- API key received: \`${uuid}\``,
  };
  for (const [rule, line] of Object.entries(caught)) {
    assert.ok(scanText('docs/x.md', line).some((f) => f.includes(`  ${rule}  `)), `${rule} must be caught`);
  }
  const assignments = [
    `META_WEBHOOK_VERIFY_TOKEN=${['acme', 'hook', 'secret', '2031'].join('_')}`,
    `BLU_BASIC_PASS="${pw}"`,
    `API Key: ${uuid}`,
    `  'apikey': '${uuid}',`,
    `https://example.org/webhook?hub.mode=subscribe&hub.verify_token=${pw}&hub.challenge=1`,
    `| \`WHATSAPP_VERIFY_TOKEN\` | \`${pw}\` | ✅ SET |`,
  ];
  for (const line of assignments) {
    assert.ok(scanText('docs/x.md', line).some((f) => f.includes('  secret-assignment  ')), `must be caught: ${line.split(/[=:|]/)[0]}`);
  }
  assert.equal(scanText('lib/x.js', `const opts = { apiKey: '${pw}' };`).length, 1, 'a quoted literal in code is caught');
  assert.ok(scanText('scripts/x.js', ` *   BLU_TRADE_API_KEY=${uuid} \\`).some((f) => f.includes('  secret-assignment  ')),
    'an unquoted UUID in a code comment is caught');

  const clean = [
    'BLU_BASIC_PASS=<set in Vercel>',
    'DATABASE_URL="postgresql://postgres:[YOUR-PASSWORD]@db.abcd.supabase.co:5432/postgres"',
    'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wapay',
    'META_WHATSAPP_TOKEN=  # never commit a real token here',
    'OPENAI_API_KEY=sk-proj-your-key-here',
    'BLU_API_KEY="${BLU_API_KEY:?export BLU_API_KEY first}"',
    "secret: '00000000-0000-0000-0000-000000000000',",
    'WAPAY_PARTNER_SECRET=local-e2e-secret-2026',
    'TOKEN=EAAxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    `-H "Authorization: Basic ${Buffer.from('test-user:test-pass').toString('base64')}"`,
    '-H "Authorization: Basic $(printf \'%s:%s\' "$BLU_BASIC_USER" "$BLU_BASIC_PASS" | base64)"',
    `hashcheck ${'a1b2c3d4'.repeat(8)}`,
  ];
  for (const line of clean) assert.deepEqual(scanText('docs/x.md', line), [], `placeholder must pass: ${line}`);
  assert.deepEqual(scanText('lib/x.js', 'const token = req.query.verifyToken2;'), [], 'an identifier in code is not a literal');
  assert.deepEqual(scanText('packages/providers/ott/__tests__/x.test.ts', `OTT_API_KEY=${pw}`), [], 'provider fixtures are allowed by path');
});
