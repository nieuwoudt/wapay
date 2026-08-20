/**
 * Card / Instant EFT deposit routing — "deposit R100" becomes a PayFast link.
 *
 * Pure tests (no DB, no network) locking:
 * - 'deposit R100' -> amount extraction (parseSlots) and a deposit-link
 *   routing decision via the SHIPPED detection pattern (extracted from the
 *   processor source, so the tests exercise the exact regex that routes);
 * - bare "deposit money" still falls through to the two-option prompt;
 * - the deposit prompt copy offers BOTH options (Blu voucher stays option 1);
 * - static wiring: the processor imports @wapay/providers-payfast checkout
 *   and lib/deposits.js createDepositIntent, wires m_payment_id/notify_url
 *   per the ITN contract, and NO wallet-PIN gate guards link creation.
 *
 * The processor is checked statically (no import — it pulls Prisma).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseSlots } from '../lib/slot-parser.js';

const processorSource = readFileSync(
  fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)),
  'utf8'
);

/** The exact card-deposit regex the processor ships (one-line by contract). */
function shippedDepositPattern() {
  const m = processorSource.match(/const DEPOSIT_CARD_PATTERN = \/(.*)\/([a-z]*);/);
  assert.ok(m, 'processor must define DEPOSIT_CARD_PATTERN on a single line');
  return new RegExp(m[1], m[2]);
}

/** The body of handleCardDepositLink, sliced out of the processor source. */
function cardDepositHandlerSource() {
  const start = processorSource.indexOf('async function handleCardDepositLink');
  assert.ok(start > -1, 'processor must define handleCardDepositLink');
  const end = processorSource.indexOf('\nasync function ', start);
  assert.ok(end > start, 'handleCardDepositLink must be followed by another function');
  return processorSource.slice(start, end);
}

// ---------------------------------------------------------------------------
// Amount extraction + routing decision
// ---------------------------------------------------------------------------

test('deposit R100: parseSlots extracts amountCents 10000 (slot parser already covers it)', () => {
  const slots = parseSlots('deposit R100');
  assert.equal(slots.amountCents, 10000);
  // No product word: nothing else should claim this message.
  assert.equal(slots.productHint, null);
});

test('deposit R100: the shipped pattern routes it to a card-deposit link', () => {
  const re = shippedDepositPattern();

  const m = 'deposit R100'.match(re);
  assert.ok(m, "'deposit R100' must match the card-deposit pattern");
  assert.equal(m[1], '100');

  // Variants the prompt copy invites.
  assert.equal('deposit 250'.match(re)?.[1], '250');
  assert.equal('Deposit money R50'.match(re)?.[1], '50');
  assert.equal('deposit R100.50'.match(re)?.[1], '100.50');
});

test('routing: bare "deposit money" does NOT match — it gets the two-option prompt instead', () => {
  const re = shippedDepositPattern();
  assert.ok(!re.test('deposit money'), 'no amount -> no link; show the prompt');
  assert.ok(!re.test('redeem voucher'));
  assert.ok(!re.test('I want to deposit money into my wallet'));
  // Amount must be adjacent to the deposit keyword — an unrelated number
  // later in the sentence must not mint a payment link.
  assert.ok(!re.test('I made a deposit yesterday, please check 0781234567'));
  // And airtime phrasing stays with airtime routing.
  assert.ok(!re.test('buy R10 airtime for 0840012300'));
});

test('routing: the pre-routing short-circuit and the AWAITING_VOUCHER_PIN state both route to the link', () => {
  assert.match(processorSource, /routeDecision: 'DEPOSIT_CARD_LINK'/);

  // In-state: choosing option 2 while the voucher prompt is active must work.
  const stateStart = processorSource.indexOf("case 'AWAITING_VOUCHER_PIN':");
  const stateEnd = processorSource.indexOf("case 'AIRTIME_AMOUNT':", stateStart);
  assert.ok(stateStart > -1 && stateEnd > stateStart);
  const stateBlock = processorSource.slice(stateStart, stateEnd);
  assert.match(stateBlock, /matchCardDepositRequest\(/);
  assert.match(stateBlock, /handleCardDepositLink\(/);
});

// ---------------------------------------------------------------------------
// Deposit prompt copy: BOTH options, voucher first
// ---------------------------------------------------------------------------

test('deposit prompt: offers CASH via voucher (option 1) AND card/bank (option 2)', () => {
  assert.ok(
    processorSource.includes('1️⃣ *Cash* — take your cash to the till at any major retailer'),
    'cash-via-voucher stays option 1, with the full step-by-step'
  );
  assert.ok(
    processorSource.includes('automatically loaded into your WaPay wallet'),
    'the cash option promises the automatic load'
  );
  assert.ok(processorSource.includes('2️⃣ *Card / bank*'), 'card/bank is option 2');
  assert.ok(
    processorSource.includes('Reply with the amount, e.g. "deposit R100"'),
    'option 2 teaches the deposit R<amount> phrasing'
  );
  assert.ok(
    processorSource.includes('Apple Pay, Google Pay, Samsung Pay, Capitec Pay, Instant EFT, SnapScan or Zapper'),
    'the electronic payment options are listed'
  );
  // One prompt builder, used by BOTH entry points (intent switch + AI action).
  const uses = processorSource.split('buildDepositPrompt').length - 1;
  assert.ok(uses >= 3, `buildDepositPrompt should be defined once and called twice, saw ${uses} mentions`);
});

// ---------------------------------------------------------------------------
// Static wiring: imports, checkout contract, and NO PIN gate
// ---------------------------------------------------------------------------

test('static: processor imports the PayFast checkout builder and createDepositIntent', () => {
  assert.match(
    processorSource,
    /import \{[^}]*buildCheckoutUrl[^}]*\} from '@wapay\/providers-payfast'/,
    'checkout comes from @wapay/providers-payfast'
  );
  assert.match(
    processorSource,
    /import \{[^}]*createDepositIntent[^}]*\} from '\.\.\/\.\.\/\.\.\/lib\/deposits\.js'/,
    'intents come from lib/deposits.js'
  );
});

test('static: checkout honours the ITN contract (m_payment_id = intent id, notify_url = /api/payfast/itn)', () => {
  const body = cardDepositHandlerSource();
  assert.match(body, /createDepositIntent\(\{ accountId: account\.id, waId: from, amountCents \}\)/);
  assert.match(body, /mPaymentId: paymentId/, "PayFast's m_payment_id must be the deposit intent id");
  assert.match(body, /itemName: 'WaPay top-up'/);
  assert.match(body, /\/api\/payfast\/itn/, 'notify_url must point at the ITN webhook');
  assert.match(body, /amountCents: grossCents,/, 'checkout charges GROSS (credit + payment fee) from the same intent');
});

test('static: NO wallet-PIN gate guards deposit-link creation (money coming IN)', () => {
  const body = cardDepositHandlerSource();
  assert.ok(
    !/updateConversationState\([^)]*_PIN/.test(body),
    'must not park the user in a *_PIN state'
  );
  assert.ok(!/Enter Your PIN/i.test(body), 'must not ask for the WaPay PIN');
  assert.ok(
    !/\b(requirePin|verifyPin|checkPin|pinRequired|walletPin)\b/i.test(body),
    'must not call any PIN verification'
  );
});

test('static: the processor never sends the ITN confirmation itself (Task B owns it)', () => {
  const body = cardDepositHandlerSource();
  assert.ok(
    !/Deposit received/.test(body),
    'payment confirmation is sent by the ITN webhook, not the chat processor'
  );
});
