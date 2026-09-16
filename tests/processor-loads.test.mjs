/**
 * The message processor must LOAD. Every other lock on it reads the source
 * as text, so a syntax error (a duplicate `let`, an unbalanced brace) passed
 * the unit suite on 2026-09-16 and was only caught by the build and the live
 * harness. Importing the module is the cheapest possible guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('pages/api/webhooks/message-processor-v2.js imports without throwing', async () => {
  const mod = await import('../pages/api/webhooks/message-processor-v2.js');
  assert.ok(mod, 'module evaluated');
});
