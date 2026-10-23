import { test } from 'node:test';
import assert from 'node:assert/strict';
const { marketingTemplatesEnabled } = await import('../packages/auth/dist/onboarding.js');

test('the two MARKETING onboarding templates are off unless the flag says on (2026-10-21 restriction)', () => {
  delete process.env.WAPAY_ONBOARDING_MARKETING_TEMPLATES;
  assert.equal(marketingTemplatesEnabled(), false);
  process.env.WAPAY_ONBOARDING_MARKETING_TEMPLATES = 'off';
  assert.equal(marketingTemplatesEnabled(), false);
  process.env.WAPAY_ONBOARDING_MARKETING_TEMPLATES = 'on';
  assert.equal(marketingTemplatesEnabled(), true);
  delete process.env.WAPAY_ONBOARDING_MARKETING_TEMPLATES;
});
