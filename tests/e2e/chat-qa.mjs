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
import { fundQaAccount, parkQaState, QA_PIN, ottCalls, prisma } from './chat-harness.mjs';

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

const LAUNCH_SWITCHES = ['VAS_LIVE_AIRTIME', 'VAS_LIVE_DATA', 'VAS_LIVE_ELECTRICITY', 'VAS_LIVE_BLU_LOAD', 'VAS_LIVE_OTT_VOUCHER'];

async function run() {
  await seedQaAccount();
  // Launch scope (2026-10-18): the scenarios below were written for the pre-launch world, so its
  // switches are on in-process here; scenario 6e below runs the shipped default (everything off).
  for (const k of LAUNCH_SWITCHES) process.env[k] = 'true';
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
      { level: 'FAIL', ok: has(d.replyText, /lands in their balance and it is free/i) && !has(d.replyText, /instantly|in minutes/i) && !looksLikeMenu(d.replyText), what: '"Can I send money to someone?" explains sending, with no time promised (2026-10-12)' },
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
  // ------------------------------------------------------------------
  // 6d part 3 (round 5, item 3). Lisa at R0, her own sentences: a voucher gift
  // delivered and an unpaid R367 link in her record. The gate leads with her
  // money and where it is, then the fuller picture, then a person; never the
  // same line twice. Runs here because the QA wallet is still R0.
  // ------------------------------------------------------------------
  {
    const prevOn = process.env.WAPAY_PAYOUT_ENABLED; const prevKyc = process.env.WAPAY_PAYOUT_KYC;
    process.env.WAPAY_PAYOUT_ENABLED = 'true'; process.env.WAPAY_PAYOUT_KYC = 'off';
    const qa = await prisma.account.findFirst({ where: { waId: QA_WA_ID } });
    const giftKey = `chatqa-gift-lisa-${qa.id}`;
    try {
      await prisma.pendingGift.create({ data: { senderAccountId: qa.id, recipientMsisdn: QA_WA_ID, amountCents: 35000, rail: 'OTT', voucherPin: 'QA-NOT-A-PIN', status: 'DELIVERED', idemKey: giftKey, deliveredAt: new Date(Date.now() - 60 * 1000) } });
      await prisma.providerRequest.create({ data: { provider: 'PAYFAST', route: 'deposit', idemKey: `chatqa-dep-lisa-${qa.id}`, status: 'PENDING', accountId: qa.id, requestTs: new Date(Date.now() - 20 * 60 * 1000), metadata: { amountCents: 35000, grossCents: 36700, feeCents: 1700, waId: QA_WA_ID } } });
      const g1 = await s.say('I want you to put in my bank account');
      const g2 = await s.say('How can you transfer in my bank account');
      const g3 = await s.say('Put in my bank account');
      const g4 = await s.say('How much can I withdraw');
      verdict('Lisa 3: the R0 gate reads her situation, explains more the second time, offers a person the third time, never the same line twice', [
        { level: 'FAIL', ok: has(g1.replyText, /You have R0 to withdraw\. The R350 \w+ sent you today came as a voucher PIN, not as money in your balance/) && has(g1.replyText, /R367 payment link from today was not paid/), what: 'first time: her money, the voucher and the unpaid link, before any minimum' },
        { level: 'FAIL', ok: !has(g1.replyText, /Withdrawals start at/), what: 'never the old product-fact line' },
        { level: 'FAIL', ok: has(g2.replyText, /Let me explain where your money is/) && has(g2.replyText, /What you can do:/) && has(g2.replyText, /passport or foreign ID works too/), what: 'second time: the picture as bullets, what she can do, a passport works' },
        { level: 'FAIL', ok: has(g3.replyText, /asked a person from the WaPay team|To talk to a person|Here it is once more/) && g3.replyText !== g2.replyText, what: 'third time: a person (or, with no alert channel here, a different wording), never the same line' },
        { level: 'FAIL', ok: has(g4.replyText, /R0/) && !has(g4.replyText, /13-digit/) && g4.replyText !== g3.replyText, what: '"How much can I withdraw" answers from her balance, not the how-it-works brief' },
        { level: 'FAIL', ok: process.env.ALERT_EMAIL || (!has(g3.replyText, /asked a person/) && !has(g4.replyText, /has been asked/)), what: 'no person is claimed when no alert could be sent (harness run 2026-10-12 caught "has been asked" with no alert)' },
      ], s);

      // 4 and 5: "send money" to her own number, then "did my payment go through" with the unpaid link.
      const own = QA_WA_ID.startsWith('27') ? `0${QA_WA_ID.slice(2)}` : QA_WA_ID;
      await s.say('Send money');
      await s.say('R350');
      const s3 = await s.say(own);
      const d1 = await s.say('Did my payment go through');
      verdict('Lisa 4 and 5: "send money" to her own number is refused, never a voucher link; an unpaid link is "not paid", never "still confirming"', [
        { level: 'FAIL', ok: has(s3.replyText, /That is your own number/) && has(s3.replyText, /say \*withdraw\*/), what: 'her own number after "send money" is refused and points to withdraw' },
        { level: 'FAIL', ok: !has(s3.replyText, /Pay the R\d+ difference|button below|Confirm WaPay Voucher/), what: 'no voucher purchase and no payment link' },
        { level: 'FAIL', ok: has(d1.replyText, /You have not paid your R367 payment link/) && has(d1.replyText, /Ignore it if you did not mean to buy/), what: '"did my payment go through" says the link was not paid' },
        { level: 'FAIL', ok: !has(d1.replyText, /still confirming|PayFast/), what: 'never "still confirming", no partner named' },
      ], s);
    } finally {
      await prisma.pendingGift.deleteMany({ where: { idemKey: giftKey } }).catch(() => {});
      await prisma.providerRequest.deleteMany({ where: { idemKey: `chatqa-dep-lisa-${qa.id}` } }).catch(() => {});
      if (prevOn === undefined) delete process.env.WAPAY_PAYOUT_ENABLED; else process.env.WAPAY_PAYOUT_ENABLED = prevOn;
      if (prevKyc === undefined) delete process.env.WAPAY_PAYOUT_KYC; else process.env.WAPAY_PAYOUT_KYC = prevKyc;
    }
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
      { level: 'FAIL', ok: has(a.replyText, /R0/) && has(a.replyText, /R58/) && !has(a.replyText, /coming soon/i), what: '"withdraw R20" reaches the flow and reports the R58 needed against a R0 wallet (R50 floor since 2026-10-10; the gate leads with the money since 2026-10-12)' },
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
      const h2 = await s.say('50');   // 2026-10-10: cash is R50 minimum in R50 steps (ATM notes, BUGLOG #98), so the R30 is asked again
      const i = await s.say('mine');
      const i2 = await s.say('Thandi Nkosi');   // 2026-10-04: the full name is asked once when KYC has none (never the display name twice)
      const j = await s.say('9001015009087');
      const k = await s.say('yes');
      const l = await s.say(QA_PIN);
      const m = await s.say('balance');
      verdict('Withdraw end to end: minimum explained, method changed, FNB eWallet paid with PIN, balance moves', [
        { level: 'FAIL', ok: has(e.replyText, /Withdraw from WaPay/) && has(e.replyText, /FNB eWallet/), what: '"Withdraw 30" shows the live menu incl. FNB eWallet' },
        { level: 'FAIL', ok: has(f.replyText, /R30 is below the R50 minimum for cash at an Absa ATM\. Please type an amount of R50 or more/), what: 'Absa at R30: below every cash minimum since the R50 floor (BUGLOG #98), the minimum is named and the amount asked again' },
        { level: 'FAIL', ok: has(g.replyText, /Withdraw from WaPay/), what: '"back" returns to the method menu ("menu" goes home, like a banking app)' },
        { level: 'FAIL', ok: has(h.replyText, /R30 is below the R50 minimum for an FNB eWallet/), what: 'FNB eWallet: the R30 kept from the opener is below the R50 cash floor, so the amount is asked again' },
        { level: 'FAIL', ok: has(h2.replyText, /cellphone number/i), what: 'R50 goes to the cellphone step' },
        { level: 'FAIL', ok: has(i.replyText, /full name, exactly as it appears on your ID/), what: 'the full name is asked once, as on the ID, because KYC has none (founder 2026-10-04)' },
        { level: 'FAIL', ok: has(i2.replyText, /13-digit/), what: 'the ID number is asked because the provider requires it' },
        { level: 'FAIL', ok: has(j.replyText, /Withdraw \*R50\* to an FNB eWallet/) && has(j.replyText, /Fee: R18/), what: 'confirmation names the eWallet, the amount and the fee' },
        { level: 'FAIL', ok: has(k.replyText, /PIN/), what: 'YES asks for the PIN' },
        { level: 'FAIL', ok: has(l.replyText, /Done\./) && has(l.replyText, /WP[A-Z0-9]{14}/), what: 'the PIN executes exactly one pay-out and returns a reference' },
        { level: 'FAIL', ok: has(l.replyText, /eWallet code is sent by SMS to •••\d{3}/) && has(l.replyText, /Cardless services\* then \*eWallet\*/), what: 'after Done the chat itself says where the code arrives and how to collect (founder 2026-10-04)' },
        { level: 'FAIL', ok: has(j.replyText, /Name on the account: Thandi Nkosi/) && has(j.replyText, /ID number: •••087/), what: 'the confirmation shows the name as given and the ID number masked' },
        { level: 'FAIL', ok: ottCalls.length === 1 && ottCalls[0].providerCode === '1' && ottCalls[0].amountCents === 5000, what: 'exactly one PerformPayout to FNB e-wallet (code 1) for R50' },
        { level: 'FAIL', ok: has(m.replyText, /R\s?32[.,]00/), what: 'balance is R100 - R50 - R18 = R32' },
        { level: 'FAIL', ok: has(j.replyText, /Total leaving your balance: \*R68\*/) && has(j.replyText, /Balance after: \*R32\*/), what: 'the confirmation shows what leaves and what remains' },
      ], s);
    } finally {
      if (prevOn === undefined) delete process.env.WAPAY_PAYOUT_ENABLED; else process.env.WAPAY_PAYOUT_ENABLED = prevOn;
      if (prevKyc === undefined) delete process.env.WAPAY_PAYOUT_KYC; else process.env.WAPAY_PAYOUT_KYC = prevKyc;
    }
  }

  // ------------------------------------------------------------------
  // 6c. Founder review 2026-10-04: compound answers ("50 and 2", "50 at ABSA",
  // "the Nedbank one") are read as amount + method and confirmed in ONE line.
  // ------------------------------------------------------------------
  {
    const prevOn = process.env.WAPAY_PAYOUT_ENABLED; const prevKyc = process.env.WAPAY_PAYOUT_KYC;
    process.env.WAPAY_PAYOUT_ENABLED = 'true'; process.env.WAPAY_PAYOUT_KYC = 'off';
    try {
      await fundQaAccount({ cents: 20000, key: 'compound' });   // the balance after 6b is R52; R252 lets every compound answer be affordable
      const a = await s.say('Can I withdraw 20');
      const b = await s.say('50 and 2');
      const c = await s.say('yes');
      await s.say('cancel');
      const d = await s.say('withdraw');
      const e = await s.say('1');
      const f = await s.say('50 at ABSA');
      const g = await s.say('No can you help me withdraw 50 at ABSA?');
      const h = await s.say('the Nedbank one');
      const i = await s.say('50');
      await s.say('cancel');
      // Round 3 (production run 2026-10-08): "add money" inside the flow goes to the deposit flow, never the method menu.
      await s.say('withdraw');
      const j = await s.say('Add money');
      await s.say('cancel');
      verdict('Compound answers: "50 and 2", "50 at ABSA", "the Nedbank one" are read as amount + method and confirmed in one line (founder 2026-10-04)', [
        { level: 'FAIL', ok: has(a.replyText, /Withdraw from WaPay/) && has(a.replyText, /Minimum withdrawals from R/), what: '"Can I withdraw 20" opens the menu (amount kept) and the menu says "Minimum withdrawals from"' },
        { level: 'FAIL', ok: has(b.replyText, /Got it: R50 by cash at an Absa ATM\. Is that right\? Reply \*YES\*/), what: '"50 and 2" is confirmed in one line, not "Reply 1, 2, 3 or 4"' },
        { level: 'FAIL', ok: has(c.replyText, /cellphone number will collect the cash at the Absa ATM/i), what: 'YES carries on to the cellphone step with R50 and Absa set' },
        { level: 'FAIL', ok: has(d.replyText, /Withdraw from WaPay/) && has(e.replyText, /How much would you like to withdraw by PayShap/), what: 'a fresh withdrawal: PayShap asks for the amount' },
        { level: 'FAIL', ok: has(f.replyText, /Got it: R50 by cash at an Absa ATM/), what: '"50 at ABSA" at the amount step switches method and amount with one confirming line, not "Just the amount"' },
        { level: 'FAIL', ok: has(g.replyText, /Got it: R50 by cash at an Absa ATM/) && !has(g.replyText, /Here is how it works/), what: 'the founder\'s exact sentence gets the confirmation, never the four-step explainer' },
        { level: 'FAIL', ok: has(h.replyText, /withdraw by Cash at a Nedbank ATM/), what: '"the Nedbank one" switches the method and asks the amount' },
        { level: 'FAIL', ok: has(i.replyText, /Nedbank ATM/) && has(i.replyText, /cellphone number/i), what: 'R50 by Nedbank goes to the cellphone step' },
        { level: 'FAIL', ok: !has(j.replyText, /Reply \*1\* for PayShap/) && has(j.replyText, /deposit|add money|card|voucher|payment link/i), what: '"Add money" inside the withdraw flow is answered by the deposit side, never the method menu (BUGLOG #94)' },
      ], s);
    } finally {
      if (prevOn === undefined) delete process.env.WAPAY_PAYOUT_ENABLED; else process.env.WAPAY_PAYOUT_ENABLED = prevOn;
      if (prevKyc === undefined) delete process.env.WAPAY_PAYOUT_KYC; else process.env.WAPAY_PAYOUT_KYC = prevKyc;
    }
  }

  // ------------------------------------------------------------------
  // 6d. The Lisa case (2026-10-10 to 10-12, round 5): a foreign national with
  // a Capitec account and R350 to withdraw. Her own sentences, made permanent.
  // ------------------------------------------------------------------
  {
    const prevOn = process.env.WAPAY_PAYOUT_ENABLED; const prevKyc = process.env.WAPAY_PAYOUT_KYC;
    process.env.WAPAY_PAYOUT_ENABLED = 'true'; process.env.WAPAY_PAYOUT_KYC = 'off';
    try {
      await fundQaAccount({ cents: 10000, key: 'lisa' });
      // 1. A passport at the ID step: the issuing country is asked, the rail gets id_type, country_of_issue and nationality.
      const callsBefore = ottCalls.length;
      await s.say('withdraw 50');
      const p1 = await s.say('1');
      const p2 = await s.say('1234567890');
      const p3 = await s.say('Capitec');
      const p4 = await s.say('Lisa Moyo');
      const p5 = await s.say('FN123456');
      const p6 = await s.say('Zimbabwe');
      const p7 = await s.say('yes');
      const p8 = await s.say(QA_PIN);
      const call = ottCalls[callsBefore] || null;
      verdict('Lisa 1: a passport or foreign ID works at the ID step (the country is asked; the rail gets the passport fields)', [
        { level: 'FAIL', ok: has(p1.replyText, /account number/i) || has(p2.replyText, /Which bank/i), what: 'PayShap asks for the account, then the bank' },
        { level: 'FAIL', ok: has(p4.replyText, /passport or foreign ID number/), what: 'the ID ask names a passport or foreign ID, not only a 13-digit SA ID' },
        { level: 'FAIL', ok: has(p5.replyText, /Which country issued that passport or ID/) && !has(p5.replyText, /FN123456/), what: 'a passport number gets the country question, never echoed' },
        { level: 'FAIL', ok: has(p6.replyText, /Passport \/ foreign ID: •••456 \(Zimbabwe\)/) && has(p6.replyText, /Name on the account: Lisa Moyo/), what: 'the confirmation shows the passport masked with its country' },
        { level: 'FAIL', ok: has(p7.replyText, /PIN/) && has(p8.replyText, /Done\.|In progress/), what: 'YES and the PIN execute the pay-out' },
        { level: 'FAIL', ok: !!call && call.recipient.id_type === 'PASSPORT' && call.recipient.country_of_issue === 'ZW' && call.recipient.nationality === 'ZW' && String(call.providerCode) === '127', what: 'exactly one PerformPayout to PayShap carrying id_type PASSPORT, country_of_issue ZW, nationality ZW' },
      ], s);
      if (/Save these details/.test(p8.replyText)) await s.say('no');

      // 2. "To my bank account" opens PayShap with the price and the numbers, never the generic menu (founder 2026-10-12).
      const b1 = await s.say('lets do a withdrawal to my bank account');
      const b2 = await s.say("I don't have a bank account");
      await s.say('cancel');
      const b3 = await s.say('I want to put all my money to my bank account');
      await s.say('cancel');
      verdict('Lisa 2: bank words open PayShap with the fee, the balance and the ceiling; no bank account means cash', [
        { level: 'FAIL', ok: has(b1.replyText, /PayShap to your bank account: R8 fee, the cheapest way into your bank\. You have R[\d.]+, so up to R\d+\./) && !has(b1.replyText, /Withdraw from WaPay/), what: '"lets do a withdrawal to my bank account" gets the PayShap opener, not the menu' },
        { level: 'FAIL', ok: has(b1.replyText, /No bank account\? Cash at an Absa, Nedbank or FNB ATM costs from R18\. How much\?/), what: 'the opener names the cash alternative and asks how much' },
        { level: 'FAIL', ok: has(b2.replyText, /cash needs no bank account/) && has(b2.replyText, /Reply \*\d\* for cash at an Absa ATM/), what: '"I don\'t have a bank account" offers the cash methods' },
        { level: 'FAIL', ok: has(b3.replyText, /account number/i), what: '"all my money to my bank account" takes the ceiling and asks for the account' },
      ], s);

      // 9, 10, 11. Saving with a name: a bare YES asks what to call it; "save my number used above as mine"
      // renames the destination the last pay-out used; labels as the customer sees them. A throwaway vault
      // key for this run only (the QA account's rows are deleted with it at teardown).
      const prevPii = process.env.WAPAY_PII_KEY;
      process.env.WAPAY_PII_KEY ||= (await import('node:crypto')).randomBytes(32).toString('hex');
      try {
        await fundQaAccount({ cents: 10000, key: 'lisa-save' });
        await s.say('withdraw 50 to my bank account');
        await s.say('1234567890');
        await s.say('Capitec');
        await s.say('Lisa Moyo');
        await s.say('FN123456');
        await s.say('Zimbabwe');
        await s.say('yes');
        const n1 = await s.say(QA_PIN);
        const n2 = await s.say('yes');
        const n3 = await s.say('mother');
        const n4 = await s.say('can you save my number used above as mine?');
        verdict('Lisa 6: a bare YES to saving asks for a name once; "save my number used above as mine" is a real rename, never a claim', [
          { level: 'FAIL', ok: has(n1.replyText, /Save these details for next time \(Capitec account •••890 and your name and passport or ID number ending 456\)/), what: 'the save offer names the account and the passport (masked)' },
          { level: 'FAIL', ok: has(n2.replyText, /Saved, encrypted: Capitec account •••890/) && has(n2.replyText, /What should I call it\? Reply \*mine\*, or a name like \*mother\*/), what: 'a bare YES saves, then asks what to call it' },
          { level: 'FAIL', ok: has(n3.replyText, /Called it \*Mother\*: Mother: Capitec account •••890/), what: '"mother" names it' },
          { level: 'FAIL', ok: has(n4.replyText, /Done: it is saved as \*Mine\*: Mine: Capitec account •••890/) && !has(n4.replyText, /I.ll remember|I have noted/i), what: '"can you save my number used above as mine?" renames the saved account, deterministically' },
        ], s);
      } finally {
        if (prevPii === undefined) delete process.env.WAPAY_PII_KEY; else process.env.WAPAY_PII_KEY = prevPii;
      }
    } finally {
      if (prevOn === undefined) delete process.env.WAPAY_PAYOUT_ENABLED; else process.env.WAPAY_PAYOUT_ENABLED = prevOn;
      if (prevKyc === undefined) delete process.env.WAPAY_PAYOUT_KYC; else process.env.WAPAY_PAYOUT_KYC = prevKyc;
    }
  }

  // ------------------------------------------------------------------
  // 6e. The PIN freeze (Lisa, 2026-10-12): one wrong PIN on a withdrawal, then
  // her own words to reset it. (A) As she is, no ID on file: the reset works and
  // the 24-hour cool-off for new destinations is said and enforced. (B) With an
  // ID on file: the whole number is asked, and the withdrawal that was waiting
  // finishes with the new PIN. "Reset pin" outside a flow too.
  // ------------------------------------------------------------------
  {
    const prev = { on: process.env.WAPAY_PAYOUT_ENABLED, kyc: process.env.WAPAY_PAYOUT_KYC, pii: process.env.WAPAY_PII_KEY };
    process.env.WAPAY_PAYOUT_ENABLED = 'true'; process.env.WAPAY_PAYOUT_KYC = 'off';
    const qa = await prisma.account.findFirst({ where: { waId: QA_WA_ID } });
    const latestCode = async () => (await prisma.otpCode.findFirst({ where: { accountId: qa.id }, orderBy: { createdAt: 'desc' } }))?.code || '';
    const clearPinReset = async () => { const a = await prisma.account.findUnique({ where: { id: qa.id } }); const { pinReset, ...rest } = a.profile || {}; await prisma.account.update({ where: { id: qa.id }, data: { profile: rest } }); };
    try {
      await prisma.payoutIdentity.deleteMany({ where: { accountId: qa.id } });
      await prisma.payoutDestination.deleteMany({ where: { accountId: qa.id } });
      await fundQaAccount({ cents: 20000, key: 'pin-reset' });
      // (A) Lisa as she is: no ID on file.
      for (const t of ['withdraw 50 to my bank account', '1234567890', 'Capitec', 'Lisa Moyo', 'FN123456', 'Zimbabwe', 'yes']) await s.say(t);
      const w1 = await s.say('2006');
      const w2 = await s.say('Me for my password what to reset');
      const c1 = await s.say(await latestCode());
      const n1 = await s.say('2580');
      const n2 = await s.say('2580');
      const n3 = await s.say('withdraw 50 to my bank account');
      verdict('Lisa 7: a wrong PIN names the way out; her own words reset the PIN; with no ID on file the 24-hour cool-off is said and enforced', [
        { level: 'FAIL', ok: has(w1.replyText, /That PIN is not right/) && has(w1.replyText, /Say \*forgot PIN\*/), what: 'the wrong PIN names "forgot PIN" and keeps the withdrawal' },
        { level: 'FAIL', ok: has(w2.replyText, /6-digit code/) && !has(w2.replyText, /Type .?reset PIN/i), what: '"Me for my password what to reset" starts the reset (never "type reset PIN")' },
        { level: 'FAIL', ok: has(c1.replyText, /Code confirmed\. Now type your new PIN/), what: 'the code is accepted; no ID on file, so straight to the new PIN' },
        { level: 'FAIL', ok: has(n1.replyText, /once more to confirm/) && has(n2.replyText, /new PIN is set/) && has(n2.replyText, /for the next 24 hours a withdrawal can only go to an account or number you saved before today/), what: 'the new PIN twice; the cool-off is said' },
        { level: 'FAIL', ok: has(n3.replyText, /withdrawals open again on/), what: 'a withdrawal to a new account waits out the cool-off' },
      ], s);
      // (B) An ID on file: the whole number, then the waiting withdrawal finishes.
      process.env.WAPAY_PII_KEY = (await import('node:crypto')).randomBytes(32).toString('hex');
      const { savePayoutIdentity } = await import('../../lib/payout-beneficiaries.js');
      await savePayoutIdentity({ prisma, accountId: qa.id, fullName: 'Lisa Moyo', idNumber: '9001015009087' });
      await clearPinReset();
      await fundQaAccount({ cents: 100, key: 'pin-restore-a' });   // QA_PIN again
      for (const t of ['withdraw 50 to my bank account', '1234567890', 'Capitec', 'yes']) await s.say(t);
      const b1 = await s.say('2006');
      const b2 = await s.say('I forgot it');
      const b3 = await s.say(await latestCode());
      const b4 = await s.say('9001015009087');
      await s.say('2580');
      const b5 = await s.say('2580');
      const b6 = await s.say('2580');
      const r1 = await s.say('Reset pin');
      const r2 = await s.say('cancel');
      verdict('Lisa 8: with an ID on file the whole number is asked, and the withdrawal that was waiting finishes with the new PIN; "Reset pin" outside a flow', [
        { level: 'FAIL', ok: has(b1.replyText, /That PIN is not right/) && has(b2.replyText, /6-digit code/), what: '"I forgot it" at the PIN prompt starts the reset' },
        { level: 'FAIL', ok: has(b3.replyText, /type the ID or passport number you gave for withdrawals \(the whole number\)/) && has(b4.replyText, /new PIN/), what: 'the whole ID number is asked and accepted' },
        { level: 'FAIL', ok: has(b5.replyText, /new PIN is set/) && has(b5.replyText, /withdrawal of R50 is still waiting/) && !has(b5.replyText, /24 hours/), what: 'back to the R50 withdrawal, no cool-off after an ID-checked reset' },
        { level: 'FAIL', ok: has(b6.replyText, /Done\.|In progress/), what: 'the new PIN completes the withdrawal' },
        { level: 'FAIL', ok: has(r1.replyText, /6-digit code|A code was already sent/) && has(r2.replyText, /PIN reset cancelled\. Your PIN is unchanged/), what: '"Reset pin" outside a flow starts it; "cancel" leaves the PIN alone' },
      ], s);
    } finally {
      await clearPinReset().catch(() => {});
      await fundQaAccount({ cents: 100, key: 'pin-restore' }).catch(() => {});   // puts QA_PIN back for any later scenario
      for (const [k, v] of [['WAPAY_PAYOUT_ENABLED', prev.on], ['WAPAY_PAYOUT_KYC', prev.kyc], ['WAPAY_PII_KEY', prev.pii]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }

  // ------------------------------------------------------------------
  // 6f. The timeout (Lisa, 2026-10-15; BUGLOG #111): her withdrawal waited
  // four hours at the ID step; her ID and then her PIN went to the AI, which
  // asked for the PIN and said "Your payout is being confirmed now" with
  // nothing sent. Now: a late answer carries the withdrawal on, a late yes or
  // PIN is confirmed again and never used, a bare PIN or ID outside a flow is
  // answered without a model (both brains), and a day-old flow says it stopped.
  // ------------------------------------------------------------------
  {
    const prev = { on: process.env.WAPAY_PAYOUT_ENABLED, kyc: process.env.WAPAY_PAYOUT_KYC, agent: process.env.WAPAY_AGENT_V3_MSISDNS };
    process.env.WAPAY_PAYOUT_ENABLED = 'true'; process.env.WAPAY_PAYOUT_KYC = 'off';
    const qa = await prisma.account.findFirst({ where: { waId: QA_WA_ID } });
    const ageState = async (hours) => {
      const a = await prisma.account.findUnique({ where: { id: qa.id } });
      await prisma.account.update({ where: { id: qa.id }, data: { conversationData: { ...(a.conversationData || {}), stateSetAt: new Date(Date.now() - hours * 3600 * 1000).toISOString() } } });
    };
    const clearPinReset = async () => { const a = await prisma.account.findUnique({ where: { id: qa.id } }); const { pinReset, ...rest } = a.profile || {}; await prisma.account.update({ where: { id: qa.id }, data: { profile: rest } }); };
    try {
      await clearPinReset();
      await prisma.payoutIdentity.deleteMany({ where: { accountId: qa.id } });
      await prisma.payoutDestination.deleteMany({ where: { accountId: qa.id } });
      await fundQaAccount({ cents: 20000, key: 'timeout' });
      await s.say('cancel');
      for (const t of ['withdraw 50 to my bank account', '1234567890', 'Capitec', 'Lisa Moyo']) await s.say(t);
      await ageState(4);
      const t1 = await s.say('FN123456');
      const t2 = await s.say('Zimbabwe');
      await ageState(4);
      const t3 = await s.say('yes');
      const t4 = await s.say('yes');
      await ageState(4);
      const before = ottCalls.length;
      const t5 = await s.say(QA_PIN);
      const usedLatePin = ottCalls.length !== before;
      const t6 = await s.say('cancel');
      for (const t of ['withdraw 50']) await s.say(t);
      await ageState(4);
      const t7 = await s.say('2580');
      const t8 = await s.say('2580');
      const t9 = await s.say('8001015009087');
      for (const t of ['withdraw 50 to my bank account', '1234567890', 'Capitec', 'Lisa Moyo']) await s.say(t);
      await ageState(30);
      const t10 = await s.say('FN123456');
      process.env.WAPAY_AGENT_V3_MSISDNS = QA_WA_ID;
      const t11 = await s.say('2580');
      const t12 = await s.say('8001015009087');
      const leak = (r) => has(r.replyText, /enter your (?:wapay )?pin|being confirmed|on its way|is being processed/i);
      verdict('Lisa 9: a timed-out withdrawal never hands her ID or PIN to the AI; late answers carry on or are confirmed again; nothing is paid on a late PIN', [
        { level: 'FAIL', ok: has(t1.replyText, /Which country issued that passport/), what: 'her ID four hours later carries the withdrawal on (the country is asked)' },
        { level: 'FAIL', ok: has(t2.replyText, /Please confirm:/), what: 'then the confirmation, everything shown before any PIN' },
        { level: 'FAIL', ok: has(t3.replyText, /checking it with you again before your PIN/) && has(t3.replyText, /Please confirm:/), what: 'a late YES is confirmed again, never straight to the PIN' },
        { level: 'FAIL', ok: has(t4.replyText, /Enter your WaPay PIN/), what: 'a fresh YES reaches the PIN step' },
        { level: 'FAIL', ok: has(t5.replyText, /I did not use the PIN you just sent/) && !usedLatePin, what: 'a late PIN is not used and nothing reaches the rail' },
        { level: 'FAIL', ok: has(t6.replyText, /Cancelled|cancel/i), what: 'cancel ends it' },
        { level: 'FAIL', ok: has(t7.replyText, /timed out/) && has(t7.replyText, /nothing was paid/), what: 'a PIN after an early step timed out is told so, deterministically' },
        { level: 'FAIL', ok: has(t8.replyText, /Nothing is waiting for a PIN right now/), what: 'a bare PIN outside a flow never reaches the two-tier model' },
        { level: 'FAIL', ok: has(t9.replyText, /Nothing is waiting for an ID or passport number/), what: 'a bare ID outside a flow never reaches the two-tier model' },
        { level: 'FAIL', ok: has(t10.replyText, /stopped because it waited too long/) && has(t10.replyText, /Nothing was sent/), what: 'a day-old withdrawal says it stopped' },
        { level: 'FAIL', ok: has(t11.replyText, /Nothing is waiting for a PIN right now/) && has(t12.replyText, /Nothing is waiting for an ID or passport number/), what: 'the agent path: a bare PIN or ID never reaches the model either' },
        { level: 'FAIL', ok: ![t1, t2, t3, t5, t7, t8, t9, t10, t11, t12].some(leak), what: 'no reply asks for a PIN out of turn or claims a pay-out is under way' },
      ], s);
    } finally {
      await s.say('cancel').catch(() => {});
      for (const [k, v] of [['WAPAY_PAYOUT_ENABLED', prev.on], ['WAPAY_PAYOUT_KYC', prev.kyc], ['WAPAY_AGENT_V3_MSISDNS', prev.agent]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
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
        { level: 'FAIL', ok: !has(a.replyText, /\bOTT\b(?! vouchers?\b)/) || live, what: 'the payout partner is not named while withdrawals are off (the OTT voucher product may be)' },
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
      // This run really does settle an R50 FNB eWallet pay-out earlier (the
      // PerformPayout assertion above; R50 since the cash floor of 2026-10-10), so "the R50 withdrawal succeeded" is
      // TRUE and must be allowed. It used to be blocked by the receipt guard
      // and replaced with the fallback line, which is what the founder saw on
      // 2026-09-19. What must still never happen is a success claimed for an
      // amount this wallet never settled.
      const successClaim = has(d.replyText, /✅|went through|was successful|has gone through|paid/i);
      const figures = [...String(d.replyText || '').matchAll(/R\s?(\d+)/g)].map((m) => Number(m[1]));
      verdict('Agent: status question is answered from the record, never invented', [
        { level: 'FAIL', ok: !looksLikeMenu(d.replyText), what: 'no menu' },
        { level: 'FAIL', ok: !successClaim || figures.includes(50) || has(d.replyText, /no (recent|pending)|nothing|don't see|can't see|haven't/i), what: 'a success is claimed only for the R50 pay-out this run settled' },
        // 50/18/68/32/100: the pay-out, its fee, the total, the balance after, the funding; 250/20: the two open pay links this run creates.
        { level: 'FAIL', ok: !successClaim || figures.every((r) => [50, 18, 68, 32, 100, 250, 20].includes(r)), what: 'no figure this wallet never saw is called paid' },
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

  // ------------------------------------------------------------------
  // 6e. Launch scope (2026-10-18): the shipped default. Airtime, data,
  //     electricity, voucher loads and the OTT self-purchase read "coming
  //     soon" with what works today; the home card and the catalogue agree;
  //     send money and pay links stay live. docs/LAUNCH_SCOPE.md.
  // ------------------------------------------------------------------
  {
    const prevSwitches = Object.fromEntries(LAUNCH_SWITCHES.map((k) => [k, process.env[k]]));
    for (const k of LAUNCH_SWITCHES) delete process.env[k];
    try {
      await s.say('cancel');
      const a = await s.say('buy airtime');
      const b = await s.say('buy R50 electricity');
      const c = await s.say('show MTN bundles');
      const d = await s.say('Can I buy electricity?');
      const e2 = await s.say('What can I buy with this?');
      const f2 = await s.say('redeem voucher');
      await s.say('cancel');
      const g = await s.say('1234567812345678');
      const h = await s.say('buy an OTT voucher for R50');
      const i = await s.say('how much does it cost to deposit cash?');
      const j = await s.say('hi');
      const soon = (r) => has(r.replyText, /coming soon/i);
      const works = (r) => has(r.replyText, /Right now you can get paid with a "please pay me" link/);
      verdict('Launch scope: off products say coming soon and what works; nothing starts; home and catalogue agree', [
        { level: 'FAIL', ok: soon(a) && works(a) && !has(a.replyText, /How much airtime would you like/i), what: '"buy airtime" is coming soon, no amount ask' },
        { level: 'FAIL', ok: soon(b) && !has(b.replyText, /meter number/i), what: '"buy R50 electricity" is coming soon, no meter ask' },
        { level: 'FAIL', ok: soon(c) && !has(c.replyText, /MTN.*R\d/i), what: '"show MTN bundles" is coming soon, no bundle list' },
        { level: 'FAIL', ok: soon(d) && !has(d.replyText, /R10 to R5000/), what: '"Can I buy electricity?" is coming soon, never the steps' },
        { level: 'FAIL', ok: has(e2.replyText, /Send money/i) && has(e2.replyText, /Get paid/i) && !has(e2.replyText, /Prepaid products you can buy here/) && has(e2.replyText, /Coming soon/), what: '"what can I buy" lists what works and names what is coming, no product menu' },
        { level: 'FAIL', ok: has(f2.replyText, /How much would you like to add/i) && soon(f2) && !has(f2.replyText, /Blu Voucher.*send me the code/i), what: '"redeem voucher" becomes the card / EFT amount ask with the cash position' },
        { level: 'FAIL', ok: soon(g) && !has(g.replyText, /Processing Voucher/i), what: 'a 16-digit PIN gets coming soon, never a redemption attempt' },
        { level: 'FAIL', ok: soon(h) && !has(h.replyText, /Confirm|enter your PIN/i), what: '"buy an OTT voucher" is coming soon, no preview' },
        { level: 'WARN', ok: soon(i) && !has(i.replyText, /keeps 6%/), what: 'the cash top-up fee question says coming soon, no Blu fee quoted' },
        { level: 'FAIL', ok: has(j.replyText, /\*Buy\*: airtime, data and electricity, coming soon/) && has(j.replyText, /by card or Instant EFT/) && has(j.replyText, /\*Send\*/), what: 'the home card: Buy coming soon, card-only deposit, Send live' },
        { level: 'FAIL', ok: ![a, b, c, d, e2, f2, g, h, i, j].some((r) => /[—–]|\b(bet|betting|casino)\b/i.test(String(r.replyText || ''))), what: 'copy rules hold in every reply' },
      ], s);
    } finally {
      for (const [k, v] of Object.entries(prevSwitches)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }

  // ------------------------------------------------------------------
  // 7. Ad arrivals (docs/AD_CHAT_FLOW.md, 2026-10-18): the tapped questions, no
  //    second welcome, onboarding straight in, the first link, the section-2
  //    truth for FAQs, and "stop". A fresh QA number with a synthetic referral.
  // ------------------------------------------------------------------
  {
    const AD_WA_ID = process.env.CHAT_QA_AD_WA_ID || '27600000902';
    const REF = { source_url: 'https://fb.me/wapay-qa', source_type: 'ad', source_id: 'qa-ad-1', headline: 'Please pay me', body: 'Get paid on WhatsApp', media_type: 'image', ctwa_clid: `qa-clid-${process.pid}` };
    const teardownAd = async () => {
      const acc = await prisma.account.findFirst({ where: { waId: AD_WA_ID } });
      if (!acc) return;
      await prisma.paymentRequest.updateMany({ where: { accountId: acc.id, status: 'PENDING' }, data: { status: 'CANCELLED' } }).catch(() => {});
      await prisma.paymentRequest.deleteMany({ where: { accountId: acc.id } }).catch(() => {});
      await prisma.authFactor.deleteMany({ where: { accountId: acc.id } }).catch(() => {});
      await prisma.conversationTurn.deleteMany({ where: { accountId: acc.id } }).catch(() => {});
      await prisma.agentTurn.deleteMany({ where: { accountId: acc.id } }).catch(() => {});
      await prisma.otpCode.deleteMany({ where: { accountId: acc.id } }).catch(() => {});
      await prisma.consent.deleteMany({ where: { accountId: acc.id } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { accountId: acc.id } }).catch(() => {});
      await prisma.wallet.deleteMany({ where: { accountId: acc.id } }).catch(() => {});
      await prisma.account.delete({ where: { id: acc.id } }).catch(() => {});
    };
    const existing = await prisma.account.findFirst({ where: { waId: AD_WA_ID } });
    if (existing && existing.onboardingState === 'S5_COMPLETED' && existing.profile?.acquisitionSource !== 'ad') {
      console.log('[SKIP] Ad arrival: CHAT_QA_AD_WA_ID belongs to a real account; set another number');
    } else {
      await teardownAd();
      const prevOtp = process.env.WAPAY_ONBOARDING_OTP;
      // The harness cannot read a real one-time code; the OTP step is skipped so
      // PIN and consent still run. Production keeps the OTP.
      process.env.WAPAY_ONBOARDING_OTP = 'off';
      try {
        const ad = createSession(AD_WA_ID);
        const a = await ad.say('What does it cost?', { referral: REF, profile: { name: 'Thandi QA' } });
        const b = await ad.say('How it works');
        const c = await ad.say('Open my account');
        const d = await ad.say('2580');
        const e = await ad.say('I accept');
        const f = await ad.say('R20 from Thandi for the test');
        const g = await ad.say('Can I buy airtime?');
        const h = await ad.say('How do I get my money out?');
        const i = await ad.say('stop');
        const row = await prisma.account.findFirst({ where: { waId: AD_WA_ID } });
        const attr = row?.profile?.attribution || {};
        const links = row ? await prisma.paymentRequest.count({ where: { accountId: row.id } }) : 0;
        const banned = /\b(banking|send money|transfer|withdraw|cash ?out)\b/i;
        verdict('Ad arrival: Q3 → how it works → open → PIN → consent → first link → FAQ → stop', [
          { level: 'FAIL', ok: has(a.replyText, /Under R50, getting paid is free/) && has(a.replyText, /\[Open my account\]/), what: 'the cost answer carries the open-account button' },
          { level: 'FAIL', ok: !has(a.replyText, /Welcome to WaPay/i) && !a.replies.some((r) => /onboarding_step_1/.test(r.text)), what: 'no second welcome, no welcome template' },
          { level: 'FAIL', ok: has(b.replyText, /Forward the payment link we send you/), what: '"How it works" answers the three steps' },
          { level: 'FAIL', ok: has(c.replyText, /Great, Thandi/) && has(c.replyText, /pin|onboarding_step_3/i), what: '"Open my account" greets by name and reaches the PIN step at once' },
          { level: 'FAIL', ok: has(d.replyText, /accept|consent|onboarding_step_4|Step 3 of 3/i), what: 'the PIN moves to the consent step' },
          { level: 'FAIL', ok: has(e.replyText, /Let's get you paid\. Who owes you, and how much\?/), what: 'completion asks for the first link, not the business question' },
          { level: 'FAIL', ok: has(f.replyText, /Here's your payment link for R20: https:\/\/pleasepayme\.co\.za\/PR[A-HJKMNP-Z]{6}/) && has(f.replyText, /Forward it to Thandi/), what: '"R20 from Thandi" mints the link with the short forwardable copy' },
          { level: 'FAIL', ok: links === 1, what: 'exactly one link exists' },
          { level: 'FAIL', ok: has(g.replyText, /coming soon/), what: '"Can I buy airtime?" is coming soon' },
          { level: 'FAIL', ok: has(h.replyText, /PayShap/) && has(h.replyText, /\[Nedbank cash\]/), what: 'money-out answer with the three pay-out buttons' },
          { level: 'FAIL', ok: has(i.replyText, /no more reminders/i) && attr.reminderOptOut === true, what: '"stop" opts out of the reminder' },
          { level: 'FAIL', ok: attr.entry === 'Q3' && Boolean(attr.ctwaClid) && Boolean(attr.onboardedAt), what: 'the account carries entry Q3, the click id and the onboarding time' },
          { level: 'FAIL', ok: [a, b, c, d, e, f, g, h, i].every((t) => !banned.test(t.replyText)), what: 'no banned word anywhere in the flow' },
        ], ad);
        await teardownAd();
        const ad2 = createSession(AD_WA_ID);
        const q1 = await ad2.say('Open my WaPay account', { referral: REF, profile: { name: 'Sipho QA' } });
        verdict('Ad arrival: Q1 goes straight into onboarding', [
          { level: 'FAIL', ok: has(q1.replyText, /Great, Sipho\. Let's open your WaPay account/) && has(q1.replyText, /pin|onboarding_step_3/i), what: 'one greeting line, then the first onboarding step' },
          { level: 'FAIL', ok: !q1.replies.some((r) => /onboarding_step_1/.test(r.text)), what: 'the welcome template is skipped' },
        ], ad2);
      } finally {
        if (prevOtp === undefined) delete process.env.WAPAY_ONBOARDING_OTP; else process.env.WAPAY_ONBOARDING_OTP = prevOtp;
        await teardownAd();
      }
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
