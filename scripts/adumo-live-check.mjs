/**
 * Adumo live test reconciliation, READ-ONLY (docs/testing/adumo-production-2026-10-23.md).
 *
 * For each pay-link code paid through the Adumo rail, compares the three
 * records that must agree before the founder switches the primary rail:
 *   1. our books: the payment request, the intent (rail, fee, adumoOutcome)
 *      and the journal entry LOAD_ADUMO on the intent's idemKey;
 *   2. Adumo's reporting: getState by our merchant reference, through the
 *      production probe /api/internal/adumo-status?mref=… (the OAuth client
 *      lives in Vercel only, never on this machine);
 *   3. the Adumo portal: read by the founder and written into the record.
 *
 * Usage (fast copy, production database, one short Prisma process):
 *   node --env-file=.env scripts/adumo-live-check.mjs <CODE> [<CODE> …]
 * Env: DATABASE_URL, WAPAY_INTERNAL_API_KEY; APP_BASE_URL (default https://pleasepayme.co.za).
 * Writes nothing; prints masks only (no payer number, no card number).
 */
import prisma from '../lib/prisma.js';

const base = String(process.env.ADUMO_CHECK_BASE_URL || process.env.APP_BASE_URL || 'https://pleasepayme.co.za').replace(/\/+$/, '');
const key = process.env.WAPAY_INTERNAL_API_KEY || '';
const mask = (s) => (s ? `•••${String(s).slice(-3)}` : null);

async function probe(mref) {
  if (!key || !mref) return { error: key ? 'NO_REFERENCE' : 'NO_INTERNAL_KEY' };
  try {
    const r = await fetch(`${base}/api/internal/adumo-status?mref=${encodeURIComponent(mref)}`, { headers: { 'x-internal-api-key': key }, signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    return { httpStatus: r.status, build: j.build, switches: j.switches, tokenOk: j.reporting?.tokenOk ?? null, transaction: j.transaction || null };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT' };
  }
}

async function check(code) {
  const out = { code, checks: {} };
  const request = await prisma.paymentRequest.findUnique({ where: { id: code } });
  const intent = await prisma.providerRequest.findUnique({ where: { idemKey: `wapay-payreq-${code}` } });
  const entry = intent ? await prisma.journalEntry.findUnique({ where: { idemKey: intent.idemKey }, include: { lines: true } }) : null;
  const m = intent?.metadata || {};
  const gross = Number.isInteger(m.grossCents) ? m.grossCents : null;
  const fee = Number.isInteger(m.feeCents) ? m.feeCents : null;
  out.request = request ? { status: request.status, amountCents: request.amountCents, paidAt: request.paidAt, payerRef: request.payerRef } : null;
  out.intent = intent
    ? { provider: intent.provider, status: intent.status, providerRef: intent.providerRef, grossCents: gross, feeCents: fee, creditCents: m.amountCents ?? null, adumoRef: m.adumoRef || null, attempts: m.adumoAttempt || 0, payer: mask(m.payerMsisdn), adumoOutcome: m.adumoOutcome || null, adumoReport: m.adumoReport || null }
    : null;
  out.journal = entry ? { source: entry.source, createdAt: entry.createdAt, lines: entry.lines.map((l) => ({ account: l.accountCode.replace(/:[a-z0-9]{20,}:/i, ':<account>:'), debitCents: l.debitCents, creditCents: l.creditCents })) } : null;
  const p = await probe(m.adumoRef);
  out.adumo = p;

  const line = (pred) => entry?.lines.find(pred);
  const t = p.transaction || {};
  const state = t.state || {};
  out.checks = {
    requestPaid: request?.status === 'PAID' && request.payerRef?.startsWith('ADUMO:'),
    intentSettledOnAdumo: intent?.status === 'SUCCESS' && intent.provider === 'ADUMO',
    journalLoadAdumo: entry?.source === 'LOAD_ADUMO',
    clearingEqualsGross: gross !== null && line((l) => l.accountCode === 'CLEARING:ADUMO')?.debitCents === gross,
    walletEqualsCredit: m.amountCents != null && line((l) => /^WALLET:/.test(l.accountCode))?.creditCents === m.amountCents,
    feeBooked: fee === 0 ? !line((l) => l.accountCode.startsWith('REVENUE:FEE')) : line((l) => l.accountCode.startsWith('REVENUE:FEE'))?.creditCents === fee,
    adumoFound: t.found === true,
    adumoApprovedOrSettled: state.settled === true,
    adumoAmountEqualsGross: gross !== null && (state.transactionState === 'SETTLED' ? state.settledCents : state.authorisedCents) === gross,
    adumoCaptured: state.transactionState === 'SETTLED',
  };
  const must = ['requestPaid', 'intentSettledOnAdumo', 'journalLoadAdumo', 'clearingEqualsGross', 'walletEqualsCredit', 'feeBooked', 'adumoFound', 'adumoApprovedOrSettled', 'adumoAmountEqualsGross'];
  out.verdict = must.every((k) => out.checks[k]) ? (out.checks.adumoCaptured ? 'PASS (captured)' : 'PASS (authorised; recheck tomorrow for SETTLED)') : `FAIL: ${must.filter((k) => !out.checks[k]).join(', ')}`;
  return out;
}

const codes = process.argv.slice(2).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{6,12}$/.test(c));
if (!codes.length) {
  console.error('usage: node --env-file=.env scripts/adumo-live-check.mjs <CODE> [<CODE> …]');
  process.exit(2);
}
try {
  for (const code of codes) console.log(JSON.stringify(await check(code), null, 2));
} finally {
  await prisma.$disconnect();
}
