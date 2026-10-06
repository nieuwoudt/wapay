/**
 * Founder review 5 (2026-10-06, thirteen screenshots, relayed by the Blu
 * thread): the architecture-level items. Every way to deposit, cash
 * included, as bullets with no second question; a question is answered, never
 * turned into a card; two or more items are WhatsApp bullets everywhere; deal
 * lists recommend best value with the balance in view; transaction history is
 * one bullet per row with icons and the reference under it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { COMPOSITION_RULES } from '@wapay/ai';
import { normaliseLists, outputGate } from '../lib/agent/guards.js';
import { movementBullet, MOVEMENT_ICONS } from '../lib/context-pack.js';
import { howItWorksBrief, howItWorksAnswer, looksLikeQuestion } from '../lib/how-it-works.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const NOW = new Date('2026-10-06T12:00:00Z');

test('prompt: the ways question lists every way with cash, yes/no is answered first, two items are a list, best value with the balance, the history shape, the start command ending', () => {
  assert.match(COMPOSITION_RULES, /lists EVERY way that is live for this customer, the cash ways included, one bullet each, then ends with: To find out more, just ask\./);
  assert.match(COMPOSITION_RULES, /A yes or no question .* gets the answer in the first word/);
  assert.match(COMPOSITION_RULES, /a start_\* tool is only for a request to DO something/);
  assert.match(COMPOSITION_RULES, /Two or more items \(ways, products, deals, transactions, steps, options, people\) are a LIST: one WhatsApp bullet \(•\) per item/);
  assert.match(COMPOSITION_RULES, /numbered list \(1\. 2\. 3\.\), ending with: Just come back here if you have any questions\. If you get stuck on any step, just ask me and I will guide you\./);
  assert.match(COMPOSITION_RULES, /recommend BEST VALUE .* not simply the cheapest/);
  assert.match(COMPOSITION_RULES, /You have R40 available, so the best value you can afford is/);
  assert.match(COMPOSITION_RULES, /one bullet per transaction: date and time · type · amount · to or from \(masked, like •••394\) · status icon \(✅ paid, ❌ failed, ⏳ pending, ⌛ expired\)/);
  assert.match(COMPOSITION_RULES, /A pending pay-out is a separate note after the list/);
  assert.match(COMPOSITION_RULES, /Every capability answer ends with the exact start command/);
  assert.doesNotMatch(COMPOSITION_RULES, /[–—]/);
});

test('normaliseLists: markdown markers become bullets, priced runs become bullets, prose and single lines are untouched', () => {
  assert.equal(normaliseLists('- *Telkom 1GB* R30 · 30 days\n* *Telkom 2GB* R55 · 30 days\n– Telkom 5GB R99'), '• *Telkom 1GB* R30 · 30 days\n• *Telkom 2GB* R55 · 30 days\n• Telkom 5GB R99');
  // The review's MTN / Vodacom / Cell C deal lists as plain lines.
  assert.equal(
    normaliseLists('Available examples:\nMTN R5, R10, R25, R50\nVodacom R5, R12, R29\nCell C R5, R10\nJust say buy R10 airtime.'),
    'Available examples:\n• MTN R5, R10, R25, R50\n• Vodacom R5, R12, R29\n• Cell C R5, R10\nJust say buy R10 airtime.',
  );
  // One priced line is not a list; a sentence with a price is prose; a header ending in a colon is a header.
  assert.equal(normaliseLists('Your balance is R40.\nWhat would you like?'), 'Your balance is R40.\nWhat would you like?');
  assert.equal(normaliseLists('MTN R5, R10'), 'MTN R5, R10');
  assert.equal(normaliseLists('Fees:\nDeposit R2.30 + 4.2%\nWithdraw R18'), 'Fees:\n• Deposit R2.30 + 4.2%\n• Withdraw R18');
  // Already a list: numbered steps and bullets are left exactly as they are.
  const steps = '1. Say "deposit R100"\n2. Tap the link\n• MTN R5\n• Vodacom R12';
  assert.equal(normaliseLists(steps), steps);
  assert.equal(normaliseLists(''), '');
  assert.equal(normaliseLists(undefined), undefined);
});

test('outputGate: a list rewrite keeps ok true under its own rule, runs before the dash rewrite, and never fires on clean text', () => {
  const r = outputGate('MTN R5, R10\nVodacom R12, R29');
  assert.deepEqual(r, { ok: true, rule: 'LIST_REWRITE', text: '• MTN R5, R10\n• Vodacom R12, R29' });
  // A leading en dash is a list marker, not a dash to turn into a comma.
  const d = outputGate('– MTN R5\n– Vodacom R12');
  assert.equal(d.text, '• MTN R5\n• Vodacom R12');
  assert.equal(d.rule, 'LIST_REWRITE');
  // Both rewrites: the dash rule is reported (it ran last and changed text).
  const both = outputGate('- Airtime R10 – cheap\n- Data R29 – good');
  assert.equal(both.rule, 'DASH_REWRITE');
  assert.match(both.text, /^• Airtime R10, cheap\n• Data R29, good$/);
  assert.deepEqual(outputGate('Hello there.'), { ok: true, rule: null, text: 'Hello there.' });
});

test('movementBullet: date · type · amount · masked destination · icon, the reference on its own line, the same shape for every kind', () => {
  const at = new Date('2026-10-04T06:39:00Z');
  const w = movementBullet({ kind: 'PAYOUT', method: 'NEDCASH', amountCents: 2000, status: 'SUCCESS', counterparty: '•••175', reference: 'WPB4D27FAF672A7E', at }, { now: NOW, methodLabel: 'Nedbank cash' });
  assert.equal(w, '• 04 Oct 08:39 · Withdrawal (Nedbank cash) · R20 → •••175 · ✅ paid\n   ref WPB4D27FAF672A7E');
  const d = movementBullet({ kind: 'DEPOSIT', amountCents: 10000, status: 'SUCCESS', counterparty: 'card', reference: '2179045', at }, { now: NOW });
  assert.equal(d, '• 04 Oct 08:39 · Deposit · R100 ← card · ✅ paid\n   ref 2179045');
  const p = movementBullet({ kind: 'PAYOUT', method: 'PAYSHAP', amountCents: 5000, status: 'PENDING', counterparty: '•••394', reference: 'WP88A417B750FC36', at }, { now: NOW, methodLabel: 'PayShap' });
  assert.match(p, /^• 04 Oct 08:39 · Withdrawal \(PayShap\) · R50 → •••394 · ⏳ pending\n   ref WP88A417B750FC36$/);
  const a = movementBullet({ kind: 'AIRTIME', amountCents: 1000, status: 'FAILED', counterparty: '083…2300', reference: 'BLU-1', at }, { now: NOW });
  assert.equal(a, '• 04 Oct 08:39 · Airtime · R10 → 083…2300 · ❌ failed · ref BLU-1');
  const x = movementBullet({ kind: 'PAY_LINK', amountCents: 3800, status: 'EXPIRED', at }, { now: NOW });
  assert.equal(x, '• 04 Oct 08:39 · Payment link · R38 · ⌛ expired');
  assert.equal(MOVEMENT_ICONS.INIT, '⏳ pending');
  // Never a full number: the pack masks before this runs, and the bullet adds nothing.
  assert.ok(!/\d{10}/.test(w + d + p + a + x));
});

test('how it works, deposit: every way as a bullet (cash included, OTT only when live), numbered steps 1 to 5, and the two closing lines', () => {
  const brief = howItWorksBrief('deposit', { ottLoadLive: true });
  assert.match(brief, /^💳 You can add money these ways:\n• \*Card, Instant EFT, Apple Pay or Google Pay:\*/);
  assert.match(brief, /\n• \*Cash at a till:\* ask any major retailer for a \*Blu Voucher\*/);
  assert.match(brief, /\n• \*OTT voucher:\* already have one\? Send me its 16-digit PIN/);
  assert.match(brief, /\n\nTo find out more, just ask\.$/);
  assert.doesNotMatch(howItWorksBrief('deposit', { ottLoadLive: false }), /OTT voucher/);
  const steps = howItWorksAnswer('deposit', { ottLoadLive: false });
  for (const n of [1, 2, 3, 4, 5]) assert.match(steps, new RegExp(`\\n${n}\\. `));
  assert.match(steps, /\n1\. Say "deposit R100"/);
  assert.match(steps, /Just come back here if you have any questions\. If you get stuck on any step, just ask me and I will guide you\.$/);
  assert.doesNotMatch(steps, /\?$/m, 'no question back');
  assert.doesNotMatch(brief + steps, /[–—]/);
});

test('runtime locks: a question never becomes the Add Money card or the PIN step; the history list uses the shared bullet and notes a pending pay-out', () => {
  const src = read('../pages/api/webhooks/message-processor-v2.js');
  const redeem = src.slice(src.indexOf("case 'REDEEM_VOUCHER': {"), src.indexOf("case 'BUY_AIRTIME': {"));
  assert.ok(redeem.indexOf('if (looksLikeQuestion(text))') > -1 && redeem.indexOf('if (looksLikeQuestion(text))') < redeem.indexOf("updateConversationState(from, 'AWAITING_VOUCHER_PIN')"), 'the question check runs before the PIN state');
  assert.match(redeem, /✅ Yes\. Send me the 16-digit PIN of your OTT voucher/);
  const dep = src.slice(src.indexOf("case 'DEPOSIT_START': {"), src.indexOf("case 'REDEEM_VOUCHER': {"));
  assert.match(dep, /if \(looksLikeQuestion\(text\)\) \{\s*return await sendWhatsAppText\(\{ to: from, text: await localizeOutbound\(howItWorksBrief\('deposit'/);
  assert.match(src, /import \{[^}]*looksLikeQuestion[^}]*\} from '..\/..\/..\/lib\/how-it-works.js'/);
  assert.match(src, /function transactionLine\(m\) \{[\s\S]{0,400}return movementBullet\(m, \{ methodLabel/);
  const tx = src.slice(src.indexOf('async function handleTransactions('), src.indexOf('async function handlePayoutStatus('));
  assert.match(tx, /const pendingPayoutLine = pp\s*\?\s*`⏳ Pending pay-out: /);
  assert.match(tx, /\[header, rows\.map\(transactionLine\)\.join\('\\n'\), pendingPayoutLine, balance,/);
  // The question matcher itself: the founder's two sentences read as questions, the commands do not.
  assert.equal(looksLikeQuestion('Can I deposit via an OTT voucher?'), true);
  assert.equal(looksLikeQuestion('how can I deposit money'), true);
  assert.equal(looksLikeQuestion('deposit R100'), false);
  assert.equal(looksLikeQuestion('redeem voucher'), false);
});

test('the PayFast receipt names a parked purchase when the account sits in a RESUME_* state, and the guard reads the pending intent', () => {
  const itn = read('../pages/api/payfast/itn.js');
  const block = itn.slice(itn.indexOf('const lines = [`✅ Deposit received'), itn.indexOf('const confirmSent = await sendWhatsAppText'));
  assert.match(block, /select: \{ conversationState: true \}/);
  assert.match(block, /\/\^RESUME_\/\.test\(String\(a\?\.conversationState \|\| ''\)\)/);
  assert.match(block, /\.catch\(\(\) => false\)/, 'a state read failure never blocks the receipt');
  assert.match(block, /Message me anything and I will finish your parked purchase\./);
  const guards = read('../lib/agent/guards.js');
  assert.match(guards, /export function agentGuard\(text, \{ pendingIntent = null \} = \{\}\)/);
  assert.match(guards, /awaitingMeter = String\(pendingIntent\?\.action \|\| ''\)\.toUpperCase\(\) === 'BUY_ELECTRICITY'/);
});
