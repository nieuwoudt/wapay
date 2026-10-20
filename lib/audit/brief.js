/**
 * The reviewer's brief for the daily conversation audit (docs/audits/
 * DAILY_AUDIT.md). docs/audits/REVIEW_BRIEF.md is the human version; this
 * module generates the part that must never go stale, "what is true today",
 * from the same registries every customer surface renders from
 * (lib/capabilities.js, lib/vas-config.js, lib/fee-facts.js, lib/payouts.js),
 * so a feature switched on in Vercel changes what the checker judges against
 * the same night. The severity rubric and the correct-behaviour list follow,
 * then the hand-maintained process checks (docs/audits/PROCESS_CHECKS.md).
 *
 * Deterministic: the same switches, providers and process checks give the
 * same text. English, no em dashes, no word about games of chance, no date. Nothing here
 * touches a database; the live pay-out providers are read by the run and
 * handed in (best effort, with the production fallback below).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { worksToday, launchScopeFor } from '../capabilities.js';
import { comingSoonPhrases, joinAnd } from '../vas-config.js';
import { feeSchedule } from '../fee-facts.js';
import { resolveProviders, PAYOUT_METHODS, MIN_PAYOUT_CENTS, MAX_PAYOUT_CENTS, CASH_MIN_CENTS, payoutEnabled } from '../payouts.js';
import { MIN_DEPOSIT_CENTS, MAX_DEPOSIT_CENTS, paymentRequestFeeCents, grossedUpRequestCents } from '../deposits.js';
import { CAN_DO } from '../ad-flow.js';
import { MIN_REQUEST_CENTS, MAX_REQUEST_CENTS } from '../payment-requests.js';
import { VAS_LIMITS } from '../how-it-works.js';
import { CATEGORIES } from './rules.js';

const R = (cents) => (cents % 100 === 0 ? `R${cents / 100}` : `R${(cents / 100).toFixed(2)}`);
const pct = (bps) => `${(bps / 100).toString().replace(/\.0$/, '')}%`;

/** The production rails when the live list cannot be read (docs/audits/DAILY_AUDIT_BRIEF.md). */
export const FALLBACK_PROVIDERS = Object.freeze([
  { method: 'PAYSHAP', label: PAYOUT_METHODS.PAYSHAP.label },
  { method: 'CASHSEND', label: PAYOUT_METHODS.CASHSEND.label },
  { method: 'NEDCASH', label: PAYOUT_METHODS.NEDCASH.label },
]);

/**
 * The live pay-out methods from the rail, best effort: null when the rail is
 * off, unconfigured, slow or down (the truth block then names the fallback).
 */
export async function liveProviders({ resolve = resolveProviders, timeoutMs = 4000, enabled = payoutEnabled() } = {}) {
  if (!enabled) return null;
  try {
    const list = await Promise.race([
      resolve({}),
      new Promise((resolve_) => { const t = setTimeout(() => resolve_(null), timeoutMs); if (t.unref) t.unref(); }),
    ]);
    if (!Array.isArray(list) || !list.length) return null;
    return list.map((p) => ({ method: p.method, label: p.label || PAYOUT_METHODS[p.method]?.label || p.method, minCents: p.minCents || null, maxCents: p.maxCents || null }));
  } catch (error) {
    console.error(JSON.stringify({ type: 'audit_providers_unavailable', error: error?.message || String(error) }));
    return null;
  }
}

/** The methods the truth block names: the rail's live list, or the production methods of record. Pure. */
export function methodList(providers) {
  const known = new Set(Object.keys(PAYOUT_METHODS));
  const list = (providers && providers.length ? providers : FALLBACK_PROVIDERS).filter((p) => known.has(p.method));
  return list.length ? list : [...FALLBACK_PROVIDERS];
}

/** The smallest withdrawal on production: the rail floor, never the bare product constant. Pure. */
export function minWithdrawCents(providers) {
  const list = methodList(providers);
  // Cash never goes below the R50 cash floor whatever the provider's own minimum says (lib/payouts.js methodLimits);
  // a bank method takes the provider's minimum. The second real run (2026-10-19) read a R10 cardless minimum from the
  // rail and told the reviewer the minimum was R20, so every correct "from R50" became a wrong fact.
  const cash = new Set(['CASHSEND', 'NEDCASH', 'EWALLET']);
  const floors = list.map((p) => (cash.has(p.method) ? Math.max(CASH_MIN_CENTS, p.minCents || 0) : (p.minCents && p.minCents > 0 ? p.minCents : CASH_MIN_CENTS)));
  return Math.max(MIN_PAYOUT_CENTS, Math.min(...floors));
}

function withdrawMethodsLine(providers, s) {
  const list = methodList(providers);
  const has = (m) => list.some((p) => p.method === m);
  const names = list.map((p) => p.label);
  const absent = Object.entries(PAYOUT_METHODS).filter(([m]) => !has(m)).map(([, d]) => d.label);
  const lines = [`Withdrawal methods on production${providers && providers.length ? ' (read from the rail at run time)' : ' (the rail list could not be read; these are the production methods of record)'}: ${joinAnd(names)}.`];
  if (absent.length) lines.push(`Methods that do NOT exist on production, whatever older copy said: ${joinAnd(absent)}. A bot line offering one of these is a P1 wrong fact.`);
  if (s.withdraw.live) {
    const cs = s.withdraw.cashsend;
    const fees = [];
    if (has('PAYSHAP')) fees.push(`${R(s.withdraw.payshapCents)} by PayShap to the customer's own bank account`);
    if (has('RTC')) fees.push(`${R(s.withdraw.rtcCents)} by bank transfer`);
    if (has('CASHSEND') || has('NEDCASH')) fees.push(`cash ${R(cs[0][1])} up to ${R(cs[0][0])}, ${R(cs[1][1])} up to ${R(cs[1][0])}, ${R(cs[2][1])} above that`);
    lines.push(`Withdrawal fees the customer pays: ${fees.join('; ')}. Minimum ${R(minWithdrawCents(providers))} (the rail floor), maximum ${R(MAX_PAYOUT_CENTS)}; a smaller minimum quoted to a customer is a wrong fact.`);
  }
  return lines;
}

/**
 * truthBlock({ providers, waId }) -> string: "what is true today", generated.
 * `providers` is liveProviders()' answer (null = fallback). `waId` scopes the
 * switches to one customer; the audit judges every customer, so it uses the
 * everyone scope (null).
 */
export function truthBlock({ providers = null, waId = null } = {}) {
  const scope = launchScopeFor({ waId });
  const s = feeSchedule({ withdrawLive: scope.withdrawLive });
  const soon = comingSoonPhrases(scope, { wicodeLive: scope.wicodeLive });
  const liveNow = [];
  liveNow.push(`getting paid with a "please pay me" link (${R(MIN_REQUEST_CENTS)} to ${R(MAX_REQUEST_CENTS)}; the person paying never pays a fee; free under ${R(s.request.freeBelowCents)}, above that ${pct(s.request.bps)} + ${R(s.request.fixedCents)} comes off what the requester receives; a request for an amount a link was just made for is that link, not a second one)`);
  liveNow.push(`adding money by card, Instant EFT, Apple Pay, Google Pay, Samsung Pay, Capitec Pay, SnapScan or Zapper through PayFast (all of these are live for deposits; ${R(MIN_DEPOSIT_CENTS)} to ${R(MAX_DEPOSIT_CENTS)}; ${pct(s.deposit.bps)} + ${R(s.deposit.fixedCents)} on top, rounded up to the next rand; the full amount lands in the balance; the link is an add-money link, never a payment link)`);
  if (scope.bluLoad) liveNow.push(`adding cash with a Blu voucher from a till (the network keeps ${pct(s.cashVoucher.keptBps)}, so a R100 voucher adds ${R(s.cashVoucher.creditedPerHundred)})`);
  liveNow.push(`sending money to any SA number (${R(VAS_LIMITS.VOUCHER[0])} to ${R(VAS_LIMITS.VOUCHER[1])} at a time, free, balance to balance; a non-member's money is held and lands when they join, or comes back after 30 days; never a voucher, never a fee, never the customer's own number)`);
  const on = ['airtime', 'data', 'electricity'].filter((k) => scope[k]);
  if (on.length) liveNow.push(`buying ${joinAnd(on)} (no WaPay fee, the product price)`);
  if (scope.wicodeLive) liveNow.push('buying fuel vouchers');
  if (scope.voucher) liveNow.push('buying a WaPay (OTT) voucher for yourself (free)');
  liveNow.push(scope.withdrawLive
    ? `withdrawing to the customer's own bank account or as cash at an ATM (${R(minWithdrawCents(providers))} to ${R(MAX_PAYOUT_CENTS)}; an SA ID or a passport / foreign ID with its issuing country; the PIN typed only at the flow's own PIN step; a wrong PIN never ends the flow; "forgot PIN" works from anywhere)`
    : 'withdrawals are NOT live: a bot that starts or promises one is wrong');
  liveNow.push('balance and transactions (answered from the ledger, never by the model)');
  liveNow.push('forgot PIN (a code to this WhatsApp number, the whole ID when one is on file, the new PIN twice)');
  liveNow.push('business accounts by invitation only ("business account" puts the uninvited on a waitlist; that is correct)');
  // The first real run (2026-10-19) flagged 54 "P1 wrong facts" that were readings of these four things: the payer's
  // methods, who carries the card fee, the fee arithmetic, and the business invite list taken for account opening.
  const ex = (cents) => ({ amount: R(cents), fee: R(paymentRequestFeeCents(cents)), net: R(cents - paymentRequestFeeCents(cents)), gross: R(grossedUpRequestCents(cents)) });
  const e1 = ex(30000), e2 = ex(15000);
  const facts = [
    `Opening an account is open to anyone with a WhatsApp number, no invitation and no waitlist: a welcome, a code, a PIN, consent, done. Only WaPay for Business is by invitation; never read the business list as a rule about opening an account.`,
    `A payer can pay a link with ${CAN_DO.payMethods}, and never needs WaPay. The payer pays exactly the displayed amount; the card fee comes off what the REQUESTER receives. A bot line naming any of these methods is correct.`,
    `Fee arithmetic on a card-paid link: ${pct(s.request.bps)} + ${R(s.request.fixedCents)}, rounded up to 10 cents, off what the requester receives, nothing under ${R(s.request.freeBelowCents)}. Worked: a ${e1.amount} link costs ${e1.fee} by card so the requester receives ${e1.net}; option 2 is a ${e1.gross} link so they receive at least ${e1.amount}. A ${e2.amount} link: ${e2.fee} off, ${e2.net} received, or a ${e2.gross} link. Both options of the chooser are correct as quoted; flag a fee only when this formula gives a different number than the bot's.`,
    `The ad flow's scripted answers (how it works, what it costs, the four tapped questions, the first-link prompt) are hand-written from these facts and are correct; flag one only when it contradicts a line here word for word.`,
  ];

  const lines = [
    'WHAT IS TRUE TODAY (generated from the registry at run time; judge against this, never against what you assume):',
    `- ${worksToday({ waId })} ("by card or Instant EFT" is the customer's short form; every PayFast method named below is live for deposits and for paying a link.)`,
    `- Live for every customer: ${liveNow.join('; ')}.`,
  ];
  if (soon.length) {
    lines.push(`- Coming soon, not available today: ${joinAnd(soon)}. A bot that says coming soon (never a date) and then what works today is CORRECT. A bot that sells, starts, explains the steps of, or quotes a fee for one of these is a P1.`);
  } else {
    lines.push('- Nothing is marked coming soon today.');
  }
  lines.push(...facts.map((l) => `- ${l}`));
  lines.push(...withdrawMethodsLine(providers, s).map((l) => `- ${l}`));
  lines.push('- The chat never asks for the wallet PIN outside a flow\'s own PIN step, never says a pay-out is under way unless the record has one pending, never names the pay-out partner, never promises a date or a time, never promotes games of chance or their operators, never offers a product line that is coming soon.');
  lines.push('- The three-tier gate at a R0 balance is correct behaviour (the third tier brings in a person). "That was my example" to the first-link example typed back, and "WaPay does not pay you itself" to "nobody owes me", are the correct answers.');
  return lines.join('\n');
}

export const SEVERITY_RUBRIC = [
  'SEVERITY:',
  '- P1: a wrong fact (fees, limits, what is live, methods that do not exist), a money intent executed wrongly or not at all, a security or privacy problem, a customer told something impossible or harmful, a coming-soon product sold or started.',
  '- P2: a customer stuck or looping, an unanswered message, a menu dump to a specific question, a contradiction between two bot turns, language mishandling, a promise of a date or a person that never came, the business flow misfiring.',
  '- P3: tone and clarity, small copy errors, missed opportunities.',
].join('\n');

export const CORRECT_BEHAVIOUR = [
  'CORRECT BEHAVIOUR THAT IS NOT A BUG:',
  '- the three-tier gate at a R0 balance (the third tier asks a person);',
  '- a coming-soon answer, without a date, for anything the truth block lists as coming soon; "coming soon" or "not available today" in a bot line is never a wrong fact, whatever it names, and the add-money message that ends with cash top-ups coming soon is correct;',
  '- the invite-only business list and the waitlist answer;',
  '- a fixed answer to a bare PIN, ID or passport typed outside a step (the model is never shown them);',
  '- a flow asking again for a step that timed out, and a withdrawal confirmed again with the money read fresh;',
  '- [number], [name], [[N1]], [[P1]] and [[S1]] in the text are the audit\'s own masks, never a bug.',
].join('\n');

export function outputInstructions({ knownTitles = [] } = {}) {
  const lines = [
    'OUTPUT: JSON only, in the schema given. One finding per distinct problem; when the same problem appears for several accounts, list it once with the clearest account as accountId and the others in alsoAccountIds.',
    `category is one of: ${CATEGORIES.join(', ')}.`,
    'title: one plain English line, at most 120 characters, naming the problem (not the customer): no person, no number, no account id, no date.',
    'botQuote: the exact bot line (at most 200 characters) and userQuote: the customer line before it, copied from the transcript. at: the timestamp printed before that bot line.',
    'why: one sentence on why it is wrong against the truth block. fix: one or two sentences.',
    'rule: the line of WHAT IS TRUE TODAY the bot line contradicts, copied word for word (empty if none). confidence: 0 to 1, how sure you are that the quoted bot line contradicts that rule. A P1 needs a rule and confidence 0.8 or more; when you are less sure, give P3 and start the title with "Verify:". Fewer, certain findings beat many guesses.',
    'accountId: the id from the "## Account <id>" header of the transcript, exactly.',
    'patterns: what customers try that WaPay cannot do yet, where sign-ups drop, questions the bot could not answer (short lines, counts welcome). workedWell: what worked well.',
    'Report nothing the deterministic sweep already catches by itself (eWallet, a R20 minimum, an em dash, an error line, identical text three times) unless you add context.',
  ];
  if (knownTitles.length) {
    lines.push('KNOWN FINDINGS still open from earlier runs. Their presence here is NOT evidence that they happen in these transcripts: do not look for them. Only if you see the same problem again in a line quoted from this transcript, reuse the title VERBATIM so it counts as recurring:');
    for (const t of knownTitles.slice(0, 60)) lines.push(`- ${t}`);
  }
  return lines.join('\n');
}

/** docs/audits/PROCESS_CHECKS.md, read at call time; '' when unreadable (logged by the caller). */
export function readProcessChecks({ cwd = process.cwd() } = {}) {
  try {
    return readFileSync(join(cwd, 'docs', 'audits', 'PROCESS_CHECKS.md'), 'utf8');
  } catch {
    return '';
  }
}

/**
 * buildReviewBrief({ truth, processChecks, knownTitles }) -> the system text
 * for the reviewer. Deterministic in its inputs; the run passes the generated
 * truth block (with the live providers) and the process checks it read.
 */
export function buildReviewBrief({ truth = truthBlock(), processChecks = readProcessChecks(), knownTitles = [] } = {}) {
  const checks = String(processChecks || '').trim();
  return [
    'You review WhatsApp conversations between WaPay (a South African WhatsApp wallet) and its customers, one transcript per account, redacted (numbers and names are masked). Judge the bot, never the customer. Read every turn. BOT(kind) says which path answered: flow = scripted flow or orchestrator, agent = Pay agent, guard, home, receipt, ops = a person. A turn marked [context] happened before the window and was judged on an earlier day; use it only to understand the window.',
    '',
    truth,
    '',
    SEVERITY_RUBRIC,
    '',
    CORRECT_BEHAVIOUR,
    '',
    checks ? `PROCESS CHECKS (what correct looks like per feature, and what to flag):\n${checks}` : 'PROCESS CHECKS: unavailable in this run; judge against the truth block and the rubric.',
    '',
    outputInstructions({ knownTitles }),
  ].join('\n');
}
