/**
 * A. One-step sign-up (WAPAY_ONBOARDING_ONE_STEP, 2026-10-22; docs/ONBOARDING.md §5).
 *
 * Locks:
 * - the switch reads "on" or a comma list of numbers in any spelling; unset is
 *   nobody, so every path below is off by default;
 * - consent by continuing leaves evidence: two consent rows (terms + privacy,
 *   the terms version, "IMPLIED_BY_USE wa:<inbound message id>") and one audit
 *   row CONSENT_IMPLIED (the message id in its own column), with the move to
 *   S5 and the profile stamp in the same transaction; a replay writes nothing;
 *   a failed consent write opens nothing;
 * - every new account is stamped profile.onboarding.path at creation;
 * - the first reply is ONE message: lead, body, terms line; sent before the
 *   account opens; no template, no model call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseFlag, flagOnFor, oneStepFor, oneStepSignupFor, signupPathFor, onboardingFlagsReadout, FLAGS } from '../lib/onboarding-flags.js';
import { TERMS_LINE, withTermsLine, composeOneStepMessage, openedGreeting, referredOpenedLead } from '../lib/one-step-signup.js';
import { adOpenedReply, copyViolations, feeExample } from '../lib/ad-flow.js';
import { paymentRequestFeeCents } from '../lib/deposits.js';
const { completeOneStepOnboarding } = await import('../packages/auth/dist/onboarding.js');
const { recordImpliedConsent, TERMS_VERSION, IMPLIED_BY_USE, TERMS_URL } = await import('../packages/auth/dist/consent.js');

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');
const userManager = read('../pages/api/webhooks/user-manager.js');
const fnBody = (src, name) => {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start > -1, `${name} exists`);
  return src.slice(start, src.indexOf('\n}\n', start));
};

// ---------------------------------------------------------------- the switch

test('the switch: "on" is everyone, a list is those numbers in any spelling, unset or off is nobody', () => {
  assert.deepEqual(parseFlag(undefined), { everyone: false, numbers: [] });
  assert.deepEqual(parseFlag(''), { everyone: false, numbers: [] });
  assert.deepEqual(parseFlag('off'), { everyone: false, numbers: [] });
  for (const on of ['on', 'ON', 'true', '1', 'yes', 'all']) assert.equal(parseFlag(on).everyone, true, on);
  const env = { [FLAGS.ONE_STEP]: '+27 60 000 0919, 0600000904;27600000905' };
  for (const spelling of ['27600000919', '0600000919', '+27600000919', '060 000 0919']) assert.equal(oneStepFor(spelling, env), true, spelling);
  assert.equal(oneStepFor('27600000904', env), true);
  assert.equal(oneStepFor('27600000905', env), true);
  assert.equal(oneStepFor('27600000906', env), false, 'a number not on the list');
  assert.equal(oneStepFor('2760000091', env), false, 'a prefix is not the number');
  assert.equal(oneStepFor('27600000919', {}), false, 'unset: nobody, never everybody');
  assert.equal(flagOnFor(FLAGS.ONE_STEP, '27600000919', { [FLAGS.ONE_STEP]: 'garbage' }), false);
  assert.equal(oneStepFor('27821234567', { [FLAGS.ONE_STEP]: 'on' }), true);
  assert.deepEqual(onboardingFlagsReadout(env).oneStep, { everyone: false, listed: 3 });
  assert.equal(JSON.stringify(onboardingFlagsReadout(env)).includes('600000919'), false, 'the readout never prints a number');
});

test('one-step applies to a payer C pre-registered only while C covers the number', () => {
  const payer = { waId: '27600000905', profile: { origin: { kind: 'PAYER', requestCode: 'PRKWXQZM' } } };
  assert.equal(oneStepSignupFor({ waId: payer.waId, account: payer }, {}), false);
  assert.equal(oneStepSignupFor({ waId: payer.waId, account: payer }, { WAPAY_PAYER_PREREGISTER: '27600000905' }), true);
  assert.equal(oneStepSignupFor({ waId: '27600000906', account: { profile: {} } }, { WAPAY_PAYER_PREREGISTER: 'on' }), false, 'C alone opens only a payer it made');
  assert.equal(oneStepSignupFor({ waId: '27600000906', account: { profile: {} } }, { WAPAY_ONBOARDING_ONE_STEP: 'on' }), true);
});

// ---------------------------------------------------------------- D's stamp, made at creation

test('every new account is stamped with its sign-up path at creation (ONE_STEP under the switch, else CLASSIC)', () => {
  assert.equal(signupPathFor('27600000919', {}), 'CLASSIC');
  assert.equal(signupPathFor('27600000919', { [FLAGS.ONE_STEP]: '0600000919' }), 'ONE_STEP');
  const stamp = userManager.indexOf("onboarding: { path: signupPathFor(waId), startedAt: new Date().toISOString() }");
  const upsert = userManager.indexOf('prisma.account.upsert');
  assert.ok(stamp > 0 && stamp < upsert, 'the stamp is in the profile the row is created with');
  assert.ok(userManager.indexOf('profile: growthProfile', upsert) > upsert);
});

// ---------------------------------------------------------------- consent by continuing

function stubDb({ state = 'S0_INITIAL', failConsent = false } = {}) {
  const writes = { consent: [], audit: [], sql: [] };
  let row = { id: 'acc_one', onboardingState: state };
  const tx = {
    account: { findUnique: async () => row },
    async $executeRaw(strings, ...values) {
      writes.sql.push({ sql: strings.join('$'), values });
      if (row.onboardingState === 'S5_COMPLETED') return 0;
      row = { ...row, onboardingState: 'S5_COMPLETED' };
      return 1;
    },
    consent: { create: async ({ data }) => { if (failConsent) throw new Error('db down'); writes.consent.push(data); return { id: data.id }; } },
    auditLog: { create: async ({ data }) => { writes.audit.push(data); return { id: data.id }; } },
  };
  return {
    writes,
    get row() { return row; },
    async $transaction(fn) {
      const snapshot = { row: { ...row }, consent: writes.consent.length, audit: writes.audit.length, sql: writes.sql.length };
      try {
        return await fn(tx);
      } catch (error) {
        row = snapshot.row; writes.consent.length = snapshot.consent; writes.audit.length = snapshot.audit; writes.sql.length = snapshot.sql;
        throw error;
      }
    },
  };
}

test('consent by continuing: two consent rows IMPLIED_BY_USE with the version and the inbound message id, an audit row CONSENT_IMPLIED, S5 and the stamp, in one transaction', async () => {
  const db = stubDb();
  const now = new Date('2026-10-22T08:00:00.000Z');
  const out = await completeOneStepOnboarding({ accountId: 'acc_one', waMessageId: 'wamid.IN123', noticeMessageId: 'wamid.OUT456', via: 'FIRST_MESSAGE', pinDeferred: true, displayName: 'Thandi', now, prisma: db });
  assert.equal(out.ok, true);
  assert.equal(out.from, 'S0_INITIAL');
  assert.equal(db.row.onboardingState, 'S5_COMPLETED');

  assert.deepEqual(db.writes.consent.map((c) => c.consentType), ['TERMS_AND_CONDITIONS', 'PRIVACY_POLICY']);
  for (const c of db.writes.consent) {
    assert.equal(c.granted, true);
    assert.equal(c.version, TERMS_VERSION);
    assert.equal(c.userAgent, `${IMPLIED_BY_USE} wa:wamid.IN123`, 'the method and the inbound message id are on the row');
    assert.equal(c.grantedAt.toISOString(), now.toISOString());
    assert.equal(c.accountId, 'acc_one');
  }
  const implied = db.writes.audit.find((a) => a.event === 'CONSENT_IMPLIED');
  assert.ok(implied, 'CONSENT_IMPLIED is written');
  assert.equal(implied.waMessageId, 'wamid.IN123');
  assert.equal(implied.metadata.method, 'IMPLIED_BY_USE');
  assert.equal(implied.metadata.termsVersion, TERMS_VERSION);
  assert.equal(implied.metadata.termsUrl, TERMS_URL);
  assert.equal(implied.metadata.noticeMessageId, 'wamid.OUT456', 'the notice that carried the terms line');
  assert.deepEqual(implied.metadata.consentIds, db.writes.consent.map((c) => c.id));
  assert.equal(implied.metadata.at, now.toISOString());
  const completed = db.writes.audit.find((a) => a.event === 'ONBOARDING_COMPLETED');
  assert.equal(completed.metadata.path, 'ONE_STEP');
  assert.equal(completed.metadata.pinDeferred, true);
  const moved = db.writes.audit.find((a) => a.event === 'STATE_TRANSITION');
  assert.deepEqual([moved.metadata.from, moved.metadata.to, moved.metadata.oneStep], ['S0_INITIAL', 'S5_COMPLETED', true]);

  assert.equal(db.writes.sql.length, 1);
  const { sql, values } = db.writes.sql[0];
  assert.match(sql, /"onboardingState" = 'S5_COMPLETED'/);
  assert.match(sql, /status = 'ACTIVE'/);
  assert.match(sql, /jsonb_set\(\s*coalesce\(profile, '\{\}'::jsonb\),\s*'\{onboarding\}'/);
  assert.match(sql, /IS DISTINCT FROM 'S5_COMPLETED'/, 'a second writer cannot complete it twice');
  const defaults = JSON.parse(values.find((v) => typeof v === 'string' && v.includes('"path"')));
  assert.deepEqual(defaults, { path: 'ONE_STEP', startedAt: now.toISOString() }, 'path and start are defaults: a stamp already on the row wins');
  const completion = JSON.parse(values.find((v) => typeof v === 'string' && v.includes('completedAt')));
  assert.deepEqual(completion, { completedAt: now.toISOString(), completedVia: 'ONE_STEP', consent: 'IMPLIED_BY_USE', termsVersion: TERMS_VERSION, pinDeferred: true, via: 'FIRST_MESSAGE' });
  assert.ok(values.includes('Thandi'), 'the WhatsApp name replaces the placeholder');
});

test('consent by continuing: a replay finds S5 and writes nothing; a failed consent write opens nothing', async () => {
  const done = stubDb({ state: 'S5_COMPLETED' });
  const again = await completeOneStepOnboarding({ accountId: 'acc_one', waMessageId: 'wamid.X', prisma: done });
  assert.deepEqual([again.ok, again.already], [true, true]);
  assert.equal(done.writes.consent.length + done.writes.audit.length + done.writes.sql.length, 0);

  const broken = stubDb({ failConsent: true });
  const out = await completeOneStepOnboarding({ accountId: 'acc_one', waMessageId: 'wamid.Y', prisma: broken });
  assert.equal(out.ok, false);
  assert.equal(broken.row.onboardingState, 'S0_INITIAL', 'no consent on file: the account is not opened');
  assert.equal(broken.writes.audit.length, 0);
});

test('recordImpliedConsent throws on a failed write (the caller then rolls back) and names an unknown message plainly', async () => {
  await assert.rejects(() => recordImpliedConsent({ accountId: 'a', waMessageId: 'w', prisma: { consent: { create: async () => { throw new Error('down'); } }, auditLog: { create: async () => ({}) } } }));
  const rows = [];
  await recordImpliedConsent({ accountId: 'a', prisma: { consent: { create: async ({ data }) => { rows.push(data); return { id: data.id }; } }, auditLog: { create: async ({ data }) => ({ id: data.id }) } } });
  assert.equal(rows[0].userAgent, 'IMPLIED_BY_USE wa:unknown');
});

// ---------------------------------------------------------------- the one-message reply

test('the reply: ONE message, the lead on top, the body, the terms line last, verbatim', () => {
  assert.equal(TERMS_LINE, 'By using WaPay you agree to our Terms & Privacy Policy: https://wapay.co.za/legal/terms');
  assert.equal(withTermsLine('Hello'), `Hello\n\n${TERMS_LINE}`);
  const m = composeOneStepMessage({ lead: 'Thandi invited you to WaPay 💚', body: 'HOME CARD', recordLead: referredOpenedLead({ inviterFirstName: null }) });
  assert.equal(m.text, `Thandi invited you to WaPay 💚\n\nHOME CARD\n\n${TERMS_LINE}`);
  assert.equal(m.recordAs, `A friend invited you to WaPay 💚\n\nHOME CARD\n\n${TERMS_LINE}`, 'memory never keeps the inviter');
  assert.equal(composeOneStepMessage({ body: 'HOME CARD' }).recordAs, null);
  assert.equal(composeOneStepMessage({ body: 'HOME CARD' }).text.split(TERMS_LINE).length, 2, 'the terms line once');
  assert.equal(openedGreeting('Thandi'), '🎉 *Welcome to WaPay, Thandi!* Your account is open.');
  assert.equal(openedGreeting('Friend'), '🎉 *Welcome to WaPay!* Your account is open.');
  assert.equal(referredOpenedLead({ inviterFirstName: 'Sipho' }), 'Sipho invited you to WaPay 💚');
});

test('the ad arrival: the answer and the first-link question in the one message, within the campaign words', () => {
  const fee = feeExample(paymentRequestFeeCents);
  const kinds = ['Q1', 'Q2', 'Q3', 'Q4', 'OPEN', 'HOW', 'COST', 'FAQ_PAY_ME_HOW', 'FAQ_MONEY_OUT', 'FAQ_CASH_IN', 'FAQ_VAS', 'FAQ_PAY_SOMEONE', 'free_text'];
  for (const kind of kinds) {
    const text = withTermsLine(adOpenedReply(kind, { firstName: 'Thandi', fee }));
    assert.match(text, /Who owes you, and how much\? Type the amount and their name\./, kind);
    assert.ok(!/three quick steps|open your account|OTP|code we sent|Step \d of \d/i.test(text), `${kind}: nothing about steps still to come`);
    assert.deepEqual(copyViolations(text), [], `${kind}: ${text}`);
    assert.ok(text.endsWith(TERMS_LINE), kind);
  }
  assert.match(adOpenedReply('Q3', { fee }), /Under R50, getting paid is free/);
  assert.match(adOpenedReply('Q4', {}), /Your WaPay account is open/);
  assert.equal(adOpenedReply('Q1', { firstName: 'Thandi' }), "You're all set, Thandi. Let's get you paid. Who owes you, and how much? Type the amount and their name.");
});

test('the processor: one message, sent before the account opens, no template and no model on the way', () => {
  const body = fnBody(processor, 'oneStepSignupTurn');
  assert.equal((body.match(/sendWhatsAppText\(/g) || []).length, 1, 'exactly one send');
  assert.ok(!/sendWhatsAppTemplate|sendWhatsAppReplyButtons|orchestrate\(|runAgentTurn\(|handleAIChat\(/.test(body), 'no template, no buttons, no model');
  const send = body.indexOf('sendWhatsAppText(');
  const open = body.indexOf('completeOneStepOnboarding(');
  assert.ok(send > 0 && open > send, 'the account opens only after the notice was sent');
  assert.match(body, /if \(!sent\?\.ok\) \{[\s\S]{0,200}return sent;/, 'an unsent notice opens nothing');
  assert.match(body, /waMessageId: messageId/, 'the inbound message id is the evidence');
  assert.match(body, /composeOneStepMessage\(\{ lead: top, body, recordLead \}\)/);
  assert.match(body, /if \(matchesStop\(text\)\) return await handleStopAsk\(\{ from, account \}\);/, '"stop" opens nothing');
  assert.match(body, /AD_STATES\.FIRST_LINK/, 'an ad arrival waits at the first-link step');
  assert.match(body, /await growthOnOnboarded\(\{ account \}\)/);
});

test('the processor: every first-message door goes one-step only under the switch, and the classic path is untouched otherwise', () => {
  const gate = processor.indexOf("if (onboardingState !== 'S5_COMPLETED') {");
  const classic = processor.indexOf('return await handleOnboardingFlow({', gate);
  const oneStep = processor.indexOf('if (oneStepSignupFor({ waId: from, account })) {', gate);
  assert.ok(gate > 0 && oneStep > gate && oneStep < classic, 'the gate asks the switch before the classic flow');
  // The ad hook: the one message instead of the answer + the OTP or PIN step.
  const ad = fnBody(processor, 'handleAdEntryTurn');
  assert.match(ad, /if \(oneStepSignupFor\(\{ waId: from, account \}\)\) return await oneStepSignupTurn\(\{ from, account, profile, text, messageId, onboardingState, via: 'AD', adKind: kind \}\);/);
  assert.ok(ad.indexOf("via: 'AD'") < ad.indexOf('const reply = adEntryReply(kind, { firstName, fee, hasAccount: false })'));
  // The referral hook: the inviter's line, handed to the gate.
  const ref = fnBody(processor, 'handleReferralCodeTurn');
  assert.match(ref, /if \(oneStepSignupFor\(\{ waId: from, account \}\)\) return \{ oneStepLead: referredOpenedLead\(\{ inviterFirstName: recorded\.inviterFirstName \}\), oneStepRecordLead: referredOpenedLead\(\{ inviterFirstName: null \}\) \};/);
  assert.match(processor, /if \(referralTurn\?\.oneStepLead\) oneStepLead = referralTurn;\s*else if \(referralTurn\) return referralTurn;/);
  // The receipt ask from a number with no finished account.
  assert.match(processor, /if \(receiptMatch && onboardingState !== 'S5_COMPLETED' && oneStepSignupFor\(\{ waId: from, account \}\)\) \{\s*return await oneStepSignupTurn\(/);
  // Nothing else in the processor opens an account in one step: the call and its one retry live in the turn.
  const turn = fnBody(processor, 'oneStepSignupTurn');
  assert.equal((processor.match(/completeOneStepOnboarding\(commit\)/g) || []).length, 2);
  assert.equal((turn.match(/completeOneStepOnboarding\(commit\)/g) || []).length, 2, 'both inside oneStepSignupTurn');
  assert.match(turn, /let done = await completeOneStepOnboarding\(commit\);\s*if \(!done\?\.ok\) done = await completeOneStepOnboarding\(commit\);/, 'one retry after the notice went out');
});
