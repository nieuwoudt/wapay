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
  // 6. Languages: switch, localized replies, non-English inbound
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
