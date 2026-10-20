/**
 * Referrals from the chat (docs/REFERRALS.md, 2026-10-20).
 *
 * Locks:
 * - a code is stable for an account id, seven characters of the unambiguous alphabet, always
 *   letters and a digit (never a number, never a plain word), and different per account;
 * - the prefilled first message parses back to its code, edited or not; words, digit runs and
 *   pay-request codes never parse;
 * - the web link redirects to wa.me with the prefilled message and utm_source=referral;
 * - "invite" and its shapes are the command; the friend's arrival sentence never is;
 * - first contact stamps attribution (code, referrer, source) once; a member's own code and an
 *   unknown code stamp nothing;
 * - the stats come from the data on a stub prisma, read-only;
 * - the reward posts exactly once per referred account, only while the switch is on, from the
 *   referral expense account, with one receipt only on a fresh post, never after a stop, and a
 *   milestone reached while off is never paid later;
 * - every customer string passes the ad flow's copy rules and carries no em dash, and the
 *   tracking line promises no amount while the switch is 0;
 * - the processor, the money-in sites, the registry and the admin profile carry the hooks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  REFERRAL_CODE_ALPHABET, REFERRAL_CODE_LENGTH, REFERRAL_NOTIONAL_REWARD_CENTS, REWARD_SOURCE, WAPAY_WA_NUMBER,
  rewardCents, rewardRateCents, rewardsOn, rewardIdemKey, isWellFormedCode, referralCodeFor, referralLink, prefilledInvite,
  referralRedirect, parseReferralCode, matchInviteAsk, inviteMessage, referredWelcome, ALREADY_MEMBER_REPLY, rewardReceipt,
  INVITE_PITCH, ensureReferralCode, recordReferredContact, referralStats, qualifyReferral, onFunded, onLinkPaid, referralCatchUp,
} from '../lib/referrals.js';
import { copyViolations } from '../lib/ad-flow.js';
import { buildReferralReward, ACCT, BALANCE } from '../lib/ledger-core.js';
import { CAPABILITIES, homeLines, helpLines, promptLines } from '../lib/capabilities.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

const REFERRER = 'cmvezlqma00hbi5od3b5anvv5';
const FRIEND = 'cmvf0abcd00hbi5od3b5a0001';
const CODE = referralCodeFor(REFERRER);

// ------------------------------------------------------------------ a stub prisma

/**
 * Rows keyed by account id; profile merges are applied the way Postgres would (top-level
 * jsonb || and jsonb_set on one key), so a second call sees what the first one wrote.
 */
function stubPrisma({ rows = [], credits = [], paidRequests = [], rewardPaidCents = 0 } = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const calls = { findMany: 0, executeRaw: [], queryRaw: [] };
  const byPath = (obj, path) => path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
  const matchesJson = (row, where) => {
    const f = where?.profile;
    if (!f) return true;
    return byPath(row.profile || {}, f.path) === f.equals;
  };
  return {
    calls,
    byId,
    account: {
      findUnique: async ({ where }) => byId.get(where.id) || null,
      findFirst: async ({ where }) => rows.find((r) => matchesJson(r, where)) || null,
      findMany: async ({ where }) => { calls.findMany += 1; return rows.filter((r) => matchesJson(r, where)); },
    },
    wallet: { findFirst: async ({ where }) => (byId.get(where.accountId)?.wallet ? { availableCents: byId.get(where.accountId).wallet } : null) },
    paymentRequest: {
      groupBy: async ({ where }) => {
        const ids = where.accountId.in;
        const out = new Map();
        for (const r of paidRequests) if (ids.includes(r.accountId) && r.status === 'PAID') { const cur = out.get(r.accountId); if (!cur || r.paidAt < cur) out.set(r.accountId, r.paidAt); }
        return [...out.entries()].map(([accountId, paidAt]) => ({ accountId, _min: { paidAt } }));
      },
    },
    async $queryRaw(strings, ...values) {
      const sql = strings.join('?');
      calls.queryRaw.push(sql);
      if (sql.includes('split_part')) {
        // Prisma.join(codes) arrives as a Prisma.Sql fragment whose .values are the wallet codes.
        const codes = values.flatMap((v) => (v && typeof v === 'object' && Array.isArray(v.values) ? v.values : [v])).filter((v) => typeof v === 'string' && v.startsWith('WALLET:'));
        return credits.filter((c) => codes.includes(`WALLET:${c.id}:SPEND`)).map((c) => ({ id: c.id, at: c.at }));
      }
      if (sql.includes('SUM')) return [{ cents: BigInt(rewardPaidCents) }];
      return [];
    },
    async $executeRaw(strings, ...values) {
      const sql = strings.join('?');
      calls.executeRaw.push(values);
      if (sql.includes('jsonb_set')) {
        const [, key, json, accountId] = values;
        const row = byId.get(accountId);
        if (row) { row.profile = row.profile || {}; row.profile[key] = { ...(row.profile[key] || {}), ...JSON.parse(json) }; }
      } else {
        const [json, accountId] = values;
        const row = byId.get(accountId);
        if (row) row.profile = { ...(row.profile || {}), ...JSON.parse(json) };
      }
      return 1;
    },
  };
}

const referrerRow = (extra = {}) => ({ id: REFERRER, waId: '27600000901', displayName: 'Thandi Nkosi', onboardingState: 'S5_COMPLETED', wallet: 12345, profile: { referral: { code: CODE, codeIssuedAt: '2026-10-20T08:00:00.000Z' } }, ...extra });
const friendRow = (extra = {}) => ({ id: FRIEND, waId: '27600000902', displayName: 'Sipho', onboardingState: 'S5_COMPLETED', profile: { acquisitionSource: 'referral', attribution: { referralCode: CODE, referrerAccountId: REFERRER, source: 'referral', referredAt: '2026-10-20T09:00:00.000Z' } }, ...extra });

// ------------------------------------------------------------------ codes

test('codes: stable per account, seven unambiguous characters, letters and a digit, distinct across accounts', () => {
  assert.equal(CODE, referralCodeFor(REFERRER), 'the same id gives the same code');
  assert.equal(CODE.length, REFERRAL_CODE_LENGTH);
  for (const ch of CODE) assert.ok(REFERRAL_CODE_ALPHABET.includes(ch), `${ch} is in the alphabet`);
  assert.doesNotMatch(REFERRAL_CODE_ALPHABET, /[01OIL]/, 'nothing a person can confuse');
  assert.ok(isWellFormedCode(CODE));
  assert.notEqual(referralCodeFor(REFERRER, 1), CODE, 'the next candidate differs (used only on a collision)');
  const ids = Array.from({ length: 200 }, (_, i) => `cm${i.toString(36).padStart(3, '0')}zlqma00hbi5od3b5anvv5`);
  const codes = ids.map((id) => referralCodeFor(id));
  assert.equal(new Set(codes).size, 200, 'distinct across accounts');
  for (const c of codes) {
    assert.ok(isWellFormedCode(c), c);
    assert.ok(/[A-Z].*[A-Z]|[A-Z][^A-Z]*[A-Z]/.test(c) && /[0-9]/.test(c), `${c} has two letters and a digit, so it is never a number`);
    assert.doesNotMatch(c, /^\d{7}$/);
  }
  assert.equal(isWellFormedCode('PAYMENT'), false, 'a plain word is not a code');
  assert.equal(isWellFormedCode('2345678'), false, 'digits alone are not a code');
  assert.equal(isWellFormedCode('K7M2XQ'), false);
  assert.equal(isWellFormedCode('K7M2XQ0'), false, 'a 0 is outside the alphabet');
  assert.throws(() => referralCodeFor(''), /accountId/);
});

test('the switch: 0 or unset tracks only; the rate the stats use is the switch while on, else the notional R10', () => {
  assert.equal(rewardCents({}), 0);
  assert.equal(rewardCents({ WAPAY_REFERRAL_REWARD_CENTS: '0' }), 0);
  assert.equal(rewardCents({ WAPAY_REFERRAL_REWARD_CENTS: 'abc' }), 0);
  assert.equal(rewardCents({ WAPAY_REFERRAL_REWARD_CENTS: '-5' }), 0);
  assert.equal(rewardCents({ WAPAY_REFERRAL_REWARD_CENTS: '1000' }), 1000);
  assert.equal(rewardsOn({}), false);
  assert.equal(rewardsOn({ WAPAY_REFERRAL_REWARD_CENTS: '1000' }), true);
  assert.equal(REFERRAL_NOTIONAL_REWARD_CENTS, 1000);
  assert.equal(rewardRateCents({}), 1000);
  assert.equal(rewardRateCents({ WAPAY_REFERRAL_REWARD_CENTS: '1500' }), 1500);
  assert.equal(rewardIdemKey(FRIEND), `referral-reward-${FRIEND}`);
  assert.throws(() => rewardIdemKey(''), /referredAccountId/);
});

// ------------------------------------------------------------------ link, prefill, parse

test('the prefilled message parses back to its code, edited or not; words, digit runs and pay-request codes never parse', () => {
  const prefilled = prefilledInvite(CODE);
  assert.equal(prefilled, `Hi WaPay! A friend invited me. Invite code: ${CODE}`);
  assert.doesNotMatch(prefilled, /Thandi/, 'the inviter is never named in the friend\'s message');
  assert.equal(parseReferralCode(prefilled), CODE);
  assert.equal(parseReferralCode(prefilled.toLowerCase()), CODE);
  assert.equal(parseReferralCode(`hey, my friend sent me this. invite code ${CODE} what now?`), CODE);
  assert.equal(parseReferralCode(`code: ${CODE}`), CODE);
  assert.equal(parseReferralCode(CODE), CODE, 'the code alone');
  assert.equal(parseReferralCode(`hi ${CODE.toLowerCase()}`), CODE);
  assert.equal(parseReferralCode(`Invite code: ${CODE}.`), CODE);
  assert.equal(parseReferralCode(''), null);
  assert.equal(parseReferralCode('PAYMENT'), null, 'a word is not a code');
  assert.equal(parseReferralCode('WELCOME to WaPay'), null);
  assert.equal(parseReferralCode('my id 8001015009087'), null, 'digit runs never parse');
  assert.equal(parseReferralCode('0821234567'), null);
  assert.equal(parseReferralCode('Receipt PRABCDEF'), null, 'a pay-request code is eight letters');
  assert.equal(parseReferralCode('Pay request PRABCDEF'), null);
  assert.equal(parseReferralCode('please pay me R250'), null);
  assert.equal(parseReferralCode('R250 from Thandi for the birthday gift'), null);
  assert.equal(parseReferralCode(`${CODE}X`), null, 'eight characters is not a code');
  assert.equal(parseReferralCode('x'.repeat(401)), null, 'a long message is never scanned');
});

test('the web link redirects to wa.me with the prefilled message and utm_source=referral; a malformed code is refused', () => {
  assert.equal(referralLink(CODE), `https://pleasepayme.co.za/i/${CODE}`);
  const r = referralRedirect(CODE.toLowerCase());
  assert.equal(r.code, CODE);
  assert.ok(r.location.startsWith(`https://wa.me/${WAPAY_WA_NUMBER}?text=`));
  const url = new URL(r.location);
  assert.equal(url.searchParams.get('text'), prefilledInvite(CODE));
  assert.equal(url.searchParams.get('utm_source'), 'referral');
  assert.equal(url.searchParams.get('utm_medium'), 'whatsapp');
  assert.equal(url.searchParams.get('utm_content'), CODE);
  assert.equal(WAPAY_WA_NUMBER, '27760497624', 'the number the pay page deep-links to');
  assert.equal(referralRedirect('PAYMENT'), null);
  assert.equal(referralRedirect('2345678'), null);
  assert.equal(referralRedirect(''), null);
  assert.equal(referralRedirect('../etc'), null);
  const page = read('../pages/i/[code].js');
  assert.match(page, /referralRedirect\(params\?\.code\)/);
  assert.match(page, /return \{ notFound: true \}/);
  assert.match(page, /redirect: \{ destination: target\.location, permanent: false \}/);
  assert.ok(!/prisma|sendWhatsApp|@wapay\/whatsapp/.test(page), 'the landing reads no database and sends nothing');
});

test('the invite command: the founder\'s phrasings in the customer\'s own words match; the friend\'s arrival sentence and ordinary words never do', () => {
  // The founder's list (2026-10-20), case-insensitive, with "please", "can you", "me a", "my" around it.
  const founder = ['Create me a referral link for a friend to share', 'referral link', 'invite link', 'invite a friend', 'refer a friend', 'share WaPay',
    'Can you create me a referral link please?', 'Please create me a referral link for a friend to share', 'REFERRAL LINK', 'Invite Link', 'can you give me my invite link', 'I want to invite a friend', 'refer a friend please', 'Share WaPay with my family'];
  for (const s of founder) assert.equal(matchInviteAsk(s), true, s);
  for (const s of ['invite', 'Invite', 'invite friends', 'refer', 'referral', 'my invite link', "what's my invite link", 'send me my invite link', 'I want to invite my sister', 'how do I refer someone', 'can I invite my friend', 'share WaPay with my friends', 'wapay invite link', 'invitation', 'what is my referral code', 'I need an invite link for my sister', 'please can you make me a referral link', 'me a referral link', 'invite please', 'can you send me an invite message for my brother']) {
    assert.equal(matchInviteAsk(s), true, s);
  }
  for (const s of ['I was invited', 'my friend invited me', prefilledInvite(CODE), `invite code ${CODE}`, `Invite code: ${CODE.toLowerCase()}`, 'please pay me R50', 'create a link for my customer to pay me', 'balance', 'invitation to the wedding', 'refer to my statement', 'I referred my friend already', 'withdraw R200', 'home', 'help', '', 'send R50 to 0831234567', 'x'.repeat(170)]) {
    assert.equal(matchInviteAsk(s), false, s || '(empty)');
  }
});

// ------------------------------------------------------------------ copy

test('every customer string passes the ad flow\'s copy rules, carries no em dash and promises no amount while the switch is 0', () => {
  const off = inviteMessage({ code: CODE, env: {} });
  const on = inviteMessage({ code: CODE, env: { WAPAY_REFERRAL_REWARD_CENTS: '1000' } });
  const all = [off, on, INVITE_PITCH, referredWelcome({ inviterFirstName: 'Thandi' }), referredWelcome(), ALREADY_MEMBER_REPLY, rewardReceipt({ amountCents: 1000, balanceCents: 12345 }), rewardReceipt({ amountCents: 1500 }), prefilledInvite(CODE)];
  for (const text of all) {
    assert.deepEqual(copyViolations(text), [], `banned copy in: ${text}`);
    assert.ok(!/[—–]/.test(text), `dash in: ${text}`);
    assert.doesNotMatch(text, /\b(20\d\d|next (week|month)|in \d+ (days|weeks)|by (monday|friday|december))\b/i, 'never a date');
    assert.ok(!/bet|wager|casino|odds/i.test(text));
  }
  assert.ok(off.includes(referralLink(CODE)), 'the invite carries the personal link');
  assert.ok(off.includes(INVITE_PITCH));
  assert.match(off, /We are tracking your invites; rewards are coming\.$/);
  assert.doesNotMatch(off, /\bR\d/, 'no amount while the switch is 0');
  assert.match(on, /You get R10 in your balance when a friend you invited adds money or gets paid for the first time\.$/);
  assert.ok(!/\breward\b/i.test(INVITE_PITCH) && !/\breward\b/i.test(prefilledInvite(CODE)), 'what the friend reads promises nothing');
  assert.match(referredWelcome({ inviterFirstName: 'Thandi' }), /^Thandi invited you to WaPay 💚/);
  assert.match(referredWelcome(), /^A friend invited you to WaPay 💚/);
  assert.match(ALREADY_MEMBER_REPLY, /\*invite\*/);
  assert.match(rewardReceipt({ amountCents: 1000, balanceCents: 12345 }), /Your R10 reward is in your balance\.\nNew balance: R123\.45$/);
  assert.doesNotMatch(rewardReceipt({ amountCents: 1000 }), /New balance/);
  assert.throws(() => inviteMessage({ code: 'PAYMENT' }), /well-formed/);
});

// ------------------------------------------------------------------ the ledger builder

test('the reward entry: balanced, from the referral expense account to the referrer, never a customer debit, guarded idemKey', () => {
  const e = buildReferralReward({ referrerAccountId: REFERRER, referredAccountId: FRIEND, amountCents: 1000, idemKey: rewardIdemKey(FRIEND) });
  assert.equal(e.source, REWARD_SOURCE);
  assert.equal(e.idemKey, `referral-reward-${FRIEND}`);
  assert.deepEqual(e.postings, [
    { accountCode: 'EXPENSE:PROMO:REFERRAL', debitCents: 1000 },
    { accountCode: ACCT.wallet(REFERRER, BALANCE.SPEND), creditCents: 1000 },
  ]);
  assert.equal(ACCT.REFERRAL_EXPENSE, 'EXPENSE:PROMO:REFERRAL');
  assert.ok(!e.postings.some((p) => p.accountCode.startsWith('WALLET:') && p.debitCents), 'no customer wallet is debited');
  assert.equal(e.meta.referredAccountId, FRIEND);
  assert.throws(() => buildReferralReward({ referrerAccountId: REFERRER, referredAccountId: FRIEND, amountCents: 0, idemKey: 'k' }), /greater than zero/);
  assert.throws(() => buildReferralReward({ referrerAccountId: REFERRER, referredAccountId: FRIEND, amountCents: 10.5, idemKey: 'k' }), /integer/);
  assert.throws(() => buildReferralReward({ referrerAccountId: REFERRER, referredAccountId: REFERRER, amountCents: 1000, idemKey: 'k' }), /refer itself/);
  assert.throws(() => buildReferralReward({ referrerAccountId: REFERRER, referredAccountId: null, amountCents: 1000, idemKey: 'k' }), /required/);
  assert.throws(() => buildReferralReward({ referrerAccountId: REFERRER, referredAccountId: FRIEND, amountCents: 1000, idemKey: 'referral-reward-1760000000000' }), /timestamp/);
});

// ------------------------------------------------------------------ the code on the profile

test('ensureReferralCode: the stored code is returned without a write; a new one is the first free candidate, stored once', async () => {
  const stored = stubPrisma({ rows: [referrerRow()] });
  assert.equal(await ensureReferralCode({ prisma: stored, accountId: REFERRER }), CODE);
  assert.equal(stored.calls.executeRaw.length, 0, 'nothing written');

  const fresh = stubPrisma({ rows: [{ id: REFERRER, waId: '27600000901', profile: {} }] });
  assert.equal(await ensureReferralCode({ prisma: fresh, accountId: REFERRER, now: new Date('2026-10-20T08:00:00Z') }), CODE);
  assert.equal(fresh.byId.get(REFERRER).profile.referral.code, CODE);
  assert.equal(fresh.byId.get(REFERRER).profile.referral.codeIssuedAt, '2026-10-20T08:00:00.000Z');
  assert.equal(await ensureReferralCode({ prisma: fresh, accountId: REFERRER }), CODE, 'stable afterwards');

  // Another account already holds candidate 0: the next deterministic candidate is issued.
  const other = { id: 'cmotherxx00hbi5od3b5a0009', waId: '27600000903', profile: { referral: { code: CODE } } };
  const clash = stubPrisma({ rows: [{ id: REFERRER, waId: '27600000901', profile: {} }, other] });
  assert.equal(await ensureReferralCode({ prisma: clash, accountId: REFERRER }), referralCodeFor(REFERRER, 1));
  await assert.rejects(() => ensureReferralCode({ prisma: clash, accountId: '' }), /accountId/);
});

test('first contact: an organic new number is stamped once with code, referrer and source; own code, unknown code and a second code change nothing', async () => {
  const now = new Date('2026-10-20T09:00:00Z');
  const friend = { id: FRIEND, waId: '27600000902', displayName: 'Sipho', onboardingState: 'S0_INITIAL', profile: { acquisitionSource: 'organic' } };
  const prisma = stubPrisma({ rows: [referrerRow(), friend] });
  const r = await recordReferredContact({ prisma, account: friend, code: CODE.toLowerCase(), now });
  assert.deepEqual(r, { ok: true, already: false, referrerAccountId: REFERRER, inviterFirstName: 'Thandi', acquisitionSource: 'referral' });
  const p = prisma.byId.get(FRIEND).profile;
  assert.equal(p.acquisitionSource, 'referral');
  assert.deepEqual(p.attribution, { referralCode: CODE, referredAt: now.toISOString(), referrerAccountId: REFERRER, source: 'referral', capturedAt: now.toISOString() });
  // A second contact (the link tapped twice): already, nothing rewritten.
  const writes = prisma.calls.executeRaw.length;
  const again = await recordReferredContact({ prisma, account: prisma.byId.get(FRIEND), code: CODE, now });
  assert.equal(again.ok, true); assert.equal(again.already, true); assert.equal(again.inviterFirstName, 'Thandi');
  assert.equal(prisma.calls.executeRaw.length, writes);
  // A different code later: the first wins, and no name is given for the second inviter.
  const otherCode = referralCodeFor('cmotherxx00hbi5od3b5a0009');
  const second = await recordReferredContact({ prisma: stubPrisma({ rows: [referrerRow(), { id: 'cmotherxx00hbi5od3b5a0009', waId: '27600000903', displayName: 'Lerato M', profile: { referral: { code: otherCode } } }, prisma.byId.get(FRIEND)] }), account: prisma.byId.get(FRIEND), code: otherCode, now });
  assert.equal(second.already, true); assert.equal(second.inviterFirstName, null); assert.equal(second.referrerAccountId, REFERRER);

  // Own code: nothing; unknown code: nothing; no code: nothing.
  assert.deepEqual(await recordReferredContact({ prisma, account: referrerRow(), code: CODE }), { ok: false, reason: 'SELF' });
  assert.deepEqual(await recordReferredContact({ prisma, account: friend, code: 'K7M2XQ4' }), { ok: false, reason: 'UNKNOWN_CODE' });
  assert.deepEqual(await recordReferredContact({ prisma, account: friend, code: 'PAYMENT' }), { ok: false, reason: 'NO_CODE' });

  // A pay-link arrival keeps its acquisition source and its referrer; the invite is still counted.
  const payer = { id: 'cmpayerxx00hbi5od3b5a0007', waId: '27600000904', displayName: 'Friend', profile: { acquisitionSource: 'paylink', attribution: { source: 'paylink', referrerAccountId: 'acc-requester', capturedAt: '2026-10-19T00:00:00.000Z' } } };
  const p2 = stubPrisma({ rows: [referrerRow({ displayName: 'Friend' }), payer] });
  const r2 = await recordReferredContact({ prisma: p2, account: payer, code: CODE, now });
  assert.equal(r2.ok, true); assert.equal(r2.inviterFirstName, null, '"Friend" is the default display name, not a name');
  const pp = p2.byId.get(payer.id).profile;
  assert.equal(pp.acquisitionSource, 'paylink');
  assert.equal(pp.attribution.referrerAccountId, 'acc-requester');
  assert.equal(pp.attribution.source, 'paylink');
  assert.equal(pp.attribution.referralCode, CODE);
});

// ------------------------------------------------------------------ stats

test('referralStats reads invited, onboarded, funded, paid and the reward tracked against paid from the data, read-only', async () => {
  const f1 = { id: 'cmf1xxxxx00hbi5od3b5a0001', onboardingState: 'S0_INITIAL', profile: { attribution: { referralCode: CODE } } };
  const f2 = { id: 'cmf2xxxxx00hbi5od3b5a0002', onboardingState: 'S5_COMPLETED', profile: { attribution: { referralCode: CODE } } };
  const f3 = { id: 'cmf3xxxxx00hbi5od3b5a0003', onboardingState: 'S5_COMPLETED', profile: { attribution: { referralCode: CODE } } };
  const notMine = { id: 'cmf4xxxxx00hbi5od3b5a0004', onboardingState: 'S5_COMPLETED', profile: { attribution: { referralCode: 'ZZZZ999' } } };
  const prisma = stubPrisma({
    rows: [referrerRow(), f1, f2, f3, notMine],
    credits: [{ id: f2.id, at: '2026-10-20T10:00:00Z' }, { id: f3.id, at: '2026-10-20T11:00:00Z' }, { id: notMine.id, at: '2026-10-20T11:00:00Z' }],
    paidRequests: [{ accountId: f3.id, status: 'PAID', paidAt: new Date('2026-10-20T12:00:00Z') }, { accountId: f2.id, status: 'PENDING', paidAt: null }],
    rewardPaidCents: 1000,
  });
  const s = await referralStats({ prisma, accountId: REFERRER, env: {} });
  assert.equal(s.code, CODE);
  assert.equal(s.link, `https://pleasepayme.co.za/i/${CODE}`);
  assert.equal(s.issued, true);
  assert.equal(s.invited, 3);
  assert.equal(s.onboarded, 2);
  assert.equal(s.funded, 2);
  assert.equal(s.paid, 1);
  assert.equal(s.rewardEligibleCents, 2000, 'two accounts reached a milestone, at the notional R10');
  assert.equal(s.rewardPaidCents, 1000);
  assert.equal(s.rewardRateCents, 1000);
  assert.equal(s.rewardsOn, false);
  assert.equal(prisma.calls.executeRaw.length, 0, 'read-only');
  const on = await referralStats({ prisma, accountId: REFERRER, env: { WAPAY_REFERRAL_REWARD_CENTS: '1500' } });
  assert.equal(on.rewardEligibleCents, 3000); assert.equal(on.rewardsOn, true); assert.equal(on.rewardRateCents, 1500);
  // The funded query excludes reward credits themselves and names the ledger source.
  assert.ok(prisma.calls.queryRaw.some((q) => q.includes('split_part') && q.includes('je.source <> ?')));

  // A member who never asked for an invite: the code the command would issue, zeros, no account scan, no write.
  const quiet = stubPrisma({ rows: [{ id: FRIEND, waId: '27600000902', profile: {} }] });
  const q = await referralStats({ prisma: quiet, accountId: FRIEND, env: {} });
  assert.equal(q.code, referralCodeFor(FRIEND)); assert.equal(q.issued, false);
  assert.deepEqual([q.invited, q.onboarded, q.funded, q.paid, q.rewardEligibleCents, q.rewardPaidCents], [0, 0, 0, 0, 0, 0]);
  assert.equal(quiet.calls.findMany, 0);
  assert.equal(quiet.calls.executeRaw.length, 0);
  await assert.rejects(() => referralStats({ prisma: quiet, accountId: '' }), /accountId/);
});

// ------------------------------------------------------------------ the reward, exactly once, only when on

function rewardDeps({ replayed = false } = {}) {
  const posts = [];
  const receipts = [];
  const ensured = [];
  return {
    posts, receipts, ensured,
    deps: {
      post: async (entry) => { posts.push(entry); return { journalEntryId: 'je1', replayed: typeof replayed === 'function' ? replayed(posts.length) : replayed }; },
      ensureWallet: async ({ accountId }) => { ensured.push(accountId); return { id: 'w1' }; },
      notify: async (args) => { receipts.push(args); return { ok: true, rail: 'text' }; },
    },
  };
}

test('switch off: the milestone is recorded with rewardCents 0, nothing is posted or sent, and it is never paid later', async () => {
  const prisma = stubPrisma({ rows: [referrerRow(), friendRow()] });
  const d = rewardDeps();
  const now = new Date('2026-10-20T12:00:00Z');
  const r = await onFunded({ prisma, accountId: FRIEND, env: {}, now, deps: d.deps });
  assert.equal(r.ok, true); assert.equal(r.rewardCents, 0); assert.equal(r.credited, false); assert.equal(r.referrerAccountId, REFERRER);
  assert.equal(d.posts.length, 0); assert.equal(d.receipts.length, 0); assert.equal(d.ensured.length, 0);
  const attr = prisma.byId.get(FRIEND).profile.attribution;
  assert.equal(attr.referralQualifiedAt, now.toISOString());
  assert.equal(attr.referralQualifiedBy, 'FUNDED');
  assert.equal(attr.referralRewardCents, 0);
  assert.equal(attr.referralRewardAt, undefined);
  // The switch turns on afterwards: a milestone reached while off is not paid.
  const later = await onLinkPaid({ prisma, accountId: FRIEND, env: { WAPAY_REFERRAL_REWARD_CENTS: '1000' }, deps: d.deps });
  assert.deepEqual(later, { skipped: 'ALREADY_QUALIFIED' });
  assert.equal(d.posts.length, 0);
});

test('switch on: one reward per referred account, from the referral expense account, one receipt, whichever hook fires first or again', async () => {
  const prisma = stubPrisma({ rows: [referrerRow(), friendRow()] });
  const d = rewardDeps();
  const env = { WAPAY_REFERRAL_REWARD_CENTS: '1000' };
  const now = new Date('2026-10-20T12:00:00Z');
  const first = await onLinkPaid({ prisma, accountId: FRIEND, env, now, deps: d.deps });
  assert.equal(first.ok, true); assert.equal(first.credited, true); assert.equal(first.rewardCents, 1000);
  assert.deepEqual(d.ensured, [REFERRER], 'the referrer\'s wallet is ensured before the post');
  assert.equal(d.posts.length, 1);
  const entry = d.posts[0];
  assert.equal(entry.idemKey, `referral-reward-${FRIEND}`);
  assert.equal(entry.source, 'REFERRAL_REWARD');
  assert.deepEqual(entry.postings, [{ accountCode: 'EXPENSE:PROMO:REFERRAL', debitCents: 1000 }, { accountCode: `WALLET:${REFERRER}:SPEND`, creditCents: 1000 }]);
  assert.equal(d.receipts.length, 1);
  assert.equal(d.receipts[0].to, '27600000901');
  assert.equal(d.receipts[0].accountId, REFERRER);
  assert.equal(d.receipts[0].kind, 'receipt');
  assert.equal(d.receipts[0].text, '💚 Thank you for inviting a friend to WaPay. Your R10 reward is in your balance.\nNew balance: R123.45');
  assert.deepEqual(copyViolations(d.receipts[0].text), []);
  const attr = prisma.byId.get(FRIEND).profile.attribution;
  assert.equal(attr.referralQualifiedBy, 'LINK_PAID');
  assert.equal(attr.referralRewardCents, 1000);
  assert.equal(attr.referralRewardAt, now.toISOString());
  assert.equal(attr.referralRewardIdemKey, `referral-reward-${FRIEND}`);
  // The other hook, a redelivery, the catch-up: nothing more.
  assert.deepEqual(await onFunded({ prisma, accountId: FRIEND, env, deps: d.deps }), { skipped: 'ALREADY_QUALIFIED' });
  assert.deepEqual(await onLinkPaid({ prisma, accountId: FRIEND, env, deps: d.deps }), { skipped: 'ALREADY_QUALIFIED' });
  assert.deepEqual(await referralCatchUp({ prisma, account: prisma.byId.get(FRIEND), env, deps: d.deps }), { skipped: 'NOTHING_TO_DO' });
  assert.equal(d.posts.length, 1); assert.equal(d.receipts.length, 1);
});

test('a race the ledger already settled (replayed post) credits nothing twice and sends no second receipt; the mark still lands', async () => {
  const prisma = stubPrisma({ rows: [referrerRow(), friendRow()] });
  const d = rewardDeps({ replayed: true });
  const r = await onFunded({ prisma, accountId: FRIEND, env: { WAPAY_REFERRAL_REWARD_CENTS: '1000' }, deps: d.deps });
  assert.equal(r.ok, true); assert.equal(r.credited, false);
  assert.equal(d.posts.length, 1, 'the post is attempted (idempotent by key)');
  assert.equal(d.receipts.length, 0, 'no receipt for an entry this call did not post');
  assert.equal(prisma.byId.get(FRIEND).profile.attribution.referralRewardCents, 1000);
});

test('a referrer who said stop is credited but not written to; a non-referred account, an own code and a missing referrer are skipped', async () => {
  const stopped = stubPrisma({ rows: [referrerRow({ profile: { referral: { code: CODE }, messaging: { optOut: true, optOutAt: '2026-10-20T09:00:00.000Z' } } }), friendRow()] });
  const d = rewardDeps();
  const r = await onFunded({ prisma: stopped, accountId: FRIEND, env: { WAPAY_REFERRAL_REWARD_CENTS: '1000' }, deps: d.deps });
  assert.equal(r.credited, true); assert.equal(d.posts.length, 1); assert.equal(d.receipts.length, 0);
  assert.deepEqual(r.receipt, { ok: false, skipped: 'OPTED_OUT' });

  const organic = stubPrisma({ rows: [referrerRow(), { id: FRIEND, waId: '27600000902', onboardingState: 'S5_COMPLETED', profile: { acquisitionSource: 'organic' } }] });
  const d2 = rewardDeps();
  assert.deepEqual(await onFunded({ prisma: organic, accountId: FRIEND, env: { WAPAY_REFERRAL_REWARD_CENTS: '1000' }, deps: d2.deps }), { skipped: 'NOT_REFERRED' });
  assert.deepEqual(await qualifyReferral({ prisma: organic, referredAccountId: '', trigger: 'FUNDED', deps: d2.deps }), { skipped: 'NO_ACCOUNT' });
  // The code points at nobody (or at the account itself): no referrer, nothing posted.
  const orphan = stubPrisma({ rows: [friendRow()] });
  assert.deepEqual(await onLinkPaid({ prisma: orphan, accountId: FRIEND, env: { WAPAY_REFERRAL_REWARD_CENTS: '1000' }, deps: d2.deps }), { skipped: 'NO_REFERRER' });
  const selfRef = stubPrisma({ rows: [{ ...friendRow(), profile: { referral: { code: CODE }, attribution: { referralCode: CODE } } }] });
  assert.deepEqual(await onLinkPaid({ prisma: selfRef, accountId: FRIEND, env: { WAPAY_REFERRAL_REWARD_CENTS: '1000' }, deps: d2.deps }), { skipped: 'NO_REFERRER' });
  assert.equal(d2.posts.length, 0);
  // A database failure never throws out of a money path.
  const broken = { account: { findUnique: async () => { throw new Error('db down'); } } };
  const out = await onFunded({ prisma: broken, accountId: FRIEND, env: { WAPAY_REFERRAL_REWARD_CENTS: '1000' }, deps: d2.deps });
  assert.equal(out.ok, false); assert.match(out.error, /db down/);
});

test('the catch-up on a referred account\'s own turn: the earlier milestone is the trigger; nothing is read for anyone else', async () => {
  const friend = friendRow();
  const prisma = stubPrisma({ rows: [referrerRow(), friend], credits: [{ id: FRIEND, at: '2026-10-20T10:00:00Z' }], paidRequests: [{ accountId: FRIEND, status: 'PAID', paidAt: new Date('2026-10-20T09:30:00Z') }] });
  const d = rewardDeps();
  const r = await referralCatchUp({ prisma, account: friend, env: {}, deps: d.deps });
  assert.equal(r.ok, true);
  assert.equal(prisma.byId.get(FRIEND).profile.attribution.referralQualifiedBy, 'LINK_PAID', 'the link was paid before the first credit');

  const fundedOnly = stubPrisma({ rows: [referrerRow(), friendRow()], credits: [{ id: FRIEND, at: '2026-10-20T10:00:00Z' }] });
  assert.equal((await referralCatchUp({ prisma: fundedOnly, account: friendRow(), env: {}, deps: d.deps })).ok, true);
  assert.equal(fundedOnly.byId.get(FRIEND).profile.attribution.referralQualifiedBy, 'FUNDED');

  const nothingYet = stubPrisma({ rows: [referrerRow(), friendRow()] });
  assert.deepEqual(await referralCatchUp({ prisma: nothingYet, account: friendRow(), env: {}, deps: d.deps }), { skipped: 'NOT_YET' });
  assert.equal(nothingYet.byId.get(FRIEND).profile.attribution.referralQualifiedAt, undefined);

  const untouched = { account: { findUnique: async () => { throw new Error('must not read'); } }, $queryRaw: async () => { throw new Error('must not read'); } };
  assert.deepEqual(await referralCatchUp({ prisma: untouched, account: { id: 'x', onboardingState: 'S5_COMPLETED', profile: { acquisitionSource: 'organic' } } }), { skipped: 'NOTHING_TO_DO' });
  assert.deepEqual(await referralCatchUp({ prisma: untouched, account: { ...friendRow(), onboardingState: 'S2_OTP_SENT' } }), { skipped: 'NOTHING_TO_DO' });
  assert.deepEqual(await referralCatchUp({ prisma: untouched, account: null }), { skipped: 'NOTHING_TO_DO' });
});

// ------------------------------------------------------------------ the wiring

test('the processor: the code is read on first contact before the ad flow, the member is told once, "invite" answers before the agent path', () => {
  const p = read('../pages/api/webhooks/message-processor-v2.js');
  assert.match(p, /import \{ parseReferralCode, recordReferredContact, matchInviteAsk, ensureReferralCode, inviteMessage, referredWelcome, ALREADY_MEMBER_REPLY \} from '\.\.\/\.\.\/\.\.\/lib\/referrals\.js';/);
  const hook = p.indexOf('const referralTurn = await handleReferralCodeTurn({ from, account, text, profile, onboardingState })');
  const ad = p.indexOf('const adTurn = await handleAdEntryTurn({');
  const gate = p.indexOf("if (onboardingState !== 'S5_COMPLETED') {");
  assert.ok(hook > 0 && hook < ad && ad < gate, 'first contact with a code is read before the ad flow and before the onboarding gate');
  const invite = p.indexOf('if (matchInviteAsk(text)) return await handleInviteAsk({ from, account });');
  const agent = p.indexOf('if (agentV3For(from)) {');
  const business = p.indexOf('if (matchBusinessSignupAsk(text)) return await handleBusinessSignupAsk({ from, account });');
  assert.ok(invite > business && invite < agent, 'the invite command answers everyone, the pilot path included');
  // The friend hears who invited them by first name only; memory keeps "A friend".
  assert.match(p, /await sendWhatsAppText\(\{ to: from, text: welcome, recordAs: referredWelcome\(\{ inviterFirstName: null \}\), kind: 'flow' \}\);/);
  assert.match(p, /return await startAdOnboarding\(\{ from, account, profile \}\);\s*\}\s*\n\n\/\*\* "invite"/, 'then the OTP step at once');
  // A member who sends a code is answered once; an unknown code or their own falls through.
  assert.match(p, /if \(onboardingState === 'S5_COMPLETED'\) \{\s*logStructured\('referral_code_from_member'[\s\S]{0,200}ALREADY_MEMBER_REPLY/);
  assert.match(p, /if \(!recorded\.ok \|\| onboardingState !== 'S0_INITIAL'\) return null;/);
  // The invite goes out through the usual send, once, localised, no reminder anywhere.
  assert.match(p, /async function handleInviteAsk\(\{ from, account \}\) \{\s*const code = await ensureReferralCode\(\{ accountId: account\.id \}\);[\s\S]{0,300}return await sendWhatsAppText\(\{ to: from, text: msg, kind: 'flow' \}\);/);
  assert.equal((p.match(/handleInviteAsk\(/g) || []).length, 2, 'one call site, one definition');
  assert.ok(!/referral(Reminder|Nudge)/i.test(p));
});

test('the milestones are hooked where money lands and where a link is paid, with the catch-up on the referred account\'s own turn', () => {
  const card = read('../lib/card-settlement.js');
  assert.match(card, /if \(!posted\?\.replayed\) \{[\s\S]{0,400}const \{ onFunded \} = await import\('\.\/referrals\.js'\);\s*await onFunded\(\{ prisma: prismaClient, accountId \}\);/);
  const itn = read('../pages/api/payfast/itn.js');
  assert.match(itn, /if \(!posted\?\.replayed\) \{[\s\S]{0,400}const \{ onFunded \} = await import\('\.\.\/\.\.\/\.\.\/lib\/referrals\.js'\);\s*await onFunded\(\{ accountId \}\);/);
  const notify = read('../lib/request-notify.js');
  assert.match(notify, /if \(!request \|\| request\.status !== 'PAID'\) return out;[\s\S]{0,500}const \{ onLinkPaid \} = await import\('\.\/referrals\.js'\);\s*await onLinkPaid\(\{ prisma, accountId: request\.accountId \}\);/);
  const growth = read('../lib/growth-attribution.js');
  assert.match(growth, /import \{ referralCatchUp \} from '\.\/referrals\.js';/);
  assert.match(growth, /attr\?\.referralCode && !attr\?\.referralQualifiedAt\) \{\s*await Promise\.race\(\[\s*referralCatchUp\(\{ prisma, account, now \}\),/);
  // The module itself never imports the transport: the one receipt goes through notifyCustomer, and nothing is sent to a number that has not written in.
  const mod = read('../lib/referrals.js');
  assert.ok(!mod.includes('@wapay/whatsapp') && !mod.includes('sendWhatsAppText('), 'no direct transport');
  assert.match(mod, /notifyCustomer/);
  assert.ok(!/setInterval\(|setTimeout\(|node-cron|ad-reminders/.test(mod), 'no scheduled sends');
});

test('the registry carries INVITE with a help line and a home line; the admin profile carries the referral numbers', () => {
  const invite = CAPABILITIES.find((c) => c.id === 'INVITE');
  assert.ok(invite, 'INVITE is a capability');
  assert.equal(invite.startCommand, 'invite');
  assert.equal(invite.helpLine, `🤝 *Invite a friend* - "invite" for your link to share`);
  assert.equal(invite.liveFor({}), true);
  assert.ok(homeLines({ waId: '27600000919' }).includes(`🤝 *Invite*: "invite" to share WaPay with a friend`));
  assert.ok(helpLines({ waId: '27600000919' }).includes(invite.helpLine));
  assert.ok(promptLines({ waId: '27600000919' }).some((l) => l.startsWith('- Invite a friend:') && l.includes('Start: "invite"')));
  for (const t of [invite.label, invite.oneLiner, invite.helpLine, invite.feeLine()]) {
    assert.deepEqual(copyViolations(t), [], t);
    assert.ok(!/[—–]/.test(t));
    assert.ok(!/\bR\d/.test(t), 'the registry promises no amount');
  }
  const customer = read('../pages/api/admin/customer.js');
  assert.match(customer, /import \{ referralStats \} from '\.\.\/\.\.\/\.\.\/lib\/referrals\.js';/);
  assert.match(customer, /const referrals = await referralStats\(\{ prisma, accountId: account\.id \}\)\.catch\(\(\) => null\);/);
  for (const key of ['code', 'link', 'invited', 'onboarded', 'funded', 'paid', 'rewardEligibleCents', 'rewardPaidCents']) {
    assert.match(customer, new RegExp(`${key}: referrals\\.${key},`), `referrals.${key} in the profile`);
  }
  const env = read('../env.template');
  assert.match(env, /# WAPAY_REFERRAL_REWARD_CENTS=0/);
});
