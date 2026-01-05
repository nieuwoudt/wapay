import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSlots } from '../lib/slot-parser.js';
import { extractNetwork } from '../packages/nlp/dist/entities.js';

const cases = [
  ['cell c bundles', 'CELLC'],
  ['cell-c data', 'CELLC'],
  ['sell c data', 'CELLC'],
  ['telcom data', 'TELKOM'],
  ['tellkom data', 'TELKOM'],
  ['vodacomn data', 'VODACOM'],
  ['mtnn data', 'MTN'],
];

test('slot parser normalizes misspelled networks', () => {
  for (const [text, expected] of cases) {
    const slots = parseSlots(text);
    assert.equal(slots.networkCode, expected, `failed for ${text}`);
  }
});

test('NLP entity extractor returns confidence and code', () => {
  for (const [text, expected] of cases) {
    const net = extractNetwork(text);
    assert.ok(net, `no network for ${text}`);
    assert.equal(net.code, expected);
    assert.ok(net.confidence === undefined || net.confidence >= 0.6);
  }
});

