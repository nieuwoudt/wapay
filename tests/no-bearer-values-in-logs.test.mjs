/**
 * Bearer values never reach a log (constitution invariant 8; security sweep 2026-11-13).
 *
 * A voucher PIN is money until it is redeemed and an electricity token is the
 * customer's purchase: whoever reads one can use it. These lock the three
 * places the sweep found one written down where it should not be.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('the Blu status check logs the path with the PIN masked, never the address it calls', () => {
  const src = read('packages/providers/blu/src/client.ts');
  const start = src.indexOf('async checkStatus(pin: string)');
  const body = src.slice(start, src.indexOf('\n  async ', start + 10));
  assert.match(body, /const url = `\$\{this\.base\}\/voucher\/variable\/vouchers\?token=\$\{encodeURIComponent\(pin\)\}`;/, 'the call still carries the PIN: that is the supplier\'s interface');
  assert.match(body, /const logUrl = `\$\{this\.base\}\/voucher\/variable\/vouchers\?token=\$\{maskVoucherPin\(pin\)\}`;/);
  const logged = [...body.matchAll(/console\.(?:log|error|warn)\([^;]*?\{([\s\S]*?)\}\s*\);/g)].map((m) => m[1]);
  assert.ok(logged.length >= 2, 'the request and the failure are both logged');
  for (const fields of logged) {
    assert.ok(!/(^|[\s,{])url,/.test(fields) && !/url:\s*url\b/.test(fields), 'no log call in the status check carries the raw address');
    assert.ok(!/\bpin:\s*pin\b|\btoken:\s*pin\b/.test(fields), 'nor the raw PIN');
  }
});

test('a supplier error body is logged with any echo of the PIN masked', async () => {
  const src = read('packages/providers/blu/src/client.ts');
  assert.ok(!/responseBody:\s*(errorBody|errorData)\s*,/.test(src), 'no raw supplier body in a log call');
  assert.equal((src.match(/responseBody: bodyForLog\((errorBody|errorData), pin\)/g) || []).length, 2, 'the status failure and the redeem failure');
  // Behaviour, when the package is built (pnpm build:packages): the mask replaces every echo, in text and in JSON.
  const blu = await import('@wapay/providers-blu');
  if (typeof blu.bodyForLog !== 'function') return;
  const pin = '4' + '7'.repeat(11);
  const masked = blu.bodyForLog({ message: `Voucher ${pin} is not valid`, token: pin }, pin);
  assert.equal(typeof masked, 'string');
  assert.ok(!masked.includes(pin), 'the PIN is gone');
  assert.ok(masked.includes('not valid'), 'the meaning is kept');
  assert.ok(!blu.bodyForLog(`echo ${pin} twice ${pin}`, pin).includes(pin));
  assert.equal(blu.bodyForLog({ message: 'Service unavailable' }, pin), '{"message":"Service unavailable"}', 'a body without the PIN is unchanged');
  assert.equal(blu.bodyForLog('x'.repeat(5000), pin).length, 2000, 'and cut');
});

test('the electricity sale logs that a token exists, not the token', () => {
  const src = read('pages/api/vas/electricity/execute.js');
  const calls = [];
  for (let at = src.indexOf("logStructured('vas_electricity_execute_result'"); at > -1; at = src.indexOf("logStructured('vas_electricity_execute_result'", at + 1)) {
    calls.push(src.slice(at, src.indexOf('});', at)));
  }
  assert.ok(calls.length >= 5, `${calls.length} result logs`);
  for (const call of calls) assert.ok(!/\btoken:\s*bluResult\.token|\btoken:\s*token\b/.test(call), 'the token goes to the customer in the response, never to the log');
  const success = calls.filter((c) => /success: true/.test(c));
  assert.ok(success.length >= 1);
  assert.ok(success.some((c) => /tokenPresent: Boolean\(bluResult\.token\)/.test(c)), 'the success log says only that a token exists');
});

test('no document carries a WhatsApp registration PIN', () => {
  const walk = (dir, out = []) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      const st = lstatSync(join(ROOT, rel));
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(rel, out); else if (/\.(md|txt|sh)$/.test(name)) out.push(rel);
    }
    return out;
  };
  const hits = walk('docs').filter((rel) => /"pin"\s*:\s*"\d{6}"|2FA PIN \| \d{6}|registration PIN \(\d{6}\)/.test(read(rel)));
  assert.deepEqual(hits, []);
});
