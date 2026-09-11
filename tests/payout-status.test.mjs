/** The OTT payout probe is read-only, gated, and never echoes a credential. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const src = readFileSync(fileURLToPath(new URL('../pages/api/internal/payout-status.js', import.meta.url)), 'utf8');
test('payout-status: internal-key gated (constant-time), GET only, OTT reads only, credentials masked', () => {
  assert.match(src, /if \(req\.method !== 'GET'\) return res\.status\(405\)/);
  assert.match(src, /if \(!keyOk\(req\)\) return res\.status\(401\)/);
  assert.match(src, /timingSafeEqual/);
  assert.match(src, /Cache-Control', 'private, no-store'/);
  // Only the three read endpoints; never a pay-out.
  assert.ok(!/performPayout|requestPayout|\.payout\(/.test(src), 'the probe must not be able to move money');
  assert.match(src, /client\.getBalance\(/); assert.match(src, /client\.getActiveProviders\(/); assert.match(src, /getActiveProviderLimits\(/);
  // Credentials are reported as presence/masked only.
  assert.match(src, /password: !!process\.env\.OTT_PAYOUT_PASSWORD/);
  assert.match(src, /apiKey: mask\(process\.env\.OTT_PAYOUT_API_KEY\)/);
  assert.match(src, /username: mask\(process\.env\.OTT_PAYOUT_USERNAME\)/);
  assert.ok(!/apiKey:\s*process\.env|password:\s*process\.env/.test(src), 'no raw secret in the payload');
  assert.match(src, /_resetProviderCache\(\)/, 'the probe reads fresh provider data');
});
