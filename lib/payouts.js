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
  CASHSEND: { label: 'Cash at an Absa ATM (CashSend)', hint: 'Absa CashSend: cash at an Absa ATM or a Pick n Pay / Boxer till; no bank account needed', match: /cash.?send/i, fields: ['mobile'] },
  // 2026-09-15: the two other cash-collection providers on the OTT merchant (founder ask).
  NEDCASH: { label: 'Cash at a Nedbank ATM', hint: 'Nedbank cardless withdrawal with a code sent by SMS; no bank account needed', match: /nedbank cardless|cardless withdrawal/i, fields: ['mobile', 'id_number'] },
  EWALLET: { label: 'FNB eWallet', hint: 'Cash at any FNB ATM with the eWallet code sent by SMS; no bank account needed', match: /e-?wallet/i, fields: ['mobile', 'id_number'] },
};
export const MIN_PAYOUT_CENTS = Number(process.env.WAPAY_PAYOUT_MIN_CENTS ?? 2000);
export const MAX_PAYOUT_CENTS = Number(process.env.WAPAY_PAYOUT_MAX_CENTS ?? 300000);

export function payoutEnabled() { return process.env.WAPAY_PAYOUT_ENABLED === 'true'; }

/**
 * Per-user pilot gate for cash-out, mirroring VAS_ALLOWLIST_FUEL.
 *
 * Cash-out is the single most consequential rail we run: it is the thing
 * that makes WaPay look like e-money rather than a closed-loop voucher, it
 * is the one flow where money genuinely leaves, and the locked model is
 * "KYC on withdrawal only" (i.e. required there). While counsel clearance
 * is outstanding, WAPAY_PAYOUT_ENABLED=true alone opens withdrawal to
 * EVERY customer in chat, so this narrows it to named testers.
 *
 * Unset = unchanged behaviour (whoever passes the other gates). Set to a
 * comma-separated list of waIds and only those numbers can withdraw.
 */
export function payoutAllowedFor(waId) {
  if (!payoutEnabled()) return false;
  const raw = process.env.WAPAY_PAYOUT_ALLOWLIST;
  if (!raw) return true; // no pilot list configured: unchanged
  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  return allowed.includes(String(waId || '').trim());
}
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
export function quotePayout({ method, amountCents, minCents = MIN_PAYOUT_CENTS, maxCents = MAX_PAYOUT_CENTS }) {
  if (!PAYOUT_METHODS[method]) throw Object.assign(new Error('Unknown payout method'), { code: 'BAD_METHOD' });
  if (!Number.isInteger(amountCents) || amountCents < minCents || amountCents > maxCents) {
    throw Object.assign(new Error(`Amount must be between ${minCents} and ${maxCents} cents`), { code: 'BAD_AMOUNT', minCents, maxCents });
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
/** Recipient fields we know how to collect; anything else a provider marks Required is refused honestly. */
export const RECIPIENT_FIELDS = ['firstname', 'surname', 'id_number', 'mobile', 'account_number', 'branch_code', 'branch_name', 'bank_id', 'email', 'title', 'middle_name', 'date_of_birth', 'id_type', 'country_of_issue', 'nationality', 'account_name', 'swift_code'];
export function cleanRecipient(method, raw = {}, requiredFields = null) {
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
    title: t(raw.title, 10),
    middle_name: t(raw.middle_name, 40),
    date_of_birth: t(raw.date_of_birth, 10),
    id_type: t(raw.id_type, 20),
    country_of_issue: t(raw.country_of_issue, 3),
    nationality: t(raw.nationality, 3),
    account_name: t(raw.account_name, 60),
    swift_code: t(raw.swift_code, 11),
  };
  // OTT's live list wins (GetActiveProvidersLimits, parsed in resolveProviders); the static
  // method fields are the fallback when the list is unavailable.
  const fromProvider = Array.isArray(requiredFields) && requiredFields.length ? requiredFields.filter((f) => RECIPIENT_FIELDS.includes(f)) : null;
  const need = [...new Set(['firstname', 'surname', ...(fromProvider || PAYOUT_METHODS[method]?.fields || [])])];
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
/** OTT field names → ours (`account_Number`, `branch_Code`, `iD_type`, `dob`). */
export function normaliseFieldName(k) {
  const n = String(k || '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/__+/g, '_');
  return { i_d_type: 'id_type', dob: 'date_of_birth', middle_name: 'middle_name', account_name: 'account_name' }[n] || n;
}
/** The provider's Required fields from OTT's shape (an array holding one { field: 'Required'|'Optional' } object), or a plain string array. */
export function requiredFieldNames(hit, fallback = []) {
  const rf = hit?.requiredFields ?? hit?.required;
  if (Array.isArray(rf) && rf.length && typeof rf[0] === 'string') return rf.map(normaliseFieldName);
  if (Array.isArray(rf) && rf.length && rf[0] && typeof rf[0] === 'object') {
    const names = [];
    for (const obj of rf) for (const [k, v] of Object.entries(obj)) if (/^required$/i.test(String(v))) names.push(normaliseFieldName(k));
    if (names.length) return [...new Set(names)];
  }
  return fallback;
}
/**
 * System limits the OTT test portal shows per provider (Payout Providers page,
 * read 2026-09-15) but the API omits when the merchant override is 0.00.
 * Rand → cents. The API's own providerMinLimit / providerMaxLimit win when > 0.
 */
export const SYSTEM_LIMITS_CENTS = {
  'PayShap Account': { min: 5000, max: 15000000 },
  'ABSA CashSend': { min: 5000, max: 10000000 },
  'Nedbank Cardless Withdrawal': { min: 1000, max: 500000 },
  'FNB e-wallet': { min: 0, max: 2500000 },
};
/** Effective min/max for a method: WaPay's product limits narrowed by the live provider's. */
export function methodLimits(method, providers = []) {
  const p = (providers || []).find((x) => x.method === method);
  return {
    minCents: Math.max(MIN_PAYOUT_CENTS, p?.minCents || 0),
    maxCents: Math.min(MAX_PAYOUT_CENTS, p?.maxCents || Number.MAX_SAFE_INTEGER),
  };
}
let providerCache = { at: 0, value: null };
export async function resolveProviders({ client, now = Date.now(), ttlMs = 5 * 60 * 1000 } = {}) {
  if (providerCache.value && now - providerCache.at < ttlMs) return providerCache.value;
  const c = client || new OttPayoutClient({ timeoutMs: 8000 });
  const fn = typeof c.getActiveProviderLimits === 'function' ? 'getActiveProviderLimits' : typeof c.getActiveProvidersLimits === 'function' ? 'getActiveProvidersLimits' : 'getActiveProviders';
  const yourUniqueReference = `WPL${crypto.randomBytes(6).toString('hex').toUpperCase()}`; // a correlation id for a read, not money
  const body = await c[fn]({ yourUniqueReference });
  // GetActiveProvidersLimits answers { requiredFields: [ { providerCode, providerName, providerMinLimit, providerMaxLimit, requiredFields: [...] } ] };
  // GetActiveProviders answers { providers: [ { providerCode, providerName } ] }. Accept both.
  const raw = body?.requiredFields || body?.providers || body?.data || body?.body?.providers || (Array.isArray(body) ? body : []);
  const list = Array.isArray(raw) ? raw : [];
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
      minCents: Number(hit.providerMinLimit) > 0 ? Math.round(Number(hit.providerMinLimit) * 100) : hit.min != null ? Math.round(Number(hit.min) * 100) : SYSTEM_LIMITS_CENTS[String(hit.providerName || '')]?.min || null,
      maxCents: Number(hit.providerMaxLimit) > 0 ? Math.round(Number(hit.providerMaxLimit) * 100) : hit.max != null ? Math.round(Number(hit.max) * 100) : SYSTEM_LIMITS_CENTS[String(hit.providerName || '')]?.max || null,
      requiredFields: requiredFieldNames(hit, def.fields),
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
    reconcileRequired: !!m.reconcileRequired,
    providerStatus: m.lastProviderStatus ?? m.providerStatus ?? null,
    lastCheckedAt: m.lastCheckedAt || null,
  };
}

/**
 * A short, masked excerpt of a provider response for the intent row: long
 * digit runs (account, ID and cellphone numbers) are reduced to their last
 * three digits, and the whole thing is capped so a stray HTML error page
 * cannot bloat the row.
 */
function providerBodyExcerpt(body) {
  if (body == null) return null;
  let text;
  try { text = typeof body === 'string' ? body : JSON.stringify(body); } catch { text = String(body); }
  return text.replace(/\d{6,}/g, (d) => `***${d.slice(-3)}`).slice(0, 300);
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
  const idemKey = `payout-${account.id}-${id}`;
  const reference = payoutReference(idemKey);

  // Replay: the same intent again returns what happened the first time.
  const existing = await prismaClient.providerRequest.findUnique({ where: { idemKey } });
  if (existing) {
    const s = serialisePayout(existing);
    return { ...s, ok: existing.status !== 'FAILED', replayed: true, status: existing.status === 'SUCCESS' ? 'SETTLED' : existing.status === 'PENDING' ? 'PENDING' : 'FAILED', reference };
  }

  // Provider for this method, from OTT's live list: its limits and required fields decide the validation.
  const list = providers || (await resolveProviders({ client }).catch(() => []));
  const provider = list.find((p) => p.method === method);
  if (!provider) return { ok: false, error: 'NO_PROVIDER', reference };
  const lim = methodLimits(method, list);
  let quote;
  let recipient;
  try {
    quote = quotePayout({ method, amountCents, minCents: lim.minCents, maxCents: lim.maxCents });
    recipient = cleanRecipient(method, rawRecipient, provider.requiredFields);
  } catch (e) {
    return { ok: false, error: e.code || 'BAD_REQUEST', field: e.field, minCents: e.minCents, maxCents: e.maxCents, reference };
  }
  if (kycRequired() && !accountKycVerified(account)) return { ok: false, error: 'KYC_REQUIRED' };
  const masked = { name: `${recipient.firstname} ${recipient.surname}`.trim(), mobile: mask(recipient.mobile), account: mask(recipient.account_number) };
  const baseMeta = { method, amountCents, feeCents: quote.feeCents, reference, recipient: masked, businessId, intentId: id };
  await prismaClient.providerRequest.create({ data: { provider: 'OTT', route: 'ott-payout', idemKey, status: 'INIT', accountId: account.id, metadata: baseMeta } });
  const record = (status, extra = {}, providerRef) =>
    prismaClient.providerRequest.update({ where: { idemKey }, data: { status, ...(providerRef ? { providerRef } : {}), metadata: { ...baseMeta, ...extra } } }).catch(() => {});

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
    // Keep what OTT said (masked) so an operator can see WHY a pay-out
    // parked. The founder's first live PayShap (2026-09-15) sat as
    // PENDING/UNKNOWN with no response recorded and nothing to reconcile
    // from (BUGLOG #53).
    await record('PENDING', {
      outcome: result.outcome,
      reconcileRequired: !!result.reconcileRequired || result.outcome === 'UNKNOWN',
      providerStatus: result.status ?? null,
      httpStatus: result.httpStatus ?? null,
      providerBody: providerBodyExcerpt(result.body),
    }, result.paymentReference || null);
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

/**
 * Customer wording for a finalised pay-out, shared by the OTT webhook and
 * the reconcile route so the two paths can never say different things.
 */
export function payoutOutcomeMessage(out) {
  const rands = (c) => `R${(Number(c || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;
  const label = PAYOUT_METHODS[out.method]?.label || 'your pay-out';
  if (out.status === 'SETTLED') return `✅ Your withdrawal of ${rands(out.amountCents)} by ${label} has been paid (reference ${out.reference}).`;
  return `❌ Your withdrawal of ${rands(out.amountCents)} by ${label} could not be completed by the bank rail (reference ${out.reference}). The full amount and the fee are back in your WaPay balance.`;
}

/** The account's newest pay-out, any status: what "did my withdrawal go through" is answered from. */
export async function getLatestPayout({ prisma: prismaClient = prisma, accountId }) {
  if (!accountId) throw new Error('accountId is required');
  const row = await prismaClient.providerRequest.findFirst({ where: { accountId, route: 'ott-payout' }, orderBy: { requestTs: 'desc' } });
  return row ? serialisePayout(row) : null;
}

/**
 * Ask OTT what became of ONE pending pay-out and apply the answer.
 *
 * GetPaymentStatus is the poll fallback to the webhook (docs/OTT_PAYOUT_API.md
 * §5 #5). A known terminal code finalises through finalisePayout: 100 settles
 * the hold, a failure code releases it and the money returns to SPEND.
 * 98/99 and any code we do not recognise leave the hold exactly where it is,
 * stamped with what OTT said (we may have paid). A transport failure is
 * indeterminate and changes nothing. Never a second PerformPayout.
 */
// OTT answers -1 (auth), 1 (invalid logon) and 2 (invalid hash) when OUR
// request is wrong, on every endpoint. On PerformPayout that means nothing
// was paid; on GetPaymentStatus it says nothing about the pay-out at all, so
// it must never release a hold (review 2026-09-16: a rotated API key at
// 03:00 would otherwise refund every parked pay-out while the bank pays).
const REQUEST_ERROR_STATUSES = new Set(['-1', '1', '2']);
function isRequestError(probe) {
  return REQUEST_ERROR_STATUSES.has(String(probe?.status ?? ''));
}

export async function reconcilePayout({ prisma: prismaClient = prisma, ledger = ledgerPost, client = null, reference }) {
  if (!reference) return { ok: false, error: 'BAD_REFERENCE' };
  const rows = await prismaClient.providerRequest.findMany({ where: { route: 'ott-payout', metadata: { path: ['reference'], equals: reference } }, take: 1 });
  const pr = rows[0];
  if (!pr) return { ok: false, error: 'UNKNOWN_REFERENCE', reference };
  if (pr.status !== 'PENDING') return { ok: true, noop: true, status: pr.status === 'SUCCESS' ? 'SETTLED' : pr.status, reference };
  const c = client || new OttPayoutClient({ timeoutMs: 8000 });
  let probe;
  try {
    probe = await c.getPaymentStatus({ yourUniqueReference: reference });
  } catch (error) {
    log('payout_reconcile_indeterminate', { reference, reason: error?.code || error?.message });
    return { ok: true, status: 'PENDING', reference, checked: false, error: error?.code || 'TRANSPORT' };
  }
  const providerStatus = probe?.status ?? null;
  const message = String(probe?.body?.message || probe?.body?.errorMessage || '').slice(0, 160);
  if (isRequestError(probe)) {
    log('payout_reconcile_request_error', { reference, providerStatus, message });
    return { ok: true, status: 'PENDING', reference, checked: false, error: 'REQUEST_ERROR', providerStatus, message };
  }
  if (probe?.settlement === 'SETTLE' || probe?.settlement === 'RELEASE') {
    const out = await finalisePayout({ prisma: prismaClient, ledger, reference, status: providerStatus, message });
    log('payout_reconciled', { reference, providerStatus, result: out.status || out.error });
    return { ...out, reference, checked: true, providerStatus, message };
  }
  await prismaClient.providerRequest
    .update({ where: { idemKey: pr.idemKey }, data: { metadata: { ...(pr.metadata || {}), lastCheckedAt: new Date().toISOString(), lastProviderStatus: providerStatus, lastMessage: message } } })
    .catch(() => {});
  log('payout_reconcile_pending', { reference, providerStatus, outcome: probe?.outcome });
  return { ok: true, status: 'PENDING', reference, checked: true, providerStatus, outcome: probe?.outcome || 'UNKNOWN', message };
}

/**
 * Recover ONE pay-out stuck at INIT.
 *
 * requestPayout creates the INIT row, upgrades SPEND→CASH (`${idemKey}-upgrade`),
 * reserves the CASH hold (`${idemKey}-hold`) and only then calls PerformPayout;
 * a crash anywhere along that line leaves an INIT row with money upgraded
 * and/or held and nothing to finalise it (the normal sweep selects PENDING
 * only). This asks OTT GetPaymentStatus by OUR reference and applies the
 * answer, never a second PerformPayout:
 *
 *   100 (paid)        → the hold must exist; move the row to PENDING so
 *                       finalisePayout accepts it, then settle through it.
 *                       No hold = we cannot settle without inventing money:
 *                       NEEDS_OPERATOR, logged, nothing moves.
 *   98/99 or unknown  → OTT has the pay-out; PENDING with what OTT said so
 *                       the normal sweep carries it from here.
 *   no record / fail  → nothing was paid. Undo exactly what the ledger did:
 *                       release the hold if it is ACTIVE, post the downgrade
 *                       only if the upgrade entry exists, mark the row
 *                       FAILED (outcome INIT_ABANDONED_<status>) and return
 *                       the customer fields so the caller can say so with
 *                       payoutOutcomeMessage.
 *   transport failure → indeterminate; nothing changes (checked: false).
 *
 * Every ledger write is idempotent on its deterministic key, so a crash
 * mid-recovery is simply picked up again by the next sweep.
 */
export async function reconcileInitPayout({ prisma: prismaClient = prisma, ledger = ledgerPost, client = null, pr }) {
  if (!pr || pr.status !== 'INIT') return { ok: true, noop: true, status: pr?.status || null, reference: pr?.metadata?.reference || null };
  const m = pr.metadata && typeof pr.metadata === 'object' ? pr.metadata : {};
  const idemKey = pr.idemKey;
  const reference = m.reference || payoutReference(idemKey);
  const who = { accountId: pr.accountId, amountCents: m.amountCents, feeCents: m.feeCents, method: m.method, reference };
  const totalCents = (m.amountCents || 0) + (m.feeCents || 0);
  const holdKey = `${idemKey}-hold`;
  const c = client || new OttPayoutClient({ timeoutMs: 8000 });
  let probe;
  try {
    probe = await c.getPaymentStatus({ yourUniqueReference: reference });
  } catch (error) {
    log('payout_init_reconcile_indeterminate', { reference, reason: error?.code || error?.message });
    return { ok: true, status: 'INIT', reference, checked: false, error: error?.code || 'TRANSPORT' };
  }
  const providerStatus = probe?.status ?? null;
  const message = String(probe?.body?.message || probe?.body?.errorMessage || '').slice(0, 160);
  if (isRequestError(probe)) {
    log('payout_init_reconcile_request_error', { reference, providerStatus, message });
    return { ok: true, status: 'INIT', reference, checked: false, error: 'REQUEST_ERROR', providerStatus, message };
  }
  const checkedAt = new Date().toISOString();
  const stamp = { lastCheckedAt: checkedAt, lastProviderStatus: providerStatus, lastMessage: message };
  const setRow = (status, extra = {}) =>
    prismaClient.providerRequest.update({ where: { idemKey }, data: { status, metadata: { ...m, ...stamp, ...extra } } });
  const operator = async (why) => {
    log(why, { reference, providerStatus, message });
    await setRow('NEEDS_OPERATOR', { outcome: why.toUpperCase(), providerStatus, providerBody: providerBodyExcerpt(probe?.body) });
    return { ok: false, status: 'NEEDS_OPERATOR', reference, checked: true, providerStatus, outcome: why.toUpperCase(), message };
  };
  const hold = await prismaClient.hold.findUnique({ where: { idemKey: holdKey } });

  if (probe?.settlement === 'SETTLE') {
    if (!hold) return operator('payout_init_settled_without_hold');
    await setRow('PENDING', { outcome: 'INIT_RECOVERED', reconcileRequired: true, providerStatus });
    const out = await finalisePayout({ prisma: prismaClient, ledger, reference, status: providerStatus, message });
    log('payout_init_reconciled', { reference, providerStatus, result: out.status || out.error });
    return { ...out, reference, checked: true, providerStatus, message };
  }

  const noRecord = String(providerStatus) === '0' || /failed to retrieve/i.test(message);
  if (probe?.settlement !== 'RELEASE' && !noRecord) {
    // 98/99 or a code we do not know: OTT has it, we may have paid. The normal sweep takes it from here.
    if (!hold) return operator('payout_init_pending_without_hold');
    await setRow('PENDING', { outcome: probe?.outcome || 'UNKNOWN', reconcileRequired: true, providerStatus });
    log('payout_init_pending', { reference, providerStatus, outcome: probe?.outcome });
    return { ok: true, status: 'PENDING', reference, checked: true, providerStatus, outcome: probe?.outcome || 'UNKNOWN', message };
  }

  // No record at OTT or a definitive failure: nothing was paid. Undo exactly what the ledger did.
  if (hold && hold.status === 'SETTLED') return operator('payout_init_hold_settled_but_provider_release');
  const upgrade = await prismaClient.journalEntry.findUnique({ where: { idemKey: `${idemKey}-upgrade` } });
  let released = false;
  if (hold && hold.status === 'ACTIVE') {
    await ledger.releaseHold({ idemKey: holdKey, reason: `payout abandoned at INIT (${providerStatus ?? 'no record'})` });
    released = true;
  }
  let downgraded = false;
  if (upgrade) {
    await ledger.postEntry(buildBalanceDowngrade({ accountId: pr.accountId, amountCents: totalCents, idemKey: `${idemKey}-downgrade` }));
    downgraded = true;
  }
  const outcome = `INIT_ABANDONED_${providerStatus ?? 'NONE'}`;
  await setRow('FAILED', { outcome, providerStatus, finalisedAt: checkedAt });
  log('payout_init_abandoned', { reference, providerStatus, released, downgraded, hadHold: !!hold, hadUpgrade: !!upgrade });
  return { ok: true, status: 'FAILED', ...who, checked: true, providerStatus, outcome, message, released, downgraded };
}

/**
 * Every pay-out still PENDING after `olderThanMs`, plus every one still INIT
 * after `initOlderThanMs` (a crash between the ledger and OTT), oldest first,
 * each reconciled. One row's failure never stops the others.
 */
export async function reconcilePendingPayouts({ prisma: prismaClient = prisma, ledger = ledgerPost, client = null, olderThanMs = 2 * 60 * 1000, initOlderThanMs = 10 * 60 * 1000, limit = 20, now = Date.now(), deadlineMs = 35 * 1000 } = {}) {
  const startedAt = Date.now();
  // Never reconcile an INIT row younger than five minutes: requestPayout may
  // still be inside its 20 s PerformPayout call (review 2026-09-16).
  initOlderThanMs = Math.max(Number(initOlderThanMs) || 0, 5 * 60 * 1000);
  const take = Math.min(100, Math.max(1, Number(limit) || 20));
  const pick = (status, ageMs) => prismaClient.providerRequest.findMany({
    where: { route: 'ott-payout', status, requestTs: { lt: new Date(now - ageMs) } },
    orderBy: { requestTs: 'asc' },
    take,
  });
  const rows = [...(await pick('PENDING', olderThanMs)), ...(await pick('INIT', initOlderThanMs))]
    .sort((a, b) => new Date(a.requestTs) - new Date(b.requestTs))
    .slice(0, take);
  if (rows.length === 0) return [];
  const c = client || new OttPayoutClient({ timeoutMs: 8000 });
  const results = [];
  for (const pr of rows) {
    // A cron function has a 60 s cap and OTT can take 8 s per row: stop
    // picking rows once the deadline passes; the rest wait for the next sweep.
    if (Date.now() - startedAt > deadlineMs) { results.push({ ok: false, error: 'DEADLINE', idemKey: pr.idemKey, status: pr.status }); break; }
    const reference = pr.metadata?.reference;
    try {
      if (pr.status === 'INIT') { results.push(await reconcileInitPayout({ prisma: prismaClient, ledger, client: c, pr })); continue; }
      if (!reference) { results.push({ ok: false, error: 'NO_REFERENCE', idemKey: pr.idemKey }); continue; }
      results.push(await reconcilePayout({ prisma: prismaClient, ledger, client: c, reference }));
    } catch (error) {
      log('payout_reconcile_row_failed', { reference: reference || null, idemKey: pr.idemKey, status: pr.status, reason: error?.code || error?.message });
      results.push({ ok: false, error: error?.code || 'RECONCILE_FAILED', reference: reference || null, idemKey: pr.idemKey, status: pr.status });
    }
  }
  return results;
}

/**
 * The scheduled sweep: reconcile every PENDING and INIT pay-out past its
 * grace period, then tell each customer whose pay-out finalised, in the same
 * words the webhook uses. `send` is injected ({ to, text }); by default the
 * WhatsApp sender is imported lazily so a unit test never touches it.
 * Returns the per-row results, who was told, and counts for the cron log.
 */
export async function sweepPayoutsAndNotify({
  send = null,
  olderThanMs = 2 * 60 * 1000,
  initOlderThanMs = 10 * 60 * 1000,
  limit = 20,
  deadlineMs = 35 * 1000,
  prisma: prismaClient = prisma,
  ledger = ledgerPost,
  client = null,
  now = Date.now(),
} = {}) {
  const counts = { swept: 0, settled: 0, failed: 0, pending: 0, needsOperator: 0, unchecked: 0, errors: 0, notified: 0, notifyFailed: 0 };
  if (!client && !payoutConfigured()) return { skipped: 'NOT_CONFIGURED', results: [], notified: [], counts };
  const results = await reconcilePendingPayouts({ prisma: prismaClient, ledger, client, olderThanMs, initOlderThanMs, limit, now, deadlineMs });
  const notified = [];
  let sendFn = send;
  for (const r of results) {
    counts.swept += 1;
    if (r.checked === false) counts.unchecked += 1;
    else if (r.status === 'NEEDS_OPERATOR') counts.needsOperator += 1;
    else if (r.ok === false) counts.errors += 1;
    else if (r.status === 'SETTLED' && !r.noop) counts.settled += 1;
    else if (r.status === 'FAILED' && !r.noop) counts.failed += 1;
    else counts.pending += 1;
    if (!(r.accountId && (r.status === 'SETTLED' || r.status === 'FAILED') && !r.noop)) continue;
    const account = await prismaClient.account.findUnique({ where: { id: r.accountId }, select: { waId: true } }).catch(() => null);
    if (!account?.waId) continue;
    try {
      if (!sendFn) sendFn = (await import('./say.js')).sendWhatsAppText;
      const sent = await sendFn({ to: account.waId, text: payoutOutcomeMessage(r) });
      // lib/say.js never throws: a transport failure comes back as ok:false
      // and must not be counted as a customer told.
      if (sent && sent.ok === false) {
        counts.notifyFailed += 1;
        log('payout_notify_failed', { reference: r.reference, reason: sent.error || 'SEND_FAILED' });
        continue;
      }
      notified.push(r.reference);
    } catch (error) {
      log('payout_notify_failed', { reference: r.reference, reason: error?.code || error?.message });
    }
  }
  counts.notified = notified.length;
  return { results, notified, counts };
}
