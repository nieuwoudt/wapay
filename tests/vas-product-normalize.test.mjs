import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBluProduct } from '../lib/vas-normalize.js';

test('normalizes social/app bundles', () => {
  const p = normalizeBluProduct({ name: 'Monthly WhatsApp 1GB', amountCents: 3000 });
  assert.ok(p.appTags.includes('WHATSAPP'));
  assert.equal(p.productType, 'SOCIAL_APP');
  assert.equal(p.periodType, 'MONTHLY');
  assert.equal(p.dataMb, 1024);
});

test('infers TikTok + weekly validity', () => {
  const p = normalizeBluProduct({ name: 'Weekly Tik Tok 500MB', amountCents: 1500 });
  assert.ok(p.appTags.includes('TIKTOK'));
  assert.equal(p.periodType, 'WEEKLY');
  assert.equal(p.dataMb, 500);
});

test('computes value score for ranking', () => {
  const p = normalizeBluProduct({ name: '1GB Daily', amountCents: 2000, sizeMb: 1024, validityDays: 1 });
  assert.ok(p.valueScore > 0);
});

