/**
 * Payouts (money OUT) on OTT's payout rail — the service behind the business
 * dashboard's "Pay out" and, later, the in-chat withdraw flow (founder ask
 * 2026-09-10). Built against docs/OTT_PAYOUT_API.md §8: the reference hold
 * pattern, exactly like a VAS vend.
 *
 *   KYC gate → SPEND→CASH upgrade (withdrawals only ever leave CASH) →
 *   reserveHold(CASH, amount + fee) → OttPayoutClient.performPayout →
 *     SETTLE  → settleHold(buildCashout) + book the rail cost
 *     PENDING → keep the hold; the webhook / GetPaymentStatus finalises
 *     RELEASE → releaseHold + move the money back to SPEND; nothing paid
 *
 * Money rules kept (lib/ledger-core.js): integer cents, deterministic
 * epoch-free idemKeys (one per step, derived from the caller's intentId),
 * flat banded customer fees, rail cost incl. VAT booked separately. Never
 * releases a hold on PENDING. Every dependency (prisma, the ledger, the OTT
 * client) is injectable so the whole flow is unit-tested without a bank.
 *
 * Gates: WAPAY_PAYOUT_ENABLED=true (counsel gate: cash-out ends the
 * no-cash-out posture, docs/OTT_PAYOUT_API.md §1) + the OTT_PAYOUT_* creds;
 * WAPAY_PAYOUT_KYC=off skips the KYC check in the sandbox ONLY.
 */

import crypto from 'node:crypto';
import prisma from './prisma.js';
import { OttPayoutClient } from './ott-payout.js';
import { ACCT, BALANCE, buildCashout, buildCashoutRailCost, buildBalanceUpgrade, cashoutFeeCents } from './ledger-core.js';
import * as ledgerPost from './ledger-post.js';

export const PAYOUT_METHODS = {
  PAYSHAP: { label: 'PayShap', hint: 'Instant, to any bank account or ShapID', match: /shap/i, fields: ['account_number', 'branch_code', 'mobile'] },
  RTC: { label: 'Bank transfer (RTC)', hint: 'Real-time clearing to any bank, usually within minutes', match: /rtc|real.?time/i, fields: ['account_number', 'branch_code'] },
  CASHSEND: { label: 'Cash at an ATM (CashSend)', hint: 'Absa or Nedbank cardless cash; no bank account needed', match: /cash.?send/i, fields: ['mobile'] },
};
export const MIN_PAYOUT_CENTS = Number(process.env.WAPAY_PAYOUT_MIN_CENTS ?? 2000);
export const MAX_PAYOUT_CENTS = Number(process.env.WAPAY_PAYOUT_MAX_CENTS ?? 300000);

export function payoutEnabled() { return process.env.WAPAY_PAYOUT_ENABLED === 'true'; }
export function payoutConfigured() {
  return ['OTT_PAYOUT_BASE_URL', 'OTT_PAYOUT_USERNAME', 'OTT_PAYOUT_PASSWORD', 'OTT_PAYOUT_API_KEY'].every((k) => !!process.env[k]);
}
export function kycRequired() { return process.env.WAPAY_PAYOUT_KYC !== 'off'; }
export function accountKycVerified(account) {
  const p = account?.profile;
  return !!(p && typeof p === 'object' && p.kyc && p.kyc.status === 'VERIFIED');
}

const mask = (s) => (s ? `•••${String(s).slice(-3)}` : null);
const log = (type, data) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));

/** The customer's flat fee for a method, and what they must have available. */
export function quotePayout({ method, amountCents }) {
  if (!PAYOUT_METHODS[method]) throw Object.assign(new Error('Unknown payout method'), { code: 'BAD_METHOD' });
  if (!Number.isInteger(amountCents) || amountCents < MIN_PAYOUT_CENTS || amountCents > MAX_PAYOUT_CENTS) {
    throw Object.assign(new Error(`Amount must be between ${MIN_PAYOUT_CENTS} and ${MAX_PAYOUT_CENTS} cents`), { code: 'BAD_AMOUNT', minCents: MIN_PAYOUT_CENTS, maxCents: MAX_PAYOUT_CENTS });
  }
  const feeCents = cashoutFeeCents(method, amountCents);
  return { method, amountCents, feeCents, totalCents: amountCents + feeCents, label: PAYOUT_METHODS[method].label };
}

/** OTT's merchant reference: deterministic from the idemKey, 16 chars, no epoch. */
export function payoutReference(idemKey) {
  return `WP${crypto.createHash('sha256').update(String(idemKey)).digest('hex').slice(0, 14).toUpperCase()}`;
}

export function validateIntentId(raw) {
  return /^[A-Za-z0-9-]{8,64}$/.test(String(raw || '')) ? String(raw) : null;
}

/** Recipient fields, cleaned; throws BAD_RECIPIENT with the missing field. */
export function cleanRecipient(method, raw = {}) {
  const t = (v, max = 60) => String(v ?? '').trim().slice(0, max);
  const digits = (v) => String(v ?? '').replace(/\D/g, '');
  const r = {
    firstname: t(raw.firstname, 40),
    surname: t(raw.surname, 40),
    id_number: digits(raw.id_number).slice(0, 13),
    mobile: digits(raw.mobile).replace(/^0/, '27').slice(0, 11),
    account_number: digits(raw.account_number).slice(0, 20),
    branch_code: digits(raw.branch_code).slice(0, 8),
    branch_name: t(raw.branch_name, 60),
    bank_id: t(raw.bank_id, 20),
    email: t(raw.email, 80),
  };
  const need = ['firstname', 'surname', ...(PAYOUT_METHODS[method]?.fields || [])];
  for (const k of need) if (!r[k]) throw Object.assign(new Error(`Missing ${k}`), { code: 'BAD_RECIPIENT', field: k });
  if (r.mobile && !/^27\d{9}$/.test(r.mobile)) throw Object.assign(new Error('Bad mobile'), { code: 'BAD_RECIPIENT', field: 'mobile' });
  if (r.id_number && r.id_number.length !== 13) throw Object.assign(new Error('Bad ID number'), { code: 'BAD_RECIPIENT', field: 'id_number' });
  return r;
}

/**
 * OTT's live providers mapped onto our methods (never hardcoded codes,
 * docs §5 #9). Cached briefly: the list changes rarely and every payout
 * form load would otherwise cost an OTT round trip.
 */
let providerCache = { at: 0, value: null };
export async function resolveProviders({ client, now = Date.now(), ttlMs = 5 * 60 * 1000 } = {}) {
  if (providerCache.value && now - providerCache.at < ttlMs) return providerCache.value;
  const c = client || new OttPayoutClient({ timeoutMs: 8000 });
  const fn = typeof c.getActiveProviderLimits === 'function' ? 'getActiveProviderLimits' : typeof c.getActiveProvidersLimits === 'function' ? 'getActiveProvidersLimits' : 'getActiveProviders';
  const yourUniqueReference = `WPL${crypto.randomBytes(6).toString('hex').toUpperCase()}`; // a correlation id for a read, not money
  const body = await c[fn]({ yourUniqueReference });
  const list = body?.providers || body?.data || body?.body?.providers || (Array.isArray(body) ? body : []);
  const providers = [];
  for (const [method, def] of Object.entries(PAYOUT_METHODS)) {
    const hit = (list || []).find((p) => def.match.test(String(p.providerName || p.name || p.provider || '')));
    if (!hit) continue;
    providers.push({
      method,
      label: def.label,
      hint: def.hint,
      providerCode: String(hit.providerCode ?? hit.code ?? hit.id ?? ''),
      providerName: String(hit.providerName || hit.name || ''),
      minCents: hit.min != null ? Math.round(Number(hit.min) * 100) : null,
      maxCents: hit.max != null ? Math.round(Number(hit.max) * 100) : null,
      requiredFields: Array.isArray(hit.requiredFields || hit.required) ? hit.requiredFields || hit.required : def.fields,
    });
  }
  providerCache = { at: now, value: providers };
  return providers;
}
export function _resetProviderCache() { providerCache = { at: 0, value: null }; }

/** Balances an account can pay out from (SPEND is upgraded to CASH on the way). */
export async function payoutBalances({ prisma: prismaClient = prisma, accountId }) {
  const wallets = await prismaClient.wallet.findMany({ where: { accountId } });
  const get = (t) => wallets.find((w) => w.balanceType === t)?.availableCents || 0;
  return { spendCents: get(BALANCE.SPEND), cashCents: get(BALANCE.CASH), totalCents: get(BALANCE.SPEND) + get(BALANCE.CASH) };
}

function serialisePayout(pr) {
  const m = pr.metadata && typeof pr.metadata === 'object' ? pr.metadata : {};
  return {
    reference: m.reference || null,
    method: m.method || null,
    amountCents: m.amountCents ?? null,
    feeCents: m.feeCents ?? null,
    status: pr.status,
    outcome: m.outcome || null,
    recipient: m.recipient || null,
    providerRef: pr.providerRef || null,
    createdAt: pr.requestTs,
    finalisedAt: m.finalisedAt || null,
  };
}

export async function listPayouts({ prisma: prismaClient = prisma, accountId, limit = 50 }) {
  const rows = await prismaClient.providerRequest.findMany({ where: { accountId, route: 'ott-payout' }, orderBy: { requestTs: 'desc' }, take: Math.min(200, Math.max(1, Number(limit) || 50)) });
  return rows.map(serialisePayout);
}

/** Move CASH back to SPEND after a payout that paid nothing. Idempotent. */
function buildBalanceDowngrade({ accountId, amountCents, idemKey }) {
  return {
    idemKey,
    source: 'BALANCE_DOWNGRADE',
    postings: [
      { accountCode: ACCT.wallet(accountId, BALANCE.CASH), debitCents: amountCents },
      { accountCode: ACCT.wallet(accountId, BALANCE.SPEND), creditCents: amountCents },
    ],
    meta: { accountId, amountCents, reason: 'payout not performed' },
  };
}

/**
 * One payout, end to end. Idempotent on `intentId` (the browser mints one
 * per form): a double submit replays the recorded outcome instead of paying
 * twice. Returns { ok, status: 'SETTLED'|'PENDING'|'FAILED', reference, … }.
 */
export async function requestPayout({
  prisma: prismaClient = prisma,
  ledger = ledgerPost,
  client = null,
  account,
  intentId,
  method,
  amountCents,
  recipient: rawRecipient,
  businessId = null,
  providers = null,
}) {
  if (!payoutEnabled()) return { ok: false, error: 'DISABLED' };
  if (!payoutConfigured() && !client) return { ok: false, error: 'NOT_CONFIGURED' };
  if (!account?.id) return { ok: false, error: 'NO_ACCOUNT' };
  const id = validateIntentId(intentId);
  if (!id) return { ok: false, error: 'BAD_INTENT' };
  let quote;
  let recipient;
  try {
    quote = quotePayout({ method, amountCents });
    recipient = cleanRecipient(method, rawRecipient);
  } catch (e) {
    return { ok: false, error: e.code || 'BAD_REQUEST', field: e.field, minCents: e.minCents, maxCents: e.maxCents };
  }
  if (kycRequired() && !accountKycVerified(account)) return { ok: false, error: 'KYC_REQUIRED' };

  const idemKey = `payout-${account.id}-${id}`;
  const reference = payoutReference(idemKey);
  const masked = { name: `${recipient.firstname} ${recipient.surname}`.trim(), mobile: mask(recipient.mobile), account: mask(recipient.account_number) };

  // Replay: the same intent again returns what happened the first time.
  const existing = await prismaClient.providerRequest.findUnique({ where: { idemKey } });
  if (existing) {
    const s = serialisePayout(existing);
    return { ...s, ok: existing.status !== 'FAILED', replayed: true, status: existing.status === 'SUCCESS' ? 'SETTLED' : existing.status === 'PENDING' ? 'PENDING' : 'FAILED', reference };
  }
  const baseMeta = { method, amountCents, feeCents: quote.feeCents, reference, recipient: masked, businessId, intentId: id };
  await prismaClient.providerRequest.create({ data: { provider: 'OTT', route: 'ott-payout', idemKey, status: 'INIT', accountId: account.id, metadata: baseMeta } });
  const record = (status, extra = {}, providerRef) =>
    prismaClient.providerRequest.update({ where: { idemKey }, data: { status, ...(providerRef ? { providerRef } : {}), metadata: { ...baseMeta, ...extra } } }).catch(() => {});

  // Provider for this method, from OTT's live list.
  const list = providers || (await resolveProviders({ client }).catch(() => []));
  const provider = list.find((p) => p.method === method);
  if (!provider) { await record('FAILED', { outcome: 'NO_PROVIDER' }); return { ok: false, error: 'NO_PROVIDER', reference }; }

  // 1. SPEND → CASH for amount + fee (withdrawals only ever leave CASH).
  try {
    await ledger.ensureWallet({ accountId: account.id, balanceType: BALANCE.CASH });
    await ledger.postEntry(buildBalanceUpgrade({ accountId: account.id, amountCents: quote.totalCents, idemKey: `${idemKey}-upgrade` }));
  } catch (e) {
    if (e?.name === 'InsufficientFundsError' || /insufficient/i.test(String(e?.message))) {
      await record('FAILED', { outcome: 'INSUFFICIENT_FUNDS' });
      return { ok: false, error: 'INSUFFICIENT_FUNDS', reference, totalCents: quote.totalCents };
    }
    throw e;
  }
  // 2. Lock it.
  await ledger.reserveHold({ accountId: account.id, amountCents: quote.totalCents, idemKey: `${idemKey}-hold`, balanceType: BALANCE.CASH, reason: `payout ${method} ${reference}` });

  // 3. Pay.
  const c = client || new OttPayoutClient({ timeoutMs: 20000 });
  const result = await c.performPayout({ amountCents, providerCode: provider.providerCode, providerName: provider.providerName, recipient, yourUniqueReference: reference });
  log('payout_perform', { accountId: account.id, reference, method, amountCents, outcome: result.outcome, settlement: result.settlement });

  if (result.settlement === 'SETTLE') {
    await ledger.settleHold({ idemKey: `${idemKey}-hold`, entry: buildCashout({ accountId: account.id, amountCents, idemKey: `${idemKey}-cashout`, method }) });
    await ledger.postEntry(buildCashoutRailCost({ amountCents, idemKey: `${idemKey}-railcost`, method })).catch(() => {});
    await record('SUCCESS', { outcome: result.outcome, finalisedAt: new Date().toISOString() }, result.paymentReference || null);
    return { ok: true, status: 'SETTLED', reference, amountCents, feeCents: quote.feeCents, providerRef: result.paymentReference || null };
  }
  if (result.settlement === 'PENDING') {
    await record('PENDING', { outcome: result.outcome, reconcileRequired: !!result.reconcileRequired }, result.paymentReference || null);
    return { ok: true, status: 'PENDING', reference, amountCents, feeCents: quote.feeCents, providerRef: result.paymentReference || null };
  }
  // RELEASE: nothing was paid. Unlock and put the money back where it was.
  await ledger.releaseHold({ idemKey: `${idemKey}-hold`, reason: `payout ${result.outcome}` });
  await ledger.postEntry(buildBalanceDowngrade({ accountId: account.id, amountCents: quote.totalCents, idemKey: `${idemKey}-downgrade` })).catch(() => {});
  await record('FAILED', { outcome: result.outcome, providerStatus: result.status, finalisedAt: new Date().toISOString() });
  return { ok: false, status: 'FAILED', error: result.outcome || 'FAILED', reference };
}

/**
 * Finalise a PENDING payout from the webhook or a GetPaymentStatus poll.
 * status 100 = paid → settle; 98/99 = still pending → no-op; ≤97 = failed →
 * release + money back. Idempotent: a repeat is a no-op.
 */
export async function finalisePayout({ prisma: prismaClient = prisma, ledger = ledgerPost, reference, status, message = '' }) {
  const rows = await prismaClient.providerRequest.findMany({ where: { route: 'ott-payout', metadata: { path: ['reference'], equals: reference } }, take: 1 });
  const pr = rows[0];
  if (!pr) return { ok: false, error: 'UNKNOWN_REFERENCE' };
  if (pr.status !== 'PENDING') return { ok: true, noop: true, status: pr.status };
  const m = pr.metadata || {};
  const who = { accountId: pr.accountId, amountCents: m.amountCents, feeCents: m.feeCents, method: m.method, reference: m.reference || reference };
  const idemKey = pr.idemKey;
  const s = String(status);
  if (s === '98' || s === '99') return { ok: true, noop: true, status: 'PENDING' };
  const finalise = async (st, extra) =>
    prismaClient.providerRequest.update({ where: { idemKey }, data: { status: st, metadata: { ...m, ...extra, finalisedAt: new Date().toISOString(), lastMessage: String(message).slice(0, 160) } } });
  if (s === '100') {
    await ledger.settleHold({ idemKey: `${idemKey}-hold`, entry: buildCashout({ accountId: pr.accountId, amountCents: m.amountCents, idemKey: `${idemKey}-cashout`, method: m.method }) });
    await ledger.postEntry(buildCashoutRailCost({ amountCents: m.amountCents, idemKey: `${idemKey}-railcost`, method: m.method })).catch(() => {});
    await finalise('SUCCESS', { outcome: 'SUCCESS' });
    log('payout_finalised', { reference, status: 'SUCCESS' });
    return { ok: true, status: 'SETTLED', ...who };
  }
  await ledger.releaseHold({ idemKey: `${idemKey}-hold`, reason: `payout webhook status ${s}` });
  await ledger.postEntry(buildBalanceDowngrade({ accountId: pr.accountId, amountCents: (m.amountCents || 0) + (m.feeCents || 0), idemKey: `${idemKey}-downgrade` })).catch(() => {});
  await finalise('FAILED', { outcome: `PROVIDER_${s}` });
  log('payout_finalised', { reference, status: 'FAILED', providerStatus: s });
  return { ok: true, status: 'FAILED', ...who };
}
