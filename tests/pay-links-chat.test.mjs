/**
 * Payment links through the REAL message processor (founder, 2026-10-24),
 * asserted on what is actually sent. tests/helpers/pay-links-chat-run.mjs runs
 * processMessage in a child process with the WhatsApp transport captured, the
 * database in memory (the web app's fixture client), and no model: the Pay
 * agent's turns return a scripted start_pay_link proposal. Module mocks need
 * --experimental-test-module-mocks, which the plain suite does not pass.
 *
 * Locks, per customer turn:
 * - a link is made with exactly ONE message, the card to forward (who asks,
 *   the amount, what for, the link as plain text, how to pay), never a button;
 * - no link without a description: one question when it is missing, a plain
 *   refusal when it could mislead, "cancel" and any other request get out;
 * - a typed number puts a tap-to-send link in the same one message and WaPay
 *   writes nothing to that number; a member the requester has sent money to
 *   gets WaPay's note only inside their 24-hour window, and the requester's
 *   message does not change with it;
 * - "my links", "remind 2", "cancel 2" answer in one message each, also on the
 *   Pay agent's pilot path, without a model call;
 * - a change of amount and the ad first link end in one message too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PAY_WAYS_LINE } from '../lib/pay-links.js';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const CARD = (who, amount, forWhat) => new RegExp(`^🙏 \\*${who} is asking you to pay ${amount}\\*\\nFor: ${forWhat}\\n\\nPay here: https://pleasepayme\\.co\\.za/PR[A-HJKMNP-Z]{6}\\n${PAY_WAYS_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const QUESTION = (amount) => `🙏 What is the ${amount} for? The person paying sees it on the link.\n\nReply in a few words, like "braids" or "rent", or "cancel" to stop.`;

let result = null;
function run() {
  if (result) return result;
  const child = spawnSync(process.execPath, ['--no-warnings', '--experimental-test-module-mocks', fileURLToPath(new URL('./helpers/pay-links-chat-run.mjs', import.meta.url))], {
    cwd: root,
    env: { ...process.env, WAPAY_ROOT: root, NODE_ENV: 'test', WAPAY_AGENT_V3_MSISDNS: '', OPENAI_API_KEY: '' },
    encoding: 'utf8',
    timeout: 120000,
  });
  const line = String(child.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no RESULT line; exit ${child.status}\nstdout: ${String(child.stdout).slice(-2000)}\nstderr: ${String(child.stderr).slice(-3000)}`);
  result = JSON.parse(line.slice('RESULT '.length));
  assert.equal(result.error, undefined, result.error);
  return result;
}
const one = (turn, to) => {
  assert.equal(turn.length, 1, `exactly one message in the turn, got ${turn.length}: ${JSON.stringify(turn)}`);
  assert.equal(turn[0].to, to);
  assert.equal(turn[0].kind, 'text', 'a plain text: a forwarded button is stripped');
  return turn[0].text;
};

test('a link with what it is for in the same message: ONE message, the card to forward', () => {
  const { s1, everyone } = run();
  assert.match(one(s1.turn, '27600010001'), CARD('Thandi Nkosi •••001', 'R40', 'lunch'));
  assert.deepEqual(s1.links.map((l) => [l.amountCents, l.note, l.status]), [[4000, 'lunch', 'PENDING']]);
  assert.equal(s1.state, null);
  assert.equal(everyone.ctaSends, 0, 'no button card anywhere');
});

test('no description: one question, no link; the answer makes the link in one message', () => {
  const { s2 } = run();
  assert.equal(one(s2.question, '27600010002'), QUESTION('R40'));
  assert.equal(s2.stateAfterQuestion, 'REQUEST_MONEY_NOTE');
  assert.equal(s2.linksAfterQuestion, 0, 'no link before it says what it is for');
  assert.match(one(s2.answer, '27600010002'), CARD('Thandi Nkosi •••002', 'R40', 'lunch'));
  assert.equal(s2.links.length, 1);
  assert.equal(s2.state, null);
});

test('a description that could mislead is refused in plain words; "cancel" ends it with no link', () => {
  const { s3 } = run();
  assert.equal(one(s3.link, '27600010003'), `A description can't carry a website, a link or an e-mail address.\n\n${QUESTION('R40')}`);
  assert.equal(one(s3.impersonation, '27600010003'), `A description can't use words like WaPay, SARS, support, admin or official, so nobody mistakes it for an official message.\n\n${QUESTION('R40')}`);
  assert.equal(one(s3.cancel, '27600010003'), '👍 Cancelled. No link was created.');
  assert.deepEqual(s3.links, []);
  assert.equal(s3.state, null);
});

test('fee band: the fee choice names what it is for and keeps what the requester receives; then one message, the card', () => {
  const { s4 } = run();
  const choice = one(s4.choice, '27600010004');
  assert.match(choice, /^🙏 \*Get paid R150 for braids\*\n\nQuick choice before I make your link:/);
  assert.match(choice, /or R\d+\.\d\d if they pay by card/, 'the requester reads their card net here, before the link exists');
  assert.match(one(s4.made, '27600010004'), CARD('Thandi Nkosi •••004', 'R150', 'braids'));
  assert.deepEqual(s4.links.map((l) => [l.amountCents, l.note]), [[15000, 'braids']]);
});

test('a number the requester typed: the tap-to-send link rides in the same one message, and WaPay sends that number nothing', () => {
  const { s5 } = run();
  const text = one(s5.turn, '27600010005');
  const [card, tap] = text.split('\n\n📲 ');
  assert.match(card, CARD('Thandi Nkosi •••005', 'R40', 'plumbing'));
  const [label, url] = tap.split('\n');
  assert.equal(label, 'Tap to send it to 082 123 4567 from your own WhatsApp:');
  assert.ok(url.startsWith('https://wa.me/27821234567?text='), url);
  assert.equal(decodeURIComponent(url.slice(url.indexOf('?text=') + 6)), card.replace(/(\/PR[A-HJKMNP-Z]{6})\n/, '$1?s=t\n'), 'the payer receives the card, from the requester\'s own WhatsApp, its link tagged ?s=t');
  assert.deepEqual(s5.links.map((l) => l.note), ['plumbing'], 'the number is used for the link only, never stored');
  assert.ok(!JSON.stringify(s5.links).includes('0821234567'));
});

test('a member the requester has paid before: WaPay\'s note only inside the member\'s 24-hour window; the requester\'s message is the same either way', () => {
  const { s6, s7 } = run();
  assert.equal(s6.turn.length, 2, 'the requester\'s one message, and WaPay\'s note to the member whose window is open');
  assert.equal(s6.turn[0].to, '27600010006');
  assert.equal(s6.turn[1].to, '27821230091');
  assert.match(s6.turn[1].text, /^🙏 \*Thandi Nkosi\* is asking you to pay \*R40\* on WaPay\.\nFor: lunch\n\nIf you'd like to pay, reply:\n\*pay request PR[A-HJKMNP-Z]{6}\*/);
  const closed = one(s7.turn, '27600010007');
  // Same words once the per-test details (code, number tail, the typed number) are blanked, prefilled text included.
  const blank = (t) => t.replace(/PR[A-HJKMNP-Z]{6}/g, 'PRCODE').replace(/•••00\d/g, '•••00X').replace(/2782123009\d|082 123 009\d/g, 'NUM');
  const shape = (t) => {
    const [head, url = ''] = t.split('\nhttps://wa.me/');
    return `${blank(head)}\n${blank(url.split('?text=')[0])}\n${blank(decodeURIComponent(url.split('?text=')[1] || ''))}`;
  };
  assert.equal(shape(s6.turn[0].text), shape(closed), 'membership-neutral: nothing in the requester\'s message tells the window or the membership');
  assert.ok(!/on WaPay|let .* know/i.test(closed));
});

test('"my links", "remind 2", "cancel 1": one message each, and they act on the list the customer saw', () => {
  const { s8 } = run();
  one(s8.m1, '27600010008');
  one(s8.m2, '27600010008');
  const list = one(s8.list, '27600010008');
  assert.match(list, /^🔗 \*Your open payment links\*\n1\. R30 for taxi · today · PR[A-HJKMNP-Z]{6}\n2\. R40 for lunch · today · PR[A-HJKMNP-Z]{6}\n\nReply \*remind 1\* for a reminder to forward, or \*cancel 1\* to close that link\.\nAll your links: app\.wapay\.co\.za\/app\/links$/);
  const [taxi, lunch] = [s8.links.find((l) => l.note === 'taxi'), s8.links.find((l) => l.note === 'lunch')];
  assert.equal(one(s8.remind, '27600010008'), `🔔 *Reminder: Thandi Nkosi •••008 is asking you to pay R40*\nFor: lunch\n\nPay here: https://pleasepayme.co.za/${lunch.id}?s=r\n${PAY_WAYS_LINE}\n${one(s8.remind, '27600010008').split('\n').pop()}`);
  assert.match(one(s8.remind, '27600010008'), /\nOpen until \d{1,2} [A-Z][a-z]{2}\.$/);
  assert.equal(one(s8.cancel, '27600010008'), `👍 Cancelled: R30 for taxi (${taxi.id}). That link no longer works.`);
  assert.equal(taxi.status, 'CANCELLED', 'through cancelPaymentRequest, the same path as "cancel request <code>"');
  assert.equal(lunch.status, 'PENDING');
  assert.match(one(s8.list2, '27600010008'), /^🔗 \*Your open payment links\*\n1\. R40 for lunch · today · /);
  assert.equal(one(s8.bad, '27600010008'), '🤔 There is no link 7 in your list. Say *my links* to see your open links with their numbers.');
});

test('a change of amount ends in one message: the new link keeps what the old one was for and says it replaces it', () => {
  const { s9 } = run();
  const text = one(s9.change, '27600010009');
  assert.match(text, /^🙏 \*Thandi Nkosi •••009 is asking you to pay R45\*\nFor: lunch\n/);
  assert.ok(text.endsWith('\n\nThis link replaces the earlier R40 link, which no longer works.'));
  assert.deepEqual(s9.links.map((l) => [l.amountCents, l.note, l.status]), [[4000, 'lunch', 'CANCELLED'], [4500, 'lunch', 'PENDING']]);
});

test('the Pay agent\'s pilot path: the tool\'s description makes the link, a missing one is asked for, and "my links" never reaches the model', () => {
  const { s10 } = run();
  assert.match(one(s10.a1, '27600010010'), CARD('Thandi Nkosi •••010', 'R40', 'school trip'));
  assert.equal(s10.callsAfterFirst, 1, 'the agent made that proposal');
  assert.equal(one(s10.a2, '27600010010'), QUESTION('R35'));
  assert.equal(s10.a2state, 'REQUEST_MONEY_NOTE');
  assert.match(one(s10.a3, '27600010010'), CARD('Thandi Nkosi •••010', 'R35', 'bus fare'));
  assert.equal(s10.callsBeforeList, 2, 'the answer to the question went to the flow, not the model');
  assert.match(one(s10.a4, '27600010010'), /^🔗 \*Your open payment links\*\n1\. R35 for bus fare/);
  assert.equal(s10.callsAfterList, s10.callsBeforeList, 'no model call for "my links"');
});

test('the description step never traps: a question leaves it and is answered; "my links" leaves it too', () => {
  const { s11 } = run();
  assert.equal(one(s11.n1, '27600010011'), QUESTION('R40'));
  assert.notEqual(one(s11.n2, '27600010011'), QUESTION('R40'), 'the question is answered, not met with the step again');
  assert.equal(s11.n2state, null);
  assert.match(one(s11.n3, '27600010011'), /^🔗 You have no open payment links\./);
  assert.equal(s11.n3state, null);
  assert.deepEqual(s11.links, []);
});

test('the ad first link: amount and what it is for in one answer make the link in one message; an amount alone gets the question', () => {
  const { s12, s13 } = run();
  assert.match(one(s12.turn, '27600010012'), CARD('Lerato Dube •••012', 'R40', 'braids'));
  assert.deepEqual(s12.links.map((l) => l.note), ['braids']);
  assert.equal(s12.state, null);
  assert.equal(one(s13.question, '27600010013'), QUESTION('R40'));
  assert.equal(s13.state, 'REQUEST_MONEY_NOTE');
  assert.match(one(s13.answer, '27600010013'), CARD('Lerato Dube •••013', 'R40', 'hair'));
});
