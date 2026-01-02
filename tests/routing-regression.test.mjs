import test from 'node:test';
import assert from 'node:assert/strict';

import { decideCommerceRoute } from '../lib/agentic-commerce-routing.js';

test('routing: one-shot airtime with amount+msisdn never asks for msisdn', () => {
  const r = decideCommerceRoute({ text: 'Buy R10 airtime for 0840012300', currentState: null, stateData: null });
  assert.equal(r.routeDecision, 'AIRTIME_PREVIEW_CONFIRM');
  assert.equal(r.nextState, 'AIRTIME_CONFIRM');
  assert.equal(r.missing.length, 0);
  assert.equal(r.slots.msisdn, '0840012300');
  assert.equal(r.slots.amountCents, 1000);
});

test('routing: airtime missing msisdn asks only for msisdn', () => {
  const r = decideCommerceRoute({ text: 'Buy R10 airtime', currentState: null, stateData: null });
  assert.equal(r.routeDecision, 'AIRTIME_MSISDN');
  assert.equal(r.nextState, 'AIRTIME_MSISDN');
  assert.deepEqual(r.missing, ['msisdn']);
});

test('routing: in AIRTIME_MSISDN state, providing msisdn completes without re-asking', () => {
  const r = decideCommerceRoute({
    text: '0840012300',
    currentState: 'AIRTIME_MSISDN',
    stateData: { amountCents: 1000 },
  });
  assert.equal(r.routeDecision, 'AIRTIME_PREVIEW_CONFIRM');
  assert.equal(r.nextState, 'AIRTIME_CONFIRM');
  assert.equal(r.missing.length, 0);
});

test('routing: send money with amount+msisdn routes to confirm (placeholder)', () => {
  const r = decideCommerceRoute({ text: 'Send R30 to 08798908089', currentState: null, stateData: null });
  assert.equal(r.routeDecision, 'SEND_MONEY_CONFIRM');
});

test('routing: one-shot electricity with amount+meter routes to electricity confirm', () => {
  const r = decideCommerceRoute({ text: 'buy R100 electricity for meter 100228728', currentState: null, stateData: null });
  assert.equal(r.routeDecision, 'ELECTRICITY_CONFIRM');
  assert.equal(r.nextState, 'ELECTRICITY_CONFIRM');
  assert.equal(r.missing.length, 0);
  assert.equal(r.slots.amountCents, 10000);
  assert.equal(r.slots.meterNumber, '100228728');
});


