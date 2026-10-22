/**
 * B. The PIN chosen on demand (WAPAY_PIN_ON_DEMAND, 2026-10-22; docs/ONBOARDING.md §5,
 * golden thread 2.14).
 *
 * Locks:
 * - the switch: B, or A / C (their accounts open without a PIN), or an account
 *   that finished sign-up without one; unset is nobody;
 * - each gate (pay-out, send, paying a link, the "PIN" ask) asks for a PIN once:
 *   while the account has none; with a PIN, or with the switch off, the flow is
 *   exactly as before and hasPIN is not even read;
 * - choose, confirm, then the interrupted step carries on with that PIN in the
 *   same turn; the PIN is stored only by setPIN, never over an existing one,
 *   never in clear in the conversation data; verifyPIN stays the only verifier;
 * - the interrupted pay-out keeps its sealed fields at the top level;
 * - the web login says "Set your WaPay PIN in the WhatsApp chat first (say *PIN*)"
 *   in the same words for every failure, so it never tells who is on WaPay;
 * - the agent prompt and the registry describe the PIN as set on the first
 *   pay-out or send, only while the switch covers the customer;
 * - the classic sign-up skips its PIN step under B.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.WAPAY_APP_SESSION_SECRET ||= 'test-app-session-secret-0123456789';

import { pinOnDemandFor, pinDeferredAtSignupFor, portalNoPinLineFor, FLAGS } from '../lib/onboarding-flags.js';
import { pinSetupGateStep, handlePinSetupReply, startPinSetup, resumeOf, matchPinSetupAsk, CHOOSE_PROMPT, CONFIRM_PROMPT, PIN_SET_LINE, NO_PIN_YET, PIN_SETUP_STATES } from '../lib/pin-setup.js';
import { SEALED_PATHS } from '../lib/flow-seal.js';
import { withLeadLine, sendWhatsAppText, configureSay } from '../lib/say.js';
import { appLogin, forgotCheck, LOGIN_FAILED_LINE, NO_PIN_YET_LINE, loginFailedLine } from '../lib/app-login.js';
import { helpLines, promptLines, PIN_ON_DEMAND_ONE_LINER, PIN_ON_DEMAND_HELP_LINE } from '../lib/capabilities.js';
const { validatePINFormat } = await import('../packages/auth/dist/pin.js');
const { buildAgentPromptPrefix, PIN_ON_DEMAND_RULE } = await import('../packages/ai/dist/prompt.js');

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');
const onboardingTs = read('../packages/auth/src/onboarding.ts');
const fnBody = (src, name) => {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start > -1, `${name} exists`);
  return src.slice(start, src.indexOf('\n}\n', start));
};

const ENV_ON = { [FLAGS.PIN_ON_DEMAND]: '0600000919', WAPAY_PII_KEY: 'test-pii-key-for-hmac-only-0123456789' };
const ACCOUNT = { id: 'acc_nopin', waId: '27600000919', profile: { onboarding: { path: 'ONE_STEP' } } };
const PIN = '2580';

function authStub({ has = false } = {}) {
  const calls = { setPIN: [], hasPIN: 0 };
  let set = has;
  return {
    calls,
    auth: {
      validatePINFormat,
      async setPIN({ accountId, pin }) { calls.setPIN.push({ accountId, pin }); set = true; return { ok: true }; },
      async hasPIN() { calls.hasPIN += 1; return set; },
    },
    hasPin: async () => { calls.hasPIN += 1; return set; },
  };
}

// ---------------------------------------------------------------- the switch

test('the switch: B covering the number, or an account that finished without a PIN; unset is nobody; A or C alone change no account they did not open', () => {
  assert.equal(pinOnDemandFor({ waId: '27600000919', account: { profile: {} } }, {}), false);
  assert.equal(pinOnDemandFor({ waId: '27600000919' }, ENV_ON), true);
  assert.equal(pinOnDemandFor({ waId: '27600000919', account: { profile: {} } }, { WAPAY_ONBOARDING_ONE_STEP: 'on', WAPAY_PAYER_PREREGISTER: 'on' }), false, 'A or C on: a classic account is untouched');
  const openedByA = { waId: '27600000919', profile: { onboarding: { path: 'ONE_STEP', pinDeferred: true } } };
  assert.equal(pinOnDemandFor({ waId: openedByA.waId, account: openedByA }, { WAPAY_ONBOARDING_ONE_STEP: 'on' }), true, 'an account A or C opened carries pinDeferred');
  assert.equal(pinOnDemandFor({ waId: '27600000999', account: { profile: { onboarding: { pinDeferred: true } } } }, {}), true, 'a switch turned off never strands such an account');
  assert.equal(pinDeferredAtSignupFor('27600000919', ENV_ON), true);
  assert.equal(pinDeferredAtSignupFor('27600000919', { WAPAY_ONBOARDING_ONE_STEP: 'on', WAPAY_PAYER_PREREGISTER: 'on' }), false, 'the classic sign-up skips its PIN only under B');
  assert.match(processor, /const deferPin = pinDeferredAtSignupFor\(from\);/);
  assert.match(processor, /const deferPin = pinDeferredAtSignupFor\(from\);\s*const started = await startOnboardingFromAd\(\{ accountId: account\.id, waId: from, msisdn: account\.msisdn \|\| from, displayName, deferPin \}\);\s*if \(deferPin\) await stampPinDeferredIfSkipped\(\{ account \}\);/);
});

// ---------------------------------------------------------------- each gate asks once, then continues

const GATES = [
  { name: 'pay-out', nextState: 'PAYOUT_PIN', nextData: { intentId: 'wd_abc', amountCents: 20000, method: 'PAYSHAP', recipient: { account_number: '62012345678', branch_code: '250655', id_number: '8001015009087' } } },
  { name: 'send to another person', nextState: 'VOUCHER_GIFT_PIN', nextData: { previewId: 'prv_1', amountCents: 5000, feeCents: 0, recipientMsisdn: '0600000902', send: true } },
  { name: 'paying a link from the balance', nextState: 'PAYREQ_PIN', nextData: { code: 'PRKWXQZM', amountCents: 15000, requesterLabel: 'Thandi' } },
  { name: 'the PIN ask (settings, and the web portal sends people here)', nextState: null, nextData: null },
];

for (const g of GATES) {
  test(`gate, ${g.name}: asks for a PIN once, then the step continues with it in the same turn`, async () => {
    const s = authStub();
    // The flow is about to ask for the PIN: the setup takes its place.
    const step = await pinSetupGateStep({ account: ACCOUNT, waId: ACCOUNT.waId, nextState: g.nextState, nextData: g.nextData, hasPin: s.hasPin, env: ENV_ON });
    assert.equal(step.state, 'PIN_SETUP_NEW');
    assert.equal(step.text, CHOOSE_PROMPT);
    assert.match(step.text, /Choose a 4-digit PIN to protect your pay-outs/);
    assert.equal(step.data.pinSetup.resume, g.nextState);
    for (const [k, v] of Object.entries(g.nextData || {})) assert.deepEqual(step.data[k], v, `${k} kept at the top level`);

    // Choose, then confirm.
    const chose = await handlePinSetupReply({ account: ACCOUNT, state: step.state, data: step.data, text: PIN, deps: { auth: s.auth }, env: ENV_ON });
    assert.equal(chose.state, 'PIN_SETUP_CONFIRM');
    assert.equal(chose.text, CONFIRM_PROMPT);
    assert.ok(!JSON.stringify(chose.data).includes(PIN), 'the chosen PIN is never in the conversation data in clear');
    assert.equal(s.calls.setPIN.length, 0, 'nothing is stored before the confirmation');
    const done = await handlePinSetupReply({ account: ACCOUNT, state: chose.state, data: chose.data, text: PIN, deps: { auth: s.auth }, env: ENV_ON });
    assert.equal(done.done, true);
    assert.equal(done.text, PIN_SET_LINE);
    assert.deepEqual(s.calls.setPIN, [{ accountId: ACCOUNT.id, pin: PIN }], 'stored once, by the auth package setter');
    if (g.nextState) {
      assert.equal(done.resume.state, g.nextState, 'the interrupted step is next');
      assert.deepEqual(done.resume.data, g.nextData, 'with exactly its own data');
      assert.equal(done.pin, PIN, 'and the PIN just typed, for its own verifyPIN');
    } else {
      assert.equal(done.resume, undefined, 'the PIN alone: nothing to continue');
      assert.equal(done.pin, undefined);
    }

    // Asked once: the account now has a PIN, so the same moment asks for the PIN as it always did.
    assert.equal(await pinSetupGateStep({ account: ACCOUNT, waId: ACCOUNT.waId, nextState: g.nextState, nextData: g.nextData, hasPin: s.hasPin, env: ENV_ON }), null);
  });
}

test('gate: with a PIN, or with the switch off, nothing changes and the switch is read before the database', async () => {
  const s = authStub({ has: true });
  assert.equal(await pinSetupGateStep({ account: ACCOUNT, nextState: 'PAYOUT_PIN', nextData: {}, hasPin: s.hasPin, env: ENV_ON }), null);
  const off = authStub();
  assert.equal(await pinSetupGateStep({ account: { ...ACCOUNT, profile: {} }, nextState: 'PAYOUT_PIN', nextData: {}, hasPin: off.hasPin, env: {} }), null);
  assert.equal(off.calls.hasPIN, 0, 'switch off: hasPIN is never read');
  const broken = await pinSetupGateStep({ account: ACCOUNT, nextState: 'PAYOUT_PIN', nextData: {}, hasPin: async () => { throw new Error('db'); }, env: ENV_ON });
  assert.equal(broken, null, 'an unreadable PIN state keeps the old path');
  assert.equal(startPinSetup({ resumeState: 'AIRTIME_PIN', notYet: true }).text, `${NO_PIN_YET} ${CHOOSE_PROMPT}`);
});

test('the interrupted pay-out keeps its account and ID numbers where the flow seal finds them', () => {
  const step = startPinSetup({ resumeState: 'PAYOUT_PIN', resumeData: GATES[0].nextData });
  for (const path of SEALED_PATHS) {
    const v = path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), step.data);
    const original = path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), GATES[0].nextData);
    assert.deepEqual(v, original, `${path.join('.')} stays on a sealed path`);
  }
  const back = resumeOf({ ...step.data, stateSetAt: '2026-10-22T08:00:00Z' });
  assert.deepEqual(back, { state: 'PAYOUT_PIN', data: GATES[0].nextData });
});

test('the setup: never over an existing PIN, weak PINs refused, a mismatch starts again, cancel and sentences leave', async () => {
  const s = authStub();
  const step = startPinSetup({ resumeState: 'PAYOUT_PIN', resumeData: { intentId: 'wd_x', amountCents: 5000 } });
  assert.match((await handlePinSetupReply({ account: ACCOUNT, state: step.state, data: step.data, text: '1234', deps: { auth: s.auth }, env: ENV_ON })).text, /too easy/);
  assert.match((await handlePinSetupReply({ account: ACCOUNT, state: step.state, data: step.data, text: '12', deps: { auth: s.auth }, env: ENV_ON })).text, /4 digits/);
  // Only a PIN on its own is a PIN, as at every PIN step: words with it are asked again and never leave the setup.
  for (const wrapped of ['my pin is 2580', '2580 please', 'use 2580', 'ok 2580']) {
    const r = await handlePinSetupReply({ account: ACCOUNT, state: step.state, data: step.data, text: wrapped, deps: { auth: s.auth }, env: ENV_ON });
    assert.equal(r.state, 'PIN_SETUP_NEW', wrapped);
    assert.match(r.text, /only the digits/, wrapped);
    assert.ok(!r.passthrough, `${wrapped}: never handed to the router or a model`);
  }
  const chose = await handlePinSetupReply({ account: ACCOUNT, state: step.state, data: step.data, text: ` ${PIN} `, deps: { auth: s.auth }, env: ENV_ON });
  assert.equal(chose.state, 'PIN_SETUP_CONFIRM');
  const mismatch = await handlePinSetupReply({ account: ACCOUNT, state: chose.state, data: chose.data, text: '9631', deps: { auth: s.auth }, env: ENV_ON });
  assert.equal(mismatch.state, 'PIN_SETUP_NEW');
  assert.match(mismatch.text, /did not match/);
  assert.equal(mismatch.data.pinSetup.resume, 'PAYOUT_PIN', 'the waiting step is still waiting');
  assert.equal(mismatch.data.pinSetup.pinHmac, undefined);
  // A PIN set meanwhile (the reset, the web) wins: this one is not written.
  const meanwhile = authStub({ has: false });
  const chose2 = await handlePinSetupReply({ account: ACCOUNT, state: 'PIN_SETUP_NEW', data: step.data, text: PIN, deps: { auth: meanwhile.auth }, env: ENV_ON });
  meanwhile.auth.hasPIN = async () => true;
  const refused = await handlePinSetupReply({ account: ACCOUNT, state: chose2.state, data: chose2.data, text: PIN, deps: { auth: meanwhile.auth }, env: ENV_ON });
  assert.match(refused.text, /already set/);
  assert.equal(meanwhile.calls.setPIN.length, 0);
  assert.match((await handlePinSetupReply({ account: ACCOUNT, state: 'PIN_SETUP_NEW', data: step.data, text: 'cancel', deps: { auth: s.auth }, env: ENV_ON })).text, /No PIN was set and nothing left your balance/);
  // A real sentence with no PIN-length number leaves; with a pay-out or send waiting, it says so (dropped).
  assert.deepEqual(await handlePinSetupReply({ account: ACCOUNT, state: 'PIN_SETUP_NEW', data: step.data, text: 'what is my balance', deps: { auth: s.auth }, env: ENV_ON }), { state: null, passthrough: true, dropped: true });
  assert.deepEqual(await handlePinSetupReply({ account: ACCOUNT, state: 'PIN_SETUP_NEW', data: startPinSetup({}).data, text: 'what is my balance', deps: { auth: s.auth }, env: ENV_ON }), { state: null, passthrough: true }, 'nothing parked: nothing to say');
  for (const short of ['yes', 'okay', 'what?', 'hmm']) {
    const r = await handlePinSetupReply({ account: ACCOUNT, state: 'PIN_SETUP_NEW', data: step.data, text: short, deps: { auth: s.auth }, env: ENV_ON });
    if (short === 'what?') assert.equal(r.passthrough, true, 'a question is a real sentence');
    else assert.equal(r.state, 'PIN_SETUP_NEW', `${short}: asked again, the parked send is not dropped silently`);
  }
  for (const cmd of ['send R2000 to 0821234567', 'withdraw R5000']) {
    const r = await handlePinSetupReply({ account: ACCOUNT, state: 'PIN_SETUP_CONFIRM', data: step.data, text: cmd, deps: { auth: s.auth }, env: ENV_ON });
    assert.ok(!r.passthrough && r.state === 'PIN_SETUP_CONFIRM', `${cmd}: a PIN-length number keeps it in the setup`);
  }
  assert.match((await handlePinSetupReply({ account: ACCOUNT, state: 'PIN_SETUP_NEW', data: step.data, text: PIN, deps: { auth: s.auth }, env: {} })).text, /not available/, 'no key: no PIN is half-set');
  for (const yes of ['PIN', 'pin', 'set my PIN', 'Set up my WaPay PIN', 'create a pin', 'my pin', 'I want to set a PIN']) assert.equal(matchPinSetupAsk(yes), true, yes);
  for (const no of ['what is a pin for my voucher number 1234', 'pinned', 'spin', 'send R50 to 0821234567']) assert.equal(matchPinSetupAsk(no), false, no);
  assert.deepEqual(PIN_SETUP_STATES, ['PIN_SETUP_NEW', 'PIN_SETUP_CONFIRM']);
});

// ---------------------------------------------------------------- the processor wiring

test('the processor: each gate sits right before its PIN step, and the setup continues the step in the same turn', () => {
  const payout = fnBody(processor, 'deliverPayoutStep');
  assert.match(payout, /if \(step\.state === 'PAYOUT_PIN'\) \{\s*const gated = await pinSetupGate\(\{ from, account, nextState: 'PAYOUT_PIN', nextData: step\.data \|\| \{\} \}\);\s*if \(gated\) return gated;\s*\}\s*await updateConversationState\(from, step\.state/);
  const send = processor.indexOf("nextState: 'VOUCHER_GIFT_PIN', nextData: { previewId, amountCents, feeCents, recipientMsisdn, send: true }");
  const sendPin = processor.indexOf("await updateConversationState(from, 'VOUCHER_GIFT_PIN', {", send);
  assert.ok(send > 0 && sendPin > send && sendPin - send < 400, 'the send asks for a PIN before VOUCHER_GIFT_PIN');
  assert.match(processor, /if \(data\?\.send\) \{\s*const gated = await pinSetupGate/);
  const payreq = processor.indexOf("const gated = await pinSetupGate({ from, account, nextState: 'PAYREQ_PIN', nextData: data });");
  assert.ok(payreq > 0 && processor.indexOf("await updateConversationState(from, 'PAYREQ_PIN', data);", payreq) - payreq < 200, 'paying a link asks before PAYREQ_PIN');
  // The ask: "PIN" or "forgot PIN" from an account with none, before the reset and before the agent.
  const ask = processor.indexOf('if (matchPinSetupAsk(text) || resetAsk(text)) {');
  const reset = processor.indexOf('if (matchPinResetAsk(text)) return await handlePinResetStart({ from, account });');
  const agent = processor.indexOf('if (agentV3For(from)) {\n    return await handleAgentTurn({ from, text, account, messageId });');
  assert.ok(ask > 0 && ask < reset && reset < agent);
  // The setup owns its turns, before the reset hook; its digits are hidden in memory.
  const dispatch = processor.indexOf("if (/^PIN_SETUP_/.test(String(state || ''))) return await handlePinSetupState({ from, account, state, data, text });");
  const midReset = processor.indexOf("if (state && !/^(?:PIN_RESET_|BIZ_SIGNUP_)|^(?:VOUCHER_PIN|AWAITING_VOUCHER_PIN)$/.test(String(state))) {");
  assert.ok(dispatch > 0 && dispatch < midReset);
  assert.match(processor, /inPinState: \/_PIN\$\|PIN_RESEND_AUTH\|AWAITING_VOUCHER_PIN\|\^PIN_RESET_\/\.test\(String\(state \|\| ''\)\) \|\| \/\^PIN_SETUP_\/\.test\(String\(state \|\| ''\)\),/);
  // Continue: the step waits at its PIN prompt, then runs with the PIN inside the lead-line scope.
  const setup = fnBody(processor, 'handlePinSetupState');
  const park = setup.indexOf('await updateConversationState(from, step.resume.state, step.resume.data);');
  const replay = setup.indexOf('handleConversationState({ from, text: step.pin, state: step.resume.state, data: step.resume.data, account })');
  assert.ok(park > 0 && replay > park);
  assert.match(setup, /await withLeadLine\(\{ to: from, line \}, \(\) => handleConversationState\(/);
  assert.match(setup, /if \(!used\) await sendWhatsAppText\(\{ to: from, text: line \}\);/);
  assert.ok(!/verifyPIN\(|setPIN\(/.test(setup), 'no verifier and no store in the processor: the step and lib/pin-setup.js own them');
});

test('withLeadLine: the finished step\'s line rides on the next text to the same customer, never on a message to anyone else', async () => {
  const sent = [];
  configureSay({ transport: async ({ to, text }) => { sent.push({ to, text }); return { ok: true, data: { messages: [{ id: `m${sent.length}` }] } }; }, prisma: { account: { findUnique: async () => null } } });
  const r = await withLeadLine({ to: '27600000919', line: PIN_SET_LINE }, async () => {
    await sendWhatsAppText({ to: '27600000902', text: 'You received R50.' });
    await sendWhatsAppText({ to: '27600000919', text: 'Sent R50 to 0600000902.' });
    await sendWhatsAppText({ to: '27600000919', text: 'Second text.' });
    return 'done';
  });
  assert.deepEqual(r, { out: 'done', used: true });
  assert.deepEqual(sent.map((m) => m.text), ['You received R50.', `${PIN_SET_LINE}\n\nSent R50 to 0600000902.`, 'Second text.']);
  const none = await withLeadLine({ to: '27600000919', line: 'x' }, async () => 1);
  assert.deepEqual(none, { out: 1, used: false });
  await sendWhatsAppText({ to: '27600000919', text: 'Outside any scope.' });
  assert.equal(sent[sent.length - 1].text, 'Outside any scope.');
  configureSay({ transport: null, prisma: null });
});

// ---------------------------------------------------------------- the web portal

function portalDeps({ accounts }) {
  const audit = [];
  return {
    audit,
    deps: {
      prisma: {
        account: { findMany: async ({ where }) => accounts.filter((a) => where.OR.some((w) => (w.waId && w.waId === a.waId) || (w.msisdn && w.msisdn === a.msisdn))) },
        auditLog: { create: async ({ data }) => { audit.push(data); return data; }, count: async () => 0 },
      },
      limiter: { count: async () => 0, hit: async () => {} },
      now: () => Date.now(),
      slowWork: async () => {},
      verifyPIN: async ({ pin }) => (pin === PIN ? { ok: true } : { ok: false, error: 'INVALID_PIN' }),
      loadPayoutIdentitySecretStrict: async () => ({ idNumber: '8001015009087' }),
    },
  };
}
const withPin = { id: 'a_pin', waId: '27600000919', msisdn: '27600000919', onboardingState: 'S5_COMPLETED', status: 'ACTIVE', authFactors: [{ type: 'PIN', attempts: 0, lockedUntil: null, setAt: new Date('2026-10-01T00:00:00Z') }] };
const noPin = { id: 'a_nopin', waId: '27600000904', msisdn: '27600000904', onboardingState: 'S5_COMPLETED', status: 'ACTIVE', authFactors: [] };

test('web login: an account without a PIN is told to set it in WhatsApp, in the same words as every other failure', async () => {
  const prev = process.env[FLAGS.PIN_ON_DEMAND];
  process.env[FLAGS.PIN_ON_DEMAND] = 'on';
  try {
    const { deps } = portalDeps({ accounts: [withPin, noPin] });
    const none = await appLogin(deps, { msisdn: '060 000 0904', pin: '4826', ip: '10.0.0.1' });
    const wrong = await appLogin(deps, { msisdn: '060 000 0919', pin: '4826', ip: '10.0.0.2' });
    const unknown = await appLogin(deps, { msisdn: '060 000 0977', pin: '4826', ip: '10.0.0.3' });
    assert.equal(NO_PIN_YET_LINE, 'Set your WaPay PIN in the WhatsApp chat first (say *PIN*), then log in here.');
    for (const r of [none, wrong, unknown]) {
      assert.equal(r.status, 401);
      assert.equal(r.error, 'BAD_CREDENTIALS');
      assert.ok(r.line.includes(NO_PIN_YET_LINE), r.line);
    }
    assert.deepEqual(none, wrong, 'no PIN and a wrong PIN answer the same');
    assert.deepEqual(none, unknown, 'and so does a number that is not on WaPay');
    assert.ok(!/—/.test(none.line));
    const ok = await appLogin(deps, { msisdn: '0600000919', pin: PIN, ip: '10.0.0.4' });
    assert.equal(ok.ok, true, 'a PIN holder signs in as before');
    // Setting a PIN on the web without the phone: an account with none never gets a reset token.
    const reset = await forgotCheck(deps, { msisdn: '0600000904', idNumber: '8001015009087', ip: '10.0.0.5' });
    const stranger = await forgotCheck(deps, { msisdn: '0600000977', idNumber: '8001015009087', ip: '10.0.0.6' });
    assert.equal(reset.ok, false);
    assert.equal(reset.resetToken, undefined);
    assert.deepEqual(reset, stranger, 'the unknown number\'s answer');
  } finally {
    if (prev === undefined) delete process.env[FLAGS.PIN_ON_DEMAND]; else process.env[FLAGS.PIN_ON_DEMAND] = prev;
  }
});

test('web login with every switch off: the line is exactly as before', async () => {
  for (const k of Object.values(FLAGS)) delete process.env[k];
  const { deps } = portalDeps({ accounts: [withPin, noPin] });
  const none = await appLogin(deps, { msisdn: '0600000904', pin: '4826', ip: '10.0.1.1' });
  assert.equal(none.line, LOGIN_FAILED_LINE);
  assert.equal(loginFailedLine('0600000904', {}), LOGIN_FAILED_LINE);
  assert.equal(portalNoPinLineFor('0600000904', {}), false);
});

// ---------------------------------------------------------------- the words around the PIN

test('the agent prompt and the registry: "set when you first pay out or send" only while the switch covers the customer', () => {
  const base = { registryLines: ['Balance: x'], feesBlock: 'fees' };
  assert.equal(buildAgentPromptPrefix({ ...base, pinOnDemand: false }), buildAgentPromptPrefix(base), 'off: byte-identical');
  assert.ok(!buildAgentPromptPrefix(base).includes(PIN_ON_DEMAND_RULE));
  assert.ok(buildAgentPromptPrefix({ ...base, pinOnDemand: true }).includes(PIN_ON_DEMAND_RULE));
  assert.match(PIN_ON_DEMAND_RULE, /first time they pay out or send money, never at sign-up/);
  assert.match(processor, /pinOnDemand: pinOnDemandFor\(\{ waId: from, account \}\),/);

  for (const k of Object.values(FLAGS)) delete process.env[k];
  const offHelp = helpLines({ waId: '27600000919' });
  assert.ok(offHelp.includes('🔐 *Forgot PIN* - "forgot PIN" to set a new one') && !offHelp.includes(PIN_ON_DEMAND_HELP_LINE));
  assert.ok(!promptLines({ waId: '27600000919' }).some((l) => l.includes(PIN_ON_DEMAND_ONE_LINER)));
  process.env[FLAGS.PIN_ON_DEMAND] = '27600000919';
  try {
    assert.ok(helpLines({ waId: '27600000919' }).includes(PIN_ON_DEMAND_HELP_LINE));
    assert.ok(promptLines({ waId: '27600000919' }).some((l) => l.includes(PIN_ON_DEMAND_ONE_LINER)));
    assert.ok(!helpLines({ waId: '27600000902' }).includes(PIN_ON_DEMAND_HELP_LINE), 'another number: as before');
  } finally {
    delete process.env[FLAGS.PIN_ON_DEMAND];
  }
  for (const s of [PIN_ON_DEMAND_ONE_LINER, PIN_ON_DEMAND_HELP_LINE, PIN_ON_DEMAND_RULE, CHOOSE_PROMPT, CONFIRM_PROMPT, PIN_SET_LINE, NO_PIN_YET_LINE]) {
    assert.ok(!/[—–]/.test(s), `no dash: ${s}`);
    assert.ok(!/\b(bet|betting|casino|loan)\b/i.test(s), s);
    // Sign-up is only ever named to say the PIN is NOT part of it.
    for (const m of s.matchAll(/sign-?up/gi)) assert.match(s.slice(Math.max(0, m.index - 30), m.index), /never (at |call the PIN a )?$/i, s);
  }
});

test('the classic sign-up under B: no PIN step; the consent step names the PIN for later; a PIN typed at S3 is still kept', () => {
  const s1 = onboardingTs.slice(onboardingTs.indexOf('export async function handleS1WelcomeSent('), onboardingTs.indexOf('export async function handleS2OtpSent('));
  assert.match(s1, /if \(deferPin && onboardingOtpDisabled\(\)\) \{[\s\S]{0,300}deferredPinConsentText\(displayName\)[\s\S]{0,200}from: 'S1_WELCOME_SENT', to: 'S4_PIN_SET', metadata: \{ otpSkipped: true, pinDeferred: true \}/);
  const s2 = onboardingTs.slice(onboardingTs.indexOf('export async function handleS2OtpSent('), onboardingTs.indexOf('export async function handleS3OtpVerified('));
  const verified = s2.indexOf('OTP verified successfully');
  const deferred = s2.indexOf('if (deferPin) {');
  const pinTemplate = s2.indexOf("templateName: 'onboarding_step_3_pin_creation'");
  assert.ok(verified < deferred && deferred < pinTemplate, 'after the code, before the PIN prompt');
  assert.match(s2, /from: 'S2_OTP_SENT', to: 'S4_PIN_SET', metadata: \{ pinDeferred: true \}/);
  const s3 = onboardingTs.slice(onboardingTs.indexOf('export async function handleS3OtpVerified('), onboardingTs.indexOf('export async function handleS4PinSet('));
  assert.match(s3, /if \(!validation\.valid && deferPin\) \{[\s\S]{0,300}from: 'S3_OTP_VERIFIED', to: 'S4_PIN_SET', metadata: \{ pinDeferred: true \}/);
  assert.ok(s3.indexOf('await setPIN({') > s3.indexOf('if (!validation.valid && deferPin)'), 'a valid PIN typed at S3 is still set');
  assert.match(onboardingTs, /You choose your WaPay PIN later, the first time you pay out or send money\./);
  // The processor hands the switch to every classic step and stamps an account that finished without a PIN.
  const flow = fnBody(processor, 'handleOnboardingFlow');
  assert.equal((flow.match(/\bdeferPin,\n/g) || []).length, 3, 'S1, S2 and S3 get it');
  assert.match(flow, /if \(deferPin && !\(await hasPIN\(account\.id\)\.catch\(\(\) => true\)\)\) \{\s*await mergeProfileSubkeyAtomic\(\{ accountId: account\.id, key: 'onboarding', patch: \{ pinDeferred: true \} \}\)/);
});

test('review fixes: the skip is stamped when it happens, "stop" never pre-empts the setup, a dropped send is said, a failed send keeps the lead line', async () => {
  // B turned off between the skipped PIN step and "I accept" can no longer strand the account.
  const flow = fnBody(processor, 'handleOnboardingFlow');
  assert.equal((flow.match(/if \(deferPin\) await stampPinDeferredIfSkipped\(\{ account \}\);/g) || []).length, 3, 'S1, S2 and S3');
  const stamp = fnBody(processor, 'stampPinDeferredIfSkipped');
  assert.match(stamp, /if \(\(await getOnboardingState\(account\.id\)\) !== 'S4_PIN_SET'\) return;/);
  assert.match(stamp, /if \(await hasPIN\(account\.id\)\.catch\(\(\) => true\)\) return;/);
  assert.match(stamp, /patch: \{ pinDeferred: true \}/);
  // The ad flow's "stop" hook leaves a PIN being chosen to the setup itself.
  assert.match(processor, /const protectedState = \/_PIN\$\|PIN_RESEND_AUTH\|AWAITING_VOUCHER_PIN\|\^PIN_RESET_\|\^PIN_SETUP_\|CONFIRM\//);
  // A real sentence that leaves the setup while a send waited: the answer says nothing was made, in one message.
  const setup = fnBody(processor, 'handlePinSetupState');
  assert.match(setup, /if \(!step\.dropped\) return await handlePostOnboarding\(\{ account, from, text \}\);/);
  assert.match(setup, /withLeadLine\(\{ to: from, line: switched \}, \(\) => handlePostOnboarding\(\{ account, from, text \}\)\)/);
  assert.match(setup, /deps: \{ isEscape: isConversationalEscape \}/, 'the same sentence rule as every other PIN step');
  // The lead line counts as delivered only when its send went out.
  const sent = [];
  let fail = true;
  configureSay({ transport: async ({ to, text }) => { if (fail) { fail = false; return { ok: false, error: 'down' }; } sent.push({ to, text }); return { ok: true, data: { messages: [{ id: 'm' }] } }; }, prisma: { account: { findUnique: async () => null } } });
  const r = await withLeadLine({ to: '27600000919', line: PIN_SET_LINE }, async () => {
    await sendWhatsAppText({ to: '27600000919', text: 'first try' });
    return 'x';
  });
  assert.equal(r.used, false, 'the caller sends the line itself');
  configureSay({ transport: null, prisma: null });
});
