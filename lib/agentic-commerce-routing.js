/**
 * Regression-guarded routing helpers for Agentic Commerce.
 *
 * These helpers are PURE (no DB, no network) so we can unit test routing
 * decisions that previously regressed (SMART_PRODUCT_QUERY bypass).
 */

import { parseSlots } from './slot-parser.js';

export function decideCommerceRoute({ text = '', currentState = null, stateData = null }) {
  const slots = parseSlots(text);

  // In-state jump: if user is in AIRTIME_MSISDN and provides MSISDN (and amount already known),
  // we should go straight to confirmation flow.
  if (currentState === 'AIRTIME_MSISDN') {
    const amountCents = slots.amountCents || stateData?.amountCents || null;
    if (amountCents && slots.msisdn) {
      return {
        routeDecision: 'AIRTIME_PREVIEW_CONFIRM',
        nextState: 'AIRTIME_CONFIRM',
        missing: [],
        slots: { ...slots, amountCents, productHint: 'AIRTIME' },
      };
    }
    return {
      routeDecision: 'AIRTIME_MSISDN',
      nextState: 'AIRTIME_MSISDN',
      missing: ['msisdn'],
      slots: { ...slots, amountCents, productHint: 'AIRTIME' },
    };
  }

  // Stateless routing based on complete slots
  if (slots.productHint === 'AIRTIME') {
    if (slots.amountCents && slots.msisdn) {
      return { routeDecision: 'AIRTIME_PREVIEW_CONFIRM', nextState: 'AIRTIME_CONFIRM', missing: [], slots };
    }
    if (slots.amountCents && !slots.msisdn) {
      return { routeDecision: 'AIRTIME_MSISDN', nextState: 'AIRTIME_MSISDN', missing: ['msisdn'], slots };
    }
    if (!slots.amountCents && slots.msisdn) {
      return { routeDecision: 'AIRTIME_AMOUNT', nextState: 'AIRTIME_AMOUNT', missing: ['amountCents'], slots };
    }
  }

  if (slots.productHint === 'SEND_MONEY' && slots.amountCents && slots.msisdn) {
    return { routeDecision: 'SEND_MONEY_CONFIRM', nextState: 'SEND_MONEY_CONFIRM', missing: [], slots };
  }

  return { routeDecision: 'NO_COMMERCE_ROUTE', nextState: null, missing: [], slots };
}


