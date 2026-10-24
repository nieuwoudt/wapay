/**
 * Payment links (founder, 2026-10-24).
 *
 * Locks:
 * - every new link says what it is for: the description is cleaned for a
 *   third party and refused, in plain words, when it carries a link, a phone
 *   or account number, wording that reads as WaPay or an authority, or more
 *   than 60 characters (lib/link-description.js); the chat, the Pay agent, the
 *   ad first-link flow and the web app all require it;
 * - exactly ONE message after a link is made, and it is the message to
 *   forward: who asks (name and number tail), the amount, what it is for, the
 *   link as plain text and how to pay, with nothing meant for the requester
 *   alone; asserted on what is sent;
 * - "my links", "remind 2", "cancel 2": one message each;
 * - the tap-to-send link opens the requester's OWN chat with the number they
 *   typed, the card ready to send; WaPay's own note to a member goes only
 *   inside the member's 24-hour window, and the requester's message is the
 *   same whether or not the number is a member (no membership oracle).
 * The processor itself is run end to end in tests/pay-links-chat.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sanitizeLinkDescription, descriptionRefusal, cleanDescription, sameDescription, plainText, DESCRIPTION_MAX } from '../lib/link-description.js';
import {
  parseLinkAsk, descriptionQuestion, requestCardText, cardForLink, reminderCardFor, cardRequesterLabel, tapToSendUrl, shareToWhatsAppUrl,
  composeLinkCreated, sendCreatedLink, myLinksText, matchLinkCommand, relativeDay, dateShort, displayDescription, webLinkTexts,
  looksLikeOtherRequest, PAY_WAYS_LINE, openLinksOf,
} from '../lib/pay-links.js';
import { copyViolations } from '../lib/ad-flow.js';
import { executeTool, buildToolDefinitions, SLOT_KEYS } from '../lib/agent/tools/index.js';
import { slotsFor } from '../lib/agent/tools/proposals.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');
const fnBody = (src, name) => src.slice(src.indexOf(`async function ${name}(`), src.indexOf('\n}\n', src.indexOf(`async function ${name}(`)));

const ACCOUNT = { id: 'acc_req', msisdn: '0821112567', waId: '27821112567', displayName: 'Thandi Nkosi' };
const LINK = { id: 'PRABCDEF', accountId: 'acc_req', amountCents: 15000, note: 'braids', status: 'PENDING', createdAt: new Date('2026-10-24T08:00:00Z'), expiresAt: new Date('2026-10-31T08:00:00Z') };
const CARD = `🙏 *Thandi Nkosi •••567 is asking you to pay R150*\nFor: braids\n\nPay here: https://pleasepayme.co.za/PRABCDEF\n${PAY_WAYS_LINE}`;
// What the requester alone may read (their net by card, the fee, promises): never on the card.
const REQUESTER_ONLY = /you receive|you'll get|you get the full|card cost|card fee|net|forward (it|this|the next)|I'll tell you|I'll message you|the moment it's paid|requested\*|Code PR/i;
const TIME_PROMISE = /\b(soon|shortly|within|hours?|minutes?|right away|immediately)\b/i;

// ---------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------

test('the description: plain words pass; formatting, newlines and invisible characters go; a leading "for" and a trailing "please" drop', () => {
  assert.deepEqual(sanitizeLinkDescription('braids'), { ok: true, text: 'braids' });
  assert.deepEqual(sanitizeLinkDescription('for braids please'), { ok: true, text: 'braids' });
  assert.deepEqual(sanitizeLinkDescription("it's for the cake."), { ok: true, text: 'the cake' });
  assert.deepEqual(sanitizeLinkDescription('*Braids*\nand _nails_'), { ok: true, text: 'Braids and nails' });
  assert.deepEqual(sanitizeLinkDescription('  "school fees"  '), { ok: true, text: 'school fees' });
  assert.deepEqual(sanitizeLinkDescription(`braids${String.fromCharCode(0x2028)}and nails`), { ok: true, text: 'braids and nails' });
  assert.deepEqual(sanitizeLinkDescription(`> quoted ~struck~ \`code\``), { ok: true, text: 'quoted struck code' });
  assert.deepEqual(sanitizeLinkDescription('2 boxes of eggs'), { ok: true, text: '2 boxes of eggs' });
  assert.equal(plainText(`a${String.fromCharCode(0x200b)}b *c*`), 'ab c', 'zero-width characters vanish, formatting goes');
  assert.equal(cleanDescription(null), '');
  assert.equal(sameDescription('Braids.', 'braids'), true);
  assert.equal(sameDescription('braids', 'nails'), false);
});

test('the description: a link, a domain or an e-mail address is refused, never shown to the payer', () => {
  for (const t of ['https://evil.example/x', 'Rent https://evil.example/x', 'pay at evil.com', 'www.x.co.za', 'see wa.me/27821234567', 'bob@gmail.com', 'pleasepayme.co.za/PRXXXXXX', 'evil dot com', 'HTTP://EVIL.COM']) {
    assert.deepEqual(sanitizeLinkDescription(t), { ok: false, reason: 'LINK' }, t);
  }
  for (const t of ['e.g. braids', 'Mr.Smith lawn', 'R1.50 sweets']) assert.equal(sanitizeLinkDescription(t).ok, true, t);
});

test('the description: a phone or account number is refused; a date is not', () => {
  for (const t of ['call 082 123 4567', 'acc 1234567890', 'ref 12-34-567', 'id 9001015800087']) assert.deepEqual(sanitizeLinkDescription(t), { ok: false, reason: 'NUMBER' }, t);
  for (const t of ['invoice 2026-10-24', 'rent 24/10/2026', 'room 12', 'R150 deposit']) assert.equal(sanitizeLinkDescription(t).ok, true, t);
});

test('the description: wording that reads as WaPay or an authority is refused, spaced or with lookalike letters; "child support" is allowed', () => {
  const zw = String.fromCharCode(0x200b);
  for (const t of ['WaPay fee', 'W a P a y', 'wa-pay', 'W4Pay', `W${zw}aPay`, 'ｗａｐａｙ', 'SARS penalty', '5ARS', 'sars', 'support', 'tech support', 'WaPay Support', 'admin fee', `a${zw}dmin fee`, 'official notice', 'helpdesk', 'help desk', 'administrator']) {
    assert.deepEqual(sanitizeLinkDescription(t), { ok: false, reason: 'IMPERSONATION' }, t);
  }
  for (const t of ['child support', 'kwa payment', 'administration of the estate', 'supporters club']) assert.equal(sanitizeLinkDescription(t).ok, true, t);
});

test('the description: more than 60 characters is refused, never cut mid-word; nothing, or a "who" word, is no description', () => {
  assert.equal(DESCRIPTION_MAX, 60);
  assert.deepEqual(sanitizeLinkDescription('x'.repeat(30) + ' ' + 'y'.repeat(30)), { ok: false, reason: 'TOO_LONG' });
  assert.equal(sanitizeLinkDescription('x'.repeat(29) + ' ' + 'y'.repeat(30)).ok, true, '60 characters is fine');
  for (const t of [undefined, null, '', '   ', 'x', '1', '!!!', 'R150', 'someone', 'me', 'skip', 'nothing', 'please', 'thanks', 'payment']) {
    assert.deepEqual(sanitizeLinkDescription(t), { ok: false, reason: 'EMPTY' }, String(t));
  }
});

test('every refusal is one plain sentence: no em dash, no time promise', () => {
  for (const reason of ['EMPTY', 'LINK', 'NUMBER', 'IMPERSONATION', 'TOO_LONG']) {
    const line = descriptionRefusal(reason);
    assert.ok(line.length > 10 && line.length < 160, reason);
    assert.ok(!/—|–/.test(line) && !TIME_PROMISE.test(line), line);
  }
  assert.match(descriptionRefusal('IMPERSONATION'), /WaPay, SARS, support, admin or official/);
});

// ---------------------------------------------------------------------------
// Reading the ask
// ---------------------------------------------------------------------------

test('parseLinkAsk: the amount, what it is for and who pays; a payer number is never read as the amount', () => {
  const cases = [
    ['please pay me R150 for braids', 15000, 'braids', null],
    ['request R200 from 082 123 4567 for plumbing', 20000, 'plumbing', { msisdn: '0821234567' }],
    ['request R200 for plumbing from 0821234567', 20000, 'plumbing', { msisdn: '0821234567' }],
    ['request R80 to +27 82 123 4567 for lunch', 8000, 'lunch', { msisdn: '0821234567' }],
    ['request from 082 123 4567 R200', 20000, null, { msisdn: '0821234567' }],
    ['R250 from Thandi for the birthday gift', 25000, 'the birthday gift', { name: 'Thandi' }],
    ['please pay me R50 from Philly', 5000, null, { name: 'Philly' }],
    ['create a payment link for R100 for braids', 10000, 'braids', null],
    ['Please create a payment link for R20', 2000, null, null],
    ['please pay me for 2 boxes R150', 15000, '2 boxes', null],
    ['please pay me for braids 150', 15000, 'braids', null],
    ['please pay me R150 for 2 nights', 15000, '2 nights', null],
    ['I want to get paid R300 for the cake I baked', 30000, 'the cake I baked', null],
    ['please pay me', null, null, null],
  ];
  for (const [text, amountCents, description, payer] of cases) {
    assert.deepEqual(parseLinkAsk(text), { amountCents, description, payer }, text);
  }
});

// ---------------------------------------------------------------------------
// The one message
// ---------------------------------------------------------------------------

test('the card: one message that reads the same forwarded: who asks, the amount, what for, the link as text, how to pay; nothing for the requester alone', () => {
  const card = cardForLink({ account: ACCOUNT, request: LINK });
  assert.equal(card, CARD);
  assert.ok(!REQUESTER_ONLY.test(card), 'nothing only the requester should read');
  assert.match(card, /\nPay here: https:\/\/pleasepayme\.co\.za\/PRABCDEF\n/, 'the link as plain text: a forward strips buttons');
  assert.match(PAY_WAYS_LINE, /^No fee for you: pay by card, Instant EFT and more, or from a WaPay balance\.$/, 'the payer never pays a fee');
  const replaced = cardForLink({ account: ACCOUNT, request: LINK, replacedCents: 10000 });
  assert.ok(replaced.endsWith('\n\nThis link replaces the earlier R100 link, which no longer works.'), 'a replacement says so, which also tells a payer who had the old link');
  assert.ok(!/For:/.test(cardForLink({ account: ACCOUNT, request: { ...LINK, note: null } })), 'an older link without a description has no empty line');
});

test('the card names the requester by name and number tail, never the whole number; a name that reads as authority becomes the masked number', () => {
  assert.equal(cardRequesterLabel(ACCOUNT), 'Thandi Nkosi •••567');
  assert.equal(cardRequesterLabel({ msisdn: '27821112567', displayName: 'Thandi' }), 'Thandi •••567', 'the 27 form reads the same');
  for (const name of ['WaPay Support', 'SARS refunds', 'Admin', 'Official', 'W a P a y', '🔥🔥', '', null, '*bold*\n']) {
    const label = cardRequesterLabel({ msisdn: '0821112567', displayName: name });
    assert.ok(label === '082•••567' || (name === '*bold*\n' && label === 'bold •••567'), `${JSON.stringify(name)} → ${label}`);
  }
  assert.equal(cardRequesterLabel({ displayName: 'Thandi' }), 'Thandi', 'no number, no tail');
  assert.equal(cardRequesterLabel({}), 'A WaPay user');
  assert.ok(!cardForLink({ account: ACCOUNT, request: LINK }).includes('0821112567'), 'never the whole number');
});

test('the tap-to-send link opens the requester\'s own chat with that number, the card ready to send', async () => {
  const url = tapToSendUrl({ msisdn: '082 123 4567', text: CARD });
  assert.ok(url.startsWith('https://wa.me/27821234567?text='), url);
  assert.equal(decodeURIComponent(url.slice('https://wa.me/27821234567?text='.length)), CARD);
  assert.equal(tapToSendUrl({ msisdn: '12345', text: CARD }), null, 'not a SA cellphone, no link');
  assert.equal(shareToWhatsAppUrl('hi there'), 'https://wa.me/?text=hi%20there', 'no number: WhatsApp asks who to send it to');

  const out = await composeLinkCreated({ card: CARD, tapMsisdn: '0821234567' });
  const [shown, link] = [out.text.slice(0, out.text.lastIndexOf('\n')), out.text.slice(out.text.lastIndexOf('\n') + 1)];
  assert.equal(shown, `${CARD}\n\n📲 Tap to send it to 082 123 4567 from your own WhatsApp:`);
  assert.equal(link, tapToSendUrl({ msisdn: '0821234567', text: CARD }));
  assert.equal(out.recordAs, `${CARD}\n\n[tap-to-send link to 082•••567]`, 'memory keeps the card and a masked number, not the long link');
  const none = await composeLinkCreated({ card: CARD });
  assert.deepEqual(none, { text: CARD, recordAs: null });
});

test('the tap-to-send prefill follows a translation, and falls back to the English card when the translation loses the paragraph break', async () => {
  const zu = (t) => t.replace('is asking you to pay', 'ucela ukuthi umkhokhele').replace('Tap to send it to', 'Thepha ukuze uthumele ku');
  const out = await composeLinkCreated({ card: CARD, tapMsisdn: '0821234567', localize: async (t) => zu(t) });
  const prefill = decodeURIComponent(out.text.split('?text=')[1]);
  assert.equal(prefill, zu(CARD), 'the payer gets the card the requester reads');
  const flattened = await composeLinkCreated({ card: CARD, tapMsisdn: '0821234567', localize: async (t) => t.replace(/\n\n/g, ' ') });
  assert.equal(decodeURIComponent(flattened.text.split('?text=')[1]), CARD);
});

function stubDeps({ windowOpen = true } = {}) {
  const calls = { send: [], window: [], member: [], log: [] };
  return {
    calls,
    deps: {
      send: async (args) => { calls.send.push(args); return { ok: true }; },
      localize: async (t) => t,
      windowOpen: async (waId) => { calls.window.push(waId); return windowOpen; },
      deliverToMember: async (waId) => { calls.member.push(waId); return true; },
      log: (type, data) => calls.log.push({ type, ...data }),
    },
  };
}

test('one message after a link is made, asserted on what is sent; WaPay\'s member note only inside the 24-hour window; the requester\'s text is the same either way', async () => {
  const request = { ...LINK };
  // No payer named: one message, the card, remembered with the link as its reference.
  const plain = stubDeps();
  await sendCreatedLink(plain.deps, { to: '27821112567', account: ACCOUNT, request });
  assert.equal(plain.calls.send.length, 1);
  assert.deepEqual(plain.calls.send[0], { to: '27821112567', text: CARD, kind: 'flow', refs: { request: 'PRABCDEF' } });
  assert.equal(plain.calls.window.length + plain.calls.member.length, 0);

  // A number that is not a member: the card and the tap-to-send link, in the same one message; nothing to the payer.
  const stranger = stubDeps();
  await sendCreatedLink(stranger.deps, { to: '27821112567', account: ACCOUNT, request, tapMsisdn: '0821234567' });
  assert.equal(stranger.calls.send.length, 1);
  assert.equal(stranger.calls.send[0].to, '27821112567', 'only the requester is written to');

  // A member inside their window gets WaPay's note; outside it, nothing (Meta drops a plain text, BUGLOG #138).
  const open = stubDeps({ windowOpen: true });
  const inside = await sendCreatedLink(open.deps, { to: '27821112567', account: ACCOUNT, request, tapMsisdn: '0821234567', member: { waId: '27821234567' } });
  assert.deepEqual(open.calls.window, ['27821234567']);
  assert.deepEqual(open.calls.member, ['27821234567']);
  assert.equal(inside.memberDelivered, true);
  const closed = stubDeps({ windowOpen: false });
  const outside = await sendCreatedLink(closed.deps, { to: '27821112567', account: ACCOUNT, request, tapMsisdn: '0821234567', member: { waId: '27821234567' } });
  assert.deepEqual(closed.calls.member, [], 'outside the window WaPay sends the payer nothing');
  assert.equal(outside.memberDelivered, false);
  assert.deepEqual(closed.calls.log[0], { type: 'payrequest_directed', accountId: 'acc_req', code: 'PRABCDEF', windowOpen: false, delivered: false });
  for (const c of [open, closed]) assert.equal(c.calls.send.length, 1, 'still exactly one message to the requester');

  // Membership-neutral: the same words whatever the number is.
  assert.equal(open.calls.send[0].text, stranger.calls.send[0].text);
  assert.equal(closed.calls.send[0].text, stranger.calls.send[0].text);
  assert.ok(!/on WaPay|let .* know|member/i.test(stranger.calls.send[0].text));
  // The requester is written to before the member is even looked at.
  const order = [];
  await sendCreatedLink({ ...open.deps, send: async () => { order.push('send'); return { ok: true }; }, windowOpen: async () => { order.push('window'); return true; }, deliverToMember: async () => { order.push('member'); return true; } }, { to: 'x', account: ACCOUNT, request, member: { waId: 'y' } });
  assert.deepEqual(order, ['send', 'window', 'member']);
});

// ---------------------------------------------------------------------------
// my links, remind, cancel
// ---------------------------------------------------------------------------

test('my links: one short message, a numbered list (amount, what for, how long ago, code), the two next steps and the web page', () => {
  const now = Date.parse('2026-10-24T10:00:00Z');
  const text = myLinksText({
    now,
    webUrl: 'app.wapay.co.za/app/links',
    links: [
      { id: 'PRABCDEF', amountCents: 15000, note: 'braids', createdAt: new Date('2026-10-24T08:00:00Z') },
      { id: 'PRGHJKMN', amountCents: 4000, note: 'lunch', createdAt: new Date('2026-10-21T08:00:00Z') },
      { id: 'PRPQRSTU', amountCents: 2050, note: null, createdAt: new Date('2026-10-23T08:00:00Z') },
    ],
  });
  assert.equal(text, [
    '🔗 *Your open payment links*',
    '1. R150 for braids · today · PRABCDEF',
    '2. R40 for lunch · 3 days ago · PRGHJKMN',
    '3. R20.50 · yesterday · PRPQRSTU',
    '',
    'Reply *remind 1* for a reminder to forward, or *cancel 1* to close that link.',
    'All your links: app.wapay.co.za/app/links',
  ].join('\n'));
  assert.equal(myLinksText({ links: [], webUrl: 'app.wapay.co.za/app/links' }), '🔗 You have no open payment links.\n\nTo make one, tell me the amount and what it is for, like "R150 for braids".\nAll your links: app.wapay.co.za/app/links');
  const many = myLinksText({ now, links: Array.from({ length: 12 }, (_, i) => ({ id: `PRAAAA${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`, amountCents: 1000, note: 'x y', createdAt: new Date(now) })) });
  assert.match(many, /\n10\. R10 for x y/);
  assert.match(many, /\nand 2 more on the web\n/);
});

test('relativeDay counts South African calendar days; dateShort is South African too', () => {
  const now = Date.parse('2026-10-24T10:00:00Z'); // 12:00 SAST
  assert.equal(relativeDay('2026-10-23T22:30:00Z', now), 'today', '00:30 SAST on the 24th');
  assert.equal(relativeDay('2026-10-23T21:30:00Z', now), 'yesterday', '23:30 SAST on the 23rd');
  assert.equal(relativeDay('2026-10-17T10:00:00Z', now), '7 days ago');
  assert.equal(dateShort('2026-10-31T22:30:00Z'), '1 Nov');
});

test('the reminder is the same card, marked as a reminder, with the date the link closes; the web gets the same texts', () => {
  const reminder = reminderCardFor({ account: ACCOUNT, request: LINK });
  assert.equal(reminder, `🔔 *Reminder: Thandi Nkosi •••567 is asking you to pay R150*\nFor: braids\n\nPay here: https://pleasepayme.co.za/PRABCDEF\n${PAY_WAYS_LINE}\nOpen until 31 Oct.`);
  assert.ok(!REQUESTER_ONLY.test(reminder));
  const web = webLinkTexts({ account: ACCOUNT, request: LINK });
  assert.deepEqual(web, { shareText: CARD, reminderText: reminder, remindUrl: `https://wa.me/?text=${encodeURIComponent(reminder)}` });
  assert.equal(displayDescription('x'.repeat(100)).length, 80, 'an older 120-character note is shortened for display');
});

test('the link commands: "my links", "remind 2", "cancel 2" and codes; anything else is not a command', () => {
  for (const t of ['my links', 'My payment links', 'links', 'show my links', 'open links', 'my link', 'my requests', 'track my links', 'my links?', 'unpaid links']) assert.deepEqual(matchLinkCommand(t), { kind: 'LIST' }, t);
  assert.deepEqual(matchLinkCommand('remind 2'), { kind: 'REMIND', n: 2 });
  assert.deepEqual(matchLinkCommand('Remind #2'), { kind: 'REMIND', n: 2 });
  assert.deepEqual(matchLinkCommand('send reminder 3'), { kind: 'REMIND', n: 3 });
  assert.deepEqual(matchLinkCommand('remind PRabcdef'), { kind: 'REMIND', code: 'PRABCDEF' });
  assert.deepEqual(matchLinkCommand('cancel 2'), { kind: 'CANCEL', n: 2 });
  assert.deepEqual(matchLinkCommand('cancel link 3'), { kind: 'CANCEL', n: 3 });
  assert.deepEqual(matchLinkCommand('cancel request PRABCDEF'), { kind: 'CANCEL', code: 'PRABCDEF' });
  assert.deepEqual(matchLinkCommand('please cancel my request PRABCDEF thanks'), { kind: 'CANCEL', code: 'PRABCDEF' });
  for (const t of ['cancel', 'remind me', 'remind me tomorrow', 'payment request', 'payment link', 'please pay me R150', 'who paid my link', 'my transactions', 'link', '']) assert.equal(matchLinkCommand(t), null, t);
});

test('the description step lets other requests through (never trap); a description is not mistaken for one', () => {
  for (const t of ['send R50 to 0821234567', 'pay request PRABCDEF', 'balance', 'my balance', 'show me my transactions', 'forgot my pin', 'speak zulu', 'invite']) assert.equal(looksLikeOtherRequest(t), true, t);
  for (const t of ['braids', 'school fees', 'airtime for my mom', 'to buy groceries', 'transport money', 'the cake']) assert.equal(looksLikeOtherRequest(t), false, t);
});

test('openLinksOf reads open personal links only, newest first', async () => {
  let seen = null;
  const prisma = { paymentRequest: { findMany: async (q) => { seen = q; return []; } } };
  await openLinksOf({ prisma, accountId: 'acc_req', now: Date.parse('2026-10-24T10:00:00Z') });
  assert.deepEqual(seen.where, { accountId: 'acc_req', businessId: null, status: 'PENDING', expiresAt: { gt: new Date('2026-10-24T10:00:00Z') } });
  assert.deepEqual(seen.orderBy, { createdAt: 'desc' });
});

test('every string the links module produces keeps the copy rules: no em dash, no time promise, the ad campaign words', () => {
  const strings = [
    CARD, cardForLink({ account: ACCOUNT, request: LINK, replacedCents: 10000 }), reminderCardFor({ account: ACCOUNT, request: LINK }),
    descriptionQuestion({ amountCents: 15000 }), descriptionQuestion({ amountCents: 15000, refused: 'LINK' }), descriptionQuestion({ amountCents: 15000, replacedCents: 10000 }),
    myLinksText({ links: [LINK] }), myLinksText({ links: [] }),
    ...['EMPTY', 'LINK', 'NUMBER', 'IMPERSONATION', 'TOO_LONG'].map(descriptionRefusal),
  ];
  for (const s of strings) {
    assert.ok(!/—|–/.test(s), s);
    assert.ok(!TIME_PROMISE.test(s.replace(/Open until \d+ \w+\./, '')), s);
    assert.deepEqual(copyViolations(s), [], s);
  }
  assert.equal(descriptionQuestion({ amountCents: 15000 }), '🙏 What is the R150 for? The person paying sees it on the link.\n\nReply in a few words, like "braids" or "rent", or "cancel" to stop.');
});

// ---------------------------------------------------------------------------
// The Pay agent and the wiring
// ---------------------------------------------------------------------------

test('the Pay agent: start_pay_link carries what the link is for, strict and nullable; the slot is short and digit-free', async () => {
  const def = buildToolDefinitions({ waId: '27600000901' }).find((d) => d.function.name === 'start_pay_link');
  assert.ok(def, 'offered to every customer');
  assert.deepEqual(def.function.parameters.required.sort(), ['amountCents', 'description']);
  assert.deepEqual(def.function.parameters.properties.description.type, ['string', 'null']);
  assert.match(def.function.description, /Every link says what it is for/);
  assert.ok(SLOT_KEYS.includes('description'));
  const out = await executeTool({ name: 'start_pay_link', args: { amountCents: 15000, description: '  braids  ' }, ctx: { waId: '27600000901' } });
  assert.equal(out.proposal.action, 'REQUEST_MONEY');
  assert.equal(out.proposal.slots.description, 'braids');
  assert.equal(slotsFor('REQUEST_MONEY', { amountCents: 15000, description: 'call 0821234567 now' }).description, 'call now', 'a number never rides in a slot');
  assert.equal(slotsFor('REQUEST_MONEY', { amountCents: 15000, description: null }).description, null);
  assert.equal(slotsFor('SEND_VOUCHER', { amountCents: 5000, description: 'x' }).description, null, 'only the pay link reads it');
  // The dispatcher hands it to the flow, which checks it like any other description.
  assert.match(processor, /case 'REQUEST_MONEY':\s*\n\s*return await handleCreatePaymentRequest\(\{ from, account, amountCents, rawText: text, noteHint: typeof result\.slots\?\.description === 'string' \? result\.slots\.description : null \}\);/);
});

test('wiring: no link without a description, asked once before the fee choice; the description step escapes; link commands answer before the agent', () => {
  const create = fnBody(processor, 'handleCreatePaymentRequest');
  const gate = create.indexOf('const described = describedAs ? sanitizeLinkDescription(describedAs) : null;');
  assert.ok(gate > 0, 'the gate exists');
  assert.ok(gate < create.indexOf('!confirmed && quoteFeeCents > 0'), 'before the fee choice');
  assert.ok(gate < create.indexOf('createPaymentRequest({ accountId'), 'before any link is minted');
  assert.match(create, /createPaymentRequest\(\{ accountId: account\.id, amountCents, note: linkNote \}\)/, 'the link carries the checked description');
  assert.match(create, /updateConversationState\(from, 'REQUEST_MONEY_NOTE'/);
  // The description state: cancel, link commands, questions and other requests all get out.
  const note = processor.slice(processor.indexOf("case 'REQUEST_MONEY_NOTE': {"), processor.indexOf("case 'AD_FIRST_LINK': {"));
  assert.match(note, /\^\(cancel\|stop\|no\|home\|menu\|back\|exit\)\$/);
  assert.match(note, /Cancelled\. No link was created\./);
  assert.match(note, /if \(matchLinkCommand\(text\) \|\| looksLikeQuestion\(text\) \|\| looksLikeOtherRequest\(text\)\) \{\s*await updateConversationState\(from, null\);\s*return await handlePostOnboarding/);
  // The ad first link passes its words on; the web refuses before its claim.
  assert.match(processor, /adPayerName: ask\.payerName \|\| null, noteHint: ask\.note \|\| null/);
  const money = read('../lib/app-money.js');
  const link = money.slice(money.indexOf('export async function createLink('), money.indexOf('export async function cancelLink('));
  assert.ok(link.indexOf('checkProof(') < link.indexOf('sanitizeLinkDescription(note)') && link.indexOf('sanitizeLinkDescription(note)') < link.indexOf('auditLog.create('), 'proof, then the description, then the claim');
  // "my links" and friends run before the Pay agent, so the pilot numbers get them too (BUGLOG #92).
  const post = processor.slice(processor.indexOf('async function handlePostOnboarding('));
  assert.ok(post.indexOf('const linkCmd = matchLinkCommand(text);') > 0 && post.indexOf('const linkCmd = matchLinkCommand(text);') < post.indexOf('if (agentV3For(from)) {\n    return await handleAgentTurn('));
  // The member note is window-gated and the old two- and three-message endings are gone.
  assert.match(create, /windowOpen: \(waId\) => serviceWindowOpen\(prisma, \{ waId \}\)/);
  assert.ok(!/Payment request created|Forward the next message|View my payment page/.test(processor), 'the old messages are gone');
});
