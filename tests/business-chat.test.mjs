/**
 * WaPay for Business — sign-up INSIDE WhatsApp (founder ask 2026-09-06).
 * Drives lib/business-chat.js against an in-memory Prisma stand-in, and
 * locks the processor wiring + the onboarding OTP flag by reading source.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  matchBusinessSignupAsk, parseAccountType, accountTypeQuestion, startBusinessSignup, handleBusinessSignupReply,
  portalUrl, BIZ_SIGNUP_TYPE, BIZ_SIGNUP_NAME,
} from '../lib/business-chat.js';
import { BUSINESS_CATEGORIES } from '../lib/business-categories.js';

const processor = readFileSync(fileURLToPath(new URL('../pages/api/webhooks/message-processor-v2.js', import.meta.url)), 'utf8');
const onboardingTs = readFileSync(fileURLToPath(new URL('../packages/auth/src/onboarding.ts', import.meta.url)), 'utf8');
const portalPage = readFileSync(fileURLToPath(new URL('../pages/business/index.js', import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------
// Minimal Prisma stand-in: account + business (unique accountId)
// ---------------------------------------------------------------------------
function table(rows, { uniques = [] } = {}) {
  let seq = 0;
  const match = (r, where = {}) => Object.entries(where).every(([k, v]) => r[k] === v);
  return {
    _rows: rows,
    async findUnique({ where }) { const r = rows.find((x) => match(x, where)); return r ? { ...r } : null; },
    async findFirst({ where }) { const r = rows.find((x) => match(x, where)); return r ? { ...r } : null; },
    async create({ data }) {
      for (const u of uniques) if (rows.some((r) => u.every((k) => r[k] === data[k]))) { const e = new Error('unique'); e.code = 'P2002'; throw e; }
      const row = { id: `id-${++seq}`, createdAt: new Date(), status: 'ACTIVE', ...data };
      rows.push(row); return { ...row };
    },
    async update({ where, data }) { const r = rows.find((x) => match(x, where)); if (!r) throw new Error('not found'); Object.assign(r, data); return { ...r }; },
  };
}
const OWNER = { id: 'acc-owner', msisdn: '0731234567', waId: '27731234567', displayName: 'Lerato', onboardingState: 'S5_COMPLETED' };
function stub({ withBusiness = false } = {}) {
  return {
    account: table([{ ...OWNER, profile: {} }]),
    business: table(withBusiness ? [{ id: 'biz1', accountId: OWNER.id, name: 'I Love My Laundry', status: 'ACTIVE' }] : [], { uniques: [['accountId']] }),
    // updateProfile merges in Postgres (jsonb ||); the stand-in just accepts it.
    async $executeRaw() { return 1; },
    async $executeRawUnsafe() { return 1; },
  };
}
function open() { process.env.WAPAY_BUSINESS_SIGNUPS = 'open'; delete process.env.WAPAY_BUSINESS_MSISDNS; delete process.env.WAPAY_BUSINESS_MSISDN; }
function closed(invites = '') { delete process.env.WAPAY_BUSINESS_SIGNUPS; process.env.WAPAY_BUSINESS_MSISDNS = invites; delete process.env.WAPAY_BUSINESS_MSISDN; }

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test('matcher: the explicit asks start the flow; ordinary sentences and the portal-code command never do', () => {
  for (const t of [
    'business account', 'Business Account please', 'register my business', 'I want to register a business',
    'sign up as a business', 'I am a business', "I'm a business owner", 'wapay for business', 'open a business account',
    'add my business', 'Hi, I want a business account', 'can I open a business account on WaPay', 'set up a business profile',
  ]) assert.equal(matchBusinessSignupAsk(t), true, t);
  for (const t of [
    'business login', 'business code', 'portal login', 'pay business', 'buy airtime', 'my business is slow today',
    'hi', 'please pay me R150', 'what is a business account?', 'business', 'I have a business', '', null,
    'send R50 to my business partner', 'x'.repeat(200),
  ]) assert.equal(matchBusinessSignupAsk(t), false, String(t));
});

test('account type answers: numbers, words, a full sentence, and the ambiguous ones', () => {
  for (const t of ['1', 'one', 'personal', 'Personal please', 'for me', 'myself', 'retail', 'no', 'skip', 'cancel']) assert.equal(parseAccountType(t), 'PERSONAL', t);
  for (const t of ['2', 'two', 'business', "It's for my spaza shop", 'my salon', 'Business account', 'Besigheid']) assert.equal(parseAccountType(t), 'BUSINESS', t);
  for (const t of ['blue', '', 'personal business', 'what?']) assert.equal(parseAccountType(t), null, t);
});

// ---------------------------------------------------------------------------
// The two questions
// ---------------------------------------------------------------------------

test('question 1 after onboarding: personal answers end it kindly; unclear twice defaults to personal', async () => {
  open();
  const q = accountTypeQuestion();
  assert.equal(q.state, BIZ_SIGNUP_TYPE); assert.match(q.text, /\*1\* or \*2\*/);
  for (const answer of ['1', 'personal', 'cancel']) {
    const prisma = stub();
    const r = await handleBusinessSignupReply({ prisma, account: OWNER, state: BIZ_SIGNUP_TYPE, data: q.data, text: answer });
    assert.equal(r.state, null, answer); assert.equal(r.personal, true); assert.match(r.text, /business account/);
    assert.equal(prisma.business._rows.length, 0, 'no business row for a personal account');
  }
  const prisma = stub();
  const first = await handleBusinessSignupReply({ prisma, account: OWNER, state: BIZ_SIGNUP_TYPE, data: { asked: 0 }, text: 'blue' });
  assert.equal(first.state, BIZ_SIGNUP_TYPE); assert.equal(first.data.asked, 1); assert.match(first.text, /\*1\*.*\*2\*/);
  const second = await handleBusinessSignupReply({ prisma, account: OWNER, state: BIZ_SIGNUP_TYPE, data: first.data, text: 'green' });
  assert.equal(second.state, null); assert.equal(second.personal, true, 'never stuck: the second unclear answer ends the question');
});

test('question 1 → business: an invited (or open) wallet is asked the trading name; a closed pilot puts the wallet on the list', async () => {
  open();
  let r = await handleBusinessSignupReply({ prisma: stub(), account: OWNER, state: BIZ_SIGNUP_TYPE, data: { asked: 0 }, text: '2' });
  assert.equal(r.state, BIZ_SIGNUP_NAME); assert.match(r.text, /trading name/i);
  closed('0829999999'); // somebody else is invited, not Lerato
  const prisma = stub();
  r = await handleBusinessSignupReply({ prisma, account: OWNER, state: BIZ_SIGNUP_TYPE, data: { asked: 0 }, text: 'business' });
  assert.equal(r.state, null); assert.equal(r.waitlisted, true); assert.match(r.text, /small group/i); assert.match(r.text, /please pay me/i);
  assert.equal(prisma.business._rows.length, 0);
  closed('0731234567'); // Lerato IS invited (0-form entry, any SA form works)
  r = await handleBusinessSignupReply({ prisma: stub(), account: OWNER, state: BIZ_SIGNUP_TYPE, data: { asked: 0 }, text: 'business' });
  assert.equal(r.state, BIZ_SIGNUP_NAME);
  open();
});

test('the command for an existing wallet: already registered → named, with the portal and the code command; else the name ask', async () => {
  open();
  process.env.WAPAY_BUSINESS_HOST = 'business.wapay.co.za';
  const r = await startBusinessSignup({ prisma: stub({ withBusiness: true }), account: OWNER });
  assert.equal(r.state, null); assert.equal(r.already, true); assert.equal(r.raw, true, 'carries a URL and a command: never localised');
  assert.match(r.text, /I Love My Laundry/); assert.match(r.text, /https:\/\/business\.wapay\.co\.za/); assert.match(r.text, /\*business login\*/);
  const fresh = await startBusinessSignup({ prisma: stub(), account: OWNER });
  assert.equal(fresh.state, BIZ_SIGNUP_NAME);
  delete process.env.WAPAY_BUSINESS_HOST;
  process.env.APP_BASE_URL = 'https://wapay.co.za';
  assert.equal(portalUrl(), 'https://wapay.co.za/business', 'no dedicated host: /business on the app');
  delete process.env.APP_BASE_URL;
});

test('question 2, the name: cancel, too short, impersonation, then a real name registers the business and clears the state', async () => {
  open();
  const prisma = stub();
  let r = await handleBusinessSignupReply({ prisma, account: OWNER, state: BIZ_SIGNUP_NAME, data: {}, text: 'cancel' });
  assert.equal(r.state, null); assert.equal(r.cancelled, true);
  r = await handleBusinessSignupReply({ prisma, account: OWNER, state: BIZ_SIGNUP_NAME, data: {}, text: 'X' });
  assert.equal(r.state, BIZ_SIGNUP_NAME); assert.match(r.text, /2 to 60/);
  r = await handleBusinessSignupReply({ prisma, account: OWNER, state: BIZ_SIGNUP_NAME, data: {}, text: 'WaPay Support' });
  assert.equal(r.state, BIZ_SIGNUP_NAME); assert.match(r.text, /can't be used/);
  r = await handleBusinessSignupReply({ prisma, account: OWNER, state: BIZ_SIGNUP_NAME, data: {}, text: 'Capitec Loans' });
  assert.equal(r.state, BIZ_SIGNUP_NAME, 'a bank name is refused in chat exactly like on the portal');
  assert.equal(prisma.business._rows.length, 0, 'nothing created yet');
  r = await handleBusinessSignupReply({ prisma, account: OWNER, state: BIZ_SIGNUP_NAME, data: {}, text: "  I Love My Laundry  " });
  assert.equal(r.state, null); assert.equal(r.done, true); assert.equal(r.raw, true);
  assert.equal(prisma.business._rows.length, 1);
  assert.equal(prisma.business._rows[0].name, 'I Love My Laundry'); assert.equal(prisma.business._rows[0].accountId, OWNER.id);
  assert.equal(prisma.business._rows[0].category ?? null, null, 'category is a portal Settings matter, never asked in chat');
  assert.equal(prisma.business._rows[0].passwordHash ?? null, null, 'no password is ever typed into WhatsApp');
  assert.match(r.text, /\*I Love My Laundry\* is now a WaPay business/); assert.match(r.text, /\*business login\*/); assert.match(r.text, /\/business|business\.wapay/);
  assert.ok(!/—/.test(r.text), 'no em dashes in client copy');
  // Double submit / race on the unique accountId adopts the winner instead of failing.
  const again = await handleBusinessSignupReply({ prisma, account: OWNER, state: BIZ_SIGNUP_NAME, data: {}, text: 'Second Name' });
  assert.equal(again.done, true); assert.equal(again.businessId, prisma.business._rows[0].id); assert.equal(prisma.business._rows.length, 1);
});

test('question 2 while the invite was withdrawn in between: the honest waitlist answer, nothing created', async () => {
  closed('0829999999');
  const prisma = stub();
  const r = await handleBusinessSignupReply({ prisma, account: OWNER, state: BIZ_SIGNUP_NAME, data: {}, text: 'I Love My Laundry' });
  assert.equal(r.waitlisted, true); assert.equal(prisma.business._rows.length, 0);
  open();
});

test('the shared category list is what the portal renders', () => {
  assert.ok(BUSINESS_CATEGORIES.length >= 5);
  assert.match(portalPage, /import \{ BUSINESS_CATEGORIES \} from '\.\.\/\.\.\/lib\/business-categories\.js'/);
  assert.match(portalPage, /const CATEGORIES = BUSINESS_CATEGORIES;/);
});

// ---------------------------------------------------------------------------
// Processor wiring (source-locked, like the portal-code hook)
// ---------------------------------------------------------------------------

test('processor: the question is asked exactly when onboarding completes, both states dispatch, the command sits after the code command and before slot parsing', () => {
  const s4 = processor.indexOf("case 'S4_PIN_SET': {");
  assert.ok(s4 > -1, 'S4 case is a block');
  const s4End = processor.indexOf('    default:', s4);
  const s4Body = processor.slice(s4, s4End);
  assert.match(s4Body, /await handleS4PinSet\(/);
  assert.match(s4Body, /=== 'S5_COMPLETED'\)/, 'the question is gated on the state actually reaching S5 (a re-asked consent must not trigger it)');
  assert.match(s4Body, /await askAccountType\(\{ from, account \}\)\.catch\(/, 'a failure to ask can never undo onboarding');
  assert.match(s4Body, /return done;/);

  const sw = processor.indexOf('async function handleConversationState({ from, text, state, data, account }) {');
  const firstCase = processor.indexOf("case 'REQUEST_MONEY_AMOUNT': {", sw);
  const bizCases = processor.slice(sw, firstCase);
  assert.match(bizCases, /case 'BIZ_SIGNUP_TYPE':\s*\n\s*case 'BIZ_SIGNUP_NAME':\s*\n\s*return await handleBusinessSignupState\(\{ from, account, state, data, text \}\);/);

  const loginHook = processor.lastIndexOf('matchBusinessLoginAsk(text)');
  const signupHook = processor.indexOf('if (matchBusinessSignupAsk(text)) return await handleBusinessSignupAsk({ from, account });');
  const slots = processor.indexOf('const slots = parseSlots(text');
  assert.ok(loginHook < signupHook && signupHook < slots, 'command order: portal code, then sign-up, then slot parsing');
  assert.match(processor, /state\.startsWith\('BIZ_SIGNUP'\) \? 'your business sign-up'/, 'the intent-switch escape names the parked flow');
  assert.match(processor, /🏪 \*Business\* - "business account"/, 'the help menu mentions the command');
  assert.match(processor, /const msg = step\.raw \? step\.text : await localizeOutbound\(step\.text/, 'steps with a command or URL are never localised');
});

// ---------------------------------------------------------------------------
// The onboarding OTP flag (source-locked; the package has no unit harness)
// ---------------------------------------------------------------------------

test('onboarding OTP flag: default ON; off skips S1→S2 straight to the PIN step and audits it', () => {
  const fnSrc = onboardingTs.slice(onboardingTs.indexOf('export function onboardingOtpDisabled(): boolean {'));
  const body = fnSrc.slice(0, fnSrc.indexOf('\n}') + 2).replace('export function onboardingOtpDisabled(): boolean {', 'function onboardingOtpDisabled() {');
  // eslint-disable-next-line no-new-func
  const onboardingOtpDisabled = new Function(`${body}; return onboardingOtpDisabled;`)();
  delete process.env.WAPAY_ONBOARDING_OTP;
  assert.equal(onboardingOtpDisabled(), false, 'unset: the OTP stays (unchanged behaviour)');
  for (const v of ['on', 'true', '1', 'yes', 'anything']) { process.env.WAPAY_ONBOARDING_OTP = v; assert.equal(onboardingOtpDisabled(), false, v); }
  for (const v of ['off', 'OFF', 'false', '0', 'no', 'skip']) { process.env.WAPAY_ONBOARDING_OTP = v; assert.equal(onboardingOtpDisabled(), true, v); }
  delete process.env.WAPAY_ONBOARDING_OTP;

  const s1 = onboardingTs.indexOf('export async function handleS1WelcomeSent(');
  const s1End = onboardingTs.indexOf('export async function handleS2OtpSent(', s1);
  const s1Body = onboardingTs.slice(s1, s1End);
  const skip = s1Body.indexOf('if (onboardingOtpDisabled()) {');
  const otp = s1Body.indexOf('await sendOTP({');
  assert.ok(skip > -1 && skip < otp, 'the flag is checked BEFORE any OTP is sent');
  const skipBlock = s1Body.slice(skip, otp);
  assert.match(skipBlock, /await sendPinCreationPrompt\(\{ waId, displayName \}\)/);
  assert.match(skipBlock, /from: 'S1_WELCOME_SENT',\s*\n\s*to: 'S3_OTP_VERIFIED',\s*\n\s*metadata: \{ otpSkipped: true \}/, 'audited transition S1→S3');
  assert.match(skipBlock, /return \{ ok: true \};/);
  assert.ok(!/otpSkipped/.test(s1Body.slice(otp)), 'the OTP path itself is untouched');
});
