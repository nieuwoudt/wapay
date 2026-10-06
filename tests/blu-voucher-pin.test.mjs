/**
 * Blu Voucher PINs come in two shapes. Blu's own test batch of 14 September
 * 2026 carried 12-digit PINs (supplier code 41), and on 2026-10-06 the QA
 * status endpoint answered ACTIVE with the face value for them, while the
 * chat refused anything but 16 digits before any call was made (founder's
 * screenshot: "This is one of the test vouchers that was provided ... that
 * obviously didn't work"). Both shapes must open the redemption; the copy
 * must say so; a bare 12-digit message outside a flow is a PIN, never an
 * amount, and is redacted from memory like a 16-digit one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { redactForMemory } from '../lib/turns.js';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

test('both PIN shapes open the Blu redemption, from the bare-PIN hook and inside the voucher state', async () => {
  const src = await read('pages/api/webhooks/message-processor-v2.js');
  assert.ok(src.includes("if (/^\\d{16}$/.test(digitsOnly)) {\n    return { intent: 'VOUCHER_PIN'"), 'the 16-digit hook is unchanged (locked byte for byte by tests/agent-guards)');
  assert.ok(src.includes("if (/^\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}$/.test(text.trim())) {"), 'a BARE 12-digit PIN opens the redemption, the same shape lib/agent/guards.js takes');
  assert.ok(src.includes('if (!/^(\\d{12}|\\d{16})$/.test(normalizedPin)) {'), 'the voucher state accepts 12 or 16 digits');
  assert.ok(!/Please enter your 16-digit Blu Voucher PIN/.test(src), 'no prompt still demands 16 digits');
  assert.ok(!/valid 16-digit Blu Voucher PIN/.test(src), 'no rejection still demands 16 digits');
  assert.ok(src.includes('12 or 16 digits'), 'the copy names both shapes');
});

test('a 12-digit PIN is redacted from memory like a 16-digit one', () => {
  const twelve = redactForMemory('here is my voucher 483216749052');
  const sixteen = redactForMemory('here is my voucher 4832167490521234');
  assert.ok(!twelve.includes('483216749052'), 'twelve digits never stored');
  assert.ok(!sixteen.includes('4832167490521234'), 'sixteen digits never stored');
});
