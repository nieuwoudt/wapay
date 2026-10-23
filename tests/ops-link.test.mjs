import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.WAPAY_INTERNAL_API_KEY ||= 'test-internal-key-for-links';
const { mintOpsPayoutLink, verifyOpsPayoutLink, OPS_LINK_TTL_MS } = await import('../lib/ops-link.js');

test('a minted link verifies, carries its fixed intent, and expires', () => {
  const now = 1_700_000_000_000;
  const t = mintOpsPayoutLink({ accountId: 'acc1', destinationId: 'd1', amountCents: 286440, by: 'founder', reason: 'restriction', now });
  const v = verifyOpsPayoutLink(t, { now: now + 1000 });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.data.accountId, 'acc1');
  assert.equal(v.data.amountCents, 286440);
  assert.match(v.data.intentId, /^ops-/);
  assert.equal(verifyOpsPayoutLink(t, { now: now + OPS_LINK_TTL_MS + 1 }).reason, 'EXPIRED');
  assert.equal(verifyOpsPayoutLink(t.slice(0, -2) + 'xx', { now }).reason, 'BAD_SIGNATURE');
  assert.equal(verifyOpsPayoutLink('nonsense', { now }).reason, 'MISSING');
  assert.equal(mintOpsPayoutLink({ accountId: 'acc1', destinationId: 'd1', amountCents: 100, by: 'x', reason: '' }), null);
});

test('two mints of the same pay-out keep the same intent when one is given', () => {
  const a = mintOpsPayoutLink({ accountId: 'acc1', destinationId: 'd1', amountCents: 100, by: 'f', reason: 'r', intentId: 'ops-fixed-0001' });
  assert.equal(verifyOpsPayoutLink(a).data.intentId, 'ops-fixed-0001');
});
