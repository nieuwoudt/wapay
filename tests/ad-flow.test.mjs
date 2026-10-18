/**
 * The ad chat flow (docs/AD_CHAT_FLOW.md, baked 2026-10-18).
 *
 * Locks:
 * - the four suggested questions and the three buttons classify exactly and loosely;
 * - the first name comes from the profile only when it reads as a name;
 * - every string the module can produce is free of the campaign's banned words
 *   ("any bank card" excepted), em dashes and percentage claims;
 * - the fee example is computed from the live fee table, never typed in;
 * - the first-link parser reads amount, who and note;
 * - reminders: due only 20 to 23.5 hours after the customer's own last message, only
 *   for ad arrivals who stopped mid-onboarding or never made a link, locked before the
 *   send so they go once, and never after "stop".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AD_QUESTIONS, AD_BUTTONS, classifyAdEntry, firstNameFrom, adEntryReply, feeExample, firstLinkPrompt,
  parseFirstLinkAsk, firstLinkRetry, adPaidCopy, reminderCopy, matchesStop, STOP_REPLY, BANNED_COPY, TIPS, buttonsAsText,
  copyViolations, firstLinkCreatedCopy, FAQ_KINDS, OPEN_FIRST, CAN_DO,
} from '../lib/ad-flow.js';
import { paymentRequestFeeCents } from '../lib/deposits.js';
import { dueAdReminders, sendAdReminders, REMINDER_AFTER_MS, REMINDER_LATEST_MS } from '../lib/ad-reminders.js';

test('entry classification: exact texts, loose variants, button titles and ids', () => {
  assert.equal(classifyAdEntry(AD_QUESTIONS.Q1), 'Q1');
  assert.equal(classifyAdEntry(AD_QUESTIONS.Q2), 'Q2');
  assert.equal(classifyAdEntry(AD_QUESTIONS.Q3), 'Q3');
  assert.equal(classifyAdEntry(AD_QUESTIONS.Q4), 'Q4');
  assert.equal(classifyAdEntry('open my wapay account!'), 'Q1');
  assert.equal(classifyAdEntry('How do I get paid with a link'), 'Q2');
  assert.equal(classifyAdEntry('what does it cost'), 'Q3');
  assert.equal(classifyAdEntry('Turn my whatsapp into a wallet'), 'Q4');
  assert.equal(classifyAdEntry('How much are the fees?'), 'Q3');
  assert.equal(classifyAdEntry('I want to open an account'), 'Q1');
  assert.equal(classifyAdEntry(AD_BUTTONS.OPEN.title), 'OPEN');
  assert.equal(classifyAdEntry(AD_BUTTONS.COST.title), 'COST');
  assert.equal(classifyAdEntry(AD_BUTTONS.HOW.title), 'HOW');
  assert.equal(classifyAdEntry(AD_BUTTONS.OPEN.id), 'OPEN');
  assert.equal(classifyAdEntry('Can I deposit cash?'), 'FAQ_CASH_IN');
  assert.equal(classifyAdEntry('can i top up with cash'), 'FAQ_CASH_IN');
  assert.equal(classifyAdEntry('Can I buy airtime?'), 'FAQ_VAS');
  assert.equal(classifyAdEntry('do you sell electricity or petrol'), 'FAQ_VAS');
  assert.equal(classifyAdEntry('How do I get my money out?'), 'FAQ_MONEY_OUT');
  assert.equal(classifyAdEntry('can I withdraw'), 'FAQ_MONEY_OUT');
  assert.equal(classifyAdEntry('How can people pay me?'), 'FAQ_PAY_ME_HOW');
  assert.equal(classifyAdEntry('which cards do you take'), 'FAQ_PAY_ME_HOW');
  assert.equal(classifyAdEntry('Can I pay someone?'), 'FAQ_PAY_SOMEONE');
  assert.equal(classifyAdEntry('can i send money to my mother'), 'FAQ_PAY_SOMEONE');
  assert.equal(classifyAdEntry('Nedbank cash'), 'PAYOUT_NEDBANK');
  assert.equal(classifyAdEntry('Hi, do you work in Zimbabwe?'), 'free_text');
  assert.equal(classifyAdEntry(''), 'free_text');
});

test('first name: only when the profile name reads as a name', () => {
  assert.equal(firstNameFrom('Thandi Nkosi'), 'Thandi');
  assert.equal(firstNameFrom('sipho'), 'Sipho');
  assert.equal(firstNameFrom('🔥🔥'), null);
  assert.equal(firstNameFrom('0821234567'), null);
  assert.equal(firstNameFrom('Shop Soweto'), null);
  assert.equal(firstNameFrom('WaPay Official'), null);
  assert.equal(firstNameFrom(''), null);
  assert.equal(firstNameFrom('A'), null, 'one letter is not a name');
});

test('every reply is short, carries at most three buttons of 20 characters, and nothing banned', () => {
  const fee = feeExample(paymentRequestFeeCents);
  const all = [];
  for (const kind of ['Q1', 'Q2', 'Q3', 'Q4', 'OPEN', 'COST', 'HOW', 'free_text', ...FAQ_KINDS]) {
    for (const [name, hasAccount] of [[null, false], ['Thandi', false], ['Thandi', true]]) {
      const r = adEntryReply(kind, { firstName: name, fee, hasAccount });
      all.push(r.text);
      assert.ok(r.text.length <= 460, `${kind} stays short (${r.text.length})`);
      assert.ok(r.buttons.length <= 3);
      for (const b of r.buttons) assert.ok(b.title.length <= 20, b.title);
      assert.equal(typeof r.startOnboarding, 'boolean');
    }
  }
  all.push(firstLinkPrompt('Thandi'), firstLinkPrompt(null), firstLinkRetry(), adPaidCopy({ amountCents: 25000 }), adPaidCopy({ amountCents: 25000, payerName: 'Thandi' }),
    reminderCopy('mid_onboarding', 'Thandi'), reminderCopy('no_link'), STOP_REPLY, ...TIPS, buttonsAsText([AD_BUTTONS.OPEN, AD_BUTTONS.COST]),
    firstLinkCreatedCopy({ amountCents: 25000, url: 'https://pleasepayme.co.za/PRABCDEF', payerName: 'Thandi' }), firstLinkCreatedCopy({ amountCents: 4000, url: 'https://pleasepayme.co.za/PRABCDEF' }), OPEN_FIRST);
  for (const text of all) {
    assert.deepEqual(copyViolations(text), [], `section 11 words in: ${text}`);
    assert.doesNotMatch(text, /welcome to wapay/i, 'no second welcome');
    assert.doesNotMatch(text, /\b(soon|coming soon)\b.*\b(20\d\d|next (week|month)|in \d+ (days|weeks))\b/i, 'coming soon carries no date');
  }
  // The word rules themselves.
  assert.deepEqual(copyViolations('any bank card, bank QR code apps and your bank account'), []);
  assert.deepEqual(copyViolations('collect cash at a Nedbank or Absa ATM'), []);
  assert.ok(copyViolations('go to the bank').length === 1, 'bare bank is refused');
  assert.ok(copyViolations('use any ATM').length === 1, 'ATM without Nedbank or Absa is refused');
  for (const bad of ['banking', 'send money', 'transfer', 'withdraw', 'cash out', 'cash-out', 'a — dash', 'save 40%']) assert.ok(copyViolations(bad).length >= 1, bad);
  // Section 2 truth: coming-soon answers never say a feature is available; the pre-account suffix is present.
  assert.match(adEntryReply('FAQ_VAS').text, /coming soon/);
  assert.match(adEntryReply('FAQ_CASH_IN').text, /Not yet\. Cash top-ups with OTT and Blue Voucher are coming soon/);
  assert.match(adEntryReply('FAQ_PAY_ME_HOW').text, /MobiCred/);
  assert.match(adEntryReply('FAQ_MONEY_OUT').text, /PayShap.*Nedbank or Absa ATM/);
  assert.ok(adEntryReply('FAQ_MONEY_OUT').text.endsWith(OPEN_FIRST), 'pre-account answers end with the open-account line');
  assert.deepEqual(adEntryReply('FAQ_MONEY_OUT', { hasAccount: true }).buttons.map((b) => b.title), ['To my bank account', 'Nedbank cash', 'Absa cash']);
  assert.deepEqual(adEntryReply('FAQ_MONEY_OUT', { hasAccount: false }).buttons.map((b) => b.title), ['Open my account']);
  assert.ok(!adEntryReply('FAQ_PAY_SOMEONE', { hasAccount: true }).text.includes(OPEN_FIRST));
  assert.match(adEntryReply('Q2').text, /Instant EFT, Capitec Pay, SnapScan and more/);
  assert.match(adEntryReply('Q4').text, /coming soon/);
  assert.match(firstLinkCreatedCopy({ amountCents: 25000, url: 'https://x', payerName: 'Thandi' }), /^Here's your payment link for R250: https:\/\/x\n\nForward it to Thandi/);
  // Q1 and Q4 go straight to onboarding; Q2/Q3 and free text offer the open-account button.
  assert.equal(adEntryReply('Q1').startOnboarding, true);
  assert.equal(adEntryReply('Q4').startOnboarding, true);
  assert.deepEqual(adEntryReply('Q2').buttons.map((b) => b.title), ['Open my account', 'What it costs']);
  assert.deepEqual(adEntryReply('Q3', { fee }).buttons.map((b) => b.title), ['Open my account', 'How it works']);
  assert.deepEqual(adEntryReply('free_text').buttons.map((b) => b.title), ['Open my account']);
  assert.match(adEntryReply('Q2').text, /any bank card/);
  assert.match(adEntryReply('Q1', { firstName: 'Thandi' }).text, /^Great, Thandi\./);
});

test('the fee example comes from the live fee table and is never quoted at exactly R50', () => {
  const fee = feeExample(paymentRequestFeeCents);
  assert.equal(fee.amountCents, 10000);
  assert.equal(fee.feeCents, paymentRequestFeeCents(10000));
  assert.equal(fee.netCents, 10000 - fee.feeCents);
  assert.equal(fee.amount, 'R100');
  const text = adEntryReply('Q3', { fee }).text;
  assert.ok(text.includes(`costs you ${fee.fee}`) && text.includes(`keep ${fee.net}`), 'the answer carries the table\'s numbers');
  assert.doesNotMatch(text, /R50 by card/);
});

test('the first-link ask parses amount, who and note; the retry line asks for the amount', () => {
  assert.deepEqual(parseFirstLinkAsk('R250 from Thandi for the birthday gift'), { amountCents: 25000, payerName: 'Thandi', note: 'the birthday gift' });
  assert.deepEqual(parseFirstLinkAsk('250 from Sipho Dlamini'), { amountCents: 25000, payerName: 'Sipho Dlamini', note: null });
  assert.deepEqual(parseFirstLinkAsk('r 99.50'), { amountCents: 9950, payerName: null, note: null });
  assert.equal(parseFirstLinkAsk('who owes me?'), null);
  assert.equal(parseFirstLinkAsk(''), null);
  assert.match(firstLinkRetry(), /R250 from Thandi/);
});

test('stop words: only a plain stop, never cancel or PIN-reset words', () => {
  for (const s of ['stop', 'STOP', 'Stop.', 'unsubscribe', 'no more messages', "don't message me"]) assert.equal(matchesStop(s), true, s);
  for (const s of ['cancel', 'forgot pin', 'reset pin', 'stop the payment please', '1234', 'no']) assert.equal(matchesStop(s), false, s);
});

test('reminders: due only in the 20 to 23.5 hour window, once, and never after stop', async () => {
  assert.equal(REMINDER_AFTER_MS, 20 * 3600 * 1000);
  assert.equal(REMINDER_LATEST_MS, 23.5 * 3600 * 1000);
  const now = new Date('2026-10-19T12:00:00Z');
  const rows = [
    { id: 'a1', wa_id: '27600000001', display_name: 'Thandi N', state: 'S2_OTP_SENT', last_user_at: new Date(now.getTime() - 21 * 3600e3), links: 0 },
    { id: 'a2', wa_id: '27600000002', display_name: '🔥', state: 'S5_COMPLETED', last_user_at: new Date(now.getTime() - 22 * 3600e3), links: 0 },
    { id: 'a3', wa_id: '27600000003', display_name: 'Done', state: 'S5_COMPLETED', last_user_at: new Date(now.getTime() - 22 * 3600e3), links: 2 },
  ];
  const captured = { where: null, marks: [] };
  const prisma = {
    async $queryRaw(strings, ...values) { captured.where = values; return rows; },
    async $executeRaw(strings, ...values) { captured.marks.push(values); return 1; },
  };
  const due = await dueAdReminders({ prisma, now });
  assert.deepEqual(due.map((d) => [d.id, d.kind, d.firstName]), [['a1', 'mid_onboarding', 'Thandi'], ['a2', 'no_link', null]], 'a3 has links and is not due');
  const [oldest, newest] = captured.where;
  assert.equal(newest.getTime(), now.getTime() - 20 * 3600e3);
  assert.equal(oldest.getTime(), now.getTime() - 23.5 * 3600e3);
  const sent = [];
  const out = await sendAdReminders({ prisma, now, send: async (m) => { sent.push(m); return { ok: true }; } });
  assert.equal(out.sent, 2);
  assert.equal(sent[0].text, 'Hi Thandi, you\'re one step away from your WaPay account. Want to finish?');
  assert.equal(sent[1].text, 'Ready for your first payment link? Just tell me who owes you and how much.');
  assert.equal(captured.marks.length, 2, 'the lock is written before each send');
  for (const m of captured.marks) assert.match(JSON.stringify(m), /reminderSentAt/);
  for (const m of sent) assert.doesNotMatch(m.text, BANNED_COPY);
});
