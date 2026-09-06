/** The Meta status probe is read-only, gated, and never echoes a token. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const src = readFileSync(fileURLToPath(new URL('../pages/api/internal/meta-status.js', import.meta.url)), 'utf8');
test('meta-status: internal-key gated (constant-time), GET only, Graph reads only, tokens never in the payload', () => {
  assert.match(src, /if \(req\.method !== 'GET'\) return res\.status\(405\)/);
  assert.match(src, /if \(!keyOk\(req\)\) return res\.status\(401\)/);
  assert.match(src, /timingSafeEqual/);
  assert.ok(!/method:\s*['"]POST['"]|method:\s*['"]DELETE['"]/.test(src), 'no writes to Graph');
  assert.match(src, /token: !!token/, 'token reported as present/absent only');
  // Graph request params legitimately carry the token (access_token, input_token); the response object must not.
  const responseSide = src.replace(/url\.searchParams\.set\('access_token', token\)/g, '').replace(/input_token: token/g, '');
  assert.ok(!/accessToken:\s*token|token:\s*token\b|access_token:\s*token\b/.test(responseSide), 'the token value is never placed in the response');
  assert.ok(!/\bout\.[\w.]+\s*=\s*token\b/.test(src), 'no out.* field is assigned the raw token');
  assert.match(src, /Cache-Control', 'private, no-store'/);
  assert.match(src, /mask\(phoneNumberId\)/); assert.match(src, /mask\(wabaId\)/);
});
