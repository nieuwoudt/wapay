import test from 'node:test';
import assert from 'node:assert/strict';

import { rankProducts } from '../lib/vas-search.js';

const make = (overrides = {}) => ({
  id: `p-${Math.random()}`,
  label: 'bundle',
  fixedPriceCents: 1000,
  priceCents: 1000,
  dataMb: 500,
  metadata: { normalized: { valueScore: 50, appTags: [], searchTokens: [], periodType: 'DAILY' } },
  ...overrides,
});

test('ranks by intent match then value', () => {
  const generic = make({ dataMb: 500, metadata: { normalized: { valueScore: 50, appTags: [] } } });
  const app = make({ dataMb: 400, metadata: { normalized: { valueScore: 40, appTags: ['TIKTOK'] } } });
  const ranked = rankProducts([generic, app], { appTags: ['TIKTOK'] });
  assert.equal(ranked[0].product, app);
});

test('uses value score when intent is equal', () => {
  const betterValue = make({ dataMb: 2048, fixedPriceCents: 2000, priceCents: 2000, metadata: { normalized: { valueScore: 102.4 } } });
  const worseValue = make({ dataMb: 1024, fixedPriceCents: 2000, priceCents: 2000, metadata: { normalized: { valueScore: 51.2 } } });
  const ranked = rankProducts([worseValue, betterValue], {});
  assert.equal(ranked[0].product, betterValue);
});

