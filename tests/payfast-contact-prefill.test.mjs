/**
 * BUGLOG #36 — PayFast asked the depositor "How can we get hold of you?"
 * even though the customer is known. The deposit checkout must prefill
 * cell_number, and the package must normalize 27-format to PayFast's local
 * 0-format (a 27-format value silently fails to prefill).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCheckoutUrl } from '../packages/providers/payfast/dist/checkout.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const base = {
  merchantId: '10000100',
  merchantKey: '46f0cd694581a',
  sandbox: true,
  amountCents: 10000,
  mPaymentId: 'test-1',
  itemName: 'WaPay top-up',
  returnUrl: 'https://x/r',
  cancelUrl: 'https://x/c',
  notifyUrl: 'https://x/n',
};

test('27-format waId becomes local 0-format cell_number', () => {
  const url = buildCheckoutUrl({ ...base, cellNumber: '27787051175' });
  assert.match(url, /cell_number=0787051175/);
});

test('0-format passes through; garbage is dropped, not sent broken', () => {
  assert.match(buildCheckoutUrl({ ...base, cellNumber: '078 705 1175' }), /cell_number=0787051175/);
  assert.ok(!buildCheckoutUrl({ ...base, cellNumber: 'not-a-number' }).includes('cell_number'));
  assert.ok(!buildCheckoutUrl({ ...base }).includes('cell_number'));
});

test('deposit flow passes the customer number to checkout', () => {
  const src = read('../pages/api/webhooks/message-processor-v2.js');
  const depositBlock = src.slice(src.indexOf("itemName: 'WaPay top-up'") - 600, src.indexOf("itemName: 'WaPay top-up'") + 600);
  assert.match(depositBlock, /cellNumber:\s*from/, 'deposit checkout must prefill the depositor cell');
});

test('paylink flow still prefills the payer number', () => {
  const src = read('../pages/api/pay/checkout.js');
  assert.match(src, /cellNumber:\s*payerMsisdn/);
});
