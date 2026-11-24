/**
 * The app's landing screen and its install (2026-11-24,
 * docs/prompting/prompts/2026-11-24-app-landing-and-install.md).
 *
 * Locks:
 * - the message box never takes a secret: a line shaped like a PIN, an ID or
 *   passport number, or a long digit run that is not a SA cell number is
 *   answered on the page and goes nowhere; the landing screen posts only the
 *   log-in (the PIN from the PIN boxes) and the log-out, and what is typed is
 *   never an argument to a request (docs/GOLDEN_THREAD.md 2.13);
 * - the router: a cell number opens the log-in step, a pay link opens the pay
 *   page, a visitor's question is read as the ad flow reads it, a member's
 *   everyday words open the page or the card that already exists;
 * - what the screen says about WaPay is the ad flow's own answers, served by
 *   /api/app/guide with no session and no customer data, and every string
 *   keeps to the ad flow's word rules (copyViolations);
 * - the pill menu is Chat, Pay, Activity, Profile, locked for a visitor;
 * - every colour is a variable with a dark set, so the app follows the phone;
 * - the install: the manifest, the icons, and a service worker that stores
 *   nothing, answers page loads only and never handles /api/.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.WAPAY_APP_SESSION_SECRET = 'test-app-session-secret-0123456789';

const { routeMessage, secretKind, cellOf, payLinkCodeOf, greetingFor, SECRET_LINE } = await import('../lib/app-chat-router.js');
const { guideView, GUIDE_LINE } = await import('../lib/app-portal.js');
const { copyViolations, adEntryReply, AD_QUESTIONS } = await import('../lib/ad-flow.js');
const { createFixtureDeps } = await import('../lib/app-dev-fixture.js');
const { createGuideHandler } = await import('../pages/api/app/guide.js');

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const read = (p) => readFileSync(path(p), 'utf8');
const landing = read('../components/app/Landing.js');

// ---------------------------------------------------------------------------
// The message box never takes a secret
// ---------------------------------------------------------------------------

test('a PIN, an ID or passport number, or a long digit run is a secret for a visitor and for a member; a cell number and an amount are not', () => {
  const secrets = [
    ['2580', 'pin'], ['123456', 'pin'], ['12 34', 'pin'], ['my pin is 2580', 'pin'], ['PIN: 4321 please', 'pin'],
    ['9001015009087', 'id'], ['900101 5009 087', 'id'], ['my id is 9001015009087', 'id'], ['A12345678', 'id'], ['passport ZN1234567', 'id'],
    ['1234567', 'digits'], ['62123456789', 'digits'], ['account 1234567890 at the bank', 'digits'],
  ];
  for (const [text, reason] of secrets) {
    assert.equal(secretKind(text), reason, text);
    for (const authed of [false, true]) assert.deepEqual(routeMessage(text, { authed }), { kind: 'secret', reason }, `${text} (${authed ? 'member' : 'visitor'})`);
  }
  for (const fine of ['0821234567', '+27 82 123 4567', '27821234567', '082 123 4567', '250', 'R1 500', 'R1,500.50', 'send R50 to 082 123 4567', 'PRDEMOEF', 'hello']) {
    assert.equal(secretKind(fine), null, fine);
  }
  assert.ok(!/\d/.test(SECRET_LINE) && /Nothing was sent/.test(SECRET_LINE));
});

test('the landing screen posts only the log-in and the log-out, and nothing typed in the message box is ever part of a request', () => {
  const calls = [...landing.matchAll(/\bapi\(([^\n]*?)\)(?=[.;)]| )/g)].map((m) => m[1].trim());
  const allowed = new Set([
    "'/api/app/home'",
    "'/api/app/guide'",
    "'/api/app/links'",
    "'/api/app/auth', { method: 'POST', body: { action: 'login', msisdn: cell, pin } }",
    "'/api/app/auth', { method: 'POST', body: { action: 'logout' } }",
  ]);
  assert.ok(calls.length >= 5, `found the calls: ${calls.join(' | ')}`);
  for (const c of calls) assert.ok(allowed.has(c), `an unexpected request from the landing screen: api(${c})`);
  assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(landing), 'no other way out of the page');
  // The log-in's PIN is the PIN boxes' state, never the message box's.
  const loginCard = landing.slice(landing.indexOf('function LoginCard('), landing.indexOf('export default function Landing('));
  assert.match(loginCard, /<PinField value=\{pin\} onChange=\{setPin\}/);
  assert.ok(!/\btext\b|\btyped\b/.test(loginCard), 'the log-in step never reads the message box');
  // In the submit handler the secret branch comes first: it is masked, answered and returned before anything else happens.
  const submit = landing.slice(landing.indexOf('const onSubmit ='), landing.indexOf('const onPlus ='));
  const secretAt = submit.indexOf("if (r.kind === 'secret')");
  assert.ok(secretAt > 0 && secretAt < submit.indexOf("push({ who: 'me', text: typed })") && secretAt < submit.indexOf('act(r)'), 'secret → masked → return, before the line is shown or acted on');
  assert.match(submit, /if \(r\.kind === 'secret'\) \{ push\(\{ who: 'me', text: '•••' \}, \{ who: 'wa', text: SECRET_LINE \}\); return; \}/);
  // Only two things are kept in the browser, and neither is typed text.
  const kept = [...landing.matchAll(/keep\.set\((\w+),/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(kept)].sort(), ['HIDE_KEY', 'INSTALL_KEY']);
  assert.ok(!/sessionStorage|document\.cookie|indexedDB/.test(landing));
  // The router itself is pure.
  assert.ok(!/\bfetch\(|localStorage|document\.|window\.|process\.env/.test(read('../lib/app-chat-router.js')));
});

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

test('a visitor: a cell number opens the log-in step, a pay link opens the pay page, a question is read as the ad flow reads it', () => {
  const v = (t) => routeMessage(t, { authed: false });
  assert.deepEqual(v('082 123 4567'), { kind: 'cell', cell: '0821234567' });
  assert.deepEqual(v('+27821234567'), { kind: 'cell', cell: '0821234567' });
  assert.equal(cellOf('0211234567'), null, 'a landline is not a WaPay cell number');
  assert.deepEqual(v('PRDEMOEF'), { kind: 'paylink', code: 'PRDEMOEF' });
  assert.deepEqual(v('https://pleasepayme.co.za/PRdemoef?s=w'), { kind: 'paylink', code: 'PRDEMOEF' });
  assert.deepEqual(v('wa-pay.me/PRDEMOEF'), { kind: 'paylink', code: 'PRDEMOEF' });
  for (const word of ['problems', 'products', 'practice', 'PRACTICES', 'please']) assert.equal(payLinkCodeOf(word), null, `${word} is a word, not a code`);
  assert.deepEqual(v('log in'), { kind: 'login' });
  assert.deepEqual(v('Sign in please'), { kind: 'login' });
  assert.deepEqual(v('I want to pay a link'), { kind: 'paylink-ask' });
  assert.deepEqual(v(AD_QUESTIONS.Q1), { kind: 'open' });
  assert.deepEqual(v('how do I open an account'), { kind: 'open' });
  assert.deepEqual(v(AD_QUESTIONS.Q2), { kind: 'answer', topic: 'how' });
  assert.deepEqual(v(AD_QUESTIONS.Q3), { kind: 'answer', topic: 'fees' });
  assert.deepEqual(v(AD_QUESTIONS.Q4), { kind: 'answer', topic: 'about' });
  assert.deepEqual(v('What is WaPay?'), { kind: 'answer', topic: 'about' });
  assert.deepEqual(v('can I buy airtime'), { kind: 'answer', topic: 'vas' });
  assert.deepEqual(v('how do I get my money out'), { kind: 'answer', topic: 'moneyOut' });
  assert.deepEqual(v('can I deposit cash'), { kind: 'answer', topic: 'cashIn' });
  assert.deepEqual(v('hello'), { kind: 'greet' });
  assert.deepEqual(v('tell me a joke about cats'), { kind: 'unknown' });
  assert.deepEqual(v('   '), { kind: 'empty' });
});

test('a member: everyday words open the page or the card that already exists, and nothing starts a payment', () => {
  const m = (t) => routeMessage(t, { authed: true });
  assert.deepEqual(m('balance'), { kind: 'card', card: 'balance' });
  assert.deepEqual(m('How much do I have?'), { kind: 'card', card: 'balance' });
  assert.deepEqual(m('how much does it cost'), { kind: 'answer', topic: 'fees' }, 'a fee question before a balance question');
  assert.deepEqual(m('recent transactions'), { kind: 'card', card: 'recent' });
  assert.deepEqual(m('my links'), { kind: 'card', card: 'links' });
  assert.deepEqual(m('make a link for R200'), { kind: 'page', href: '/app/get-paid' }, 'making a link before listing links');
  assert.deepEqual(m('Sipho owes me R200 for the tyres'), { kind: 'page', href: '/app/get-paid' });
  assert.deepEqual(m('pay out'), { kind: 'page', href: '/app/pay-out' });
  assert.deepEqual(m('withdraw R200'), { kind: 'page', href: '/app/pay-out' });
  assert.deepEqual(m('top up'), { kind: 'page', href: '/app/top-up' });
  assert.deepEqual(m('send R50 to 082 123 4567'), { kind: 'page', href: '/app/send' });
  assert.deepEqual(m('082 123 4567'), { kind: 'page', href: '/app/send' }, 'a number alone means paying that person: the Send screen asks for it');
  assert.deepEqual(m('change my pin'), { kind: 'page', href: '/app/profile' });
  assert.deepEqual(m('help'), { kind: 'page', href: '/app/help' });
  assert.deepEqual(m('airtime'), { kind: 'vas', product: 'AIRTIME' });
  assert.deepEqual(m('buy electricity'), { kind: 'vas', product: 'ELECTRICITY' });
  assert.deepEqual(m('log out'), { kind: 'logout' });
  assert.deepEqual(m('what is the weather'), { kind: 'unknown' });
  // Every page it can open is one of the app's own screens, and no result carries the typed amount or number.
  for (const t of ['pay out', 'send R50 to 082 123 4567', 'top up R100', 'make a link for R200', 'profile', 'help']) {
    const r = m(t);
    assert.match(r.href, /^\/app\/(get-paid|pay-out|top-up|send|profile|help)$/);
    assert.deepEqual(Object.keys(r).sort(), ['href', 'kind']);
  }
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

test('the guide: every string is the ad flow\'s own and keeps to its word rules; opening an account is the person\'s own WhatsApp', () => {
  const g = guideView({});
  const strings = [g.line, g.fallback, g.memberFallback, g.open.line, g.open.label, g.login, g.payLink, g.locked, ...Object.values(g.visitor), ...Object.values(g.member)];
  assert.ok(strings.length >= 24);
  for (const s of strings) {
    assert.ok(typeof s === 'string' && s.length > 5, 'a real line');
    assert.deepEqual(copyViolations(s), [], s.slice(0, 90));
    assert.ok(!/\*/.test(s), 'no chat formatting on a web page');
  }
  assert.equal(g.line, GUIDE_LINE);
  // The one line under the welcome is the clause the ad flow's own answer uses, so the two cannot drift.
  assert.ok(adEntryReply('FAQ_VAS', { hasAccount: true }).text.toLowerCase().includes(GUIDE_LINE.toLowerCase().replace(/\.$/, '')));
  assert.equal(g.visitor.how, adEntryReply('Q2', { hasAccount: false }).text);
  assert.equal(g.member.moneyOut, adEntryReply('FAQ_MONEY_OUT', { hasAccount: true }).text);
  assert.match(g.visitor.fees, /costs you R\d/, 'the fee example is worked out from the live fee table');
  assert.ok(!/Just tell me/.test(g.member.paySomeone), "the chat's own instruction does not reach the web");
  assert.equal(g.open.url, `https://wa.me/27760497624?text=${encodeURIComponent(AD_QUESTIONS.Q1)}`, 'the customer writes first, with the ad flow\'s first question');
  assert.equal(guideView({ WAPAY_WA_NUMBER: '+27 60 000 0000' }).open.url.split('?')[0], 'https://wa.me/27600000000');
  // The page takes its words about WaPay from the guide, never from text typed into the component.
  assert.ok(!/get paid by anyone|pay other WaPay users|coming soon/i.test(landing), 'no product wording in the page');
});

test('the guide route answers anyone, carries no customer data, and takes nothing in', async () => {
  const deps = createFixtureDeps();
  const mk = () => ({ statusCode: 200, headers: {}, body: undefined, setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  const handler = createGuideHandler(deps);
  const res = mk();
  await handler({ method: 'GET', headers: { host: 'app.wapay.co.za' }, query: {}, socket: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['guide', 'ok']);
  assert.deepEqual(Object.keys(res.body.guide).sort(), ['fallback', 'line', 'locked', 'login', 'member', 'memberFallback', 'open', 'payLink', 'visitor']);
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
  assert.match(landing, /const safeNext = \(n\) => \(typeof n === 'string' && \/\^\\\/app\(\\\/\[a-z0-9-\]\*\)\?\(\\\?\[\\w=&%\.-\]\*\)\?\$\/i\.test\(n\) \? n : '\/app'\);/, 'a return address is one of the app\'s own pages or nothing');
  assert.match(read('../components/app/Shell.js'), /router\.replace\(`\/app\/login\?next=\$\{encodeURIComponent\(router\.asPath \|\| '\/app'\)\}`\)/, 'an ended session still comes back through the log-in step');
  assert.match(landing, /<Shell title=\{authed \? 'Chat' : 'Welcome'\} tab="chat" auth=\{false\} locked=\{!authed\}/);
  assert.match(landing, /placeholder=\{authed \? 'Ask WaPay anything' : 'Your cell number'\}/);
  assert.match(landing, /src="\/brand\/wapay-mark-256\.png"/, 'the real W-mark');
  assert.match(landing, /greetingFor\(new Date\(\), cfg\?\.me\?\.firstName\)/);
  // A balance that could not be read is never shown as an amount.
  assert.match(landing, /homeFailed \? 'Balance unavailable\. Tap to try again' : 'Loading your balance'/);
  assert.match(landing, /hide \? '••••' : R\(b\.totalCents\)/);
  // "Open an account" is a link the person follows themselves, to their own WhatsApp.
  assert.match(landing, /href=\{guide\.open\.url\} target="_blank" rel="noopener noreferrer"/);
});

test('the pill menu is Chat, Pay, Activity, Profile; for a visitor everything but Chat is a greyed button that says why', () => {
  const shell = read('../components/app/Shell.js');
  const tabs = [...shell.matchAll(/\{ key: '(\w+)', href: '([^']+)', label: '(\w+)'/g)].map((m) => `${m[1]}:${m[2]}:${m[3]}`);
  assert.deepEqual(tabs, ['chat:/app:Chat', 'pay:/app/pay:Pay', 'activity:/app/activity:Activity', 'profile:/app/profile:Profile']);
  assert.match(shell, /locked && t\.key !== 'chat' \? \(\s*<button key=\{t\.key\} type="button" className="locked" aria-disabled="true" onClick=\{\(\) => onLocked && onLocked\(t\)\}>/);
  assert.match(landing, /onLocked=\{\(\) => say\(guide\?\.locked, \{ actions: \['open', 'login'\] \}\)\}/);
  for (const [page, tab] of [['get-paid', 'pay'], ['send', 'pay'], ['pay-out', 'pay'], ['top-up', 'pay'], ['links', 'pay'], ['pay', 'pay'], ['activity', 'activity'], ['profile', 'profile']]) {
    assert.match(read(`../pages/app/${page}.js`), new RegExp(`<Shell title="[^"]+" tab="${tab}">`), `${page} lights ${tab}`);
  }
  assert.match(read('../pages/app/pay.js'), /tiles\.map\(\(t\) => \(/, 'the coming-soon tiles moved to the Pay page');
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
  assert.equal(m.theme_color, '#359853');
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
  assert.match(offline, /You are offline/);
  assert.ok(!/R\d|\$\{/.test(offline), 'no amount and nothing filled in');
  assert.match(code, /'X-Frame-Options': 'DENY'/);
  assert.match(code, /'Cache-Control': 'no-store'/);
  assert.ok(!sw.includes('—'));
  // Registered for /app only, and only in a production build.
  const shell = read('../components/app/Shell.js');
  assert.match(shell, /if \(process\.env\.NODE_ENV !== 'production' \|\| typeof navigator === 'undefined' \|\| !\('serviceWorker' in navigator\)\) return;\n\s+navigator\.serviceWorker\.register\('\/app-sw\.js', \{ scope: '\/app' \}\)/);
  // The security headers of the app's pages are untouched.
  const cfg = read('../next.config.js');
  assert.match(cfg, /\{ source: '\/app', headers: app \},\n\s+\{ source: '\/app\/:path\*', headers: app \}/);
});
