/**
 * The one customer fact the model may ask to keep (C16 of
 * docs/AGENT_ARCHITECTURE_V2.md): it proposes, the runtime asks, and only an
 * explicit yes writes.
 *
 * Until 2026-09-18 `propose_note` wrote the note the moment the model called
 * it, which made the model the author of a customer fact and broke the
 * standing rule in lib/user-profile.js that every profile key is written
 * deterministically at a success point and never by the model.
 *
 * Three layers are checked here: the tool (pure), the writer (deterministic,
 * capped) and the wiring in the processor (ask before write, and a yes is the
 * only thing that writes).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { executeProposeNote } from '../lib/agent/tools/proposals.js';
import { addNote, NOTES_MAX } from '../lib/user-profile.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');

// A prisma stub shaped like the one lib/profile-merge.js drives.
function stubPrisma(profile = {}) {
  const store = { profile: { ...profile } };
  const calls = [];
  return {
    _store: store,
    _calls: calls,
    account: {
      async findUnique() {
        calls.push(['findUnique']);
        return { profile: store.profile };
      },
    },
    async $executeRaw(_strings, ...values) {
      // mergeProfileAtomic passes the patch as a JSON string into jsonb ||.
      calls.push(['$executeRaw', values]);
      const json = values.find((v) => typeof v === 'string' && v.startsWith('{'));
      store.profile = { ...store.profile, ...(json ? JSON.parse(json) : {}) };
      return 1;
    },
  };
}

test('the tool proposes and touches nothing: no database, no clock, no context needed', () => {
  const out = executeProposeNote({ note: 'You usually buy airtime for your mum.' });
  assert.equal(out.ok, true);
  assert.equal(out.accepted, false);
  assert.equal(out.note, null);
  assert.deepEqual(out.pendingNote, { text: 'You usually buy airtime for your mum.' });
  assert.equal(out.reason, 'NEEDS_CONFIRM');
  // A refusal is still a refusal, and carries nothing pending.
  const bad = executeProposeNote({ note: 'You send R50 to Philly every week.' });
  assert.equal(bad.reason, 'HAS_DIGITS');
  assert.equal(bad.pendingNote, undefined);
});

test('addNote is the only writer, keeps the newest ten, and leaves every other profile key alone', async () => {
  const prisma = stubPrisma({
    language: 'zu',
    lastMeterNumber: '01234567890',
    notes: Array.from({ length: NOTES_MAX - 1 }, (_, i) => ({ text: `note ${'x'.repeat(i)}`, at: '2026-01-01T00:00:00.000Z' })),
  });
  const first = await addNote({ prisma, accountId: 'acc-1', text: 'You usually buy airtime for your mum.' });
  assert.equal(first.count, NOTES_MAX);
  assert.equal(first.note.text, 'You usually buy airtime for your mum.');
  const second = await addNote({ prisma, accountId: 'acc-1', text: 'You prefer isiZulu replies.' });
  assert.equal(second.count, NOTES_MAX, 'capped: the oldest drops');
  const { notes, language, lastMeterNumber } = prisma._store.profile;
  assert.equal(notes.length, NOTES_MAX);
  assert.equal(notes[notes.length - 1].text, 'You prefer isiZulu replies.');
  assert.equal(language, 'zu', 'other keys untouched');
  assert.equal(lastMeterNumber, '01234567890');
  // The same note twice moves it to the end rather than storing it twice.
  await addNote({ prisma, accountId: 'acc-1', text: 'You prefer isiZulu replies.' });
  const texts = prisma._store.profile.notes.map((n) => n.text);
  assert.equal(texts.filter((t) => t === 'You prefer isiZulu replies.').length, 1);
  // Nothing to write is not an error.
  assert.equal(await addNote({ prisma, accountId: 'acc-1', text: '   ' }), null);
  assert.equal(await addNote({ prisma, accountId: null, text: 'You like data.' }), null);
});

test('no tool under lib/agent/tools can write a customer fact any more', () => {
  const proposals = read('../lib/agent/tools/proposals.js');
  assert.ok(!/updateProfile|mergeProfileAtomic/.test(proposals), 'the tools folder holds no profile writer');
  assert.ok(!/from '\.\.\/\.\.\/user-profile\.js'/.test(proposals), 'and does not import one');
});

// The wiring. These are source assertions on purpose: what they protect is an
// ORDER inside one long function, which is the one thing a behaviour test of a
// single unit cannot see.
test('the processor asks before it writes, and parks only a question the customer saw', () => {
  const turn = processor.slice(processor.indexOf('async function handleAgentTurn('), processor.indexOf('async function handleAIChat('));
  const askAt = turn.indexOf('Want me to remember this?');
  const gateAt = turn.indexOf('const gate = outputGate(out, { withdrawLive });');
  const sendAt = turn.indexOf("kind: blocked ? 'fallback' : 'agent'");
  const parkAt = turn.indexOf("updateConversationState(from, 'AGENT_NOTE_CONFIRM'");
  assert.ok(askAt > 0 && gateAt > askAt, 'the note text is composed before the output gate, so the model text is gated');
  assert.ok(sendAt > gateAt && parkAt > sendAt, 'send, then park: a failed send leaves nothing waiting for a yes');
  assert.match(turn, /else if \(!blocked && pendingNote\)/, 'a blocked turn parks nothing');
  assert.ok(!/addNote\(/.test(turn), 'handleAgentTurn never writes the note itself');
});

test('only an explicit yes writes; anything else keeps nothing and is still answered', () => {
  const hook = processor.slice(
    processor.indexOf("if (state === 'AGENT_NOTE_CONFIRM') {"),
    processor.indexOf('if (state) {\n    // Universal intent-switch escape'),
  );
  assert.ok(hook.length > 0, 'the hook sits above the generic state block, so it is not routed as a flow');
  assert.ok(
    hook.indexOf('await updateConversationState(from, null);') < hook.indexOf('addNote('),
    'the state is cleared before anything is written, so a redelivered turn cannot write twice',
  );
  assert.match(hook, /addNote\(\{ accountId: account\.id, text: pendingNote\.text \}\)/);
  assert.match(hook, /state = null; data = null;/, 'anything that is not a yes or a no falls through and is answered');
  // The yes must be an explicit one: a sentence is not a yes.
  const yesRe = /\/\^\\W\*\(yes\|yep\|yeah\|y\|sure\|ok\|okay\|alright\|confirm\|please\|yebo\|ewe\|ja\|ee\|eya\)\\W\*\$\/i/;
  assert.match(hook, yesRe);
  // The idle expiry and the home trigger both sit above this hook, so a yes
  // typed the next morning writes nothing.
  assert.ok(
    processor.indexOf('if (state === \'AGENT_NOTE_CONFIRM\') {') > processor.indexOf('isHomeTrigger(text)'),
    'home and idle expiry win over a pending note',
  );
});

test('a shared contact while a note is pending is not told to finish another step', () => {
  const shared = processor.slice(processor.indexOf('async function handleSharedContact('), processor.indexOf('async function handlePostOnboarding('));
  assert.match(shared, /state === 'AGENT_CLARIFY' \|\| state === 'AGENT_NOTE_CONFIRM'/);
});
