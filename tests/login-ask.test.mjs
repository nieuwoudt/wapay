/**
 * "login" in the chat (lib/login-ask.js, BUGLOG #153): a sign-in question is answered by code from
 * what exists for the sender's own number, and no reply names a command the chat does not handle
 * for the person reading it. The replies are run through the loop guard and through the real
 * matchers of the commands they name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { matchLoginAsk, loginAnswer, noBusinessLoginText, pausedBusinessLoginText } from '../lib/login-ask.js';
import { echoLoop, instructedPhrases } from '../lib/loop-guard.js';
import { matchPinResetAsk } from '../lib/pin-reset.js';
import { matchBusinessSignupAsk } from '../lib/business-chat.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const processor = read('../pages/api/webhooks/message-processor-v2.js');
const HOST = 'app.wapay.co.za';

test('a bare sign-in ask is recognised, in the ways people type it', () => {
  for (const yes of ['login', 'Login', 'LOGIN.', 'log in', 'Log in please', 'sign in', 'Sign-in', 'signin', 'log me in', 'logon',
    'how do I log in', 'How can I login?', 'how do i sign in?', 'I want to log in', 'i need to login', 'can I sign in', 'where do I log in?',
    'login to my account', 'log in to wapay', 'sign in to my WaPay account', 'hi, how do i sign in?', 'please log me in', 'login on the website']) {
    assert.equal(matchLoginAsk(yes), true, yes);
  }
});

test('a sentence that only mentions a login, and the two code commands, are left alone', () => {
  for (const no of ['business login', 'admin login', 'login code', 'portal login', 'business portal', 'wapay business login',
    'the login page shows an error', "I can't log in, it says wrong PIN", 'login 1234', 'my login is not working since yesterday and I need help with it now',
    'log', 'sign', 'in', 'balance', 'withdraw R100', 'send R50 to 0830000000', 'help', '', '   ', null, undefined,
    'is the login safe?', 'did someone log in to my account?', 'I logged in but the balance is wrong']) {
    assert.equal(matchLoginAsk(no), false, String(no));
  }
});

test('the answer says the chat is the account, names the web portal, and offers a business code only to a business', () => {
  const plain = loginAnswer({ appHost: HOST, hasBusiness: false });
  assert.match(plain, /already signed in here/);
  assert.match(plain, /app\.wapay\.co\.za/);
  assert.match(plain, /cell number and your WaPay PIN/);
  assert.match(plain, /\*forgot PIN\*/);
  assert.ok(!/business login/i.test(plain), 'a number with no business is never told to say "business login"');
  assert.ok(!/business/i.test(plain));

  const owner = loginAnswer({ appHost: HOST, hasBusiness: true });
  assert.match(owner, /\*business login\*/);
  assert.match(owner, /app\.wapay\.co\.za/);

  const noWeb = loginAnswer({ appHost: '', hasBusiness: false });
  assert.ok(!/browser/.test(noWeb), 'no web line when the portal is switched off');
  assert.match(noWeb, /already signed in here/);
  assert.deepEqual(loginAnswer(), noWeb, 'defaults name nothing that may not exist');
});

test('"business login" from a number with no business is answered plainly, about that number only', () => {
  const t = noBusinessLoginText({ appHost: HOST });
  assert.match(t, /no WaPay for Business account on this number/);
  assert.match(t, /\*business account\*/);
  assert.match(t, /app\.wapay\.co\.za/);
  assert.ok(!/\*business login\*/.test(t), 'it never asks for the words again');
  const paused = pausedBusinessLoginText({ supportEmail: 'help@wapay.co.za' });
  assert.match(paused, /paused/); assert.match(paused, /help@wapay\.co\.za/);
  assert.ok(!/person will/.test(pausedBusinessLoginText()), 'no promise of a person without somewhere to write');
});

test('every command a reply names is one the chat handles for the reader', () => {
  const handled = {
    'forgot PIN': (p) => matchPinResetAsk(p),
    'business account': (p) => matchBusinessSignupAsk(p),
    // Named only by loginAnswer({ hasBusiness: true }); the owner's code is issued by handleBusinessLoginAsk.
    'business login': (p) => /^business login$/.test(p),
  };
  const replies = {
    plain: loginAnswer({ appHost: HOST, hasBusiness: false }),
    owner: loginAnswer({ appHost: HOST, hasBusiness: true }),
    noBusiness: noBusinessLoginText({ appHost: HOST }),
    paused: pausedBusinessLoginText({ supportEmail: 'help@wapay.co.za' }),
  };
  for (const [name, reply] of Object.entries(replies)) {
    for (const phrase of instructedPhrases(reply)) {
      assert.ok(handled[phrase], `${name} names "${phrase}", which must be on the handled list`);
      assert.equal(handled[phrase](phrase), true, `${name}: "${phrase}" is matched by its own handler`);
    }
  }
  assert.deepEqual(instructedPhrases(replies.plain), ['forgot PIN']);
  assert.deepEqual(instructedPhrases(replies.noBusiness), ['business account']);
  assert.deepEqual(instructedPhrases(replies.owner).sort(), ['business login', 'forgot PIN']);
});

test('the conversation of 18 November cannot loop: neither reply asks for the words the customer just sent', () => {
  // "login" -> the answer; then whatever they type that the answer named is handled by code, and the
  // line a number with no business gets for "business login" does not ask for "business login".
  const first = loginAnswer({ appHost: HOST, hasBusiness: false });
  assert.equal(echoLoop(first, 'login', null), false);
  const second = noBusinessLoginText({ appHost: HOST });
  assert.equal(echoLoop(second, 'business login', first), false);
  assert.equal(echoLoop(second, 'business login', loginAnswer({ appHost: HOST, hasBusiness: true })), false);
  // What the model had said that day is still caught by the guard.
  const modelSaid = 'You’re in. If you mean your WaPay portal, say *business login* for your code.';
  assert.equal(echoLoop(modelSaid, 'business login', modelSaid), true);
});

test('the processor answers sign-in asks by code, before the model and before the Pay agent', () => {
  const hook = processor.indexOf('if (matchLoginAsk(text)) return await handleLoginAsk({ from, account });');
  assert.ok(hook > -1, 'the login hook exists');
  const businessHook = processor.lastIndexOf('if (matchBusinessLoginAsk(text)) {');
  const agent = processor.indexOf('if (agentV3For(from)) {\n    return await handleAgentTurn({ from, text, account, messageId });');
  assert.ok(businessHook > -1 && agent > -1);
  assert.ok(businessHook < hook, '"business login" is tried first, so the bare ask never shadows it');
  assert.ok(hook < agent, 'the hook runs before the Pay agent takes the turn, so pilot numbers get the same answer');

  const handler = processor.slice(processor.indexOf('async function handleLoginAsk('), processor.indexOf('\nfunction matchBusinessLoginAsk'));
  assert.match(handler, /business\?\.status === 'ACTIVE'/, 'a business code is named only for an active business');
  assert.match(handler, /configuredAppHost\(\)/, 'the portal address comes from the setting, never a literal');
  assert.ok(!/sendOpsAlert|opsPersonAlert/.test(handler), 'an answered question raises no alert');
});

test('the feature notes the model reads no longer hand "business login" to everyone', () => {
  const notes = read('../lib/how-it-works.js');
  assert.ok(!/Say "business login" for your portal code any time/.test(notes));
  assert.match(notes, /Once your business is open, "business login" gives you its portal code/);
});
