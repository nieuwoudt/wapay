/**
 * The reviewer's precision gate (first real run 2026-10-19: 54 of 59 "P1" findings
 * were misreadings): the brief states the facts it got wrong, and the parser
 * drops or demotes what cannot be a wrong fact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewOutput, gateFinding, REVIEW_SCHEMA, P1_CONFIDENCE } from '../lib/audit/review.js';
import { truthBlock, buildReviewBrief } from '../lib/audit/brief.js';

test('the schema asks for a cited rule and a confidence; the gate demotes an uncited or unsure P1 and drops the known misreadings', () => {
  assert.ok(REVIEW_SCHEMA.properties.findings.items.required.includes('rule'));
  assert.ok(REVIEW_SCHEMA.properties.findings.items.required.includes('confidence'));
  const base = { severity: 'P1', category: 'wrong-fact', title: 'Add-money flow sells cash top-ups', accountId: 'a', botQuote: 'Cash top-ups with Blu and OTT vouchers are coming soon on WaPay.', userQuote: 'add money', why: 'sells a coming-soon product', fix: 'x', rule: 'Coming soon: cash deposits', confidence: 0.95 };
  assert.deepEqual(parseReviewOutput({ findings: [base] }, { accountIds: ['a'] }).findings, [], 'a coming-soon line is never a wrong fact');
  const invite = { ...base, botQuote: "Let's open your account. It's three quick steps.", userQuote: 'Open my account', why: 'accounts are invite-only with a waitlist', rule: 'business accounts by invitation only' };
  assert.deepEqual(parseReviewOutput({ findings: [invite] }, { accountIds: ['a'] }).findings, [], 'the business invite list is not a rule about opening an account');
  const unsure = { ...base, botQuote: 'You receive R285.10 if they pay by card (R14.90 card cost).', why: 'fee looks wrong', rule: 'Fee arithmetic on a card-paid link', confidence: 0.4 };
  const [d] = parseReviewOutput({ findings: [unsure] }, { accountIds: ['a'] }).findings;
  assert.equal(d.severity, 'P3'); assert.match(d.title, /^Verify: /); assert.equal(d.rule, 'review'); assert.equal(d.cited, 'Fee arithmetic on a card-paid link'); assert.equal(d.confidence, 0.4);
  const uncited = { ...unsure, rule: '', confidence: 0.99 };
  assert.equal(parseReviewOutput({ findings: [uncited] }, { accountIds: ['a'] }).findings[0].severity, 'P3', 'no cited rule, no P1');
  const sure = { ...unsure, confidence: 0.9, botQuote: 'You can collect it as an FNB eWallet.' };
  const [k] = parseReviewOutput({ findings: [sure] }, { accountIds: ['a'] }).findings;
  assert.equal(k.severity, 'P1'); assert.equal(k.confidence, 0.9); assert.ok(!/^Verify/.test(k.title));
  assert.equal(gateFinding(null), null); assert.equal(P1_CONFIDENCE, 0.8);
  const noConf = parseReviewOutput({ findings: [{ severity: 'P2', category: 'stuck-loop', title: 'Loop', accountId: 'a' }] }, { accountIds: ['a'] }).findings[0];
  assert.equal(noConf.confidence, 0.5, 'a missing confidence reads as unsure'); assert.equal(noConf.severity, 'P2', 'only P1 is gated');
});

test('the brief states what the first run misread: open account opening, the payer methods, the fee arithmetic, the scripted ad answers', () => {
  const t = truthBlock({ providers: null });
  assert.match(t, /Opening an account is open to anyone with a WhatsApp number, no invitation and no waitlist/);
  assert.match(t, /A payer can pay a link with any credit, cheque or debit card, Apple Pay/);
  assert.match(t, /The payer pays exactly the displayed amount; the card fee comes off what the REQUESTER receives/);
  assert.match(t, /Worked: a R300 link costs R14\.90 by card so the requester receives R285\.10; option 2 is a R316 link/);
  assert.match(t, /A R150 link: R8\.60 off, R141\.40 received, or a R159 link/);
  assert.match(t, /The ad flow's scripted answers .* are correct; flag one only when it contradicts a line here word for word/);
  const b = buildReviewBrief({ truth: t, processChecks: '' });
  assert.match(b, /"coming soon" or "not available today" in a bot line is never a wrong fact/);
  assert.match(b, /A P1 needs a rule and confidence 0\.8 or more/);
  assert.ok(!/[—–]/.test(b), 'no em dashes in the brief');
});

test('the live-provider minimum never drops below the cash floor; deposits name every PayFast method', async () => {
  const { minWithdrawCents, truthBlock } = await import('../lib/audit/brief.js');
  assert.equal(minWithdrawCents([{ method: 'PAYSHAP', minCents: 5000 }, { method: 'NEDCASH', minCents: 1000 }, { method: 'CASHSEND', minCents: 5000 }]), 5000, 'a R10 cardless minimum from the rail does not make the minimum R20');
  assert.equal(minWithdrawCents([{ method: 'PAYSHAP', minCents: 3000 }]), 3000, 'a bank method takes the rail minimum');
  assert.equal(minWithdrawCents(null), 5000);
  assert.match(truthBlock({ providers: null }), /adding money by card, Instant EFT, Apple Pay, Google Pay, Samsung Pay, Capitec Pay, SnapScan or Zapper through PayFast/);
});
