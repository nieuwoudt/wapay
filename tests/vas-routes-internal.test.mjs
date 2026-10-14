/**
 * No VAS route may reach a supplier without the internal key (2026-10-14).
 *
 * /api/vas/bundles/:network was public and fetched the bundle list live from
 * Blu on every request; Blu reported "unusually high volumes of traffic from
 * your credentials" for the night of 13 October while WaPay's own records
 * carried no vends, no previews and no chat. A crawler or monitor on a public
 * proxy route is indistinguishable from us at the supplier. This lock walks
 * every route under pages/api/vas and pages/api/internal: a file that imports
 * a Blu client must call requireInternalAuth, and listing routes read our
 * catalogue table, never the supplier.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.js$/.test(name)) out.push(p);
  }
  return out;
}
const BLU_CLIENT = /\b(BluVasClient|BluClient|BluVasExtendedClient|BLU_BASE_URL)\b/;
// The gates a Blu-reaching route may stand behind. The WhatsApp webhook is
// excluded from the walk: its gate is Meta's signature on the request.
const GATES = [
  /requireInternalAuth\(/,          // operator and chat-internal routes
  /isCronAuthed\(/,                 // the daily catalogue sync (Vercel cron header or CRON_SECRET)
  /ADMIN_API_KEY|x-admin-key/,      // the manual catalogue sync
];

test('every route under pages/api that reaches Blu stands behind a gate', () => {
  const files = walk(path.join(root, 'pages/api')).filter((f) => !f.includes(`${path.sep}webhooks${path.sep}`));
  const reaching = files.filter((f) => BLU_CLIENT.test(readFileSync(f, 'utf8')));
  assert.ok(reaching.length >= 7, `expected the known Blu-reaching routes to be found (got ${reaching.length})`);
  const offenders = reaching
    .filter((f) => !GATES.some((g) => g.test(readFileSync(f, 'utf8'))))
    .map((f) => path.relative(root, f));
  assert.deepEqual(offenders, [], `routes reaching Blu without a gate: ${offenders.join(', ')}`);
  // The gates are real functions, not comments: each named gate exists where it is relied on.
  const cron = readFileSync(path.join(root, 'pages/api/cron/daily-vas-sync.js'), 'utf8');
  assert.ok(/function isCronAuthed\(/.test(cron) && /if \(!isCronAuthed\(req\)\)/.test(cron), 'the cron sync checks its gate');
  const admin = readFileSync(path.join(root, 'pages/api/admin/sync-vas-catalog.js'), 'utf8');
  assert.ok(/ADMIN_API_KEY/.test(admin), 'the manual sync checks the admin key');
});

test('the bundles-by-network listing reads the catalogue table and never the supplier', () => {
  const src = readFileSync(path.join(root, 'pages/api/vas/bundles/[network].js'), 'utf8');
  assert.ok(!BLU_CLIENT.test(src), 'no Blu client in a listing route');
  assert.ok(src.includes('requireInternalAuth('), 'internal key required');
  assert.ok(src.includes("prisma.vasProduct.findMany"), 'served from VasProduct');
});
