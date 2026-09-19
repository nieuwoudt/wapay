/**
 * Memory: remember as much as possible, unless the customer says not to.
 *
 * Founder direction 2026-09-19. What the customer tells us about themselves is
 * kept the moment the model hears it, with no confirmation turn, and it is
 * RENDERED INTO THE PROMPT so the next conversation is better for it. For one
 * day the write was gated behind a "shall I remember this?" question; that was
 * the wrong default, because a question most people never answer means almost
 * nothing is ever kept.
 *
 * Three things this locks, in order of how much they would cost if they broke:
 *  1. No figure ever enters memory. That is money safety, not preference.
 *  2. What is remembered actually reaches the model. Before 2026-09-19 the
 *     notes were stored and never shown to it, which made them pointless.
 *  3. The customer can stop it, see it, and erase it, and those are three
 *     different things.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { executeProposeNote, noteRejection } from '../lib/agent/tools/proposals.js';
import { addNote, setMemoryOptOut, NOTES_MAX } from '../lib/user-profile.js';
import { renderCustomerRecord, NOTES_IN_RECORD } from '../lib/context-pack.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');

// A prisma stub shaped like the one lib/profile-merge.js drives.
function stubPrisma(profile = {}) {
  const store = { profile: { ...profile } };
  const calls = [];
  return {
    _store: store,
    _calls: calls,
    account: { async findUnique() { calls.push(['findUnique']); return { profile: store.profile }; } },
    async $executeRaw(_s, ...values) {
      calls.push(['$executeRaw']);
      const json = values.find((v) => typeof v === 'string' && v.startsWith('{'));
      store.profile = { ...store.profile, ...(json ? JSON.parse(json) : {}) };
      return 1;
    },
  };
}

test('no figure can ever enter memory, whatever the model says', () => {
  // The money-safety half, unchanged by the direction change.
  assert.equal(noteRejection('You send R50 to Philly every week.'), 'HAS_DIGITS');
  assert.equal(noteRejection('Your PIN is 1234.'), 'HAS_DIGITS');
  assert.equal(noteRejection('Your balance is 66 rand.'), 'HAS_DIGITS');
  assert.equal(noteRejection('Your account number is 62xxxxxxx.'), 'HAS_DIGITS');
  assert.equal(noteRejection('The weather is nice today.'), 'NOT_ABOUT_CUSTOMER');
  assert.equal(noteRejection('x'.repeat(200)), 'TOO_LONG');
  assert.equal(noteRejection('You usually buy airtime for your mum on Fridays.'), null);
});

test('a fact the customer states is kept at once, with no question asked', async () => {
  const prisma = stubPrisma({ language: 'zu' });
  const out = await executeProposeNote(
    { note: 'You usually buy airtime for your mum.' },
    { prisma, account: { id: 'acc-1' } },
  );
  assert.equal(out.ok, true);
  assert.equal(out.accepted, true, 'kept, not merely proposed');
  assert.equal(out.note.text, 'You usually buy airtime for your mum.');
  assert.equal(prisma._store.profile.notes.length, 1);
  assert.equal(prisma._store.profile.language, 'zu', 'other keys untouched');
  // A refused note is still refused, and writes nothing.
  const bad = await executeProposeNote({ note: 'You send R50 weekly.' }, { prisma, account: { id: 'acc-1' } });
  assert.equal(bad.accepted, false);
  assert.equal(bad.reason, 'HAS_DIGITS');
  assert.equal(prisma._store.profile.notes.length, 1);
});

test('what is remembered reaches the model, which is the whole point of remembering it', () => {
  const record = renderCustomerRecord({
    displayName: 'Nieuwoudt',
    balances: { spendCents: 6600, cashCents: 0, heldSpendCents: 0, heldCashCents: 0 },
    movements: [],
    notes: [
      { text: 'You buy airtime for your mother on Fridays.', at: '2026-09-19T10:00:00.000Z' },
      { text: 'You prefer to be called Nie.', at: '2026-09-19T10:05:00.000Z' },
    ],
  });
  assert.match(record, /What they have told you about themselves:/);
  assert.match(record, /- You buy airtime for your mother on Fridays\./);
  assert.match(record, /- You prefer to be called Nie\./);
  // Bounded, so a customer with many notes cannot crowd out their own balance.
  const many = renderCustomerRecord({
    balances: { spendCents: 100 },
    movements: [],
    notes: Array.from({ length: NOTES_MAX }, (_, i) => ({ text: `You like thing ${'x'.repeat(i % 5)}`, at: null })),
  });
  assert.equal((many.match(/^- You like thing/gm) || []).length, NOTES_IN_RECORD);
  assert.match(many, /Balance to spend/);
});

test('the cap keeps the newest and never stores the same thing twice', async () => {
  const prisma = stubPrisma({
    notes: Array.from({ length: NOTES_MAX }, (_, i) => ({ text: `note ${i}`, at: '2026-01-01T00:00:00.000Z' })),
  });
  const out = await addNote({ prisma, accountId: 'acc-1', text: 'You are saving for a car.' });
  assert.equal(out.count, NOTES_MAX, 'capped');
  const notes = prisma._store.profile.notes;
  assert.equal(notes[notes.length - 1].text, 'You are saving for a car.');
  assert.ok(!notes.some((n) => n.text === 'note 0'), 'the oldest dropped');
  await addNote({ prisma, accountId: 'acc-1', text: 'You are saving for a car.' });
  assert.equal(prisma._store.profile.notes.filter((n) => n.text === 'You are saving for a car.').length, 1);
});

test('"stop remembering" stops it, and is not the same thing as erasing', async () => {
  const prisma = stubPrisma({ notes: [{ text: 'You like data bundles.', at: null }] });
  await setMemoryOptOut({ prisma, accountId: 'acc-1', optOut: true });
  assert.equal(prisma._store.profile.memoryOptOut, true);
  const blocked = await addNote({ prisma, accountId: 'acc-1', text: 'You buy for your brother.' });
  assert.equal(blocked.optedOut, true);
  assert.equal(prisma._store.profile.notes.length, 1, 'nothing new was kept');
  assert.equal(prisma._store.profile.notes[0].text, 'You like data bundles.', 'and nothing old was destroyed');
  // The tool reports it rather than claiming success.
  const viaTool = await executeProposeNote({ note: 'You buy for your brother.' }, { prisma, account: { id: 'acc-1' } });
  assert.equal(viaTool.accepted, false);
  assert.equal(viaTool.reason, 'MEMORY_OFF');
  // And it can be turned back on.
  await setMemoryOptOut({ prisma, accountId: 'acc-1', optOut: false });
  const again = await addNote({ prisma, accountId: 'acc-1', text: 'You buy for your brother.' });
  assert.equal(again.note.text, 'You buy for your brother.');
});

test('the three memory commands are distinct, and stopping is never answered with a disclosure', () => {
  const offAt = processor.indexOf('if (matchMemoryOff(text))');
  const onAt = processor.indexOf('if (matchMemoryOn(text))');
  const forgetAt = processor.indexOf('if (matchForgetMe(text))');
  const aboutAt = processor.indexOf('if (matchAboutMeAsk(text))');
  const looseAt = processor.indexOf('const ask = memoryHistoryAsk(text);');
  assert.ok(offAt > 0 && onAt > offAt, 'both switches are wired');
  assert.ok(forgetAt < offAt, 'erasure still comes first');
  assert.ok(offAt < looseAt, 'the loose memory matcher can never steal "stop remembering" (BUGLOG #71 shape)');
  assert.ok(aboutAt > 0);
  // Opting out must not erase: the two handlers are different.
  const sw = processor.slice(processor.indexOf('async function handleMemorySwitch('), processor.indexOf('async function handleAboutMe('));
  assert.ok(!/eraseTurns|notes: \[\]/.test(sw), 'stopping keeps what is already there');
  assert.match(sw, /setMemoryOptOut\(/);
});

test('the model asks no permission and the runtime holds no pending note', () => {
  assert.ok(!processor.includes('AGENT_NOTE_CONFIRM'), 'the confirmation state is gone');
  assert.ok(!processor.includes('pendingNote'), 'and so is its plumbing');
  assert.ok(!read('../packages/ai/src/agent.ts').includes('pendingNote'));
  // The prompt tells it to remember, in as many words.
  const prompt = read('../packages/ai/src/prompt.ts');
  assert.match(prompt, /REMEMBER THEM/);
  assert.match(prompt, /Never store a figure, a balance, a PIN or an account number/);
});
