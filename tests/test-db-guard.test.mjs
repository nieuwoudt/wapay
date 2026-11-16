// Tests never reach a real database unless one is named for them (founder 2026-10-24). Prisma loads the
// project's .env by itself and the fast copy's .env holds PRODUCTION, so both shared clients point at
// TEST_DATABASE_URL, or at a closed local port, whenever `node --test` runs them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { default: prisma, testDatabaseUrl, NO_TEST_DATABASE_URL } = await import('../lib/prisma.js');
const { getPrisma } = await import('../packages/domain/dist/db.js');
const root = fileURLToPath(new URL('..', import.meta.url));

test('the URL a test process gets: none outside tests, the named test database, or a closed port', () => {
  assert.equal(testDatabaseUrl({}), null, 'production and scripts are untouched');
  assert.equal(testDatabaseUrl({ NODE_TEST_CONTEXT: 'child-v8' }), NO_TEST_DATABASE_URL);
  assert.equal(testDatabaseUrl({ NODE_TEST_CONTEXT: 'child-v8', TEST_DATABASE_URL: 'postgresql://t@localhost:5433/wapay_test' }), 'postgresql://t@localhost:5433/wapay_test');
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test marks this process');
});

test('both shared clients refuse at the closed port instead of reaching the .env database', { skip: !!process.env.TEST_DATABASE_URL && 'a test database is named' }, async () => {
  for (const [name, client] of [['lib/prisma.js', prisma], ['packages/domain getPrisma()', getPrisma()]]) {
    await assert.rejects(client.$queryRawUnsafe('select 1'), (e) => {
      assert.match(String(e?.message), /127\.0\.0\.1:1/, `${name} tried the closed port`);
      assert.doesNotMatch(String(e?.message), /supabase/i, `${name} never reached Supabase`);
      return true;
    });
  }
});

test('every place that builds a PrismaClient carries the test guard', () => {
  const sites = [];
  for (const dir of ['lib', 'pages', 'packages/domain/src', 'packages/auth/src', 'packages/ai/src', 'packages/whatsapp/src']) {
    for (const f of readdirSync(`${root}${dir}`, { recursive: true })) {
      if (!/\.(m?js|tsx?)$/.test(f)) continue;
      const rel = `${dir}/${f}`;
      const src = readFileSync(`${root}${rel}`, 'utf8');
      if (!/new PrismaClient\(/.test(src)) continue;
      sites.push(rel);
      assert.ok(/NODE_TEST_CONTEXT|testDatabaseUrl\(/.test(src), `${rel} builds a client without the test guard`);
    }
  }
  assert.deepEqual(sites.sort(), ['lib/prisma.js', 'packages/domain/src/db.ts', 'packages/whatsapp/src/seedTemplates.ts', 'packages/whatsapp/src/templateCatalog.ts']);
});
