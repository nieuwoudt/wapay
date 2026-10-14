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
const BLU_CLIENT = /\b(BluVasClient|BluClient|BluVasExtendedClient)\b/;

test('every VAS or internal route that imports a Blu client requires the internal key', () => {
  const files = [...walk(path.join(root, 'pages/api/vas')), ...walk(path.join(root, 'pages/api/internal'))];
  const offenders = files
    .filter((f) => BLU_CLIENT.test(readFileSync(f, 'utf8')))
    .filter((f) => !readFileSync(f, 'utf8').includes('requireInternalAuth('))
    .map((f) => path.relative(root, f));
  assert.deepEqual(offenders, [], `routes reaching Blu without the internal key: ${offenders.join(', ')}`);
});

test('the bundles-by-network listing reads the catalogue table and never the supplier', () => {
  const src = readFileSync(path.join(root, 'pages/api/vas/bundles/[network].js'), 'utf8');
  assert.ok(!BLU_CLIENT.test(src), 'no Blu client in a listing route');
  assert.ok(src.includes('requireInternalAuth('), 'internal key required');
  assert.ok(src.includes("prisma.vasProduct.findMany"), 'served from VasProduct');
});
