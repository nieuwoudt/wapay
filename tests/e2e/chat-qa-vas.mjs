/**
 * VAS chat scenarios from the founder's live run of 2026-10-06 (Blu UAT thread).
 *
 *   node --env-file=.env --experimental-test-module-mocks tests/e2e/chat-qa-vas.mjs
 *
 * Drives the REAL processMessage() through the shared harness (real DB on the
 * harness account, WhatsApp transport captured, OTT mocked). The three VAS
 * preview routes are HTTP routes the harness cannot serve, so this runner
 * answers them in-process (`previewStub`): it is the ROUTE contract that is
 * stubbed (ok / INSUFFICIENT_BALANCE with the two figures), never Blu, and
 * the chat is exercised exactly as production would see it. No PIN is ever
 * entered, so no money moves.
 *
 * Scenarios (each one a founder screenshot):
 *   1. "buy 50MB Vodacom data for 0720012345" right after browsing bundles
 *      must reach the purchase confirm, never the bundle list again.
 *   2. "buy R20 electricity for meter 000001020001" must reach the
 *      electricity confirm without asking for the meter a second time.
 *   3. A purchase the balance cannot cover names the gap, sends the top-up
 *      link in the same turn and parks; "hello" says the top-up has not
 *      landed; once it has, any message re-runs the purchase.
 *   4. The same shortfall shape on data, resuming into the confirm.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { seedQaAccount, teardownQaAccount, createSession, fundQaAccount, QA_WA_ID } from './chat-harness.mjs';

const results = [];
const has = (text, re) => re.test(String(text || ''));
function verdict(name, checks, session) {
  const failed = checks.filter((c) => c.level === 'FAIL' && !c.ok);
  const warned = checks.filter((c) => c.level === 'WARN' && !c.ok);
  const status = failed.length ? 'FAIL' : warned.length ? 'WARN' : 'PASS';
  results.push({ name, status, checks: checks.map((c) => `${c.ok ? '✅' : c.level === 'WARN' ? '⚠️' : '❌'} ${c.what}`), transcript: session.transcript.splice(0) });
  console.log(`[${status}] ${name}`);
}

// --------------------------------------------------------------------------
// Preview route stub: the contract the chat reads, nothing else.
// --------------------------------------------------------------------------
const previewStub = { airtime: 'ok', data: 'ok', electricity: 'ok', availableCents: 4000, requiredCents: 10000 };
const realFetch = globalThis.fetch;
let previewSeq = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const m = u.match(/\/api\/vas\/(airtime|data|electricity)\/preview/);
  if (!m) return realFetch(url, init);
  const kind = m[1];
  const body = init?.body ? JSON.parse(init.body) : {};
  const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  if (previewStub[kind] === 'insufficient') {
    return json(400, { error: 'USER_INPUT', code: 'INSUFFICIENT_BALANCE', availableCents: previewStub.availableCents, requiredCents: previewStub.requiredCents, message: `Insufficient balance. Available: R${(previewStub.availableCents / 100).toFixed(2)}` });
  }
  previewSeq += 1;
  if (kind === 'airtime') return json(200, { ok: true, previewId: `preview-air-qa${previewSeq}`, preview: { type: 'airtime', msisdn: body.msisdn, amountCents: body.amountCents, vendorId: 'mtn', vendorName: 'MTN', feeCents: 0, totalCents: body.amountCents } });
  if (kind === 'data') return json(200, { ok: true, previewId: `preview-data-qa${previewSeq}`, preview: { type: 'data', msisdn: body.msisdn, productId: body.productId, vendorId: body.vendorId, amountCents: 300, totalCents: 300, productName: 'Daily WhatsApp 50MB' } });
  return json(200, { ok: true, previewId: `preview-elec-qa${previewSeq}`, preview: { reference: 'QA-ELEC-REF', transactionTypeId: 'TT-QA', utility: 'Eskom', consumer: { name: 'QA Customer', address: 'QA Street' }, amountCents: body.amountCents, serviceFee: 100, totalCents: Number(body.amountCents) + 100 } });
};

async function run() {
  await seedQaAccount();
  await fundQaAccount({ cents: 4000 });
  const s = createSession();

  // 1. Data purchase sentence after browsing bundles
  {
    const a = await s.say('show me vodacom bundles');
    const b = await s.say('buy 50MB Vodacom data for 0720012345');
    verdict('Data: a complete purchase sentence after browsing reaches the confirm, not the list', [
      { level: 'WARN', ok: has(a.replyText, /bundle|data/i), what: 'browsing shows bundles (sets the active category)' },
      { level: 'FAIL', ok: !has(b.replyText, /Data Bundles\*?\n|show a few great options/i), what: 'the purchase sentence is NOT answered with the bundle list' },
      { level: 'FAIL', ok: has(b.replyText, /50MB|Daily WhatsApp|confirm|YES/i), what: 'it reaches the data confirm (bundle named, YES/NO)' },
    ], s);
    await s.say('cancel');
  }

  // 2. Electricity: amount and meter in one message
  {
    previewStub.electricity = 'ok';
    const a = await s.say('buy R20 electricity for meter 000001020001');
    verdict('Electricity: amount + meter in one message goes straight to the confirm', [
      { level: 'FAIL', ok: !has(a.replyText, /enter your meter number/i), what: 'the meter is NOT asked for again' },
      { level: 'FAIL', ok: has(a.replyText, /Confirm Electricity/i) && has(a.replyText, /000001020001/), what: 'the electricity confirm shows the meter and the amount' },
      { level: 'FAIL', ok: has(a.replyText, /R20\.00/), what: 'the chosen amount is quoted, not a default' },
    ], s);
    await s.say('no');
  }

  // 3. Airtime shortfall: name the gap, send the link, park, resume
  {
    previewStub.airtime = 'insufficient'; previewStub.availableCents = 4000; previewStub.requiredCents = 10000;
    const a = await s.say('buy R100 airtime for 0830012300');
    const b = await s.say('any news?');
    await fundQaAccount({ cents: 10000, key: 'topup' });
    previewStub.airtime = 'ok';
    // "hi" is the usual first word back from the payment page: a greeting
    // goes home everywhere else (founder rule), but a funded park resumes.
    const c = await s.say('hi');
    verdict('Airtime shortfall: gap named, top-up link in the same turn, parked, then resumed', [
      { level: 'FAIL', ok: !has(a.replyText, /Please try again later/i), what: 'no dead-end "try again later"' },
      { level: 'FAIL', ok: has(a.replyText, /You have R40(\.00)? available/i) && has(a.replyText, /needs R100/i), what: 'the two figures are stated' },
      { level: 'FAIL', ok: has(a.replyText, /Top up R60(\.00)?/i), what: 'the top-up asked for is exactly the difference' },
      { level: 'FAIL', ok: has(a.replyText, /payfast|pay\.|https?:\/\//i) || has(a.replyText, /payment fee/i), what: 'a deposit link (with its fee) is in the same turn' },
      // The deposit-status hook may answer this one first ("still confirming your R60"): also true, also keeps the park.
      { level: 'FAIL', ok: has(b.replyText, /hasn't landed yet|has not landed|still confirming/i), what: 'a message while parked: top-up not landed yet (or still confirming), park kept' },
      { level: 'FAIL', ok: has(c.replyText, /Confirm Airtime Purchase/i) && has(c.replyText, /R100/), what: 'once the money is there, even "hi" re-runs the purchase to the confirm' },
    ], s);
    await s.say('no');
  }

  // 4. Data shortfall resumes into the confirm
  {
    previewStub.data = 'insufficient'; previewStub.availableCents = 14000; previewStub.requiredCents = 20000;
    const a = await s.say('buy 50MB Vodacom data for 0720012345');
    const b = await s.say('yes');
    await fundQaAccount({ cents: 6000, key: 'topup2' });
    previewStub.data = 'ok';
    const c = await s.say('thanks');
    verdict('Data shortfall: parked at the confirm, resumed into the confirm once funded', [
      { level: 'FAIL', ok: has(a.replyText, /YES/i), what: 'the data confirm is shown first' },
      { level: 'FAIL', ok: has(b.replyText, /available/i) && has(b.replyText, /Top up R60(\.00)?/i), what: '"yes" at a shortfall names the gap and asks for exactly the difference' },
      { level: 'FAIL', ok: has(c.replyText, /top-up landed/i) && has(c.replyText, /YES/i), what: 'once funded, the confirm is re-offered' },
    ], s);
    await s.say('no');
  }

  await teardownQaAccount();

  const date = new Date().toISOString().slice(0, 10);
  const lines = [`# Chat QA (VAS flows), ${date}`, '', `Harness account ${QA_WA_ID}; preview routes stubbed in-process (route contract only); no PIN entered, no money moved.`, ''];
  for (const r of results) {
    lines.push(`## [${r.status}] ${r.name}`, '', ...r.checks.map((c) => `- ${c}`), '', '```');
    for (const t of r.transcript) lines.push(`> ${t.user}`, t.bot, '');
    lines.push('```', '');
  }
  mkdirSync(new URL('../../docs/testing/', import.meta.url), { recursive: true });
  writeFileSync(new URL(`../../docs/testing/chat-qa-vas-report-${date}.md`, import.meta.url), lines.join('\n'));
  console.log(`\nReport: docs/testing/chat-qa-vas-report-${date}.md`);
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} scenarios pass`);
  process.exit(failed ? 1 : 0);
}

run().catch(async (e) => { console.error(e); try { await teardownQaAccount(); } catch {} process.exit(1); });
