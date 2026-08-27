/**
 * Pay-page founder feedback round 4 (2026-08-27, 14:06 screenshot):
 * - the hero goes BACK to the big/bold pre-round-2 design ("🙏 Please Pay
 *   Me" 28px/800 over a small "with WaPay" line) — only the ™ is small
 *   and non-bold, which was the round-2 ask all along;
 * - the card/EFT button lights up (solid green) the moment a plausible
 *   number is typed, and a tap WITHOUT one answers with our own popup
 *   ("Enter your WhatsApp number first.") instead of a silent bounce.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const page = readFileSync(
  fileURLToPath(new URL('../pages/pay/[code].js', import.meta.url)),
  'utf8'
);

test('hero is big and bold again; only the TM is small and non-bold', () => {
  assert.match(page, /logo: \{ color: '#1d7a3f', fontSize: 28, fontWeight: 800/, 'hero back to 28px/800');
  assert.match(page, /tm: \{ fontSize: 13, fontWeight: 400/, 'TM small and non-bold');
  assert.match(page, /Please Pay Me\s*\n?\s*<span style=\{styles\.tm\}>™<\/span>/, 'TM split into its own styled span');
  assert.match(page, />with WaPay<\/div>/, 'the WaPay line is back under the phrase');
});

test('card button lights up on a plausible number, stays quiet otherwise', () => {
  assert.match(page, /numberLooksOk \? styles\.cardReady : styles\.secondary/, 'conditional highlight');
  assert.match(page, /PAYER_NUMBER_SHAPE = \/\^\[0-9\+ \]\{10,15\}\$\//, 'one named shape, same as the input pattern');
  assert.match(page, /PAYER_NUMBER_SHAPE\.test\(domValue\.trim\(\)\)/, 'submit gate reads the DOM value (autofill can skip onChange)');
  assert.match(page, /cardReady: \{\s*\n\s*background: '#1d7a3f'/, 'lit state is the solid brand green');
});

test('tapping card/EFT without a number pops our nudge, not a browser bounce', () => {
  assert.match(page, /noValidate/, 'native validation replaced by our gate');
  assert.match(page, /e\.preventDefault\(\);\s*\n\s*setNumberNudge\(true\);\s*\n\s*payerInputRef\.current\?\.focus\(\)/, 'block, nudge, focus');
  assert.match(page, /numberNudge && !numberLooksOk \? \(/, 'nudge hides itself the moment the number is in');
  assert.match(page, /📱 Enter your WhatsApp number first\./, 'the exact popup copy');
});

test('round-4 additions carry no em dashes in client-facing copy', () => {
  const clientStrings = page.match(/Enter your WhatsApp number first[^<]*/g) || [];
  for (const s of clientStrings) assert.ok(!s.includes('—'), `em dash in: ${s}`);
});
