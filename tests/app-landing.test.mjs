/**
 * The app's landing screen and its install (2026-11-24,
 * docs/prompting/prompts/2026-11-24-app-landing-and-install.md; reviewed the
 * same day, docs/testing/adversarial-review-2026-11-24.md).
 *
 * Locks:
 * - the message box never takes a secret: a line shaped like a PIN, an ID or
 *   passport number, or a long digit run that is not a SA cell number is
 *   answered on the page and goes nowhere; the landing screen posts only the
 *   log-in (the PIN from the PIN boxes) and the log-out, and what is typed is
 *   never part of a request, an address or the browser's storage
 *   (docs/GOLDEN_THREAD.md 2.13);
 * - the router: a cell number opens the log-in step, a pay link opens the pay
 *   page, a visitor's question is read as the ad flow reads it, a member's
 *   everyday words open the page or the card that already exists, and a
 *   question it does not understand is never answered with a yes;
 * - a return address after log-in is one of the app's own pages or nothing;
 * - money on the screen is read fresh each time, a failed log-out is never
 *   shown as a log-out, and the hide button hides the balance and the
 *   activity in every card (a link's own amount stays, as on Your links);
 * - what the screen says about WaPay is the ad flow's own answers, served by
 *   /api/app/guide with no session and no customer data, and everything a
 *   visitor can read keeps to the ad flow's word rules (copyViolations);
 * - the pill menu is Chat, Pay, Activity, Profile, locked for a visitor;
 * - every colour is a variable with a dark set, so the app follows the phone;
 * - the install: the manifest, the icons, and a service worker that stores
 *   nothing, answers page loads only, never handles /api/, and whose offline
 *   screen says nothing about what did or did not happen in the account.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.WAPAY_APP_SESSION_SECRET = 'test-app-session-secret-0123456789';

const { routeMessage, secretKind, cellOf, payLinkCodeOf, greetingFor, safeNext, SECRET_LINE, BAD_CELL_LINE } = await import('../lib/app-chat-router.js');
const { guideView, GUIDE_LINE } = await import('../lib/app-portal.js');
const { copyViolations, adEntryReply, AD_QUESTIONS } = await import('../lib/ad-flow.js');
const { createFixtureDeps } = await import('../lib/app-dev-fixture.js');
const { createGuideHandler } = await import('../pages/api/app/guide.js');

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const read = (p) => readFileSync(path(p), 'utf8');
const landing = read('../components/app/Landing.js');

/** Every call of `name(` in a source with its whole argument text, however many lines the call spans. */
function callsOf(src, name) {
  const out = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let quote = null;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i += 1) {
      const ch = src[i];
      if (quote) { if (ch === '\\') i += 1; else if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    out.push(src.slice(m.index + m[0].length, i - 1).replace(/\s+/g, ' ').trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// The message box never takes a secret
// ---------------------------------------------------------------------------

test('a PIN, an ID or passport number, or a long digit run is a secret for a visitor and for a member; a cell number and an amount are not', () => {
  const secrets = [
    ['2580', 'pin'], ['123456', 'pin'], ['12 34', 'pin'], ['my pin is 2580', 'pin'], ['PIN: 4321 please', 'pin'],
    // However a PIN is glued, spaced or named (review 2026-11-24).
    ['pin2580', 'pin'], ['my pin is 2 5 8 0', 'pin'], ['otp 123456', 'pin'], ['my code is 4821', 'pin'], ['it is 4821', 'pin'],
    // Digits of another script: full-width ones are folded and read, any other script is never guessed at.
    ['２５８０', 'pin'], ['٢٥٨٠', 'digits'],
    ['9001015009087', 'id'], ['900101 5009 087', 'id'], ['my id is 9001015009087', 'id'], ['A12345678', 'id'], ['passport ZN1234567', 'id'],
    ['1234567', 'digits'], ['62123456789', 'digits'], ['account 1234567890 at the bank', 'digits'], ['card 4111 1111 1111 1111', 'digits'],
    // A PIN typed beside a cell number is still a secret, in either order or run together.
    ['0821234567 2580', 'digits'], ['2580 0821234567', 'digits'], ['08212345672580', 'digits'],
  ];
  for (const [text, reason] of secrets) {
    assert.equal(secretKind(text), reason, text);
    for (const authed of [false, true]) assert.deepEqual(routeMessage(text, { authed }), { kind: 'secret', reason }, `${text} (${authed ? 'member' : 'visitor'})`);
  }
  for (const fine of ['0821234567', '+27 82 123 4567', '27821234567', '082 123 4567', '250', 'R1 500', 'R1,500.50', 'send R50 to 082 123 4567', 'pay 2500 to 0821234567', 'top up 5000', 'send 2000', 'PRDEMOEF', 'hello']) {
    assert.equal(secretKind(fine), null, fine);
  }
  // A pay link's own address is not weighed, but a secret typed beside it is.
  assert.deepEqual(routeMessage('https://pleasepayme.co.za/PRDEMOEF my pin is 2580', { authed: true }), { kind: 'secret', reason: 'pin' });
  for (const line of [SECRET_LINE, BAD_CELL_LINE]) assert.deepEqual(copyViolations(line), [], line);
  assert.ok(!/\d/.test(SECRET_LINE) && /Nothing was sent/.test(SECRET_LINE));
});

test('a number that is not a cell number is said so plainly, shown as dots and sent nowhere', () => {
  for (const text of ['0211234567', '082 123 456', '+44 7700 900123', '08212345678']) {
    for (const authed of [false, true]) assert.deepEqual(routeMessage(text, { authed }), { kind: 'badcell' }, `${text} (${authed ? 'member' : 'visitor'})`);
  }
  assert.match(BAD_CELL_LINE, /South African cell number/);
  const submit = landing.slice(landing.indexOf('const onSubmit ='), landing.indexOf('const onPlus ='));
  assert.match(submit, /if \(r\.kind === 'badcell'\) \{ push\(\{ who: 'me', text: '•••' \}, \{ who: 'wa', text: BAD_CELL_LINE \}\); return; \}/);
});

test('the landing screen posts only the log-in and the log-out, and nothing typed in the message box is ever part of a request, an address or the browser\'s storage', () => {
  // The scanner reads a call that spans lines, so a request cannot hide behind a line break.
  assert.deepEqual(callsOf("x = api(\n  '/a',\n  { b: f(1), c: ')' }\n); y.api('/b')", 'api'), ["'/a', { b: f(1), c: ')' }"]);
  const calls = callsOf(landing, 'api');
  const allowed = new Set([
    "'/api/app/home'",
    "'/api/app/guide'",
    "'/api/app/links'",
    "'/api/app/auth', { method: 'POST', body: { action: 'login', msisdn: cell, pin } }",
    "'/api/app/auth', { method: 'POST', body: { action: 'logout' } }",
  ]);
  assert.equal(calls.length, 5, `found the calls: ${calls.join(' | ')}`);
  for (const c of calls) assert.ok(allowed.has(c), `an unexpected request from the landing screen: api(${c})`);
  assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(landing), 'no other way out of the page');
  assert.ok(!/\bconsole\./.test(landing), 'nothing is written to the console');

  // Every address the screen can go to: one of the app's own pages from the router, a checked return address, or a pay link's code.
  assert.deepEqual([...callsOf(landing, 'router\\.push'), ...callsOf(landing, 'router\\.replace')].sort(), ['r.href', 'safeNext(router.query.next)', 'target']);
  assert.match(landing, /const target = safeNext\(router\.query\.next\);/);
  assert.deepEqual(callsOf(landing, 'window\\.location\\.assign'), ['`/pay/${code}`']);
  assert.deepEqual(callsOf(landing, 'openPayLink').sort(), ['code', 'r.code'], 'a pay code only from the router or from payLinkCodeOf');
  assert.ok(!/location\.href\s*=|window\.open\(/.test(landing));

  // The log-in's PIN is the PIN boxes' state, never the message box's.
  const loginCard = landing.slice(landing.indexOf('function LoginCard('), landing.indexOf('export default function Landing('));
  assert.match(loginCard, /<PinField value=\{pin\} onChange=\{setPin\}/);
  assert.ok(!/\btext\b|\btyped\b/.test(loginCard), 'the log-in step never reads the message box');

  // In the submit handler the secret branch comes first: masked, answered and returned before anything else happens.
  const submit = landing.slice(landing.indexOf('const onSubmit ='), landing.indexOf('const onPlus ='));
  const secretAt = submit.indexOf("if (r.kind === 'secret')");
  assert.ok(secretAt > 0 && secretAt < submit.indexOf("push({ who: 'me', text: typed })") && secretAt < submit.indexOf('act(r)'), 'secret → masked → return, before the line is shown or acted on');
  assert.match(submit, /if \(r\.kind === 'secret'\) \{ push\(\{ who: 'me', text: '•••' \}, \{ who: 'wa', text: SECRET_LINE \}\); return; \}/);
  // What was typed is read by the router and shown in the thread: it is handed to nothing else.
  assert.deepEqual([...submit.matchAll(/(\S*\s?)\btyped\b/g)].map((m) => m[0]), ['const typed', '(!typed', 'routeMessage(typed', 'text: typed']);

  // Only two things are kept in the browser, both fixed flags, both through the one helper.
  const keepAt = landing.indexOf('const keep = {');
  const keepBlock = landing.slice(keepAt, landing.indexOf('};', keepAt));
  assert.equal((landing.match(/localStorage/g) || []).length, 2);
  assert.equal((keepBlock.match(/localStorage/g) || []).length, 2, 'storage is touched only inside keep');
  assert.deepEqual(callsOf(landing, 'keep\\.set').sort(), ["HIDE_KEY, h ? '0' : '1'", "INSTALL_KEY, '1'"]);
  assert.ok(!/sessionStorage|document\.cookie|indexedDB/.test(landing));

  // The clipboard is read only to look for a pay link's code: its text is handed to payLinkCodeOf and nothing else.
  assert.deepEqual([...landing.matchAll(/(\w+\()?\bclip\b(?!\s*=)/g)].map((m) => m[0]), ['payLinkCodeOf(clip']);

  // The router itself is pure.
  assert.ok(!/\bfetch\(|localStorage|document\.|window\.|process\.env|console\./.test(read('../lib/app-chat-router.js')));
});

test('money on the screen is read fresh, a failed log-out is not shown as one, and the hide button hides the balance and the activity in every card', () => {
  // A card is drawn from a read made when it was asked for; a failed read says so and drops the older figure.
  assert.ok(!/\bhome \|\|/.test(landing), 'no "the balance we already had, or else a new read"');
  assert.match(landing, /const fresh = await loadHome\(\);\n\s+if \(fresh\) push\(\{ who: 'wa', card: r\.card, home: fresh \}\); else say\(NO_BALANCE\);/);
  assert.match(landing, /setHome\(null\);\n\s+setHomeFailed\(true\);\n\s+return null;/);
  assert.match(landing, /if \(document\.visibilityState === 'visible'\) loadHome\(\);/, 'an app come back to reads the balance again');
  // The log-out: the answer is read before anything on the screen changes.
  const logout = landing.slice(landing.indexOf('const logout = async'), landing.indexOf('const lockedTap ='));
  const okAt = logout.indexOf('if (!r.ok) { say(STILL_IN); return; }');
  assert.ok(okAt > 0 && okAt < logout.indexOf('forgetSession()') && okAt < logout.indexOf('setHome(null)') && okAt < logout.indexOf('setCfg('), 'a log-out WaPay did not answer leaves the screen signed in and says so');
  assert.match(landing, /const STILL_IN = 'You are still logged in/);
  // The Profile screen's log-out keeps the same rule.
  const profile = read('../pages/app/profile.js');
  const profileLogout = profile.slice(profile.indexOf('const logout = '), profile.indexOf('const pill ='));
  const profileOkAt = profileLogout.indexOf("if (!r.ok) { say('You are still logged in");
  assert.ok(profileOkAt > 0 && profileOkAt < profileLogout.indexOf('forgetSession()') && profileOkAt < profileLogout.indexOf('router.replace('));
  // Hidden means hidden in the chip and in every card.
  assert.match(landing, /function BalanceCard\(\{ home, hide \}\) \{\n\s+if \(hide\) return /);
  assert.match(landing, /function RecentCard\(\{ home, hide \}\) \{\n\s+if \(hide\) return /);
  assert.match(landing, /<BalanceCard home=\{it\.home\} hide=\{hide\} \/>\{hide \? null : /);
  assert.match(landing, /<RecentCard home=\{it\.home\} hide=\{hide\} \/>/);
  assert.match(landing, /hide \? '••••' : R\(b\.totalCents\)/);
});

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

test('a visitor: a cell number opens the log-in step, a pay link opens the pay page, a question is read as the ad flow reads it', () => {
  const v = (t) => routeMessage(t, { authed: false });
  assert.deepEqual(v('082 123 4567'), { kind: 'cell', cell: '0821234567' });
  assert.deepEqual(v('+27821234567'), { kind: 'cell', cell: '0821234567' });
  assert.deepEqual(v('my number is 082 123 4567'), { kind: 'cell', cell: '0821234567' });
  assert.equal(cellOf('0211234567'), null, 'a landline is not a WaPay cell number');
  assert.deepEqual(v('PRDEMOEF'), { kind: 'paylink', code: 'PRDEMOEF' });
  assert.deepEqual(v('Prdemoef'), { kind: 'paylink', code: 'PRDEMOEF' }, 'as a phone keyboard types it');
  assert.deepEqual(v('pay PRDEMOEF'), { kind: 'paylink', code: 'PRDEMOEF' });
  assert.deepEqual(v('https://pleasepayme.co.za/PRdemoef?s=w'), { kind: 'paylink', code: 'PRDEMOEF' });
  assert.deepEqual(v('wa-pay.me/PRDEMOEF'), { kind: 'paylink', code: 'PRDEMOEF' });
  for (const word of ['problems', 'Problems', 'PROBLEMS', 'products', 'practice', 'PRACTICES', 'progress', 'please']) assert.equal(payLinkCodeOf(word), null, `${word} is a word, not a code`);
  assert.deepEqual(v('log in'), { kind: 'login' });
  assert.deepEqual(v('Sign in please'), { kind: 'login' });
  assert.deepEqual(v('I have an account'), { kind: 'login' });
  assert.deepEqual(v('where is my money'), { kind: 'login' }, 'only a member can be shown money');
  assert.deepEqual(v('I want to pay a link'), { kind: 'paylink-ask' });
  assert.deepEqual(v('someone sent me a link'), { kind: 'paylink-ask' }, 'someone holding a link is helped to pay it, not sold an account');
  // Opening an account is read before logging in (review 2026-11-24: "Open my account" opened the log-in step).
  assert.deepEqual(v(AD_QUESTIONS.Q1), { kind: 'open' });
  assert.deepEqual(v('Open my account'), { kind: 'open' });
  assert.deepEqual(v('how do I open an account'), { kind: 'open' });
  assert.deepEqual(v('sign up'), { kind: 'open' });
  assert.deepEqual(v('I dont have an account'), { kind: 'open' });
  assert.deepEqual(v("I don't have an account"), { kind: 'open' });
  assert.deepEqual(v(AD_QUESTIONS.Q2), { kind: 'answer', topic: 'how' });
  assert.deepEqual(v('how does wapay work'), { kind: 'answer', topic: 'how' });
  assert.deepEqual(v(AD_QUESTIONS.Q3), { kind: 'answer', topic: 'fees' });
  assert.deepEqual(v('is it free?'), { kind: 'answer', topic: 'fees' });
  assert.deepEqual(v(AD_QUESTIONS.Q4), { kind: 'answer', topic: 'about' });
  assert.deepEqual(v('What is WaPay?'), { kind: 'answer', topic: 'about' });
  assert.deepEqual(v('can I buy airtime'), { kind: 'answer', topic: 'vas' });
  assert.deepEqual(v('how do I get my money out'), { kind: 'answer', topic: 'moneyOut' });
  assert.deepEqual(v('can I deposit cash'), { kind: 'answer', topic: 'cashIn' });
  assert.deepEqual(v('can I get a loan'), { kind: 'answer', topic: 'loans' }, 'the ad flow\'s own no');
  assert.deepEqual(v('hello'), { kind: 'greet' });
  assert.deepEqual(v('forgot my pin'), { kind: 'page', href: '/app/forgot-pin' });
  // Trouble, or wanting a person: the support address, said on this screen.
  for (const t of ['can I talk to a person', 'I have a problem', 'it didnt go through', 'support']) assert.deepEqual(v(t), { kind: 'support' }, t);
  assert.deepEqual(v('thanks'), { kind: 'thanks' });
  assert.deepEqual(v('home'), { kind: 'home' });
  // What it does not understand gets the plain fallback: never the "about" answer, never a yes.
  for (const t of ['tell me a joke about cats', 'what is the weather', 'can I bet on wapay', 'is this a scam', 'no problem']) assert.deepEqual(v(t), { kind: 'unknown' }, t);
  assert.deepEqual(v('   '), { kind: 'empty' });
});

test('a member: everyday words open the page or the card that already exists, and nothing starts a payment', () => {
  const m = (t) => routeMessage(t, { authed: true });
  assert.deepEqual(m('balance'), { kind: 'card', card: 'balance' });
  assert.deepEqual(m('bal'), { kind: 'card', card: 'balance' });
  assert.deepEqual(m('How much do I have?'), { kind: 'card', card: 'balance' });
  assert.deepEqual(m('where is my money'), { kind: 'card', card: 'balance' });
  assert.deepEqual(m('how much does it cost'), { kind: 'answer', topic: 'fees' }, 'a fee question before a balance question');
  assert.deepEqual(m('is it free'), { kind: 'answer', topic: 'fees' });
  assert.deepEqual(m('what does a pay out cost'), { kind: 'answer', topic: 'feesPayout' }, 'a fee question never opens the pay-out form');
  assert.deepEqual(m('top up fee'), { kind: 'answer', topic: 'feesTopup' });
  assert.deepEqual(m('recent transactions'), { kind: 'card', card: 'recent' });
  assert.deepEqual(m('did my payment arrive'), { kind: 'card', card: 'recent' });
  // Asking where a pay-out is must never open a second pay-out (review 2026-11-24).
  for (const t of ['where is my pay out', 'when will my pay out arrive', 'has my pay out landed', 'my money didnt arrive', 'status']) assert.deepEqual(m(t), { kind: 'card', card: 'recent' }, t);
  assert.deepEqual(m('my links'), { kind: 'card', card: 'links' });
  for (const t of ['did someone pay me', 'has Thandi paid', 'did Sipho pay', 'who paid me']) assert.deepEqual(m(t), { kind: 'card', card: 'links' }, `${t}: asking who paid is not asking for a new link`);
  assert.deepEqual(m('make a link for R200'), { kind: 'page', href: '/app/get-paid' }, 'making a link before listing links');
  assert.deepEqual(m('Sipho owes me R200 for the tyres'), { kind: 'page', href: '/app/get-paid' });
  assert.deepEqual(m('pay me R200'), { kind: 'page', href: '/app/get-paid' }, '"pay me" is read before a bare "pay"');
  assert.deepEqual(m('how do people pay me'), { kind: 'answer', topic: 'payMethods' }, 'a question about ways to pay is not a request for a new link');
  assert.deepEqual(m('pay out'), { kind: 'page', href: '/app/pay-out' });
  assert.deepEqual(m('withdraw R200'), { kind: 'page', href: '/app/pay-out' });
  assert.deepEqual(m('request a pay out'), { kind: 'page', href: '/app/pay-out' });
  assert.deepEqual(m('how do I get my money'), { kind: 'page', href: '/app/pay-out' });
  assert.deepEqual(m('top up'), { kind: 'page', href: '/app/top-up' });
  assert.deepEqual(m('send R50 to 082 123 4567'), { kind: 'page', href: '/app/send' });
  assert.deepEqual(m('pay Sipho R50'), { kind: 'page', href: '/app/send' });
  assert.deepEqual(m('082 123 4567'), { kind: 'page', href: '/app/send' }, 'a number alone means paying that person: the Send screen asks for it');
  assert.deepEqual(m('pay PRDEMOEF'), { kind: 'paylink', code: 'PRDEMOEF' }, 'a pay code is a link to pay, not a person to send to');
  assert.deepEqual(m('I have a link to pay'), { kind: 'paylink-ask' });
  assert.deepEqual(m('change my pin'), { kind: 'page', href: '/app/profile' });
  assert.deepEqual(m('forgot my pin'), { kind: 'page', href: '/app/forgot-pin' });
  assert.deepEqual(m('help'), { kind: 'page', href: '/app/help' });
  assert.deepEqual(m('airtime'), { kind: 'vas', product: 'AIRTIME' });
  assert.deepEqual(m('buy electricity'), { kind: 'vas', product: 'ELECTRICITY' });
  assert.deepEqual(m('can I get a loan'), { kind: 'answer', topic: 'loans' });
  assert.deepEqual(m('log out'), { kind: 'logout' });
  assert.deepEqual(m('home'), { kind: 'home' });
  // Trouble is read before any action, and "no problem" is not trouble.
  for (const t of ['I have a problem with my request', 'talk to a person', 'refund', 'it didnt go through']) assert.deepEqual(m(t), { kind: 'page', href: '/app/help' }, t);
  for (const t of ['no problem', 'problem solved', 'what is the weather']) assert.deepEqual(m(t), { kind: 'unknown' }, t);
  assert.deepEqual(m('thank you'), { kind: 'thanks' });
  // Every page it can open is one of the app's own screens, and no result carries the typed amount or number.
  for (const t of ['pay out', 'send R50 to 082 123 4567', 'top up R100', 'make a link for R200', 'profile', 'help']) {
    const r = m(t);
    assert.match(r.href, /^\/app\/(get-paid|pay-out|top-up|send|profile|help|forgot-pin)$/);
    assert.deepEqual(Object.keys(r).sort(), ['href', 'kind']);
  }
});

test('a return address after log-in is one of the app\'s own pages, never the log-in page, another site or a path that climbs out', () => {
  for (const ok of ['/app', '/app/pay-out', '/app/links?x=1']) assert.equal(safeNext(ok), ok);
  for (const bad of ['/app/login', '/app/login?next=/app', '/app/LOGIN', '//evil.example', 'https://evil.example', '/app/../admin', '/admin', '/apple', '/app/pay/out', '/app\\evil', '/app/pay-out#x', '/app/pay-out?next=//evil.example', 'javascript:alert(1)', '', undefined, null, ['/app/pay-out'], { href: '/app' }]) {
    assert.equal(safeNext(bad), '/app', JSON.stringify(bad));
  }
  // The landing screen has no check of its own to drift from this one.
  assert.ok(!/const safeNext\b/.test(landing));
  assert.match(landing, /import \{ BAD_CELL_LINE, SECRET_LINE, greetingFor, payLinkCodeOf, routeMessage, safeNext \} from '\.\.\/\.\.\/lib\/app-chat-router\.js';/);
});

test('the greeting follows South African time, with the first name when there is one', () => {
  assert.equal(greetingFor(new Date('2026-11-24T03:00:00Z'), 'Thandi'), 'Good morning, Thandi'); // 05:00 SAST
  assert.equal(greetingFor(new Date('2026-11-24T09:59:00Z'), 'Thandi'), 'Good morning, Thandi'); // 11:59
  assert.equal(greetingFor(new Date('2026-11-24T10:00:00Z'), 'Thandi'), 'Good afternoon, Thandi'); // 12:00
  assert.equal(greetingFor(new Date('2026-11-24T15:59:00Z')), 'Good afternoon'); // 17:59, no name on file
  assert.equal(greetingFor(new Date('2026-11-24T16:00:00Z'), 'Thandi'), 'Good evening, Thandi'); // 18:00
  assert.equal(greetingFor(new Date('2026-11-24T02:59:00Z'), ''), 'Good evening'); // 04:59
});

// ---------------------------------------------------------------------------
// What the screen says about WaPay
// ---------------------------------------------------------------------------

/** Every sentence written into a source file: quoted strings and the text between tags, with a space in them. */
function sentencesIn(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');
  const found = [...code.matchAll(/'((?:[^'\\\n]|\\.){12,})'|"([^"\n]{12,})"|>([^<>{}\n]{12,})</g)].map((m) => (m[1] || m[2] || m[3]).trim());
  return found.filter((t) => /[A-Za-z]{3,} [A-Za-z]{2,}/.test(t) && !/^[.\/@]|=>|\)\s*[;{]|className|\$\{/.test(t));
}

test('the guide: what a visitor reads is the ad flow\'s own and keeps to its word rules; opening an account is the person\'s own WhatsApp', () => {
  const g = guideView({});
  assert.deepEqual(Object.keys(g).sort(), ['chat', 'fallback', 'line', 'locked', 'member', 'memberFallback', 'open', 'payLink', 'support', 'visitor']);
  const visitorReads = [g.line, g.fallback, g.open.line, g.open.label, g.chat.label, g.support, g.payLink, g.locked, ...Object.values(g.visitor)];
  assert.ok(visitorReads.length >= 16);
  // A member also gets the chat's own two fee lines (lib/fee-facts.js), which use the chat's member wording; everything else keeps the visitor rule.
  const { feesPayout, feesTopup, ...memberRest } = g.member;
  for (const s of [...visitorReads, g.memberFallback, ...Object.values(memberRest)]) {
    assert.ok(typeof s === 'string' && s.length > 5, 'a real line');
    assert.deepEqual(copyViolations(s), [], s.slice(0, 90));
    assert.ok(!/\*/.test(s), 'no chat formatting on a web page');
  }
  for (const s of [feesPayout, feesTopup]) assert.ok(typeof s === 'string' && s.length > 20 && !/[*—]/.test(s) && !/\p{Extended_Pictographic}/u.test(s), 'a plain line, no chat formatting');
  assert.deepEqual(Object.keys(g.visitor).sort(), ['about', 'cashIn', 'fees', 'how', 'loans', 'moneyOut', 'payMethods', 'paySomeone', 'vas']);
  assert.equal(g.line, GUIDE_LINE);
  // The one line under the welcome is the clause the ad flow's own answer uses, so the two cannot drift.
  assert.ok(adEntryReply('FAQ_VAS', { hasAccount: true }).text.toLowerCase().includes(GUIDE_LINE.toLowerCase().replace(/\.$/, '')));
  // A visitor's answer is the ad flow's, minus the chat's own onboarding ending, plus how an account is opened from the web.
  for (const [topic, said] of Object.entries(g.visitor)) if (topic !== 'loans') assert.ok(said.endsWith(`\n\n${g.open.line}`), topic);
  assert.ok(g.visitor.how.startsWith('It works like this:'));
  assert.ok(!/this phone|three quick steps|Let's open your account/i.test(JSON.stringify(g)), 'the chat\'s own onboarding wording does not reach the web');
  assert.equal(g.member.moneyOut, adEntryReply('FAQ_MONEY_OUT', { hasAccount: true }).text);
  assert.match(g.visitor.fees, /costs you R\d/, 'the fee example is worked out from the live fee table');
  assert.ok(!/Just tell me/.test(g.member.paySomeone), "the chat's own instruction does not reach the web");
  // The fallback offers what the screen can do and affirms nothing; a loan ask gets the ad flow's own no.
  assert.match(g.fallback, /^I can tell you what WaPay is, what it costs, and how to open an account or log in\./);
  assert.ok(!/\byes\b|you can (get|bet|borrow)/i.test(g.fallback));
  assert.match(g.visitor.loans, /^WaPay doesn't offer loans\./);
  assert.match(g.support, /^E-mail \S+@\S+ with your cell number\. Never send your PIN\.$/);
  assert.equal(g.open.url, `https://wa.me/27760497624?text=${encodeURIComponent(AD_QUESTIONS.Q1)}`, 'the customer writes first, with the ad flow\'s first question');
  assert.equal(guideView({ WAPAY_WA_NUMBER: '+27 60 000 0000' }).open.url.split('?')[0], 'https://wa.me/27600000000');
  // A switched-on tile points at the person's own WhatsApp with nothing typed for them: the customer writes first.
  assert.equal(g.chat.url, 'https://wa.me/27760497624');
  assert.match(landing, /tile\?\.live \? \{ actions: \['chat'\] \} : \{\}/);
  assert.match(landing, /it\.actions\?\.includes\('chat'\) && guide\?\.chat \? <a className="btn" href=\{guide\.chat\.url\} target="_blank" rel="noopener noreferrer">/);
  // The page takes its words about WaPay from the guide, never from text typed into the component,
  // and every sentence that is written into the screen or the offline page keeps the same word rules.
  assert.ok(!/get paid by anyone|pay other WaPay users|coming soon/i.test(landing), 'no product wording in the page');
  const written = [...sentencesIn(landing), ...sentencesIn(read('../public/app-sw.js').replace(/<style>[\s\S]*?<\/style>/, ''))];
  assert.ok(written.length >= 25 && written.includes('Welcome to WaPay') && written.some((t) => t.startsWith('WaPay needs a connection')), 'the scanner finds the screen\'s sentences');
  for (const t of written) assert.deepEqual(copyViolations(t), [], t);
});

test('the guide route answers anyone, carries no customer data, and takes nothing in', async () => {
  const deps = createFixtureDeps();
  const mk = () => ({ statusCode: 200, headers: {}, body: undefined, setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  const handler = createGuideHandler(deps);
  const res = mk();
  await handler({ method: 'GET', headers: { host: 'app.wapay.co.za' }, query: {}, socket: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['guide', 'ok']);
  assert.deepEqual(Object.keys(res.body.guide).sort(), ['chat', 'fallback', 'line', 'locked', 'member', 'memberFallback', 'open', 'payLink', 'support', 'visitor']);
  assert.match(res.headers['cache-control'], /no-store/);
  const post = mk();
  await handler({ method: 'POST', headers: { host: 'app.wapay.co.za' }, body: { text: '2580' }, query: {}, socket: {} }, post);
  assert.equal(post.statusCode, 405, 'nothing can be posted to it');
  const src = read('../pages/api/app/guide.js');
  assert.ok(!/deps\.prisma|requireAppSession|req\.body|req\.query/.test(src), 'no session, no database, no input');
});

// ---------------------------------------------------------------------------
// The screen, the menu, the look
// ---------------------------------------------------------------------------

test('one screen for everyone: /app and /app/login are the same landing screen, and the old addresses keep working', () => {
  assert.match(read('../pages/app/index.js'), /return <Landing \/>;/);
  assert.match(read('../pages/app/login.js'), /return <Landing mode="login" \/>;/);
  assert.match(read('../components/app/Shell.js'), /router\.replace\(`\/app\/login\?next=\$\{encodeURIComponent\(router\.asPath \|\| '\/app'\)\}`\)/, 'an ended session still comes back through the log-in step');
  assert.match(landing, /<Shell title=\{authed \? 'Chat' : 'Welcome'\} tab="chat" auth=\{false\} locked=\{!authed\} onLocked=\{lockedTap\} onSame=\{goHome\}>/);
  assert.match(landing, /const placeholder = authed \? 'Ask WaPay anything' : 'Your cell number';/);
  assert.match(landing, /placeholder=\{placeholder\} aria-label=\{placeholder\}/, 'the box is named for a screen reader by what it asks for');
  // The newest answer, or the log-in step, is brought to the top of what can be seen; any other step puts the log-in step away;
  // and there is always a way back to the first view (review 2026-11-24).
  assert.match(landing, /if \(thread\.length \|\| login\) lastRef\.current\?\.scrollIntoView\(\{ block: 'start' \}\);/);
  assert.match(landing, /if \(r\.kind !== 'cell' && r\.kind !== 'login'\) setLogin\(null\);/);
  assert.match(landing, /const goHome = \(\) => \{ setMenu\(false\); setThread\(\[\]\); setLogin\(null\); \};/);
  assert.match(landing, /if \(r\.kind === 'home'\) \{ goHome\(\); return; \}/);
  // No connection is said as no connection, with a way to try again; what WaPay says is fetched again when it was missed.
  assert.match(landing, /\{cfg\.offline \? \(\n\s+<Notice tone="warn">\n\s+No connection\. Check your data or Wi-Fi\./);
  assert.match(landing, /const g = guide \|\| \(await loadGuide\(\)\);/);
  // "Not now" puts the install hint away for this visit only; "Got it" and a finished prompt are remembered.
  assert.match(landing, /const dismissInstall = \(remember\) => \{ if \(remember\) keep\.set\(INSTALL_KEY, '1'\); setInstall\(null\); \};/);
  assert.match(landing, /onClick=\{\(\) => dismissInstall\(install\.kind === 'ios'\)\}/);
  assert.match(landing, /src="\/brand\/wapay-mark-256\.png"/, 'the real W-mark');
  assert.match(landing, /greetingFor\(new Date\(\), cfg\?\.me\?\.firstName\)/);
  // A balance that could not be read is never shown as an amount.
  assert.match(landing, /homeFailed \? 'Balance unavailable\. Tap to try again' : 'Loading your balance'/);
  // "Open an account" is a link the person follows themselves, to their own WhatsApp.
  assert.match(landing, /href=\{guide\.open\.url\} target="_blank" rel="noopener noreferrer"/);
});

test('the pill menu is Chat, Pay, Activity, Profile; for a visitor everything but Chat is a greyed button that says why', () => {
  const shell = read('../components/app/Shell.js');
  const tabs = [...shell.matchAll(/\{ key: '(\w+)', href: '([^']+)', label: '(\w+)'/g)].map((m) => `${m[1]}:${m[2]}:${m[3]}`);
  assert.deepEqual(tabs, ['chat:/app:Chat', 'pay:/app/pay:Pay', 'activity:/app/activity:Activity', 'profile:/app/profile:Profile']);
  assert.match(shell, /locked && t\.key !== 'chat' \? \(\s*<button key=\{t\.key\} type="button" className="locked" aria-disabled="true" onClick=\{\(\) => onLocked && onLocked\(t\)\}>/);
  assert.match(landing, /const lockedTap = async \(\) => \{\n[^\n]*\n\s+setLogin\(null\);\n\s+const g = guide \|\| \(await loadGuide\(\)\);\n\s+say\(g\?\.locked, \{ actions: \['open', 'login'\] \}\);\n\s+\};/, 'the line is said with the log-in step put away, so it is never hidden above it');
  // Pressing the tab you are on comes back to the first view.
  assert.match(shell, /onClick=\{tab === t\.key && onSame \? \(\) => onSame\(t\) : undefined\}/);
  assert.match(shell, /<Nav tab=\{tab\} locked=\{locked\} onLocked=\{onLocked\} onSame=\{onSame\} \/>/);
  for (const [page, tab] of [['get-paid', 'pay'], ['send', 'pay'], ['pay-out', 'pay'], ['top-up', 'pay'], ['links', 'pay'], ['pay', 'pay'], ['activity', 'activity'], ['profile', 'profile']]) {
    assert.match(read(`../pages/app/${page}.js`), new RegExp(`<Shell title="[^"]+" tab="${tab}">`), `${page} lights ${tab}`);
  }
  assert.match(read('../pages/app/pay.js'), /tiles\.map\(\(t\) => \(/, 'the coming-soon tiles moved to the Pay page');
});

test('the slide-over menu: every place in the app on one panel, hidden while closed, and it makes no request of its own', () => {
  const drawer = read('../components/app/Drawer.js');
  // It shows what it is given and calls back: no request, no storage, no wording about WaPay.
  assert.ok(!/\bapi\(|\bfetch\(|localStorage|sessionStorage|document\.cookie|console\./.test(drawer));
  assert.ok(!/coming soon|get paid|pay out|top up|airtime|account/i.test(drawer.replace(/\/\*[\s\S]*?\*\//g, '')), 'its labels come from the screen that opens it');
  for (const t of sentencesIn(drawer)) assert.deepEqual(copyViolations(t), [], t);
  assert.match(drawer, /<div ref=\{sheet\} id="app-menu" className="sheet" role="dialog" aria-modal="true" aria-label="Menu" tabIndex=\{-1\}/);
  // An item closes the menu and then does its job, both, in that order; a link closes it too.
  assert.match(drawer, /<button type="button" className=\{tone\} onClick=\{\(\) => \{ onClose\(\); item\.onClick\(\); \}\}>/);
  assert.match(drawer, /<Link href=\{item\.href\} className=\{tone\} onClick=\{onClose\}>/);
  // Open: the screen behind is inert, the keyboard is in the panel, Escape closes it from anywhere.
  const effect = drawer.slice(drawer.indexOf('useEffect(() => {'), drawer.indexOf('const onKeyDown ='));
  assert.match(effect, /behind\.forEach\(\(el\) => el\.setAttribute\('inert', ''\)\);/);
  assert.match(effect, /document\.querySelector\('nav\[aria-label="Main"\]'\)/, 'the pill menu behind it too');
  assert.match(effect, /const onEscape = \(e\) => \{ if \(e\.key === 'Escape'\) onClose\(\); \};\n\s+document\.addEventListener\('keydown', onEscape\);\n\s+sheet\.current\?\.focus\(\);/);
  // Closed: all three undone, in an order that lets the menu button take the keyboard (never the message box).
  const undo = effect.slice(effect.indexOf('return () => {'));
  const inertOff = undo.indexOf("behind.forEach((el) => el.removeAttribute('inert'));");
  assert.ok(undo.indexOf("document.removeEventListener('keydown', onEscape);") > 0 && inertOff > 0 && inertOff < undo.indexOf('opener?.current?.focus();'));
  assert.ok(!/before\.focus\(\)|activeElement;\n\s+sheet/.test(drawer), 'it never hands the keyboard back to whatever had it');
  assert.match(drawer, /if \(e\.shiftKey && \(document\.activeElement === first \|\| document\.activeElement === sheet\.current\)\) \{ e\.preventDefault\(\); last\.focus\(\); \}/, 'Tab stays inside');
  assert.match(drawer, /className="scrim" aria-hidden="true" tabIndex=\{-1\} onClick=\{onClose\}/, 'a tap beside it closes it');
  assert.match(drawer, /if \(from\.x - t\.clientX > 60 && Math\.abs\(t\.clientY - from\.y\) < 60\) onClose\(\);/, 'a swipe to the left closes it');
  assert.match(drawer, /src="\/brand\/wapay-mark-256\.png"/, 'the real W-mark');
  // Closed means out of sight, out of the keyboard's way and out of a screen reader; it slides, with rounded edges, unless the phone asks for no motion.
  const kit = read('../components/app/kit.js');
  assert.match(kit, /\.drawer\{[^}]*visibility:hidden[^}]*\}\n\.drawer\.open\{visibility:visible;transition:none\}\n\.drawer:not\(\.open\)\{pointer-events:none\}/, 'out of sight, and it takes no tap while it slides away');
  assert.match(kit, /\.sheet\{[^}]*border-radius:0 28px 28px 0[^}]*transform:translateX\(-104%\)[^}]*transition:transform[^}]*\}\n\.drawer\.open \.sheet\{transform:translateX\(0\)\}/);
  assert.match(kit, /@media \(prefers-reduced-motion:reduce\)\{\.drawer,\.sheet,\.scrim\{transition:none\}\}/);
  assert.equal((kit.match(/--scrim:/g) || []).length, 2, 'the shade behind it has a light and a dark value');
  // The landing screen fills it: every address is one of the app's own pages.
  assert.match(landing, /<Drawer open=\{menu\} onClose=\{\(\) => setMenu\(false\)\}[^\n]* opener=\{menuBtn\} \/>/);
  assert.match(landing, /<button ref=\{menuBtn\} type="button" className="round" aria-label="Menu" aria-expanded=\{menu\} aria-controls="app-menu" onClick=\{\(\) => setMenu\(true\)\}>/);
  assert.ok(!/className="menu"/.test(landing), 'the small pop-up menu is gone');
  const lists = landing.slice(landing.indexOf('// The slide-over menu'), landing.indexOf('const chatting ='));
  const hrefs = [...lists.matchAll(/\bhref:\s*([^,}]+)/g)].map((m) => m[1].trim());
  assert.deepEqual([...new Set(hrefs)].sort(), ["'/app/activity'", "'/app/get-paid'", "'/app/help'", "'/app/links'", "'/app/pay-out'", "'/app/profile'", "'/app/send'", "'/app/top-up'"], 'every address is a plain literal naming one of the app\'s own pages');
  // A question row asks for a topic the guide really has, and shows its own label as the question.
  const asked = [...lists.matchAll(/\.\.\.ask\('(\w+)', '([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(asked, ['about', 'how', 'fees', 'vas']);
  for (const topic of asked) assert.ok(typeof guideView({}).visitor[topic] === 'string', `the guide answers ${topic}`);
  assert.match(lists, /const ask = \(topic, label\) => \(\{ label, onClick: \(\) => \{ push\(\{ who: 'me', text: label \}\); act\(\{ kind: 'answer', topic \}\); \} \}\);/);
  // A member's "Buy" rows are the server's own tiles (the launch switches decide what each says); a tap answers in the thread and buys nothing.
  assert.match(lists, /\(home\?\.tiles \|\| \[\]\)\.map\(\(t\) => \(\{ key: t\.id, label: t\.label, icon: t\.icon, note: t\.note, dim: !t\.live, onClick: \(\) => act\(\{ kind: 'vas', product: t\.id \}\) \}\)\)/);
  // Someone not signed in sees a member's places greyed, with no address: a tap says to log in or open an account first.
  assert.match(lists, /\.map\(\(\{ href, \.\.\.item \}\) => \(\{ \.\.\.item, dim: true, onClick: lockedTap \}\)\)/);
  assert.match(lists, /const menuFoot = authed \? \[help, \{ key: 'logout', label: 'Log out', icon: 'out', onClick: logout \}\] : \[help\];/);
});

test('every colour is a variable with a dark set: the app follows the phone', () => {
  const kit = read('../components/app/kit.js');
  const css = kit.slice(kit.indexOf('export const CSS = `'));
  const light = css.match(/:root\{([^}]+)\}/)[1];
  const dark = css.match(/@media \(prefers-color-scheme:dark\)\{:root\{([^}]+)\}\}/)[1];
  assert.match(light, /color-scheme:light dark/);
  assert.match(light, /--green:#359853/, 'the brand green');
  for (const token of ['--ink', '--grey', '--line', '--outer', '--page', '--card', '--field', '--soft', '--amber', '--amber-bg', '--red', '--red-bg', '--blue', '--blue-bg', '--green-soft', '--green-text']) {
    assert.ok(new RegExp(`${token}:`).test(light), `${token} in the light set`);
    assert.ok(new RegExp(`${token}:`).test(dark), `${token} in the dark set`);
  }
  // After the two sets, no rule names a colour of its own (the select arrow's grey reads on both).
  const rules = css.slice(css.indexOf('*{box-sizing'));
  assert.deepEqual([...new Set(rules.match(/#[0-9A-Fa-f]{3,8}\b/g) || [])], ['#6B7280']);
  assert.ok(!/:\s*(white|black)\b/.test(rules), 'no named colour either');
  const shell = read('../components/app/Shell.js');
  assert.match(shell, /<meta name="theme-color" content="#F4F6F8" media="\(prefers-color-scheme: light\)" \/>/);
  assert.match(shell, /<meta name="theme-color" content="#0E100F" media="\(prefers-color-scheme: dark\)" \/>/);
  // No page of the app paints a colour of its own either.
  for (const page of ['activity', 'forgot-pin', 'get-paid', 'help', 'index', 'links', 'login', 'pay', 'pay-out', 'profile', 'send', 'top-up']) {
    assert.ok(!/#[0-9A-Fa-f]{6}\b/.test(read(`../pages/app/${page}.js`)), `${page}: colours come from the variables`);
  }
  assert.ok(!/#[0-9A-Fa-f]{6}\b/.test(landing));
});

// ---------------------------------------------------------------------------
// The install
// ---------------------------------------------------------------------------

const pngSize = (file) => {
  const b = readFileSync(path(file));
  assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG', `${file} is a PNG`);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
};

test('the manifest: the app opens at /app, full screen, with icons cut from the brand master', () => {
  const m = JSON.parse(read('../public/manifest.webmanifest'));
  assert.equal(m.name, 'WaPay');
  assert.equal(m.start_url, '/app');
  assert.equal(m.scope, '/app');
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#F4F6F8', 'the bar above the installed app takes the page colour, as the pages\' own theme-color does');
  assert.equal(m.background_color, '#F4F6F8');
  assert.deepEqual(copyViolations(m.description), []);
  assert.deepEqual(m.icons.map((i) => `${i.sizes}:${i.purpose}`), ['192x192:any', '512x512:any', '512x512:maskable']);
  for (const icon of m.icons) {
    assert.ok(existsSync(path(`../public${icon.src}`)), icon.src);
    assert.equal(pngSize(`../public${icon.src}`), icon.sizes);
  }
  assert.equal(pngSize('../public/brand/app-icon-180.png'), '180x180');
  const shell = read('../components/app/Shell.js');
  assert.match(shell, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
  assert.match(shell, /<link rel="apple-touch-icon" href="\/brand\/app-icon-180\.png" \/>/);
  // The icons are cut from the master by a script, never redrawn.
  const make = read('../marketing/brand/make-app-icons.py');
  assert.match(make, /wapay-logo-1024\.png/);
  assert.ok(!/ImageDraw|\.polygon\(|\.ellipse\(|\.line\(/.test(make), 'nothing is drawn');
});

test('the service worker stores nothing, answers page loads only, and never handles /api/', () => {
  const sw = read('../public/app-sw.js');
  const code = sw.slice(sw.indexOf("self.addEventListener('install'"));
  assert.ok(!/\bcaches\b|\bcache\.(put|add|addAll)\b|indexedDB|localStorage/.test(code), 'no cache and no storage of any kind');
  const fetchHandler = code.slice(code.indexOf("self.addEventListener('fetch'"));
  const guardAt = fetchHandler.indexOf("if (request.method !== 'GET' || request.mode !== 'navigate') return;");
  const apiAt = fetchHandler.indexOf("url.pathname.startsWith('/api/')) return;");
  assert.ok(guardAt > 0 && apiAt > guardAt && apiAt < fetchHandler.indexOf('event.respondWith('), 'page loads only, never /api/, both before any answer');
  assert.match(fetchHandler, /url\.origin !== self\.location\.origin \|\|/);
  assert.equal((code.match(/respondWith\(/g) || []).length, 1);
  assert.ok(!/postMessage|importScripts|push|sync/.test(code), 'no messages, no imported code, no push');
  // The offline screen: no amount, no customer data, the same framing rules as the app.
  const offline = sw.slice(sw.indexOf('const OFFLINE_PAGE = `'), sw.indexOf("self.addEventListener('install'"));
  assert.match(offline, /<h1>No connection<\/h1>/);
  assert.ok(!/R\d|\$\{/.test(offline), 'no amount and nothing filled in');
  // It cannot know what did or did not happen in the account, so it never says (review 2026-11-24).
  assert.ok(!/nothing has changed|no money (has )?(moved|left)|your money is safe|was not (sent|paid)/i.test(offline));
  assert.match(offline, /look at Activity before you try it again/);
  assert.match(code, /'X-Frame-Options': 'DENY'/);
  assert.match(code, /'Cache-Control': 'no-store'/);
  assert.ok(!sw.includes('—'));
  // Registered for /app only, and only in a production build.
  const shell = read('../components/app/Shell.js');
  assert.match(shell, /if \(process\.env\.NODE_ENV !== 'production' \|\| typeof navigator === 'undefined' \|\| !\('serviceWorker' in navigator\)\) return;\n\s+navigator\.serviceWorker\.register\('\/app-sw\.js', \{ scope: '\/app' \}\)/);
  // The security headers of the app's pages are untouched.
  const cfg = read('../next.config.js');
  assert.match(cfg, /\{ source: '\/app', headers: app \},\n\s+\{ source: '\/app\/:path\*', headers: app \}/);
  // The worker and the manifest are served as what they are, never guessed to be another type.
  for (const file of ['app-sw\\.js', 'manifest\\.webmanifest']) assert.match(cfg, new RegExp(`\\{ source: '\\/${file}', headers: \\[\\{ key: 'X-Content-Type-Options', value: 'nosniff' \\}\\] \\}`));
});

test('the service worker, run: a failed page load gets the offline screen; an API call, a script, a post and another site are never answered', async () => {
  const vm = await import('node:vm');
  const listeners = {};
  let fetched = 0;
  const self = { addEventListener: (name, fn) => { listeners[name] = fn; }, skipWaiting() {}, clients: { claim: async () => {} }, location: { origin: 'https://app.wapay.co.za' } };
  const sandbox = { self, URL, Response, fetch: async () => { fetched += 1; throw new TypeError('offline'); } };
  vm.runInNewContext(read('../public/app-sw.js'), sandbox);
  assert.deepEqual(Object.keys(listeners).sort(), ['activate', 'fetch', 'install']);
  const ask = (url, { method = 'GET', mode = 'navigate' } = {}) => {
    let answer = null;
    listeners.fetch({ request: { url, method, mode }, respondWith(p) { answer = p; } });
    return answer;
  };
  for (const [url, init] of [
    ['https://app.wapay.co.za/api/app/home', { mode: 'cors' }],
    ['https://app.wapay.co.za/api/app/home', {}],
    ['https://app.wapay.co.za/api/app/auth', { method: 'POST' }],
    ['https://app.wapay.co.za/app', { method: 'POST' }],
    ['https://app.wapay.co.za/_next/static/chunks/main.js', { mode: 'no-cors' }],
    ['https://app.wapay.co.za/brand/wapay-mark-256.png', { mode: 'no-cors' }],
    ['https://www.payfast.co.za/eng/process', {}],
  ]) assert.equal(ask(url, init), null, `left alone: ${init.method || 'GET'} ${url} (${init.mode || 'navigate'})`);
  assert.equal(fetched, 0, 'nothing it leaves alone is fetched by the worker');
  const res = await ask('https://app.wapay.co.za/app/pay-out');
  assert.equal(fetched, 1);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const html = await res.text();
  assert.match(html, /No connection/);
  assert.ok(!/nothing has changed/i.test(html));
  assert.ok(!/R\d/.test(html), 'no amount on the offline screen');
  // When WaPay answers, the worker hands the answer on untouched, whatever its status.
  const live = new Response('page', { status: 500 });
  sandbox.fetch = async () => live;
  assert.equal(await ask('https://app.wapay.co.za/app'), live);
});
