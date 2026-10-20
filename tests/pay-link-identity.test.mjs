// Pay-link identity (2026-10-20): the pay page shows the requester's number
// tail next to their self-chosen name and tells the payer to check it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requesterNumberTail, requesterLabelWithTail, maskedRequesterLabel } from '../lib/payment-requests.js';

test('requesterNumberTail: last three digits only, never the middle, null when unknown', () => {
  assert.equal(requesterNumberTail({ msisdn: '0761234567' }), '•••567');
  assert.equal(requesterNumberTail({ msisdn: '+27 76 123 4567' }), '•••567');
  assert.equal(requesterNumberTail({ msisdn: '12' }), null);
  assert.equal(requesterNumberTail({}), null);
  assert.equal(requesterNumberTail(null), null);
  assert.ok(!requesterNumberTail({ msisdn: '0761234567' }).includes('1234'));
});

test('requesterLabelWithTail: name plus tail; a masked number is not doubled', () => {
  assert.equal(requesterLabelWithTail({ displayName: 'Philly', msisdn: '0761234567' }), 'Philly •••567');
  assert.equal(requesterLabelWithTail({ msisdn: '0761234567' }), maskedRequesterLabel({ msisdn: '0761234567' }));
  assert.equal(requesterLabelWithTail({ displayName: 'Philly' }), 'Philly');
  assert.equal(requesterLabelWithTail(null), 'A WaPay user');
});

test('pay page: shows the tail in the title and heading, warns the payer, business links carry no tail', () => {
  const src = fs.readFileSync(new URL('../pages/pay/[code].js', import.meta.url), 'utf8');
  assert.match(src, /requesterTail = requesterNumberTail\(account\)/, 'tail computed from the requester account');
  assert.match(src, /maskedRequesterLabel\(account\)/, 'the masked label is still the base');
  assert.match(src, /requesterTail = null;\s*\n\s*isBusiness = true;/, 'business links drop the tail');
  assert.match(src, /Please pay \$\{shownLabel\}/, 'link preview title carries the tail');
  assert.match(src, /\{shownLabel\} is requesting/, 'heading carries the tail');
  assert.match(src, /Check the number\. This request comes from the WaPay account on a number ending \{requesterTail\}\./);
  assert.match(src, /If that is not the person you expect, do not pay\./);
  const warning = src.slice(src.indexOf('Check the number.'), src.indexOf('do not pay.') + 11);
  assert.ok(!/—/.test(warning), 'no em dash in customer copy');
  assert.ok(!/withdraw|cash-out|banking/i.test(warning), 'no banned words in the warning');
});
