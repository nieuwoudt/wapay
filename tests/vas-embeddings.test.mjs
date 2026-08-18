import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEmbeddingText,
  contentHashOf,
  semanticProductSearch,
  syncProductEmbeddings,
  EMBEDDING_MODEL,
} from '../lib/vas-embeddings.js';

const makeProduct = (overrides = {}) => ({
  id: 'prod-1',
  label: 'Vodacom TikTok 1GB Weekly',
  networkCode: 'VODACOM',
  category: 'DATA',
  dataMb: 1024,
  validityDays: 7,
  periodType: 'WEEKLY',
  metadata: { normalized: { appTags: ['TIKTOK'] } },
  ...overrides,
});

/** Run fn with OPENAI_API_KEY forced to `value` (undefined = unset), restoring after. */
async function withApiKey(value, fn) {
  const prev = process.env.OPENAI_API_KEY;
  if (value === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
}

/** Run fn with global.fetch stubbed, restoring after. Returns recorded calls. */
async function withFetchStub(impl, fn) {
  const prev = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return impl(url, opts);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = prev;
  }
}

const okEmbeddingResponse = (vectors) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: vectors.map((embedding, index) => ({ index, embedding })) }),
  text: async () => '',
});

// ---------------------------------------------------------------------------
// buildEmbeddingText
// ---------------------------------------------------------------------------

test('buildEmbeddingText includes label, network, category, size, validity and app tags', () => {
  const text = buildEmbeddingText(makeProduct());
  assert.match(text, /Vodacom TikTok 1GB Weekly/);
  assert.match(text, /VODACOM network/);
  assert.match(text, /mobile data bundle/);
  assert.match(text, /1GB data/);
  assert.match(text, /weekly \(valid 7 days\)/);
  assert.match(text, /for TikTok/);
  assert.ok(!text.includes('\n'), 'must be a single line');
});

test('buildEmbeddingText formats MB sizes and fractional GB', () => {
  assert.match(buildEmbeddingText(makeProduct({ dataMb: 500 })), /500MB data/);
  assert.match(buildEmbeddingText(makeProduct({ dataMb: 1536 })), /1\.5GB data/);
  assert.match(buildEmbeddingText(makeProduct({ dataMb: 2048 })), /2GB data/);
});

test('buildEmbeddingText maps validity days to daily/weekly/monthly words', () => {
  assert.match(buildEmbeddingText(makeProduct({ validityDays: 1 })), /daily \(valid 1 day\)/);
  assert.match(buildEmbeddingText(makeProduct({ validityDays: 30 })), /monthly \(valid 30 days\)/);
  assert.match(buildEmbeddingText(makeProduct({ validityDays: 3 })), /valid 3 days/);
});

test('buildEmbeddingText falls back to periodType when validityDays is missing', () => {
  const p = makeProduct({ validityDays: null, periodType: 'MONTHLY' });
  assert.match(buildEmbeddingText(p), /monthly/);
});

test('buildEmbeddingText uses normalized metadata fallbacks and friendly app names', () => {
  const p = makeProduct({
    dataMb: null,
    validityDays: null,
    periodType: null,
    metadata: { normalized: { appTags: ['WHATSAPP', 'SOCIAL'], dataMb: 250, validityDays: 1 } },
  });
  const text = buildEmbeddingText(p);
  assert.match(text, /250MB data/);
  assert.match(text, /daily \(valid 1 day\)/);
  assert.match(text, /for WhatsApp, social media/);
});

test('buildEmbeddingText handles electricity products without data fields', () => {
  const text = buildEmbeddingText({
    id: 'e1',
    label: 'R50 Electricity (Eskom)',
    category: 'ELECTRICITY',
    metadata: {},
  });
  assert.match(text, /R50 Electricity \(Eskom\)/);
  assert.match(text, /prepaid electricity token/);
  assert.ok(!text.includes('undefined'));
  assert.ok(!text.includes('null'));
});

test('buildEmbeddingText is deterministic', () => {
  const a = buildEmbeddingText(makeProduct());
  const b = buildEmbeddingText(makeProduct());
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// contentHashOf
// ---------------------------------------------------------------------------

test('contentHashOf is a stable 64-char sha256 hex digest', () => {
  const h1 = contentHashOf(makeProduct());
  const h2 = contentHashOf(makeProduct());
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('contentHashOf changes when the meaning changes', () => {
  const base = contentHashOf(makeProduct());
  const relabelled = contentHashOf(makeProduct({ label: 'Vodacom TikTok 2GB Weekly' }));
  assert.notEqual(base, relabelled);
});

// ---------------------------------------------------------------------------
// semanticProductSearch graceful paths
// ---------------------------------------------------------------------------

test('semanticProductSearch returns [] without an API key and never touches the DB', async () => {
  await withApiKey(undefined, async () => {
    const prisma = {
      async $queryRaw() {
        throw new Error('DB must not be called without an API key');
      },
    };
    const out = await semanticProductSearch({ prisma, query: 'cheap tiktok bundle' });
    assert.deepEqual(out, []);
  });
});

test('semanticProductSearch returns [] when the embeddings table is missing', async () => {
  await withApiKey('test-key', async () => {
    await withFetchStub(async () => okEmbeddingResponse([[0.1, 0.2, 0.3]]), async () => {
      const prisma = {
        async $queryRaw() {
          throw new Error('relation "vas_product_embeddings" does not exist');
        },
      };
      const out = await semanticProductSearch({ prisma, query: 'tiktok weekly' });
      assert.deepEqual(out, []);
    });
  });
});

test('semanticProductSearch returns [] when the query embedding call fails', async () => {
  await withApiKey('test-key', async () => {
    await withFetchStub(async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }), async () => {
      const prisma = {
        async $queryRaw() {
          throw new Error('DB must not be reached when embedding fails');
        },
      };
      const out = await semanticProductSearch({ prisma, query: 'tiktok weekly' });
      assert.deepEqual(out, []);
    });
  });
});

test('semanticProductSearch passes the vector literal, network filter and limit to SQL', async () => {
  await withApiKey('test-key', async () => {
    await withFetchStub(async () => okEmbeddingResponse([[0.1, 0.2, 0.3]]), async (fetchCalls) => {
      const captured = [];
      const rows = [{ id: 'prod-1', label: 'Vodacom TikTok 1GB Weekly', distance: 0.12 }];
      const prisma = {
        async $queryRaw(strings, ...values) {
          captured.push({ sql: strings.join('$'), values });
          return rows;
        },
      };
      const out = await semanticProductSearch({ prisma, query: 'week of tiktok', networkCode: 'VODACOM', limit: 5 });
      assert.deepEqual(out, rows);

      assert.equal(fetchCalls.length, 1);
      const body = JSON.parse(fetchCalls[0].opts.body);
      assert.equal(body.model, EMBEDDING_MODEL);
      assert.deepEqual(body.input, ['week of tiktok']);

      assert.equal(captured.length, 1);
      assert.match(captured[0].sql, /<=>/);
      assert.ok(captured[0].values.includes('[0.1,0.2,0.3]'));
      assert.ok(captured[0].values.includes('VODACOM'));
      assert.ok(captured[0].values.includes(5));
    });
  });
});

// ---------------------------------------------------------------------------
// syncProductEmbeddings graceful paths
// ---------------------------------------------------------------------------

function syncFixtureRows() {
  const missing = makeProduct({ id: 'prod-missing' });
  const stale = makeProduct({ id: 'prod-stale', label: 'MTN YouTube 500MB Daily', networkCode: 'MTN', dataMb: 500, validityDays: 1 });
  const current = makeProduct({ id: 'prod-current', label: 'CellC 2GB Monthly', networkCode: 'CELLC', dataMb: 2048, validityDays: 30 });
  return [
    { ...missing, existingContentHash: null },
    { ...stale, existingContentHash: 'old-hash-no-longer-matching' },
    { ...current, existingContentHash: contentHashOf(current) },
  ];
}

test('syncProductEmbeddings without an API key counts pending products as skipped', async () => {
  await withApiKey(undefined, async () => {
    const prisma = {
      async $queryRaw() {
        return syncFixtureRows();
      },
      async $executeRaw() {
        throw new Error('must not upsert without an API key');
      },
    };
    const out = await syncProductEmbeddings({ prisma });
    assert.equal(out.embedded, 0);
    assert.equal(out.skipped, 2); // missing + stale; the current one is up to date
    assert.equal(out.failed, 0);
    assert.equal(out.upToDate, 1);
    assert.equal(out.total, 3);
  });
});

test('syncProductEmbeddings survives a missing embeddings table', async () => {
  await withApiKey(undefined, async () => {
    const prisma = {
      async $queryRaw() {
        throw new Error('relation "vas_product_embeddings" does not exist');
      },
    };
    const out = await syncProductEmbeddings({ prisma });
    assert.equal(out.embedded, 0);
    assert.equal(out.skipped, 0);
    assert.equal(out.failed, 0);
    assert.ok(out.error);
  });
});

test('syncProductEmbeddings embeds only stale/missing products and upserts vectors', async () => {
  await withApiKey('test-key', async () => {
    await withFetchStub(
      async () => okEmbeddingResponse([[0.1, 0.2], [0.3, 0.4]]),
      async (fetchCalls) => {
        const upserts = [];
        const prisma = {
          async $queryRaw() {
            return syncFixtureRows();
          },
          async $executeRaw(strings, ...values) {
            upserts.push({ sql: strings.join('$'), values });
            return 1;
          },
        };
        const out = await syncProductEmbeddings({ prisma });
        assert.equal(out.embedded, 2);
        assert.equal(out.failed, 0);
        assert.equal(out.skipped, 0);
        assert.equal(out.upToDate, 1);

        assert.equal(fetchCalls.length, 1); // 2 pending, one batch of 96
        const body = JSON.parse(fetchCalls[0].opts.body);
        assert.equal(body.model, EMBEDDING_MODEL);
        assert.equal(body.input.length, 2);

        assert.equal(upserts.length, 2);
        assert.ok(upserts[0].values.includes('prod-missing'));
        assert.ok(upserts[0].values.includes('[0.1,0.2]'));
        assert.ok(upserts[1].values.includes('prod-stale'));
        assert.match(upserts[0].sql, /ON CONFLICT \("productId"\)/);
      }
    );
  });
});

test('syncProductEmbeddings logs and continues when the OpenAI call fails', async () => {
  await withApiKey('test-key', async () => {
    await withFetchStub(
      async () => ({ ok: false, status: 429, text: async () => 'rate limited', json: async () => ({}) }),
      async () => {
        const prisma = {
          async $queryRaw() {
            return syncFixtureRows();
          },
          async $executeRaw() {
            throw new Error('must not upsert when the batch failed');
          },
        };
        const out = await syncProductEmbeddings({ prisma });
        assert.equal(out.embedded, 0);
        assert.equal(out.failed, 2);
        assert.equal(out.upToDate, 1);
      }
    );
  });
});
