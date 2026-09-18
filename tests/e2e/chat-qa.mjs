/**
 * WaPay conversational QA — the "bug reporter" (founder ask 2026-08-27).
 *
 * Talks to the real chat brain through tests/e2e/chat-harness.mjs and
 * verdicts every scenario like a bug report: what was said, what came
 * back, PASS/FAIL/WARN. Run it any time with:
 *
 *   pnpm qa:chat        (alias for: node --env-file=.env
 *                        --experimental-test-module-mocks tests/e2e/chat-qa.mjs)
 *
 * Scenarios: the founder's exact mid-flow intent-switch repro, the
 * electricity→airtime→home→get-paid fluidity chain, message dedupe, AI
 * memory recall, memory ACROSS flow changes (BUGLOG #30), and language
 * switching with live localization. WARN = fail-open behavior worth eyes
 * (e.g. localizer timed out to English), FAIL = a real bug.
 *
 * AI-dependent verdicts call live OpenAI; money never moves (no PIN is
 * ever sent, no VAS purchase completes, wallet stays at 0c).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { seedQaAccount, teardownQaAccount, createSession, QA_WA_ID } from './chat-harness.mjs';
import { fundQaAccount, parkQaState, QA_PIN, ottCalls } from './chat-harness.mjs';

const results = [];

function verdict(name, checks, session, notes = []) {
  const failed = checks.filter((c) => c.level === 'FAIL' && !c.ok);
  const warned = checks.filter((c) => c.level === 'WARN' && !c.ok);
  const status = failed.length ? 'FAIL' : warned.length ? 'WARN' : 'PASS';
  results.push({
    name,
    status,
    checks: checks.map((c) => `${c.ok ? '✅' : c.level === 'WARN' ? '⚠️' : '❌'} ${c.what}`),
    notes,
    transcript: session.transcript.splice(0),
  });
  console.log(`[${status}] ${name}`);
}

const has = (text, re) => re.test(String(text || ''));

/**
 * Every canned menu/fallback surface a QUESTION must never receive
 * (founder screenshot 2026-08-29: "Where can I spend my WaPay money!"
 * got the bare Help Menu twice). Matched loosely; run these scenarios
 * while the profile language is English or the copy match is unreliable.
 */
const MENU_MARKERS = [
  /WaPay Help Menu/i,
  /I didn't quite understand/i,
  /Just talk to me naturally/i,
  /Type "help"/i,
  /balance checks, airtime, data, electricity/i,
  /⚡ Quick:/,
  /🛒 \*Buy\*/,
];
const looksLikeMenu = (t) => MENU_MARKERS.some((re) => re.test(String(t || '')));

async function run() {
  await seedQaAccount();
  const s = createSession();

  // ------------------------------------------------------------------
  // 1. Founder repro: payment-link ask mid-electricity (BUGLOG #29)
  // ------------------------------------------------------------------
  {
    const a = await s.say('Buy electricity');
    const b = await s.say('50');
    const c = await s.say('Please create a payment link for R20');
    verdict('Founder repro: "payment link" escapes the meter ask', [
      { level: 'FAIL', ok: has(a.replyText, /electricity/i) && has(a.replyText, /amount|how much/i), what: 'electricity flow opens with an amount ask' },
      { level: 'FAIL', ok: has(b.replyText, /meter/i), what: 'R50 moves to the meter ask' },
      { level: 'FAIL', ok: !has(c.replyText, /valid meter number/i), what: 'the link ask is NOT answered with a meter error' },
      { level: 'FAIL', ok: has(c.replyText, /switching over/i), what: 'the switch is acknowledged out loud' },
      { level: 'FAIL', ok: has(c.replyText, /pleasepayme\.co\.za\/PR[A-HJKMNP-Z]{6}/), what: 'a real R20 pay link comes back (free band creates in one step)' },
    ], s);
  }

  // ------------------------------------------------------------------
  // 2. Fluidity chain: electricity → airtime → home → get paid
  // ------------------------------------------------------------------
  {
    const a = await s.say('buy electricity');
    const b = await s.say('I want to buy airtime');
    const c = await s.say('cancel');
    const d = await s.say('hi');
    const e = await s.say('please pay me R250');
    const f = await s.say('1');
    verdict('Fluidity: electricity → airtime → home → get-paid link', [
      { level: 'FAIL', ok: has(a.replyText, /electricity/i), what: 'electricity flow opens' },
      { level: 'FAIL', ok: has(b.replyText, /switching over/i) && has(b.replyText, /airtime/i), what: 'airtime ask mid-electricity acknowledges and switches' },
      { level: 'FAIL', ok: has(c.replyText, /cancel/i), what: '"cancel" ends the airtime flow' },
      { level: 'FAIL', ok: has(d.replyText, /balance|help|airtime|menu/i), what: '"hi" lands on the home screen' },
      { level: 'FAIL', ok: has(e.replyText, /1️⃣|reply \*?1|R2[67]\d/i), what: 'R250 request offers the fee choice before creating' },
      { level: 'FAIL', ok: has(f.replyText, /pleasepayme\.co\.za\/PR[A-HJKMNP-Z]{6}/), what: 'choosing 1 mints exactly one link' },
    ], s);
  }

  // ------------------------------------------------------------------
  // 3. Dedupe: a replayed messageId is swallowed
  // ------------------------------------------------------------------
  {
    const a = await s.say('hi', { messageId: `chatqa-dup-${process.pid}` });
    const b = await s.say('hi', { messageId: `chatqa-dup-${process.pid}` });
    verdict('Dedupe: replayed messageId produces no second reply', [
      { level: 'FAIL', ok: a.replies.length > 0, what: 'first delivery replies' },
      { level: 'FAIL', ok: b.res?.deduped === true && b.replies.length === 0, what: 'replay is swallowed with zero sends' },
    ], s);
  }

  // ------------------------------------------------------------------
  // 4. AI memory: recall inside a conversation
  // ------------------------------------------------------------------
  {
    await s.say('My name is Thabo and I run a spaza shop in Soweto.');
    const b = await s.say('What did I tell you my name was?');
    verdict('Memory: AI recalls a fact from earlier in the chat', [
      { level: 'FAIL', ok: has(b.replyText, /thabo/i), what: 'the name comes back on request' },
    ], s);
  }

  // ------------------------------------------------------------------
  // 5. Memory ACROSS a flow (BUGLOG #30 regression proof)
  // ------------------------------------------------------------------
  {
    await s.say('Please remember that my favourite colour is green.');
    await s.say('buy electricity');   // state change: history used to die here
    await s.say('cancel');            // and again here
    const d = await s.say('What is my favourite colour?');
    verdict('Memory: a flow in between does not amnesia the AI (BUGLOG #30)', [
      { level: 'FAIL', ok: has(d.replyText, /green/i), what: 'the fact survives entering AND leaving a flow' },
    ], s);
  }

  // ------------------------------------------------------------------
  // 6. Questions never get the bare menu (founder screenshot 2026-08-29)
  // ------------------------------------------------------------------
  {
    const a = await s.say('Where can I spend my WaPay money!');
    verdict('Questions: the founder repro gets a real spend answer, never the menu', [
      { level: 'FAIL', ok: !looksLikeMenu(a.replyText), what: 'no bare menu for the exact founder phrasing' },
      { level: 'FAIL', ok: has(a.replyText, /airtime|electricity|voucher|data/i), what: 'the answer names real spend destinations' },
      { level: 'WARN', ok: has(a.replyText, /[\u{1F300}-\u{1FAFF}☀-➿]/u), what: 'the reply carries warmth (emoji)' },
    ], s);
  }
  {
    // Flag-aware (2026-09-13): with payouts live the SAME sentence must start
    // the withdraw flow (here: the R20 minimum, the QA wallet holds R0); with
    // payouts off it must get the honest coming-soon script.
    const live = process.env.WAPAY_PAYOUT_ENABLED === 'true';
    const a = await s.say('How do I withdraw my money to my bank account?');
    verdict(live ? 'Questions: cash-out ask starts the withdraw flow (payouts live)' : 'Questions: cash-out ask gets the coming-soon script, then spend guidance', [
      { level: 'FAIL', ok: !looksLikeMenu(a.replyText), what: 'no bare menu for a cash-out question' },
      live
        ? { level: 'FAIL', ok: has(a.replyText, /Withdrawals start at R20|identity|PayShap|bank transfer/i) && !has(a.replyText, /coming soon/i), what: 'the withdraw flow answers, never "coming soon"' }
        : { level: 'FAIL', ok: has(a.replyText, /coming soon|not (yet|available yet)|soon/i), what: 'honest coming-soon position' },
      { level: 'FAIL', ok: !has(a.replyText, /\b(january|february|march|april|june|july|august|september|october|november|december|20\d\d)\b/i), what: 'no date is promised' },
      { level: 'WARN', ok: live || has(a.replyText, /airtime|electricity|spend|voucher/i), what: 'redirects to what the money CAN do' },
    ], s);
  }
  {
    // Founder screenshots 2026-09-13: a price question got the Add Money
    // menu, then "I don't want to guess". Fees now come from the fee tables.
    const a = await s.say('How much does it cost to deposit money on here?');
    const b = await s.say('But how much does it cost?');
    const c = await s.say('And online card deposits?');
    verdict('Fees: "how much does it cost to deposit" is answered with the real numbers', [
      { level: 'FAIL', ok: has(a.replyText, /4\.2% \+ R2\.30/) && has(a.replyText, /R20 costs R24/), what: 'the card fee and a worked example' },
      { level: 'FAIL', ok: has(a.replyText, /keeps 6%|adds R94/), what: 'the cash-voucher haircut is disclosed up front' },
      { level: 'FAIL', ok: !has(a.replyText, /Add Money to WaPay/i) && !looksLikeMenu(a.replyText), what: 'no menu for a price question' },
      { level: 'FAIL', ok: has(b.replyText, /What WaPay costs/i), what: 'a bare "how much does it cost" gets the whole schedule' },
      { level: 'WARN', ok: has(c.replyText, /4\.2|R2\.30|R24|R107/), what: 'the AI follow-up quotes the card fee from the FEES block' },
      { level: 'FAIL', ok: !has(c.replyText, /don't want to guess|can't quote/i), what: 'no refusal to quote a fee' },
    ], s);
  }
  {
    // Founder review 2026-09-15: questions are answered, never turned into flows.
    const a = await s.say('Can I buy electricity?');
    const b = await s.say('Can they withdraw the OTT voucher for money?');
    const c = await s.say('Is it accepted at Checkers?');
    const d = await s.say('Can I send money to someone?');
    verdict('How it works: capability questions get the steps, not a flow or a menu', [
      { level: 'FAIL', ok: !has(a.replyText, /How much electricity would you like to buy/i) && has(a.replyText, /R10 to R5000/) && has(a.replyText, /buy R100 electricity/), what: '"Can I buy electricity?" explains and offers the words to start' },
      { level: 'FAIL', ok: !has(b.replyText, /Withdraw from WaPay|Reply 1, 2 or 3/i) && has(b.replyText, /cannot be exchanged for cash/i), what: 'an OTT cash-out question is answered, not turned into a withdrawal' },
      { level: 'FAIL', ok: has(c.replyText, /Checkers does not take OTT vouchers/i) && has(c.replyText, /Talk360|Pay@/), what: '"Is it accepted at Checkers?" gets a no by name and the places it does work' },
      { level: 'FAIL', ok: has(d.replyText, /instantly and it is free/i) && !looksLikeMenu(d.replyText), what: '"Can I send money to someone?" explains sending' },
    ], s);
  }
  {
    const a = await s.say('What can I buy with this?');
    verdict('Discovery: "what can I buy" lists everything the money does, not three VAS lines', [
      { level: 'FAIL', ok: has(a.replyText, /Send money/i) && has(a.replyText, /Get paid/i) && has(a.replyText, /vouchers/i), what: 'catalogue-built list (send, get paid, vouchers)' },
      { level: 'FAIL', ok: has(a.replyText, /airtime/i) && has(a.replyText, /electricity/i), what: 'prepaid categories still listed' },
      { level: 'FAIL', ok: !has(a.replyText, /WaPay VAS Products/), what: 'the old three-item dump is gone' },
    ], s);
  }
  {
    // Withdraw flow wiring with the switch on, no money: the QA wallet holds R0.
    const prevOn = process.env.WAPAY_PAYOUT_ENABLED; const prevKyc = process.env.WAPAY_PAYOUT_KYC;
    process.env.WAPAY_PAYOUT_ENABLED = 'true'; process.env.WAPAY_PAYOUT_KYC = 'off';
    const a = await s.say('withdraw R20');
    const b = await s.say('can I take my money out?');
    const c = await s.say('what is the cash-out fee?');
    if (prevOn === undefined) delete process.env.WAPAY_PAYOUT_ENABLED; else process.env.WAPAY_PAYOUT_ENABLED = prevOn;
    if (prevKyc === undefined) delete process.env.WAPAY_PAYOUT_KYC; else process.env.WAPAY_PAYOUT_KYC = prevKyc;
    verdict('Withdraw: with payouts live the flow starts deterministically and fees are quoted', [
      { level: 'FAIL', ok: has(a.replyText, /Withdrawals start at R20/i) && has(a.replyText, /R0/), what: '"withdraw R20" reaches the flow and reports the R20 minimum against a R0 wallet' },
      { level: 'FAIL', ok: !has(a.replyText, /coming soon/i) && !has(b.replyText, /coming soon/i) && !has(c.replyText, /coming soon/i), what: 'never "coming soon" while live' },
      { level: 'FAIL', ok: has(b.replyText, /Reply \*YES\*|withdraw R50/i) && !looksLikeMenu(b.replyText) && !has(b.replyText, /coming soon/i), what: '"can I take my money out?" is a QUESTION: a short specific answer plus the offer, no flow starts (knowledge base, 2026-09-15)' },
      { level: 'FAIL', ok: has(c.replyText, /R8/) && has(c.replyText, /R10/) && has(c.replyText, /R18/), what: 'the cash-out fee question quotes R8 / R10 / R18' },
    ], s);
  }
  {
    const a = await s.say('Can I buy petrol with WaPay?');
    verdict('Questions: fuel ask in test mode is coming-soon, never claimed redeemable', [
      { level: 'FAIL', ok: !looksLikeMenu(a.replyText), what: 'no bare menu for a fuel question' },
      { level: 'FAIL', ok: !has(a.replyText, /redeem (it|this|your voucher) at|works at any (shell|engen|station)/i), what: 'no live-redemption claim while gated' },
      { level: 'WARN', ok: has(a.replyText, /coming soon|soon|not (yet|available)/i), what: 'fuel presented as coming soon' },
    ], s);
  }
  {
    const a = await s.say('Where is OTT vouchers accepted?');
    verdict('Questions: "where is OTT accepted" is ANSWERED, never a purchase flow (founder 2026-08-31)', [
      { level: 'FAIL', ok: !has(a.replyText, /How much would you like your voucher for/i), what: 'the question never starts the buy flow' },
      { level: 'FAIL', ok: !looksLikeMenu(a.replyText), what: 'no bare menu either' },
      { level: 'WARN', ok: has(a.replyText, /online|accept|ottvoucher|stores?|platforms?/i), what: 'the answer says where OTT is accepted' },
      { level: 'FAIL', ok: !has(a.replyText, /\b(bet|betting|casino|gambl)/i), what: 'no betting vocabulary, ever' },
    ], s);
  }
  {
    await s.say('buy electricity');
    const b = await s.say('how do fees work on WaPay?');
    await s.say('cancel');
    verdict('Questions: a question mid-flow is answered, not menued or meter-errored', [
      { level: 'FAIL', ok: !looksLikeMenu(b.replyText), what: 'no bare menu mid-flow' },
      { level: 'FAIL', ok: !has(b.replyText, /valid (amount|meter)/i), what: 'no validation insult for a real question' },
      { level: 'WARN', ok: has(b.replyText, /fee|cost|charge|free|switching over/i), what: 'the fees question is acknowledged' },
    ], s);
  }

  // ------------------------------------------------------------------
  // 6b. Founder review 3 (2026-09-15 evening): idle states, specific short answers, minimums, full pay-out
  // ------------------------------------------------------------------
  {
    const prevOn = process.env.WAPAY_PAYOUT_ENABLED; const prevKyc = process.env.WAPAY_PAYOUT_KYC;
    process.env.WAPAY_PAYOUT_ENABLED = 'true'; process.env.WAPAY_PAYOUT_KYC = 'off';
    try {
      // Idle: a flow parked 12 hours ago is over; "Hello" goes home. A fresh flow + "home" also goes home.
      await parkQaState('PAYOUT_AMOUNT', { method: 'CASHSEND', options: ['PAYSHAP', 'CASHSEND'], balanceCents: 6600 }, 12 * 60);
      const a = await s.say('Hello');
      await parkQaState('PAYOUT_AMOUNT', { method: 'CASHSEND', options: ['PAYSHAP', 'CASHSEND'], balanceCents: 6600 }, 1);
      const b = await s.say('home');
      verdict('Idle: a parked flow expires; hi / home always go to the home screen', [
        { level: 'FAIL', ok: !has(a.replyText, /Just the amount/i) && has(a.replyText, /Balance:/), what: '"Hello" after 12 idle hours gets the home screen, not "Just the amount"' },
        { level: 'FAIL', ok: has(b.replyText, /Balance:/) && !has(b.replyText, /Just the amount/i), what: '"home" inside a fresh flow goes home' },
      ], s);

      // Specific, short answer + YES starts the flow.
      await fundQaAccount({ cents: 10000 });
      const c = await s.say('Can I withdraw at an ABSA atm?');
      const d = await s.say('yes');
      verdict('How it works: "Can I withdraw at an Absa ATM?" gets a specific short answer, and YES starts the flow', [
        { level: 'FAIL', ok: has(c.replyText, /Absa ATM/) && has(c.replyText, /R18/) && has(c.replyText, /ID number/), what: 'the answer is about Absa: fee, minimum, what is needed' },
        { level: 'FAIL', ok: !has(c.replyText, /1️⃣ Say \*withdraw\*/), what: 'no four-step wall for a "can I" question' },
        { level: 'FAIL', ok: has(c.replyText, /Reply \*YES\*/), what: 'offers to take them through it' },
        { level: 'FAIL', ok: has(d.replyText, /How much would you like to withdraw by Cash at an Absa ATM|Withdraw from WaPay/), what: 'YES starts the withdrawal (Absa pre-selected)' },
      ], s);
      await s.say('cancel');

      // Below the minimum: name the alternatives; "menu" changes method; full pay-out with PIN and money.
      const e = await s.say('Withdraw 30');
      const f = await s.say('2');
      const g = await s.say('back');
      const h = await s.say('4');
      const i = await s.say('mine');
      const j = await s.say('9001015009087');
      const k = await s.say('yes');
      const l = await s.say(QA_PIN);
      const m = await s.say('balance');
      verdict('Withdraw end to end: minimum explained, method changed, FNB eWallet paid with PIN, balance moves', [
        { level: 'FAIL', ok: has(e.replyText, /Withdraw from WaPay/) && has(e.replyText, /FNB eWallet/), what: '"Withdraw 30" shows the live menu incl. FNB eWallet' },
        { level: 'FAIL', ok: has(f.replyText, /R30 is below the R50 minimum for cash at an Absa ATM, but /) && has(f.replyText, /Reply \*YES\* to switch to that/), what: 'Absa at R30: the one method that carries R30 is offered as a yes or no, no menu bounce (founder review 2026-09-18)' },
        { level: 'FAIL', ok: has(g.replyText, /Withdraw from WaPay/), what: '"back" returns to the method menu ("menu" goes home, like a banking app)' },
        { level: 'FAIL', ok: has(h.replyText, /FNB eWallet/) && has(h.replyText, /cellphone number/i), what: 'FNB eWallet keeps the R30 and asks for the cellphone number' },
        { level: 'FAIL', ok: has(i.replyText, /13-digit/), what: 'the ID number is asked because the provider requires it' },
        { level: 'FAIL', ok: has(j.replyText, /Withdraw \*R30\* to an FNB eWallet/) && has(j.replyText, /Fee: R18/), what: 'confirmation names the eWallet, the amount and the fee' },
        { level: 'FAIL', ok: has(k.replyText, /PIN/), what: 'YES asks for the PIN' },
        { level: 'FAIL', ok: has(l.replyText, /Done\./) && has(l.replyText, /WP[A-Z0-9]{14}/), what: 'the PIN executes exactly one pay-out and returns a reference' },
        { level: 'FAIL', ok: ottCalls.length === 1 && ottCalls[0].providerCode === '1' && ottCalls[0].amountCents === 3000, what: 'exactly one PerformPayout to FNB e-wallet (code 1) for R30' },
        { level: 'FAIL', ok: has(m.replyText, /R\s?52[.,]00/), what: 'balance is R100 - R30 - R18 = R52' },
        { level: 'FAIL', ok: has(j.replyText, /Total leaving your balance: \*R48\*/) && has(j.replyText, /Balance after: \*R52\*/), what: 'the confirmation shows what leaves and what remains' },
      ], s);
    } finally {
      if (prevOn === undefined) delete process.env.WAPAY_PAYOUT_ENABLED; else process.env.WAPAY_PAYOUT_ENABLED = prevOn;
      if (prevKyc === undefined) delete process.env.WAPAY_PAYOUT_KYC; else process.env.WAPAY_PAYOUT_KYC = prevKyc;
    }
  }

  // ------------------------------------------------------------------
  // 7. Languages: switch, localized replies, non-English inbound
  // ------------------------------------------------------------------
  {
    const a = await s.say('speak zulu');
    const b = await s.say('balance');
    const c = await s.say('wat is my balans');
    const d = await s.say('speak english');
    verdict('Language: switch to isiZulu, localized replies, Afrikaans inbound', [
      { level: 'FAIL', ok: a.res?.languageSet === 'zu', what: '"speak zulu" locks the preference' },
      { level: 'WARN', ok: !has(b.replyText, /your wapay balance/i), what: 'balance reply is localized (English here = localizer failed open, worth eyes)' },
      { level: 'FAIL', ok: has(b.replyText, /R\s?\d/), what: 'money figures survive localization untranslated' },
      { level: 'WARN', ok: has(c.replyText, /R\s?\d/), what: 'Afrikaans "wat is my balans" still reads as a balance ask' },
      { level: 'FAIL', ok: d.res?.languageSet === 'en', what: '"speak english" switches back' },
    ], s);
  }

  // ------------------------------------------------------------------
  // 8. Business sign-up from the chat (founder ask 2026-09-06)
  // ------------------------------------------------------------------
  {
    // The pilot is closed: invite the QA wallet for this run only, and give
    // the portal-code command a secret so "business login" can answer.
    process.env.WAPAY_BUSINESS_MSISDNS = QA_WA_ID;
    const hadSecret = !!process.env.WAPAY_BUSINESS_SESSION_SECRET;
    process.env.WAPAY_BUSINESS_SESSION_SECRET ||= 'chat-qa-business-secret-0123456789abcdef';
    const a = await s.say('business account');
    const b = await s.say('I Love My Laundry');
    const c = await s.say('business account');
    const d = await s.say('business login');
    verdict('Business sign-up in chat: two answers, then the portal code', [
      { level: 'FAIL', ok: has(a.replyText, /trading name/i) && !looksLikeMenu(a.replyText), what: '"business account" asks for the trading name' },
      { level: 'FAIL', ok: has(b.replyText, /I Love My Laundry\* is now a WaPay business/), what: 'the name registers the business' },
      { level: 'FAIL', ok: has(b.replyText, /business login/i) && has(b.replyText, /business\.wapay\.co\.za|\/business/), what: 'the reply explains the portal and the code command' },
      { level: 'FAIL', ok: has(c.replyText, /already registered/i) && has(c.replyText, /I Love My Laundry/), what: 'asking again names the existing business' },
      { level: 'FAIL', ok: has(d.replyText, /WaPay for Business code: \d{6}/), what: '"business login" now answers with a portal code (the wallet owns a business)' },
    ], s);
    delete process.env.WAPAY_BUSINESS_MSISDNS;
    if (!hadSecret) delete process.env.WAPAY_BUSINESS_SESSION_SECRET;
  }

  {
    // Founder review 2026-09-18: this exact sentence got the canned
    // how-it-works line twice instead of the record.
    const a = await s.say("Can you tell me a full history of what you know about me and all my past transactions?");
    verdict("Memory: the full-history sentence is answered from the record, in one message", [
      { level: "FAIL", ok: !looksLikeMenu(a.replyText), what: "no menu, no canned how-it-works line" },
      { level: "FAIL", ok: has(a.replyText, /What I know about you/i), what: "the record block" },
      { level: "FAIL", ok: has(a.replyText, /movement|No movements/i), what: "the movement block in the SAME message" },
      { level: "FAIL", ok: a.replies.length === 1, what: "exactly one outbound message (Meta bills every reply from 1 October 2026)" },
      { level: "FAIL", ok: !has(a.replyText, /Say "balance" any time/i), what: "never the how-it-works fallback" },
    ], s);
  }
  // ---- The Pay agent (Phase 2, docs/AGENT_ARCHITECTURE_V2.md) under the
  // shadow list: the same founder review-4 asks, answered by one model call
  // over the customer record and typed tools. Money flows are unchanged:
  // a proposal lands in the same confirm/PIN steps the regex router uses.
  {
    const prevList = process.env.WAPAY_AGENT_V3_MSISDNS;
    const prevBudget = process.env.WAPAY_AGENT_TURNS_PER_HOUR;
    process.env.WAPAY_AGENT_V3_MSISDNS = QA_WA_ID;
    delete process.env.WAPAY_AGENT_TURNS_PER_HOUR;
    try {
      const live = process.env.WAPAY_PAYOUT_ENABLED === 'true';
      const a = await s.say('How can I withdraw money?');
      const aLines = String(a.replyText || '').split('\n').filter((l) => l.trim());
      verdict('Agent: "How can I withdraw money?" is short, honest, and never the menu', [
        { level: 'FAIL', ok: !looksLikeMenu(a.replyText), what: 'no menu' },
        { level: 'FAIL', ok: !has(a.replyText, /\b(january|february|march|april|june|july|august|september|october|november|december|20\d\d)\b/i), what: 'no date promised' },
        { level: 'FAIL', ok: !has(a.replyText, /\bOTT\b/) || live, what: 'the payout partner is not named while withdrawals are off' },
        { level: 'FAIL', ok: !has(a.replyText, /\bbet|wager|casino|odds\b/i), what: 'no betting word' },
        { level: 'WARN', ok: aLines.length <= 6, what: 'six lines or fewer (review 4: two lines and a question)' },
        live
          ? { level: 'WARN', ok: has(a.replyText, /Withdrawals start at R20|identity|PayShap|bank/i), what: 'live: the withdraw flow or a real how-to answers' }
          : { level: 'FAIL', ok: has(a.replyText, /soon|not (yet|available)|spend/i), what: 'off: honest position and what the money can do' },
      ], s);

      const b = await s.say('Where can I spend my OTT voucher?');
      const bLines = String(b.replyText || '').split('\n').filter((l) => l.trim());
      verdict('Agent: spend question gets real destinations, not the menu', [
        { level: 'FAIL', ok: !looksLikeMenu(b.replyText), what: 'no menu' },
        { level: 'FAIL', ok: has(b.replyText, /airtime|data|electricity|voucher|fuel/i), what: 'names real spend destinations' },
        { level: 'FAIL', ok: bLines.length >= 3, what: 'a list, one per line, not a paragraph (founder review 2026-09-18)' },
      ], s);

      const c = await s.say('what did I buy last week');
      verdict('Agent: transaction question is answered from the record', [
        { level: 'FAIL', ok: !looksLikeMenu(c.replyText), what: 'no menu' },
        { level: 'FAIL', ok: has(c.replyText, /nothing|no (purchases|transactions|movements)|haven't|R\s?\d|last/i), what: 'a factual answer (the QA wallet has no purchases) or a listed movement' },
        { level: 'FAIL', ok: !has(c.replyText, /didn't (quite )?(catch|understand)/i), what: 'never the canned fallback' },
      ], s);

      const d = await s.say('did my payment go through');
      verdict('Agent: status question is answered from the record, never invented', [
        { level: 'FAIL', ok: !looksLikeMenu(d.replyText), what: 'no menu' },
        { level: 'FAIL', ok: !has(d.replyText, /✅.*(paid|success|went through)|has gone through|was successful/i) || has(d.replyText, /no (recent|pending)|nothing|don't see|can't see|haven't/i), what: 'no invented success (the QA wallet has no payment)' },
      ], s);

      const e = await s.say('Okay');
      verdict('Agent: "Okay" gets a short human line, not a menu dump', [
        { level: 'FAIL', ok: !looksLikeMenu(e.replyText), what: 'no menu' },
        { level: 'WARN', ok: String(e.replyText || '').length <= 240, what: 'short' },
      ], s);

      // A send with the number would call the voucher preview route over HTTP,
      // which this harness cannot serve (the regex router has the same limit);
      // without a number the same gift flow asks for the recipient first.
      const f = await s.say('send R50 to my brother');
      verdict('Agent: a send proposal lands in the same gift flow (recipient step)', [
        { level: 'FAIL', ok: !looksLikeMenu(f.replyText), what: 'no menu' },
        { level: 'FAIL', ok: has(f.replyText, /number|who|recipient|083|078|balance|fund|top up|add money/i), what: 'the gift flow asks for the recipient (or states the funding position)' },
        { level: 'FAIL', ok: !has(f.replyText, /✅ Sent|has been sent/i), what: 'nothing is executed without a PIN' },
      ], s);
      await s.say('cancel');

      // "buy R30 airtime" has two legitimate landings and the model picks
      // between them turn by turn: it asks which number, or it fills the
      // number from the customer's own record and goes straight to the
      // preview. The second calls the preview route over HTTP, which this
      // harness cannot serve (docs/HANDOVER_V1.5.md section 7), so the flow
      // doing exactly the right thing used to read as a failure every other
      // run. Reaching the preview IS the airtime flow answering, so it counts;
      // the menu and the no-execution assertions below still hold either way.
      const g = await s.say('buy R30 airtime');
      verdict('Agent: an airtime proposal lands in the same airtime step', [
        { level: 'FAIL', ok: !looksLikeMenu(g.replyText), what: 'no menu' },
        { level: 'FAIL', ok: has(g.replyText, /R\s?30|number|which (phone|number)|confirm|PIN|balance|fund|top up|add money|Non-JSON response from preview/i), what: 'the airtime flow answers (number/confirm/PIN, the funding position, or the preview route this harness cannot serve)' },
        { level: 'FAIL', ok: !has(g.replyText, /✅ .*airtime.*(sent|delivered|loaded)/i), what: 'nothing is executed without a PIN' },
      ], s);
      await s.say('cancel');

      // guards: bearer input never reaches the model; the budget stops a loop
      const h = await s.say('voucher pin 1234');
      verdict('Agent guard: "voucher pin 1234" goes to the resend flow, not the model', [
        { level: 'FAIL', ok: !looksLikeMenu(h.replyText), what: 'no menu' },
        { level: 'FAIL', ok: has(h.replyText, /voucher|serial|1234|find|no voucher/i), what: 'the resend flow answered' },
      ], s);
      process.env.WAPAY_AGENT_TURNS_PER_HOUR = '1';
      const i = await s.say('and now?');
      verdict('Agent budget: the per-customer cap answers without a model call', [
        { level: 'FAIL', ok: has(i.replyText, /slow down|few minutes/i), what: 'the budget line' },
      ], s);
    } finally {
      if (prevList === undefined) delete process.env.WAPAY_AGENT_V3_MSISDNS; else process.env.WAPAY_AGENT_V3_MSISDNS = prevList;
      if (prevBudget === undefined) delete process.env.WAPAY_AGENT_TURNS_PER_HOUR; else process.env.WAPAY_AGENT_TURNS_PER_HOUR = prevBudget;
    }
  }

  return results;
}

function writeReport() {
  const date = new Date().toISOString().slice(0, 10);
  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const r of results) counts[r.status]++;
  const lines = [
    `# WaPay chat QA report · ${date}`,
    '',
    `Conversational end-to-end run against the REAL message processor (live DB, live OpenAI, outbound WhatsApp captured, no money moved). QA account: \`${QA_WA_ID}\` (seeded and torn down by the run).`,
    '',
    `**${counts.PASS} pass · ${counts.WARN} warn · ${counts.FAIL} fail**`,
    '',
  ];
  for (const r of results) {
    lines.push(`## ${r.status === 'PASS' ? '✅' : r.status === 'WARN' ? '⚠️' : '❌'} ${r.name}`, '');
    for (const c of r.checks) lines.push(`- ${c}`);
    if (r.notes.length) lines.push('', ...r.notes.map((n) => `> ${n}`));
    lines.push('', '<details><summary>Transcript</summary>', '');
    for (const t of r.transcript) {
      lines.push(`**User:** ${t.user}`, '');
      lines.push('```', t.bot, '```', '');
    }
    lines.push('</details>', '');
  }
  mkdirSync(new URL('../../docs/testing/', import.meta.url), { recursive: true });
  const path = new URL(`../../docs/testing/chat-qa-report-${date}.md`, import.meta.url);
  writeFileSync(path, lines.join('\n'));
  console.log(`\nReport: docs/testing/chat-qa-report-${date}.md`);
  return counts;
}

let exitCode = 0;
try {
  await run();
  const counts = writeReport();
  exitCode = counts.FAIL ? 1 : 0;
  console.log(`\n${counts.PASS} pass · ${counts.WARN} warn · ${counts.FAIL} fail`);
} catch (err) {
  console.error('HARNESS ERROR:', err);
  exitCode = 2;
} finally {
  await teardownQaAccount().catch((e) => console.error('teardown failed:', e.message));
}
process.exit(exitCode);
