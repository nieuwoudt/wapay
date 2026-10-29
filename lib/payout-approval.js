/**
 * The founder approves every pay-out (2026-10-26): "I think we should manually approve the payout requests instead
 * of just running with them, to make sure it doesn't seem like fraud and it's not from the same numbers that we
 * expected as fraud in the past."
 *
 * With approval mode on (lib/payout-hold.js), requestPayout runs every check, the customer's PIN and the fraud
 * triage, sets the money aside (CASH, held) and stores the request as AWAITING_APPROVAL, with where it goes kept
 * encrypted (lib/pii-vault.js). The founder then:
 *   - approves (Mission Control's Pay-outs tab, or the signed link in the alert): the freeze is read again, the
 *     float must cover it, the request is claimed atomically (no double approval) and sent through the same rail
 *     step as an immediate pay-out (railAndSettle). A short float leaves it waiting, nothing lost.
 *   - rejects: the hold is released and the money moves back to SPEND; the customer is told it was not approved.
 * The customer hears the outcome on WhatsApp when the outcome can reach them (inside their 24-hour window, or by
 * the pay-out outcome template once WAPAY_TEMPLATE_PAYOUT_OUTCOME is set); otherwise it waits in their history
 * and they see it when they ask for the status. Never a time promise.
 */
import crypto from 'node:crypto';
import prismaDefault from './prisma.js';
import * as ledgerPost from './ledger-post.js';
import { decryptPii } from './pii-vault.js';
import { readPayoutFreeze } from './payout-freeze.js';
import { railAndSettle, buildBalanceDowngrade, defaultReadFloat, payoutOutcomeMessage, payoutOutcomeParams, payoutBalances, PAYOUT_METHODS } from './payouts.js';
import { onItsWayCopy, cancelledCopy } from './payout-status-copy.js';
import { cashoutRailCostCents } from './ledger-core.js';

export const APPROVAL_LINK_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const log = (type, data) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
const R = (c) => `R${(Number(c || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;

// ---------------------------------------------------------------------------
// The signed link in the founder's alert (the operator tap link's pattern, lib/ops-link.js)
// ---------------------------------------------------------------------------
function linkKey(env = process.env) {
  const secret = env.WAPAY_OPS_LINK_SECRET || env.WAPAY_INTERNAL_API_KEY || '';
  return secret ? crypto.createHash('sha256').update(`wapay-approval-link:v1:${secret}`).digest() : null;
}
const b64 = (b) => Buffer.from(b).toString('base64url');

/** A token naming ONE waiting pay-out, valid three days. The page it opens shows it and approves or rejects it. */
export function mintApprovalToken({ reference, now = Date.now(), ttlMs = APPROVAL_LINK_TTL_MS, env = process.env }) {
  const k = linkKey(env);
  if (!k || !/^WP[0-9A-F]{14}$/.test(String(reference || ''))) return null;
  const payload = b64(JSON.stringify({ r: reference, e: now + ttlMs }));
  return `${payload}.${b64(crypto.createHmac('sha256', k).update(payload).digest())}`;
}

export function verifyApprovalToken(token, { now = Date.now(), env = process.env } = {}) {
  const k = linkKey(env);
  if (!k) return { ok: false, reason: 'NO_SECRET' };
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return { ok: false, reason: 'MALFORMED' };
  const want = crypto.createHmac('sha256', k).update(payload).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, reason: 'BAD_SIGNATURE' };
  let body;
  try { body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'MALFORMED' }; }
  if (!body?.r || !Number.isFinite(body.e)) return { ok: false, reason: 'MALFORMED' };
  if (now > body.e) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, reference: body.r, expiresAt: body.e };
}

/** The page the founder taps (the API host serves /ops on every domain). */
export function approvalUrl(token, env = process.env) {
  const base = String(env.APP_BASE_URL || 'https://wapay-api.vercel.app').replace(/\/+$/, '');
  return `${base}/ops/approve?token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------
async function waitingRow(prisma, reference, statuses = ['AWAITING_APPROVAL']) {
  const rows = await prisma.providerRequest.findMany({ where: { route: 'ott-payout', status: { in: statuses }, metadata: { path: ['reference'], equals: String(reference || '') } }, take: 1 });
  return rows[0] || null;
}

/** What the founder sees for one waiting pay-out: no account number, no ID number. */
export async function approvalView({ prisma = prismaDefault, row }) {
  const m = row.metadata || {};
  const account = await prisma.account.findUnique({ where: { id: row.accountId }, select: { id: true, waId: true, displayName: true, createdAt: true, profile: true } }).catch(() => null);
  const wallets = await prisma.wallet.findMany({ where: { accountId: row.accountId }, select: { balanceType: true, availableCents: true, pendingCents: true } }).catch(() => []);
  return {
    reference: m.reference,
    status: row.status,
    requestedAt: m.approval?.requestedAt || row.requestTs,
    accountId: row.accountId,
    phone: account?.waId ? `•••${String(account.waId).slice(-4)}` : null,
    name: account?.profile?.kyc?.fullName || account?.displayName || null,
    accountAgeDays: account?.createdAt ? Math.floor((Date.now() - new Date(account.createdAt).getTime()) / 86400000) : null,
    idChecked: account?.profile?.kyc?.status === 'VERIFIED',
    frozen: account?.profile?.payouts?.frozen === true,
    method: m.method,
    methodLabel: PAYOUT_METHODS[m.method]?.label || m.method,
    amountCents: m.amountCents,
    feeCents: m.feeCents,
    express: !!m.express,
    to: m.recipient ? { name: m.recipient.name || null, account: m.recipient.account || null, mobile: m.recipient.mobile || null, idDoc: m.recipient.idDoc || null } : null,
    level: m.triage?.level ?? null,
    reasons: m.triage?.reasons || [],
    heldCents: wallets.reduce((s, w) => s + (Number(w.pendingCents) || 0), 0),
    availableCents: wallets.reduce((s, w) => s + (Number(w.availableCents) || 0), 0),
  };
}

/** Every pay-out waiting for the founder, oldest first. */
export async function listAwaitingApproval({ prisma = prismaDefault, take = 100 } = {}) {
  const rows = await prisma.providerRequest.findMany({ where: { route: 'ott-payout', status: 'AWAITING_APPROVAL' }, orderBy: { requestTs: 'asc' }, take });
  return Promise.all(rows.map((row) => approvalView({ prisma, row })));
}

/**
 * What the customer hears when the founder approves (BUGLOG #148): ✅ only when the bank has paid. PENDING means the
 * bank has the request and nothing more, so it is ⏳ "approved and on its way"; a failure says why
 * (lib/payout-status-copy.js). On 28 October a ✅ "approved and handed to the bank rail" was followed by a ❌ in
 * the same minute.
 */
export function approvedCopy(out) {
  if (out.status === 'SETTLED') return payoutOutcomeMessage({ ...out, status: 'SETTLED' });
  if (out.status === 'PENDING') return onItsWayCopy(out, { approved: true });
  return payoutOutcomeMessage({ ...out, status: 'FAILED' });
}

export function rejectedCopy(out) {
  const label = PAYOUT_METHODS[out.method]?.label || 'your withdrawal';
  return `❌ *Not approved.* Your ${R(out.amountCents)} withdrawal by ${label} was not approved, so it was not sent (reference ${out.reference}). The ${R(out.amountCents)} and the ${R(out.feeCents)} fee are back in your WaPay balance. Reply *person* to talk to someone from WaPay about it.`;
}

async function tellCustomer({ prisma, accountId, text, out, deps = {} }) {
  try {
    const account = await prisma.account.findUnique({ where: { id: accountId }, select: { waId: true } });
    if (!account?.waId) return { ok: false, error: 'NO_WA_ID' };
    const notify = deps.notifyCustomer || (await import('./notify.js')).notifyCustomer;
    const p = payoutOutcomeParams(out);
    return await notify({ to: account.waId, accountId, text, kind: 'receipt', templateEnv: 'WAPAY_TEMPLATE_PAYOUT_OUTCOME', templateParams: [p.amount, p.method, p.reference] });
  } catch (error) {
    return { ok: false, error: error?.message };
  }
}

/**
 * Approve one waiting pay-out and send it. Returns the rail's outcome, or { ok:false, error } with the row still
 * waiting (FLOAT_SHORT, a transient read) or already handled (NOT_WAITING). A frozen account is rejected instead.
 */
export async function approvePayout({ prisma = prismaDefault, ledger = ledgerPost, client = null, reference, by = 'founder', readFloat = null, now = Date.now(), deps = {} }) {
  const row = await waitingRow(prisma, reference);
  if (!row) return { ok: false, error: 'NOT_WAITING' };
  const m = row.metadata || {};
  if (await readPayoutFreeze({ prisma, accountId: row.accountId })) {
    const out = await rejectPayout({ prisma, ledger, reference, by: 'freeze', reason: 'the account was frozen while it waited', deps });
    return { ...out, ok: false, error: 'FROZEN' };
  }
  let secret;
  try {
    secret = JSON.parse(decryptPii(m.approval?.enc, m.approval?.keyVersion || 1));
  } catch (error) {
    log('payout_approval_unreadable', { reference, error: error?.code || error?.message });
    return { ok: false, error: 'DETAILS_UNREADABLE' };
  }
  // The float must cover it now; when it does not, the request keeps waiting (top up, then approve again).
  const needCents = m.amountCents + cashoutRailCostCents(m.method, m.amountCents) + 100;
  const fl = readFloat ? await readFloat().catch(() => null) : client ? null : await defaultReadFloat().catch(() => null);
  if (fl && Number.isInteger(fl.balanceCents) && fl.balanceCents < needCents) return { ok: false, error: 'FLOAT_SHORT', floatCents: fl.balanceCents, needCents, reference };
  // Claim it: exactly one approval can move it out of the queue.
  const approvalMeta = { requestedAt: m.approval?.requestedAt || null, approvedBy: String(by).slice(0, 60), approvedAt: new Date(now).toISOString() };
  const baseMeta = { ...m, approval: approvalMeta };
  const claimed = await prisma.providerRequest.updateMany({ where: { idemKey: row.idemKey, status: 'AWAITING_APPROVAL' }, data: { status: 'INIT', metadata: baseMeta } });
  if (claimed.count !== 1) return { ok: false, error: 'NOT_WAITING' };
  const record = (status, extra = {}, providerRef) =>
    prisma.providerRequest.update({ where: { idemKey: row.idemKey }, data: { status, ...(providerRef ? { providerRef } : {}), metadata: { ...baseMeta, ...extra } } }).catch(() => {});
  log('payout_approved', { reference, by: approvalMeta.approvedBy, accountId: row.accountId, amountCents: m.amountCents });
  const out = await railAndSettle({
    prismaClient: prisma, ledger, client, accountId: row.accountId, idemKey: row.idemKey, reference: m.reference, method: m.method,
    amountCents: m.amountCents, feeCents: m.feeCents, totalCents: (m.amountCents || 0) + (m.feeCents || 0), express: !!m.express,
    provider: { providerCode: secret.providerCode, providerName: secret.providerName }, recipient: secret.recipient, record,
  });
  // A failure tells the balance the money came back to (BUGLOG #146).
  const balanceCents = out.status === 'FAILED' ? (await payoutBalances({ prisma, accountId: row.accountId }).catch(() => null))?.totalCents ?? null : null;
  const told = await tellCustomer({ prisma, accountId: row.accountId, text: approvedCopy({ ...out, method: m.method, amountCents: m.amountCents, feeCents: m.feeCents, reference: m.reference, recipient: m.recipient, balanceCents }), out: { ...out, method: m.method, amountCents: m.amountCents, reference: m.reference }, deps });
  return { ...out, method: m.method, told: !!told?.ok };
}

/**
 * Reject one waiting pay-out: the money goes back to the customer's balance. Idempotent. The customer's own
 * "cancel withdrawal" (BUGLOG #147) is the same step with by 'customer' and outcome CANCELLED_BY_CUSTOMER; the
 * chat answers it itself (tell: false), so the customer gets one message, not two.
 */
export async function rejectPayout({ prisma = prismaDefault, ledger = ledgerPost, reference, by = 'founder', reason = 'not approved', outcome = 'REJECTED', tell = true, now = Date.now(), deps = {} }) {
  const row = await waitingRow(prisma, reference, ['AWAITING_APPROVAL', 'REJECTING']);
  if (!row) return { ok: false, error: 'NOT_WAITING' };
  const m = row.metadata || {};
  if (row.status === 'AWAITING_APPROVAL') {
    const claimed = await prisma.providerRequest.updateMany({ where: { idemKey: row.idemKey, status: 'AWAITING_APPROVAL' }, data: { status: 'REJECTING' } });
    if (claimed.count !== 1) return { ok: false, error: 'NOT_WAITING' };
  }
  // Both steps are idempotent on their keys, so a retry after a failure here finishes the job.
  await ledger.releaseHold({ idemKey: `${row.idemKey}-hold`, reason: `payout ${m.reference} rejected` });
  await ledger.postEntry(buildBalanceDowngrade({ accountId: row.accountId, amountCents: (m.amountCents || 0) + (m.feeCents || 0), idemKey: `${row.idemKey}-downgrade` }));
  const { enc, keyVersion, ...approvalKept } = m.approval || {};
  await prisma.providerRequest.update({ where: { idemKey: row.idemKey }, data: { status: 'FAILED', metadata: { ...m, approval: { ...approvalKept, rejectedBy: String(by).slice(0, 60), rejectedAt: new Date(now).toISOString(), rejectReason: String(reason || '').slice(0, 200) }, outcome, finalisedAt: new Date(now).toISOString() } } });
  log('payout_rejected', { reference: m.reference, by, accountId: row.accountId, outcome });
  const out = { status: 'FAILED', method: m.method, amountCents: m.amountCents, feeCents: m.feeCents, reference: m.reference, recipient: m.recipient || null, outcome };
  const told = tell ? await tellCustomer({ prisma, accountId: row.accountId, text: outcome === 'CANCELLED_BY_CUSTOMER' ? cancelledCopy(out) : rejectedCopy(out), out, deps }) : null;
  return { ok: true, status: 'REJECTED', reference: m.reference, told: !!told?.ok, out };
}
