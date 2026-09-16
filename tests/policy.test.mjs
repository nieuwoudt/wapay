/**
 * Policy engine (v1.4 agent): the deterministic gate between a proposal and a
 * flow start. Every branch, with WAPAY_PAYOUT_KYC set and unset in the test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy, requirementMessage, isProposable, hasConsent } from '../lib/policy.js';

const verified = { id: 'acc_1', profile: { kyc: { status: 'VERIFIED' } } };
const unverified = { id: 'acc_2', profile: { kyc: { status: 'PENDING' } } };
const noProfile = { id: 'acc_3', profile: null };
const cap = (over = {}, policy = {}) => ({
  id: 'withdraw',
  liveFor: () => true,
  policy: { minKycTier: 0, consents: [], adviceClass: 'none', ...policy },
  ...over,
});
const withKyc = (mode, fn) => {
  const prev = process.env.WAPAY_PAYOUT_KYC;
  if (mode === undefined) delete process.env.WAPAY_PAYOUT_KYC; else process.env.WAPAY_PAYOUT_KYC = mode;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.WAPAY_PAYOUT_KYC; else process.env.WAPAY_PAYOUT_KYC = prev;
  }
};

test('a live, ungated, no-requirement capability is allowed', () => {
  const r = evaluatePolicy({ capability: cap(), account: unverified, waId: '27821111111' });
  assert.deepEqual(r, { decision: 'allow', reasons: [], requirements: [] });
  assert.equal(isProposable(cap(), { account: unverified, waId: '27821111111' }), true);
});

test('liveFor false denies with NOT_LIVE and passes the ctx through', () => {
  let seen;
  const c = cap({ liveFor: (ctx) => { seen = ctx; return false; } });
  const r = evaluatePolicy({ capability: c, account: verified, waId: '27821111111', pack: { x: 1 } });
  assert.equal(r.decision, 'deny');
  assert.deepEqual(r.reasons, ['NOT_LIVE']);
  assert.deepEqual(r.requirements, [{ type: 'NOT_LIVE' }]);
  assert.equal(seen.waId, '27821111111');
  assert.deepEqual(seen.pack, { x: 1 });
  assert.equal(seen.account, verified);
  assert.equal(isProposable(c, { account: verified }), false);
});

test('a throwing liveFor is treated as not live, never as allow', () => {
  const r = evaluatePolicy({ capability: cap({ liveFor: () => { throw new Error('boom'); } }), account: verified });
  assert.equal(r.decision, 'deny');
  assert.deepEqual(r.reasons, ['NOT_LIVE']);
});

test('missing liveFor means live; missing capability denies', () => {
  assert.equal(evaluatePolicy({ capability: { id: 'x', policy: {} }, account: verified }).decision, 'allow');
  assert.equal(evaluatePolicy({ capability: null, account: verified }).decision, 'deny');
  assert.equal(evaluatePolicy({ capability: undefined, account: verified }).decision, 'deny');
});

test('perCustomerGate false denies (NOT_LIVE requirement) and sees waId; true continues', () => {
  const gate = (ctx) => ctx.waId === '27829999999';
  const denied = evaluatePolicy({ capability: cap({}, { perCustomerGate: gate }), account: verified, waId: '27821111111' });
  assert.equal(denied.decision, 'deny');
  assert.deepEqual(denied.reasons, ['NOT_LIVE_FOR_CUSTOMER']);
  assert.deepEqual(denied.requirements, [{ type: 'NOT_LIVE' }]);
  const ok = evaluatePolicy({ capability: cap({}, { perCustomerGate: gate }), account: verified, waId: '27829999999' });
  assert.equal(ok.decision, 'allow');
  const thrown = evaluatePolicy({ capability: cap({}, { perCustomerGate: () => { throw new Error('x'); } }), account: verified, waId: '27829999999' });
  assert.equal(thrown.decision, 'deny');
});

test('regulated advice is never proposable, even for a verified, consented customer', () => {
  const r = evaluatePolicy({ capability: cap({}, { adviceClass: 'regulated' }), account: verified });
  assert.deepEqual(r, { decision: 'deny', reasons: ['REGULATED_ADVICE'], requirements: [] });
  assert.equal(isProposable(cap({}, { adviceClass: 'regulated' }), { account: verified }), false);
  for (const adviceClass of ['none', 'factual-only'])
    assert.equal(evaluatePolicy({ capability: cap({}, { adviceClass }), account: verified }).decision, 'allow', adviceClass);
});

test('NOT_LIVE wins over everything else; regulated wins over requirements', () => {
  const dead = cap({ liveFor: () => false }, { adviceClass: 'regulated', minKycTier: 1 });
  withKyc(undefined, () => assert.deepEqual(evaluatePolicy({ capability: dead, account: unverified }).reasons, ['NOT_LIVE']));
  const reg = cap({}, { adviceClass: 'regulated', minKycTier: 1, consents: [{ type: 'TERMS_AND_CONDITIONS', version: '1' }] });
  withKyc(undefined, () => assert.deepEqual(evaluatePolicy({ capability: reg, account: unverified }).reasons, ['REGULATED_ADVICE']));
});

test('minKycTier 1 with KYC required (env unset) requires KYC_TIER 1 for an unverified account', () => {
  withKyc(undefined, () => {
    for (const account of [unverified, noProfile, {}, null]) {
      const r = evaluatePolicy({ capability: cap({}, { minKycTier: 1 }), account });
      assert.equal(r.decision, 'require');
      assert.deepEqual(r.reasons, ['KYC_REQUIRED']);
      assert.deepEqual(r.requirements, [{ type: 'KYC_TIER', tier: 1 }]);
      assert.equal(isProposable(cap({}, { minKycTier: 1 }), { account }), false);
    }
    assert.equal(evaluatePolicy({ capability: cap({}, { minKycTier: 1 }), account: verified }).decision, 'allow');
  });
});

test('WAPAY_PAYOUT_KYC=off (and only exactly "off") skips the KYC requirement, as lib/payouts.js does', () => {
  withKyc('off', () => {
    assert.equal(evaluatePolicy({ capability: cap({}, { minKycTier: 1 }), account: unverified }).decision, 'allow');
  });
  for (const v of ['OFF', 'false', '0', 'on', '']) {
    withKyc(v, () => {
      const r = evaluatePolicy({ capability: cap({}, { minKycTier: 1 }), account: unverified });
      assert.equal(r.decision, 'require', `value ${JSON.stringify(v)} must not disable KYC`);
    });
  }
});

test('minKycTier 0 never asks for KYC, whatever the env or account', () => {
  withKyc(undefined, () => assert.equal(evaluatePolicy({ capability: cap({}, { minKycTier: 0 }), account: unverified }).decision, 'allow'));
  withKyc('off', () => assert.equal(evaluatePolicy({ capability: cap({}, { minKycTier: 0 }), account: null }).decision, 'allow'));
});

test('consents: missing, wrong version, revoked, granted=false all require; a matching unrevoked entry satisfies', () => {
  const need = { consents: [{ type: 'TERMS_AND_CONDITIONS', version: '2' }] };
  const req = { type: 'CONSENT', consentType: 'TERMS_AND_CONDITIONS', version: '2' };
  const cases = [
    ['no consents key', { ...verified }],
    ['empty list', { ...verified, consents: [] }],
    ['consents not an array', { ...verified, consents: 'yes' }],
    ['wrong type', { ...verified, consents: [{ type: 'PRIVACY_POLICY', version: '2' }] }],
    ['wrong version', { ...verified, consents: [{ type: 'TERMS_AND_CONDITIONS', version: '1' }] }],
    ['revoked in the past', { ...verified, consents: [{ type: 'TERMS_AND_CONDITIONS', version: '2', revokedAt: '2026-01-01T00:00:00Z' }] }],
    ['prisma row, granted false', { ...verified, consents: [{ consentType: 'TERMS_AND_CONDITIONS', version: '2', granted: false }] }],
  ];
  for (const [name, account] of cases) {
    const r = evaluatePolicy({ capability: cap({}, need), account });
    assert.equal(r.decision, 'require', name);
    assert.deepEqual(r.reasons, ['CONSENT_REQUIRED:TERMS_AND_CONDITIONS'], name);
    assert.deepEqual(r.requirements, [req], name);
  }
  const good = [
    ['plain entry', [{ type: 'TERMS_AND_CONDITIONS', version: '2' }]],
    ['revokedAt null', [{ type: 'TERMS_AND_CONDITIONS', version: '2', revokedAt: null }]],
    ['numeric version', [{ type: 'TERMS_AND_CONDITIONS', version: 2 }]],
    ['prisma row shape, granted', [{ consentType: 'TERMS_AND_CONDITIONS', version: '2', granted: true }]],
    ['old revoked plus new grant', [{ type: 'TERMS_AND_CONDITIONS', version: '2', revokedAt: '2026-01-01T00:00:00Z' }, { type: 'TERMS_AND_CONDITIONS', version: '2' }]],
  ];
  for (const [name, consents] of good)
    assert.equal(evaluatePolicy({ capability: cap({}, need), account: { ...verified, consents } }).decision, 'allow', name);
});

test('a revocation dated after `now` has not happened yet; `now` is honoured', () => {
  const consents = [{ type: 'PRIVACY_POLICY', version: '1', revokedAt: '2026-10-01T00:00:00Z' }];
  const c = cap({}, { consents: [{ type: 'PRIVACY_POLICY', version: '1' }] });
  assert.equal(evaluatePolicy({ capability: c, account: { consents }, now: new Date('2026-09-16T00:00:00Z') }).decision, 'allow');
  assert.equal(evaluatePolicy({ capability: c, account: { consents }, now: new Date('2026-10-02T00:00:00Z') }).decision, 'require');
  assert.equal(hasConsent({ consents }, { type: 'PRIVACY_POLICY', version: '1' }, new Date('2026-12-01T00:00:00Z')), false);
});

test('a consent requirement without a version accepts any unrevoked version', () => {
  const c = cap({}, { consents: [{ type: 'MARKETING' }] });
  assert.equal(evaluatePolicy({ capability: c, account: { consents: [{ type: 'MARKETING', version: '7' }] } }).decision, 'allow');
  const r = evaluatePolicy({ capability: c, account: { consents: [] } });
  assert.deepEqual(r.requirements, [{ type: 'CONSENT', consentType: 'MARKETING', version: null }]);
});

test('requirements accumulate: KYC plus two consents in one answer, in policy order', () => {
  withKyc(undefined, () => {
    const c = cap({}, { minKycTier: 1, consents: [{ type: 'TERMS_AND_CONDITIONS', version: '2' }, { type: 'PRIVACY_POLICY', version: '3' }] });
    const r = evaluatePolicy({ capability: c, account: { ...unverified, consents: [{ type: 'PRIVACY_POLICY', version: '3' }] } });
    assert.equal(r.decision, 'require');
    assert.deepEqual(r.reasons, ['KYC_REQUIRED', 'CONSENT_REQUIRED:TERMS_AND_CONDITIONS']);
    assert.deepEqual(r.requirements, [{ type: 'KYC_TIER', tier: 1 }, { type: 'CONSENT', consentType: 'TERMS_AND_CONDITIONS', version: '2' }]);
  });
});

test('malformed policy entries are ignored rather than crashing', () => {
  const c = cap({}, { consents: [null, {}, { version: '1' }], minKycTier: 'nope' });
  assert.equal(evaluatePolicy({ capability: c, account: verified }).decision, 'allow');
});

test('the engine is pure: same inputs, same output, and the account is not mutated', () => {
  withKyc(undefined, () => {
    const account = Object.freeze({ ...unverified, consents: Object.freeze([]) });
    const c = cap({}, { minKycTier: 1, consents: [{ type: 'TERMS_AND_CONDITIONS', version: '2' }] });
    const a = evaluatePolicy({ capability: c, account });
    const b = evaluatePolicy({ capability: c, account });
    assert.deepEqual(a, b);
  });
});

test('requirementMessage: one clean sentence per requirement, no em dashes, betting words or partner names', () => {
  const reqs = [
    { type: 'KYC_TIER', tier: 1 },
    { type: 'CONSENT', consentType: 'TERMS_AND_CONDITIONS', version: '2' },
    { type: 'CONSENT', consentType: 'PRIVACY_POLICY', version: '1' },
    { type: 'CONSENT', consentType: 'MARKETING', version: '1' },
    { type: 'CONSENT', consentType: 'SOMETHING_NEW', version: '1' },
    { type: 'NOT_LIVE' },
    { type: 'UNKNOWN' },
    null,
  ];
  const seen = new Set();
  for (const req of reqs) {
    const m = requirementMessage(req);
    assert.equal(typeof m, 'string');
    assert.ok(m.length > 10 && m.length < 160, m);
    assert.ok(/[.!]$/.test(m), `ends with a full stop: ${m}`);
    assert.doesNotMatch(m, /—/, 'no em dashes');
    assert.doesNotMatch(m, /\b(bet|betting|wager|odds|gamble|gambling|hollywood|didit|ott|payfast|blu|yoyo|adumo)\b/i, m);
    seen.add(m);
  }
  assert.ok(seen.size >= 5, 'distinct messages for distinct requirement kinds');
  assert.match(requirementMessage({ type: 'KYC_TIER', tier: 1 }), /verify your identity/i);
  assert.match(requirementMessage({ type: 'CONSENT', consentType: 'TERMS_AND_CONDITIONS', version: '2' }), /terms and conditions/i);
  assert.match(requirementMessage({ type: 'CONSENT', consentType: 'PRIVACY_POLICY', version: '1' }), /privacy policy/i);
  assert.match(requirementMessage({ type: 'NOT_LIVE' }), /not available/i);
});

test('isProposable forwards waId, pack and now', () => {
  let seen;
  const c = cap({ liveFor: (ctx) => { seen = ctx; return true; } });
  const now = new Date('2026-09-16T10:00:00Z');
  assert.equal(isProposable(c, { account: verified, waId: '27820000000', pack: { p: 1 }, now }), true);
  assert.equal(seen.waId, '27820000000');
  assert.deepEqual(seen.pack, { p: 1 });
  assert.equal(seen.now, now);
  assert.equal(isProposable(c), true, 'ctx defaults to empty');
});
