/**
 * The personal portal's money actions (2026-10-21): get paid, send, pay out,
 * top up, and the PIN step that approves them. Every rand moves through the
 * chat's own libraries (requestPayout, sendMoney, createPaymentRequest,
 * createDepositIntent); this file only orders the checks, builds the
 * arguments and writes the audit rows.
 *
 * The order in every action that moves money (docs/GOLDEN_THREAD.md 2.1):
 *   the session and the CSRF check (the route) → the PIN proof, verified here
 *   with verifyPinProof for this account, this intent and this amount → the
 *   freeze, the rules and the cool-off → the vault read at the moment of use
 *   → the library, which checks the proof again.
 * The proof is issued only by @wapay/auth verifyPIN after a correct PIN
 * (pinStepUp below asks it, with `approves`), lives two minutes and is bound
 * to one intent: a payout intent pays out once (requestPayout's idemKey), a
 * send preview executes once (its claim), a link intent creates one link (its
 * audit claim). Intent ids carry their purpose as a prefix, so a proof for a
 * link can never pay out.
 *
 * Nothing here sends a WhatsApp message (WaPay never starts a conversation)
 * and nothing here reaches a model. Responses carry labels and last digits,
 * never a full account, ID or card number.
 */
import crypto from 'node:crypto';
import { pinShaped, webPinGate, keyOf, APP_PIN_MAX_FAILS, APP_LOCKOUT_WINDOW_MS } from './app-auth.js';
import {
  webLine, rands, randsShort, methodShort, linkQuote, linkShareText, linkView, coolOffOf, payoutRulesNote, kycView, balancesOf, topupQuote,
  supportEmail,
} from './app-portal.js';
import { dailyCapCopy, kycThresholdCopy } from './payout-rules.js';
import { FROZEN_PAYOUT_COPY, FROZEN_SEND_COPY } from './payout-freeze.js';
import { isPayoutHeldFor, PAYOUT_HOLD_COPY } from './payout-hold.js';
import { expressFor, recentReceipts as realRecentReceipts, expressFeeLine } from './payout-express.js';
import { PAYOUT_REVIEW_COPY } from './payout-triage.js';
import { feeChangedCopy, testRunCopy } from './payout-chat.js';
import { arrivalLine, collectionSteps } from './payout-collection.js';
import { openPayoutCopy, reasonFor } from './payout-status-copy.js';
import { DESTINATION_FAMILY, fingerprintOf, cleanNickname } from './payout-beneficiaries.js';
import { paymentRequestUrl } from './payment-requests.js';
import { sanitizeLinkDescription, descriptionRefusal } from './link-description.js';
import { SEND_MIN_CENTS, SEND_MAX_CENTS, sendFeeCents } from './send-money.js';
import { isValidSaMsisdn, normaliseMsisdn, toWaId } from './msisdn.js';
import {
  BANK_BRANCH_CODES, bankToBranch, cleanFullName, parseIdDocument, ISSUING_COUNTRIES, countryName, affordableMaxCents, payoutHandedOver,
} from './payout-chat.js';
import { takePendingWithdraw } from './kyc-resume.js';
import { HELD_GIFT_DAYS } from './pending-gifts.js';
import { referralLink, inviteMessage } from './referrals.js';
import { sanitizeLabel } from './business.js';
import { BALANCE } from './ledger-core.js';
import {
  PAYOUT_METHODS, MIN_PAYOUT_CENTS, MAX_PAYOUT_CENTS, CASH_STEP_CENTS, isCashMethod, quotePayout, methodLimits, validateIntentId,
} from './payouts.js';

const log = (type, data = {}) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
const meta = (x) => (x && typeof x.metadata === 'object' && x.metadata ? x.metadata : {});
const digits = (v) => String(v ?? '').replace(/\D/g, '');

// ---------------------------------------------------------------------------
// Intents and the proof
// ---------------------------------------------------------------------------

/** The purpose of an intent is its prefix. A send's intent is the chat's own preview id shape. */
export const INTENT_PREFIX = Object.freeze({ payout: 'apo-', link: 'alk-', send: 'preview-send-' });
const LETTERS = 'abcdefghjkmnpqrstuvwxyz';

/** "apo-mh0k3x2a-qwhtnbzr": base36 time and letters only, so the ledger's timestamp guard never trips. */
export function newIntentId(purpose, now = Date.now()) {
  const prefix = INTENT_PREFIX[purpose];
  if (!prefix || purpose === 'send') throw new Error(`no minted intent for ${purpose}`);
  let rand = '';
  for (const b of crypto.randomBytes(10)) rand += LETTERS[b % LETTERS.length];
  return `${prefix}${Number(now).toString(36)}-${rand}`;
}

export function intentFits(purpose, intentId) {
  const prefix = INTENT_PREFIX[purpose];
  const id = String(intentId || '');
  return !!prefix && id.startsWith(prefix) && !!validateIntentId(id);
}

/**
 * The customer's approval for exactly this, minutes old (golden thread 2.1),
 * checked before anything is read from the vault or written anywhere. The
 * verifier is the real one from deps; it cannot be stood in for by an argument.
 */
export function checkProof(deps, { account, purpose, intentId, amountCents, proof }) {
  if (!intentFits(purpose, intentId)) return { ok: false, error: 'BAD_INTENT' };
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, error: 'BAD_AMOUNT' };
  if (typeof proof !== 'string' || !proof) return { ok: false, error: 'NO_PROOF', reason: 'MISSING' };
  const v = deps.verifyPinProof(proof, { accountId: account.id, intentId, amountCents });
  return v.ok ? { ok: true } : { ok: false, error: 'NO_PROOF', reason: v.reason };
}

async function audit(deps, { accountId, event, metadata = {}, id = null }) {
  try {
    await deps.prisma.auditLog.create({ data: { ...(id ? { id } : {}), accountId, event, metadata } });
    return true;
  } catch (error) {
    if (error?.code === 'P2002') throw error;
    log('app_audit_write_failed', { event, error: error?.message });
    return false;
  }
}

// ---------------------------------------------------------------------------
// The PIN step: a correct PIN returns the proof for one intent and amount
// ---------------------------------------------------------------------------

/**
 * Ask verifyPIN (the only verifier) to approve one intent. Before a PIN
 * attempt is spent: the intent's shape, the amount, the PIN's shape, this
 * account's and this IP's recent failures, the web ceiling on the shared
 * counter, and for a send the preview's owner and amount.
 */
export async function pinStepUp(deps, { account, factor, purpose, intentId, amountCents, pin, ip }) {
  if (!intentFits(purpose, intentId)) return { ok: false, error: 'BAD_INTENT' };
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, error: 'BAD_AMOUNT' };
  if (!pinShaped(pin)) return { ok: false, error: 'BAD_PIN' };
  const accKey = `pf:a:${account.id}`;
  const ipKey = `pf:ip:${keyOf('ip', ip)}`;
  const [byAccount, byIp] = await Promise.all([deps.limiter.count(accKey, APP_LOCKOUT_WINDOW_MS), deps.limiter.count(ipKey, APP_LOCKOUT_WINDOW_MS)]);
  if (byAccount >= APP_PIN_MAX_FAILS || byIp >= APP_PIN_MAX_FAILS) return { ok: false, error: 'LOCKED' };
  if (purpose === 'send') {
    const p = await deps.prisma.providerRequest.findUnique({ where: { id: intentId } });
    const m = meta(p);
    if (!p || p.route !== 'send-preview' || p.accountId !== account.id || p.status !== 'PENDING' || m.amountCents !== amountCents) return { ok: false, error: 'NOT_FOUND' };
    if (m.expiresAt && Date.parse(m.expiresAt) < deps.now()) return { ok: false, error: 'EXPIRED' };
  }
  const gate = webPinGate(factor, deps.now());
  if (!gate.ok) return { ok: false, error: gate.error, lockedUntil: gate.lockedUntil || null };
  const out = await deps.verifyPIN({ accountId: account.id, pin, approves: { intentId, amountCents } });
  if (!out?.ok) {
    if (out?.error === 'INVALID_PIN') {
      await Promise.all([deps.limiter.hit(accKey, { accountId: account.id }), deps.limiter.hit(ipKey)]);
      return { ok: false, error: out.lockedUntil ? 'PIN_LOCKED' : 'WRONG_PIN', lockedUntil: out.lockedUntil ? new Date(out.lockedUntil).toISOString() : null };
    }
    if (out?.error === 'SOFT_LOCKOUT') return { ok: false, error: 'PIN_LOCKED', lockedUntil: out.lockedUntil ? new Date(out.lockedUntil).toISOString() : null };
    if (out?.error === 'HARD_LOCKOUT') return { ok: false, error: 'PIN_RESET_NEEDED' };
    if (out?.error === 'PIN_NOT_SET') return { ok: false, error: 'PIN_NOT_SET' };
    log('app_pin_step_error', { accountId: account.id, purpose });
    return { ok: false, error: 'PIN_CHECK_FAILED' };
  }
  // A correct PIN with no proof means the proof secret is missing: nothing can be approved (golden thread 2.3).
  if (!out.proof) return { ok: false, error: 'NO_PROOF_SECRET' };
  return { ok: true, proof: out.proof, expiresInMs: 120000 };
}

// ---------------------------------------------------------------------------
// Get paid: payment links
// ---------------------------------------------------------------------------

const cleanText = (v, max) => sanitizeLabel(String(v ?? '').replace(/https?:\/\/\S+/gi, ''), max) || null;

/** A quote plus the intent the PIN will approve. */
export function linkPrepare({ amountCents, now = Date.now() }) {
  const q = linkQuote(amountCents);
  if (!q.ok) return q;
  return { ...q, intentId: newIntentId('link', now) };
}

/**
 * Create one link for one approved intent. The intent is claimed first by an
 * audit row with a deterministic id, so the same proof replayed returns the
 * same link and never mints a second one.
 */
export async function createLink(deps, { account, intentId, amountCents, label, note, proof }) {
  const p = checkProof(deps, { account, purpose: 'link', intentId, amountCents, proof });
  if (!p.ok) return { ...p, status: p.error === 'NO_PROOF' ? 403 : 400 };
  const q = linkQuote(amountCents);
  if (!q.ok) return { ...q, status: 400 };
  const who = cleanText(label, 40);
  // Every link says what it is for, and the payer reads it (founder 2026-10-24): the chat's check, refused in plain words.
  const described = sanitizeLinkDescription(note);
  if (!described.ok) return { ok: false, error: 'DESCRIPTION', reason: described.reason, line: descriptionRefusal(described.reason), status: 400 };
  const forWhat = described.text;
  const claimId = `app_link_${crypto.createHash('sha256').update(`${account.id}|${intentId}`).digest('hex').slice(0, 24)}`;
  try {
    // The claim fails closed: no claim row, no link (a replayed proof must find it).
    await deps.prisma.auditLog.create({ data: { id: claimId, accountId: account.id, event: 'APP_LINK_CREATED', metadata: { intentId, amountCents, label: who, state: 'CLAIMED' } } });
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    const prior = await deps.prisma.auditLog.findUnique({ where: { id: claimId } });
    const code = meta(prior).code;
    const row = code ? await deps.prisma.paymentRequest.findUnique({ where: { id: code } }) : null;
    if (!row) return { ok: false, error: 'IN_PROGRESS', status: 409 };
    return { ok: true, replayed: true, link: linkView(row, who), quote: q, shareText: linkShareText({ account, amountCents: row.amountCents, url: paymentRequestUrl(row.id), note: row.note }) };
  }
  let row;
  try {
    row = await deps.createPaymentRequest({ prisma: deps.prisma, accountId: account.id, amountCents, note: forWhat });
  } catch (error) {
    await deps.prisma.auditLog.deleteMany({ where: { id: claimId } }).catch(() => {});
    if (error?.code === 'REQUEST_LIMIT') {
      const line = error.limit === 'OPEN'
        ? `You already have ${error.openCount ?? 'the most'} payment links waiting to be paid. That's the most you can have open at once. Cancel one you no longer need, or wait for a link to be paid.`
        : `You've created today's maximum number of payment links. Please try again tomorrow.`;
      return { ok: false, error: 'REQUEST_LIMIT', limit: error.limit, line, status: 429 };
    }
    throw error;
  }
  await deps.prisma.auditLog.update({ where: { id: claimId }, data: { metadata: { intentId, amountCents, label: who, code: row.id, state: 'CREATED' } } }).catch(() => {});
  const url = paymentRequestUrl(row.id);
  return { ok: true, link: linkView(row, who), quote: q, shareText: linkShareText({ account, amountCents, url, note: row.note }) };
}

export async function cancelLink(deps, { account, code }) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z]{6,12}$/.test(c)) return { ok: false, error: 'BAD_CODE', status: 400 };
  const ok = await deps.cancelPaymentRequest({ prisma: deps.prisma, code: c, accountId: account.id });
  return ok ? { ok: true } : { ok: false, error: 'NOT_OPEN', status: 409 };
}

// ---------------------------------------------------------------------------
// Send money: through the ledger, the chat's sendMoney
// ---------------------------------------------------------------------------

const SEND_PREVIEW_TTL_MS = 5 * 60 * 1000;
const EXEC_TAKEOVER_MS = 120 * 1000;

/** The send confirm, membership-neutral, in the chat's words (lib/send-money.js sendConfirmText) without "reply YES". */
export function sendConfirmLines({ amountCents, recipientMsisdn }) {
  return [
    `Send ${randsShort(amountCents)} to ${recipientMsisdn}?`,
    'It lands in their WaPay balance: straight away if they use WaPay, or when they join. No fee.',
    `If they have not joined after ${HELD_GIFT_DAYS()} days, it comes back to you.`,
  ];
}

/** After the money moved: the same words whoever the number belongs to (sendReceiptText). */
export function sendDoneLines({ amountCents, recipientMsisdn, newBalanceCents }) {
  return [
    `Sent ${randsShort(amountCents)} to ${recipientMsisdn}.`,
    'It is in their WaPay balance, or it waits there for them until they join WaPay. No fee.',
    `Your balance: ${rands(newBalanceCents)}`,
  ];
}

function sendCoolOff(account, now) {
  const c = coolOffOf(account, new Date(now));
  // The web reset proves the ID but not the phone: until the cool-off ends, money for another person waits too.
  return c && c.web ? c : null;
}

export async function sendPreview(deps, { account, msisdn, amountCents }) {
  const now = deps.now();
  if (await deps.readPayoutFreeze({ prisma: deps.prisma, accountId: account.id, fallbackProfile: account.profile || null })) {
    return { ok: false, error: 'FROZEN', line: webLine(FROZEN_SEND_COPY), status: 423 };
  }
  const cool = sendCoolOff(account, now);
  if (cool) return { ok: false, error: 'COOL_OFF', until: cool.until, line: `Your PIN was reset on the web recently, so for your safety sending to other people opens again on ${whenSast(cool.until)}. Getting paid and pay-outs to your saved details work now.`, status: 423 };
  if (!Number.isInteger(amountCents) || amountCents < SEND_MIN_CENTS || amountCents > SEND_MAX_CENTS) {
    return { ok: false, error: 'BAD_AMOUNT', minCents: SEND_MIN_CENTS, maxCents: SEND_MAX_CENTS, line: `You can send between ${randsShort(SEND_MIN_CENTS)} and ${randsShort(SEND_MAX_CENTS)} at a time.`, status: 400 };
  }
  const to = normaliseMsisdn(msisdn || '');
  if (!to || !isValidSaMsisdn(to)) return { ok: false, error: 'BAD_NUMBER', line: 'That does not look like a South African cellphone number, like 0781234567.', status: 400 };
  if (to === normaliseMsisdn(account.msisdn || account.waId || '')) return { ok: false, error: 'SELF', line: 'That is your own number.', status: 400 };
  const feeCents = sendFeeCents();
  const totalCents = amountCents + feeCents;
  const wallet = await deps.prisma.wallet.findFirst({ where: { accountId: account.id, balanceType: BALANCE.SPEND } });
  const available = Number(wallet?.availableCents) || 0;
  if (available < totalCents) return { ok: false, error: 'INSUFFICIENT_FUNDS', availableCents: available, line: `You have ${rands(available)} available, so ${randsShort(amountCents)} is more than you can send right now.`, status: 400 };
  const previewId = `${INTENT_PREFIX.send}${crypto.randomUUID()}`;
  const expiresAt = new Date(now + SEND_PREVIEW_TTL_MS).toISOString();
  await deps.prisma.providerRequest.create({ data: { id: previewId, idemKey: previewId, route: 'send-preview', status: 'PENDING', accountId: account.id, provider: 'WAPAY', metadata: { amountCents, feeCents, totalCents, recipientMsisdn: to, expiresAt, via: 'app' } } });
  return { ok: true, previewId, amountCents, feeCents, totalCents, recipient: to, expiresAt, lines: sendConfirmLines({ amountCents, recipientMsisdn: to }) };
}

export async function sendExecute(deps, { account, previewId, proof }) {
  const now = deps.now();
  const id = String(previewId || '');
  if (!intentFits('send', id)) return { ok: false, error: 'BAD_INTENT', status: 400 };
  const preview = await deps.prisma.providerRequest.findUnique({ where: { id } });
  const m = meta(preview);
  if (!preview || preview.route !== 'send-preview' || preview.accountId !== account.id) return { ok: false, error: 'NOT_FOUND', status: 404 };
  // The proof first: nothing below is touched without the customer's own PIN for this send and this amount.
  const p = checkProof(deps, { account, purpose: 'send', intentId: id, amountCents: m.amountCents, proof });
  if (!p.ok) return { ...p, status: 403 };
  if (preview.status === 'SUCCESS') return { ok: true, replayed: true, amountCents: m.amountCents, recipient: m.recipientMsisdn, lines: sendDoneLines({ amountCents: m.amountCents, recipientMsisdn: m.recipientMsisdn, newBalanceCents: m.newBalance ?? 0 }), newBalanceCents: m.newBalance ?? null };
  const stale = preview.status === 'EXECUTING' && now - (Date.parse(m.executingAt || '') || 0) > EXEC_TAKEOVER_MS;
  if (preview.status === 'EXECUTING' && !stale) return { ok: false, error: 'IN_PROGRESS', status: 409 };
  if (!(preview.status === 'PENDING' || stale)) return { ok: false, error: 'NOT_FOUND', status: 404 };
  if (m.expiresAt && Date.parse(m.expiresAt) < now) return { ok: false, error: 'EXPIRED', line: 'That confirmation timed out, so nothing was sent. Please start again.', status: 410 };
  if (sendCoolOff(account, now)) return { ok: false, error: 'COOL_OFF', status: 423 };
  const claim = await deps.prisma.providerRequest.updateMany({ where: { id, status: stale ? 'EXECUTING' : 'PENDING' }, data: { status: 'EXECUTING', metadata: { ...m, executingAt: new Date(now).toISOString() } } });
  if (claim.count !== 1) return { ok: false, error: 'IN_PROGRESS', status: 409 };
  let out;
  try {
    out = await deps.sendMoney({ prisma: deps.prisma, sender: account, previewId: id, recipientMsisdn: m.recipientMsisdn, amountCents: m.amountCents, authorization: proof });
  } catch (error) {
    await deps.prisma.providerRequest.updateMany({ where: { id, status: 'EXECUTING' }, data: { status: 'PENDING' } }).catch(() => {});
    log('app_send_failed', { accountId: account.id, previewId: id, error: error?.message });
    return { ok: false, error: 'RETRYABLE', line: 'Something went wrong; nothing was sent. Please try again.', status: 500 };
  }
  if (!out?.ok) {
    await deps.prisma.providerRequest.update({ where: { id }, data: { status: 'FAILED', metadata: { ...m, error: out?.error || 'FAILED' } } }).catch(() => {});
    await audit(deps, { accountId: account.id, event: 'APP_SEND', metadata: { previewId: id, amountCents: m.amountCents, ok: false, error: out?.error || 'FAILED' } }).catch(() => {});
    const status = out?.error === 'FROZEN' ? 423 : out?.error === 'NOT_AUTHORISED' ? 403 : 400;
    const line = out?.error === 'FROZEN' ? webLine(FROZEN_SEND_COPY) : out?.error === 'INSUFFICIENT_FUNDS' ? 'You no longer have enough available for this send. Nothing was sent.' : out?.error === 'SELF' ? 'That is your own number.' : 'That send did not go through. Nothing left your balance.';
    return { ok: false, error: out?.error || 'FAILED', line, status };
  }
  const wallet = await deps.prisma.wallet.findFirst({ where: { accountId: account.id, balanceType: BALANCE.SPEND } });
  const newBalance = wallet?.availableCents ?? null;
  // `delivered` stays on the server row: the sender's screen reads the same for a member and anyone else.
  await deps.prisma.providerRequest.update({ where: { id }, data: { status: 'SUCCESS', metadata: { ...m, delivered: out.delivered, giftId: out.giftId || null, newBalance } } }).catch(() => {});
  await audit(deps, { accountId: account.id, event: 'APP_SEND', metadata: { previewId: id, amountCents: m.amountCents, recipient: `${String(m.recipientMsisdn).slice(0, 3)}•••${String(m.recipientMsisdn).slice(-3)}`, ok: true, replayed: !!out.replayed } }).catch(() => {});
  return { ok: true, amountCents: m.amountCents, recipient: m.recipientMsisdn, newBalanceCents: newBalance, lines: sendDoneLines({ amountCents: m.amountCents, recipientMsisdn: m.recipientMsisdn, newBalanceCents: newBalance ?? 0 }) };
}

// ---------------------------------------------------------------------------
// Pay out: the chat's requestPayout, rules and vault
// ---------------------------------------------------------------------------

export const ALL_METHODS = Object.freeze(['PAYSHAP', 'RTC', 'CASHSEND', 'NEDCASH', 'EWALLET']);

/** The banks the bank methods can be addressed to, with their universal branch codes (the chat's list). */
export const BANKS = Object.freeze(
  Object.keys(BANK_BRANCH_CODES)
    .filter((k) => k !== 'TYME')
    .map((k) => ({ key: k, ...bankToBranch(k) }))
    .map((b) => ({ key: b.key, name: b.branch_name, branchCode: b.branch_code })),
);
export const COUNTRIES = Object.freeze(Object.entries(ISSUING_COUNTRIES).filter(([cc]) => cc !== 'ZA').map(([cc, names]) => ({ code: cc, name: names[0] })).sort((a, b) => a.name.localeCompare(b.name)));

/** "16 Oct at 19:15" in SAST, as the chat says it. */
function whenSast(iso) {
  const x = new Date(new Date(iso).getTime() + 2 * 3600 * 1000);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][x.getUTCMonth()];
  return `${x.getUTCDate()} ${mon} at ${String(x.getUTCHours()).padStart(2, '0')}:${String(x.getUTCMinutes()).padStart(2, '0')}`;
}

/** The chat's cool-off line (lib/payout-chat.js coolOffText), for a pay-out to new details. */
export function coolOffLine(until) {
  return `🔒 Your PIN was reset recently, so for your safety, until ${whenSast(until)} a withdrawal can only go to an account or number saved before the reset. Pick one from the list, or withdraw to a new one after that time.`;
}

/** The withdraw KYC ask (lib/payout-chat.js KYC_ASK) for the web. */
export const KYC_ALL_LINE = 'Withdrawals need a once-off identity check on your phone. Verify your ID below to continue.';

/** The name that goes to the bank: the KYC name, else the name given as on the account (the chat's recipientName). */
function recipientName(account, fullName = null) {
  const full = String(account?.profile?.kyc?.fullName || fullName || '').trim();
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return { firstname: parts[0], surname: parts.slice(1).join(' ') };
  const one = parts[0] || String(account?.displayName || '').trim().split(/\s+/)[0] || 'WaPay';
  return { firstname: one, surname: 'Customer' };
}

async function liveProviders(deps) {
  if (!deps.payoutConfigured()) return null;
  try { return await deps.resolveProviders({}); } catch { return null; }
}

function methodsFor({ live, balanceCents }) {
  const options = live ? ALL_METHODS.filter((m) => live.some((p) => p.method === m)) : [...ALL_METHODS];
  return options.map((m) => {
    const lim = methodLimits(m, live || []);
    const fields = (live || []).find((p) => p.method === m)?.requiredFields || PAYOUT_METHODS[m].fields;
    const feeFrom = quotePayout({ method: m, amountCents: lim.minCents, minCents: lim.minCents, maxCents: lim.maxCents }).feeCents;
    return {
      method: m,
      label: PAYOUT_METHODS[m].label,
      short: methodShort(m),
      hint: PAYOUT_METHODS[m].hint,
      family: DESTINATION_FAMILY[m],
      minCents: lim.minCents,
      maxCents: lim.maxCents,
      cash: isCashMethod(m),
      stepCents: isCashMethod(m) ? CASH_STEP_CENTS : 100,
      needsId: fields.includes('id_number'),
      feeFromCents: feeFrom,
      maxNowCents: affordableMaxCents({ method: m, balanceCents, limits: { [m]: lim } }),
    };
  });
}

function pendingPayoutOf(account, now) {
  const app = account?.profile?.app && typeof account.profile.app === 'object' ? account.profile.app.pendingPayout : null;
  if (app && app.amountCents && Date.parse(app.at || '') > now - 24 * 3600 * 1000) {
    return { amountCents: Number(app.amountCents), method: app.method || null, destinationId: app.destinationId || null };
  }
  const chat = takePendingWithdraw(account?.profile, now);
  return chat ? { amountCents: chat.amountCents, method: chat.method || null, destinationId: null } : null;
}

/**
 * A check that is still open at Didit gets asked about directly (the decision
 * endpoint, the same call the admin "refresh" makes) when the pay-out screen
 * loads, at most once a minute per account. The webhook remains the fast path;
 * this is the fallback that made the portal's ID check complete on 2026-10-21
 * while the webhook's signing secret was wrong in Vercel (BUGLOG #136 notes).
 */
const KYC_SYNC_EVERY_MS = 60 * 1000;
const kycSyncedAt = new Map();
export async function refreshOpenKyc(deps, { account, now = Date.now() }) {
  const k = account?.profile?.kyc && typeof account.profile.kyc === 'object' ? account.profile.kyc : null;
  if (!k || !k.sessionId || !['PENDING', 'PENDING_REVIEW'].includes(k.status)) return account;
  if (typeof deps.syncKycFromDecision !== 'function' || !deps.kycConfigured()) return account;
  const last = kycSyncedAt.get(account.id) || 0;
  if (now - last < KYC_SYNC_EVERY_MS) return account;
  kycSyncedAt.set(account.id, now);
  try {
    const synced = await deps.syncKycFromDecision({ prisma: deps.prisma, accountId: account.id, sessionId: k.sessionId });
    if (!synced?.ok || !synced.kyc || synced.kyc.status === k.status) return account;
    const fresh = await deps.prisma.account.findUnique({ where: { id: account.id } }).catch(() => null);
    return fresh || { ...account, profile: { ...(account.profile || {}), kyc: { ...k, ...synced.kyc } } };
  } catch {
    return account;
  }
}

/** Everything the pay-out screen needs, read fresh: methods, limits, saved details (labels), the rules and the gates. */
export async function payoutContext(deps, { account: given }) {
  const now = deps.now();
  const account = await refreshOpenKyc(deps, { account: given, now });
  const enabled = !!deps.payoutAllowedFor(account.waId);
  const held = await isPayoutHeldFor({ prisma: deps.prisma, account });
  const configured = !!deps.payoutConfigured();
  const [balance, frozen, saved, identity] = await Promise.all([
    balancesOf(deps, account.id),
    deps.readPayoutFreeze({ prisma: deps.prisma, accountId: account.id, fallbackProfile: account.profile || null }),
    deps.listPayoutDestinations({ prisma: deps.prisma, accountId: account.id }).catch(() => []),
    deps.getPayoutIdentity({ prisma: deps.prisma, accountId: account.id }).catch(() => null),
  ]);
  const live = enabled && configured ? await liveProviders(deps) : null;
  const kyc = kycView(account, { configured: deps.kycConfigured() });
  const coolOff = coolOffOf(account, new Date(now));
  return {
    enabled,
    configured,
    balance,
    // The global hold shows through the same notice as a per-account freeze (founder 2026-10-24).
    frozen: frozen ? { line: webLine(FROZEN_PAYOUT_COPY) } : held ? { line: webLine(PAYOUT_HOLD_COPY) } : null,
    methods: enabled ? methodsFor({ live, balanceCents: balance.totalCents }) : [],
    providersLive: !!live,
    saved: (saved || []).map((d) => ({ id: d.id, label: d.label, method: d.method, family: d.family || DESTINATION_FAMILY[d.method] || null, timesUsed: d.timesUsed ?? null })),
    identity: identity ? { fullName: identity.fullName || null, idType: identity.idType || 'RSAID', idLast3: identity.idLast3 || null, country: identity.countryOfIssue ? countryName(identity.countryOfIssue) : null } : null,
    kycName: account?.profile?.kyc?.fullName || null,
    kyc: { ...kyc, required: !!deps.kycRequired() && !kyc.verified },
    rulesNote: payoutRulesNote(account, balance.totalCents),
    coolOff: coolOff ? { until: coolOff.until, line: coolOffLine(coolOff.until) } : null,
    pending: pendingPayoutOf(account, now),
    vault: !!deps.beneficiariesAvailable(),
    banks: BANKS,
    countries: COUNTRIES,
    supportEmail: supportEmail(),
  };
}

/** New pay-out details as typed: cleaned, never echoed back beyond last digits. */
function cleanDetails(method, details = {}, account) {
  const family = DESTINATION_FAMILY[method];
  if (family === 'BANK') {
    const accountNumber = digits(details.accountNumber);
    const bank = bankToBranch(details.bank || details.branchCode || '');
    if (accountNumber.length < 6 || accountNumber.length > 20) return { ok: false, error: 'BAD_ACCOUNT_NUMBER' };
    if (!bank) return { ok: false, error: 'BAD_BANK' };
    return { ok: true, rec: { account_number: accountNumber, branch_code: bank.branch_code, branch_name: bank.branch_name }, label: `${bank.branch_name} account •••${accountNumber.slice(-3)}` };
  }
  const mobile = details.mine ? account.waId : details.mobile;
  const local = normaliseMsisdn(mobile || '');
  if (!local || !isValidSaMsisdn(local)) return { ok: false, error: 'BAD_MOBILE' };
  const wa = toWaId(local);
  return { ok: true, rec: { mobile: wa }, label: `Cellphone •••${wa.slice(-4)}` };
}

/** The ID typed on the confirm screen (only when none is on file): SA ID, or passport with its country. */
function cleanTypedIdentity(identity = {}) {
  if (!identity || (!identity.fullName && !identity.idNumber)) return { ok: true, name: null, id: null };
  const name = identity.fullName ? cleanFullName(identity.fullName) : null;
  if (identity.fullName && !name) return { ok: false, error: 'BAD_NAME' };
  let id = null;
  if (identity.idNumber) {
    const parsed = parseIdDocument(identity.idNumber);
    if (!parsed) return { ok: false, error: 'BAD_ID' };
    if (parsed.idType === 'PASSPORT') {
      const cc = String(identity.countryOfIssue || '').toUpperCase();
      if (!ISSUING_COUNTRIES[cc] || cc === 'ZA') return { ok: false, error: 'BAD_COUNTRY' };
      id = { idType: 'PASSPORT', idNumber: parsed.idNumber, countryOfIssue: cc };
    } else {
      id = { idType: 'RSAID', idNumber: parsed.idNumber, countryOfIssue: null };
    }
  }
  return { ok: true, name, id };
}

/** Why a pay-out rule stops this amount, in the chat's words. */
function rulesLine(rules) {
  if (rules.error === 'DAILY_CAP') return webLine(dailyCapCopy(rules));
  if (rules.error === 'KYC_REQUIRED' && rules.reason) return webLine(kycThresholdCopy(rules));
  return KYC_ALL_LINE;
}

/**
 * Check a pay-out before the PIN: the method, the amount and its fee, the
 * balance, the destination, the freeze, the cool-off, the rules and KYC, and
 * what the bank will need (a name, an ID). Reads only; returns the intent the
 * PIN will approve and everything the confirm screen shows.
 */
export async function payoutCheck(deps, { account, method, amountCents, destinationId = null, details = null, identity = null }) {
  const now = deps.now();
  if (!deps.payoutAllowedFor(account.waId)) return { ok: false, error: 'DISABLED', line: 'Pay-outs are not switched on right now. Your money stays safe in your balance.', status: 503 };
  if (await deps.readPayoutFreeze({ prisma: deps.prisma, accountId: account.id, fallbackProfile: account.profile || null })) return { ok: false, error: 'FROZEN', line: webLine(FROZEN_PAYOUT_COPY), status: 423 };
  if (await isPayoutHeldFor({ prisma: deps.prisma, account })) return { ok: false, error: 'PAYOUT_HOLD', line: webLine(PAYOUT_HOLD_COPY), status: 423 };
  if (!PAYOUT_METHODS[method]) return { ok: false, error: 'BAD_METHOD', status: 400 };
  const live = await liveProviders(deps);
  if (live && !live.some((p) => p.method === method)) return { ok: false, error: 'NO_PROVIDER', line: 'That pay-out method is not available right now. Pick another one.', status: 400 };
  const lim = methodLimits(method, live || []);
  if (!Number.isInteger(amountCents) || amountCents < lim.minCents || amountCents > lim.maxCents) {
    return { ok: false, error: 'BAD_AMOUNT', minCents: lim.minCents, maxCents: lim.maxCents, line: `${methodShort(method)} pay-outs are between ${randsShort(lim.minCents)} and ${randsShort(lim.maxCents)}.`, status: 400 };
  }
  if (isCashMethod(method) && amountCents % CASH_STEP_CENTS !== 0) {
    return { ok: false, error: 'CASH_STEP', stepCents: CASH_STEP_CENTS, line: `ATMs give R50 and R100 notes, so ${methodShort(method)} takes multiples of ${randsShort(CASH_STEP_CENTS)}.`, status: 400 };
  }
  const balance = await balancesOf(deps, account.id);
  // The express fee (lib/payout-express.js, 2026-10-24): money under two hours old doubles the fee for the part that needs it.
  const receipts = await (deps.recentReceipts || realRecentReceipts)({ prisma: deps.prisma, accountId: account.id, now }).catch(() => []);
  const base = quotePayout({ method, amountCents, minCents: lim.minCents, maxCents: lim.maxCents });
  const ex = expressFor({ balanceCents: balance.totalCents, receipts, amountCents, normalFeeCents: base.feeCents, now });
  const quote = ex.express ? quotePayout({ method, amountCents, minCents: lim.minCents, maxCents: lim.maxCents, feeMultiplier: ex.multiplier }) : base;
  if (quote.totalCents > balance.totalCents) {
    const most = affordableMaxCents({ method, balanceCents: balance.totalCents, limits: { [method]: lim }, receipts });
    return { ok: false, error: 'INSUFFICIENT_FUNDS', maxNowCents: most, line: most ? `With the ${randsShort(quotePayout({ method, amountCents: most, minCents: lim.minCents, maxCents: lim.maxCents }).feeCents)} fee, ${randsShort(most)} is the most you can take by ${methodShort(method)} right now.` : `With ${rands(balance.totalCents)} you cannot use ${methodShort(method)} yet.`, status: 400 };
  }

  // Where it goes: a saved destination of the same family, or new details.
  const family = DESTINATION_FAMILY[method];
  let label;
  if (destinationId) {
    const saved = await deps.listPayoutDestinations({ prisma: deps.prisma, accountId: account.id }).catch(() => []);
    const d = (saved || []).find((x) => x.id === destinationId);
    if (!d || (d.family || DESTINATION_FAMILY[d.method]) !== family) return { ok: false, error: 'BAD_DESTINATION', status: 400 };
    label = d.label;
  } else {
    const coolOff = coolOffOf(account, new Date(now));
    if (coolOff) return { ok: false, error: 'COOL_OFF', until: coolOff.until, line: coolOffLine(coolOff.until), status: 423 };
    const c = cleanDetails(method, details || {}, account);
    if (!c.ok) return { ok: false, error: c.error, status: 400 };
    label = c.label;
  }

  const rules = await deps.checkPayoutRules({ prisma: deps.prisma, account, amountCents });
  if (!rules.ok) return { ok: false, error: rules.error, reason: rules.reason || null, line: rulesLine(rules), kyc: { canVerify: !!rules.kycConfigured }, status: rules.error === 'DAILY_CAP' ? 409 : 403 };
  if (deps.kycRequired() && !deps.accountKycVerified(account)) return { ok: false, error: 'KYC_REQUIRED', line: KYC_ALL_LINE, kyc: { canVerify: !!deps.kycConfigured() }, status: 403 };

  // What the bank needs from the customer: a name (unless the KYC name or the saved one is there) and an ID (when the method asks).
  const onFile = await deps.getPayoutIdentity({ prisma: deps.prisma, accountId: account.id }).catch(() => null);
  const typed = cleanTypedIdentity(identity || {});
  if (!typed.ok) return { ok: false, error: typed.error, status: 400 };
  const fields = (live || []).find((p) => p.method === method)?.requiredFields || PAYOUT_METHODS[method].fields;
  const kycName = account?.profile?.kyc?.fullName || null;
  const name = kycName || typed.name || onFile?.fullName || null;
  const needs = { fullName: !name, idNumber: fields.includes('id_number') && !typed.id && !onFile };
  const idLine = typed.id
    ? (typed.id.idType === 'PASSPORT' ? `Passport / foreign ID: •••${typed.id.idNumber.slice(-3)} (${countryName(typed.id.countryOfIssue)})` : `ID number: •••${typed.id.idNumber.slice(-3)}`)
    : onFile?.idLast3 ? (onFile.idType === 'PASSPORT' ? `Passport / foreign ID: •••${onFile.idLast3} (saved)` : `ID number: •••${onFile.idLast3} (saved)`) : null;

  return {
    ok: true,
    intentId: newIntentId('payout', now),
    method,
    methodLabel: methodShort(method),
    amountCents,
    feeCents: quote.feeCents,
    totalCents: quote.totalCents,
    express: !!ex.express,
    normalFeeCents: base.feeCents,
    feeNote: ex.express ? webLine(expressFeeLine(ex)) : null,
    balanceAfterCents: Math.max(0, balance.totalCents - quote.totalCents),
    destinationLabel: label,
    nameOnAccount: name,
    idLine,
    needs,
    canSave: !destinationId && !!deps.beneficiariesAvailable(),
    arrival: webLine(arrivalLine(method, null)),
  };
}

/**
 * The pay-out itself, after the PIN: the proof first, then the gates again,
 * the vault read at the moment of use, then requestPayout (the one door to
 * the rail, which checks the proof, the freeze and the rules once more).
 */
export async function payoutRequest(deps, { account, intentId, method, amountCents, destinationId = null, details = null, identity = null, save = false, nickname = null, proof, feeCents = null }) {
  const now = deps.now();
  const p = checkProof(deps, { account, purpose: 'payout', intentId, amountCents, proof });
  if (!p.ok) return { ...p, status: p.error === 'NO_PROOF' ? 403 : 400 };
  if (!deps.payoutAllowedFor(account.waId)) return { ok: false, error: 'DISABLED', status: 503 };
  if (!PAYOUT_METHODS[method]) return { ok: false, error: 'BAD_METHOD', status: 400 };
  if (await deps.readPayoutFreeze({ prisma: deps.prisma, accountId: account.id, fallbackProfile: account.profile || null })) return { ok: false, error: 'FROZEN', line: webLine(FROZEN_PAYOUT_COPY), status: 423 };
  if (await isPayoutHeldFor({ prisma: deps.prisma, account })) return { ok: false, error: 'PAYOUT_HOLD', line: webLine(PAYOUT_HOLD_COPY), status: 423 };
  const family = DESTINATION_FAMILY[method];
  const typed = cleanTypedIdentity(identity || {});
  if (!typed.ok) return { ok: false, error: typed.error, status: 400 };

  // The destination: a saved row is decrypted here, at the moment of use, never earlier.
  const rec = {};
  let savedLabel = null;
  let usedSavedId = null;
  if (destinationId) {
    const secret = await deps.loadPayoutDestinationSecret({ prisma: deps.prisma, accountId: account.id, id: destinationId }).catch(() => null);
    if (!secret) return { ok: false, error: 'DESTINATION_UNREADABLE', line: 'The saved details for that destination could not be read, so nothing was sent and nothing has left your balance. Type the details instead.', status: 409 };
    if ((secret.family || DESTINATION_FAMILY[secret.method]) !== family) return { ok: false, error: 'BAD_DESTINATION', status: 400 };
    if (family === 'BANK') Object.assign(rec, { account_number: secret.account_number, branch_code: secret.branch_code, branch_name: secret.branch_name });
    else rec.mobile = secret.mobile;
    savedLabel = secret.label || null;
    usedSavedId = destinationId;
  } else {
    // The PIN-reset cool-off, read again right before money moves (the chat does the same).
    const coolOff = coolOffOf(account, new Date(now));
    if (coolOff) return { ok: false, error: 'COOL_OFF', until: coolOff.until, line: coolOffLine(coolOff.until), status: 423 };
    const c = cleanDetails(method, details || {}, account);
    if (!c.ok) return { ok: false, error: c.error, status: 400 };
    Object.assign(rec, c.rec);
    savedLabel = c.label;
  }
  if ((PAYOUT_METHODS[method].fields || []).includes('mobile') && !rec.mobile) rec.mobile = account.waId;

  // The name and the ID: what was typed now, else the KYC name and the vault (decrypted only here).
  const kycName = account?.profile?.kyc?.fullName || null;
  let vaultIdentity = null;
  if (!typed.id || !(kycName || typed.name)) vaultIdentity = await deps.loadPayoutIdentitySecret({ prisma: deps.prisma, accountId: account.id }).catch(() => null);
  const id = typed.id || (vaultIdentity?.idNumber ? { idType: vaultIdentity.idType === 'PASSPORT' ? 'PASSPORT' : 'RSAID', idNumber: vaultIdentity.idNumber, countryOfIssue: vaultIdentity.countryOfIssue || null } : null);
  if (id) {
    rec.id_number = id.idNumber;
    if (id.idType === 'PASSPORT') Object.assign(rec, { id_type: deps.passportIdType(), country_of_issue: id.countryOfIssue, nationality: id.countryOfIssue });
  }
  const recipient = { ...recipientName(account, typed.name || vaultIdentity?.fullName || null), ...rec };

  // The fee the customer saw at the check: a higher one is refused by requestPayout, never charged (2026-10-24).
  const out = await deps.requestPayout({ prisma: deps.prisma, account, intentId, method, amountCents, recipient, authorization: proof, expectedFeeCents: Number.isInteger(feeCents) ? feeCents : null });
  if (out?.error === 'FEE_CHANGED') return { ok: false, error: 'FEE_CHANGED', feeCents: out.feeCents, line: webLine(feeChangedCopy(out)), status: 409 };
  if (out?.error === 'REVIEW') return { ok: false, error: 'REVIEW', line: webLine(PAYOUT_REVIEW_COPY), status: 423 };
  if (out?.error === 'TEST_RUN') return { ok: false, error: 'TEST_RUN', line: webLine(testRunCopy(out)), status: 200 };
  const accepted = !!out?.ok && (out.status === 'SETTLED' || out.status === 'PENDING' || out.status === 'AWAITING_APPROVAL');

  let saved = null;
  if (accepted) {
    const number = family === 'BANK' ? rec.account_number : rec.mobile;
    if (usedSavedId) {
      await deps.touchPayoutDestination({ prisma: deps.prisma, accountId: account.id, id: usedSavedId }).catch(() => {});
    } else {
      // A number typed again that is already saved counts as a use of the saved row, never a second one.
      const list = await deps.listPayoutDestinations({ prisma: deps.prisma, accountId: account.id }).catch(() => []);
      const fp = number ? fingerprintOf(account.id, method, number) : null;
      const same = fp ? (list || []).find((d) => d.fingerprint && d.fingerprint === fp) : null;
      if (same) await deps.touchPayoutDestination({ prisma: deps.prisma, accountId: account.id, id: same.id }).catch(() => {});
      else if (save && deps.beneficiariesAvailable()) {
        // Written only on the customer's explicit tick, and only after the rail accepted (the chat's consent rule).
        saved = await deps.savePayoutDestination({ prisma: deps.prisma, accountId: account.id, method, recipient: rec, nickname: cleanNickname(nickname) }).catch(() => null);
      }
    }
    const onFile = await deps.getPayoutIdentity({ prisma: deps.prisma, accountId: account.id }).catch(() => null);
    if (save && typed.id && typed.name && !onFile && !kycName && deps.beneficiariesAvailable()) {
      await deps.savePayoutIdentity({ prisma: deps.prisma, accountId: account.id, fullName: typed.name, idNumber: typed.id.idNumber, idType: typed.id.idType, countryOfIssue: typed.id.countryOfIssue }).catch(() => null);
    }
    await deps.mergeProfileSubkey({ accountId: account.id, key: 'app', patch: { pendingPayout: null } }).catch(() => {});
    await deps.clearPendingWithdraw({ prisma: deps.prisma, accountId: account.id }).catch(() => {});
  } else if (out?.error === 'KYC_REQUIRED') {
    await rememberPayout(deps, { account, amountCents, method, destinationId, now });
  }

  const label = savedLabel || PAYOUT_METHODS[method].label;
  await audit(deps, {
    accountId: account.id,
    event: 'APP_PAYOUT',
    metadata: { intentId, amountCents, feeCents: out?.feeCents ?? null, method, destination: label, status: out?.status || null, error: out?.error || null, reference: out?.reference || null, replayed: !!out?.replayed },
  }).catch(() => {});

  if (accepted) {
    const mobile = family === 'BANK' ? null : rec.mobile;
    const settled = out.status === 'SETTLED';
    const head = out.status === 'AWAITING_APPROVAL'
      ? `Waiting for approval. A person at WaPay checks every pay-out before it goes. ${randsShort(amountCents)}${Number.isInteger(out.feeCents) ? ` and the ${randsShort(out.feeCents)} fee` : ''} are set aside for it and nothing has left WaPay (reference ${out.reference}). Activity shows the result.`
      : settled
      ? `Done. ${randsShort(amountCents)} is on its way to you by ${PAYOUT_METHODS[method].label}. Reference ${out.reference}. Fee ${randsShort(out.feeCents ?? 0)}.`
      : payoutHandedOver(out.outcome)
        ? `On its way. ${randsShort(amountCents)} ${DESTINATION_FAMILY[method] === 'BANK' ? 'is on its way to your bank' : 'is being sent, and the collection code goes to your cellphone'} (reference ${out.reference}). Activity shows the moment it is paid, and if it does not go through the amount and the fee come straight back to your balance.`
        : `We could not get confirmation from your bank just now, so we are checking on it (reference ${out.reference}). Your ${randsShort(amountCents)}${Number.isInteger(out.feeCents) ? ` plus the ${randsShort(out.feeCents)} fee` : ''} is held, not spent; Activity shows the result either way.`;
    const steps = settled && isCashMethod(method) ? webLine(collectionSteps(method)).split('\n').filter(Boolean) : [];
    const balance = await balancesOf(deps, account.id).catch(() => null);
    return {
      ok: true,
      payoutStatus: out.status,
      reference: out.reference,
      amountCents,
      feeCents: out.feeCents ?? null,
      destinationLabel: label,
      newBalanceCents: balance ? balance.totalCents : null,
      saved: saved?.ok ? { label: saved.label } : null,
      lines: [head, webLine(arrivalLine(method, mobile))],
      steps,
    };
  }
  return { ok: false, ...payoutFailure(out, { method, amountCents }) };
}

/** A refused or failed pay-out in the chat's words (lib/payout-chat.js executeWithdraw), fit for the web. */
function payoutFailure(out, { method }) {
  const e = out?.error || 'FAILED';
  if (e === 'FROZEN') return { error: e, line: webLine(FROZEN_PAYOUT_COPY), status: 423 };
  if (e === 'DAILY_CAP') return { error: e, line: webLine(dailyCapCopy(out)), status: 409 };
  if (e === 'KYC_REQUIRED') return { error: e, line: out.reason ? webLine(kycThresholdCopy(out)) : KYC_ALL_LINE, kyc: { canVerify: !!out.kycConfigured }, status: 403 };
  if (e === 'FLOAT_SHORT') return { error: e, line: `This withdrawal could not be made right now: our pay-out account is being topped up. Nothing has left your balance and your money is safe. Try again a little later${out.alerted ? '; a person from the WaPay team has been told' : ''}.`, status: 503 };
  if (e === 'NOT_AUTHORISED') return { error: 'NO_PROOF', line: 'We could not confirm your PIN for this pay-out, so nothing was sent and nothing has left your balance.', status: 403 };
  // One withdrawal at a time (BUGLOG #147), and the rail's own reason when it said no (BUGLOG #146).
  if (e === 'OPEN_PAYOUT') return { error: e, line: webLine(openPayoutCopy(out.open || {})), status: 409 };
  if (!out?.replayed && out?.status === 'FAILED' && out?.reference) {
    const r = reasonFor({ providerStatus: out.providerStatus ?? null, outcome: out.outcome || e, message: out.message || null });
    return { error: e, reference: out.reference, line: webLine(`The pay-out did not go through, because ${r.reason}. Nothing has left your balance. ${r.nextText}`.trim()), status: 502, method };
  }
  const why = e === 'INSUFFICIENT_FUNDS' ? `you no longer have ${randsShort(out.totalCents || 0)} available`
    : e === 'NO_PROVIDER' ? 'that pay-out method is not available right now'
      : e === 'BAD_RECIPIENT' ? `the ${String(out.field || 'details').replace('_', ' ')} was not accepted`
        : e === 'DISABLED' || e === 'NOT_CONFIGURED' ? 'pay-outs are not switched on right now'
          : e === 'REQUEST_INVALID' ? 'our system could not send the request (our side, not yours) and we are fixing it'
            : `it was not accepted (${e})`;
  const status = ['DISABLED', 'NOT_CONFIGURED', 'NO_PROVIDER'].includes(e) ? 503 : e === 'INSUFFICIENT_FUNDS' || e === 'BAD_RECIPIENT' || e === 'BAD_AMOUNT' ? 400 : 502;
  return { error: e, field: out?.field || null, reference: out?.reference || null, line: `The pay-out did not go through: ${why}. Nothing has left your balance.`, status, method };
}

/** Keep the ask the identity check interrupts: the chat's own record, and the web's (which the KYC webhook leaves alone). */
async function rememberPayout(deps, { account, amountCents, method, destinationId = null, now }) {
  await deps.rememberPendingWithdraw({ prisma: deps.prisma, accountId: account.id, ask: { amountCents, method } }).catch(() => {});
  await deps.mergeProfileSubkey({ accountId: account.id, key: 'app', patch: { pendingPayout: { amountCents, method, destinationId: destinationId || null, at: new Date(now).toISOString() } } }).catch(() => {});
}

/** The identity check: a Didit session opened in this browser, coming back to the pay-out screen. */
export async function startKyc(deps, { account, origin, pending = null }) {
  if (!deps.kycConfigured()) return { ok: false, error: 'KYC_NOT_CONFIGURED', line: 'The identity check is being switched on. For now a smaller amount works.', status: 503 };
  if (account?.profile?.kyc?.status === 'VERIFIED') return { ok: false, error: 'ALREADY_VERIFIED', status: 409 };
  if (pending && Number.isInteger(pending.amountCents) && pending.amountCents > 0 && PAYOUT_METHODS[pending.method]) {
    await rememberPayout(deps, { account, amountCents: pending.amountCents, method: pending.method, destinationId: pending.destinationId || null, now: deps.now() });
  }
  const out = await deps.startKycSession({ prisma: deps.prisma, account, callbackUrl: origin ? `${origin}/app/pay-out?kyc=done` : null }).catch(() => ({ ok: false }));
  // The link goes into an href on the page: only an https link (or the dev fixture's own /app path) is handed on.
  const safe = typeof out?.url === 'string' && (/^https:\/\/\S+$/.test(out.url) || /^\/app\/[\w/?=&.-]*$/.test(out.url));
  if (!out?.ok || !safe) return { ok: false, error: 'KYC_START_FAILED', line: 'The identity check could not start right now. Please try again a little later.', status: 502 };
  return { ok: true, url: out.url };
}

// ---------------------------------------------------------------------------
// Top up by card (the existing PayFast deposit flow)
// ---------------------------------------------------------------------------

export function payfastConfigured(env = process.env) {
  return !!(env.PAYFAST_MERCHANT_ID && env.PAYFAST_MERCHANT_KEY);
}

export async function topupCard(deps, { account, amountCents, origin, env = process.env }) {
  const q = topupQuote(amountCents);
  if (!q.ok) return { ...q, line: `Card and Instant EFT top-ups are between ${randsShort(q.minCents)} and ${randsShort(q.maxCents)}.`, status: 400 };
  if (!payfastConfigured(env)) return { ok: false, error: 'NOT_CONFIGURED', line: 'Card top-ups are not available right now.', status: 503 };
  const intent = await deps.createDepositIntent({ prisma: deps.prisma, accountId: account.id, waId: account.waId, amountCents });
  const base = String(env.APP_BASE_URL || origin || '').replace(/\/+$/, '');
  const url = deps.buildCheckoutUrl({
    merchantId: env.PAYFAST_MERCHANT_ID,
    merchantKey: env.PAYFAST_MERCHANT_KEY,
    passphrase: env.PAYFAST_PASSPHRASE || undefined,
    sandbox: env.PAYFAST_SANDBOX === 'true',
    // The customer pays gross (amount + payment fee); the wallet is credited the amount (the chat's deposit flow).
    amountCents: intent.grossCents,
    mPaymentId: intent.paymentId,
    itemName: 'WaPay top-up',
    cellNumber: account.waId,
    returnUrl: `${origin}/app/top-up?paid=${encodeURIComponent(intent.paymentId)}`,
    cancelUrl: `${origin}/app/top-up?cancelled=1`,
    notifyUrl: `${base}/api/payfast/itn`,
  });
  return { ok: true, url, paymentId: intent.paymentId, amountCents, feeCents: intent.feeCents, grossCents: intent.grossCents };
}

export async function topupStatus(deps, { account, paymentId }) {
  const id = String(paymentId || '');
  if (!id || id.length > 80) return { ok: false, error: 'BAD_ID', status: 400 };
  const intent = await deps.getDepositIntent({ prisma: deps.prisma, paymentId: id }).catch(() => null);
  if (!intent || intent.accountId !== account.id || intent.route !== 'deposit') return { ok: false, error: 'NOT_FOUND', status: 404 };
  const m = meta(intent);
  const state = intent.status === 'SUCCESS' ? 'PAID' : intent.status === 'FAILED' ? 'FAILED' : 'WAITING';
  return { ok: true, state, amountCents: m.amountCents ?? null };
}

// ---------------------------------------------------------------------------
// Profile actions
// ---------------------------------------------------------------------------

/** Change the PIN: the current one through verifyPIN, the new one twice, then the chat's setPIN. */
export async function changePin(deps, { account, factor, currentPin, newPin, newPinAgain, ip }) {
  if (!pinShaped(currentPin)) return { ok: false, error: 'BAD_PIN', status: 400 };
  if (!pinShaped(newPin)) return { ok: false, error: 'BAD_NEW_PIN', line: 'A PIN is 4 to 6 digits.', status: 400 };
  if (newPin !== newPinAgain) return { ok: false, error: 'PIN_MISMATCH', line: 'Those two did not match, so your PIN is unchanged.', status: 400 };
  const v = deps.validatePINFormat(newPin);
  if (!v?.valid) return { ok: false, error: 'WEAK_PIN', line: 'That PIN is too easy to guess. Please choose 4 to 6 digits without a simple pattern like 1234, 1111 or 0000.', status: 400 };
  const accKey = `pf:a:${account.id}`;
  const ipKey = `pf:ip:${keyOf('ip', ip)}`;
  const [byAccount, byIp] = await Promise.all([deps.limiter.count(accKey, APP_LOCKOUT_WINDOW_MS), deps.limiter.count(ipKey, APP_LOCKOUT_WINDOW_MS)]);
  if (byAccount >= APP_PIN_MAX_FAILS || byIp >= APP_PIN_MAX_FAILS) return { ok: false, error: 'LOCKED', status: 429 };
  const gate = webPinGate(factor, deps.now());
  if (!gate.ok) return { ok: false, error: gate.error, lockedUntil: gate.lockedUntil || null, status: 423 };
  const out = await deps.verifyPIN({ accountId: account.id, pin: currentPin });
  if (!out?.ok) {
    if (out?.error === 'INVALID_PIN') {
      await Promise.all([deps.limiter.hit(accKey, { accountId: account.id }), deps.limiter.hit(ipKey)]);
      return { ok: false, error: 'WRONG_PIN', line: 'That is not your current PIN, so nothing changed.', status: 401 };
    }
    return { ok: false, error: out?.error === 'SOFT_LOCKOUT' ? 'PIN_LOCKED' : out?.error === 'HARD_LOCKOUT' ? 'PIN_RESET_NEEDED' : 'PIN_CHECK_FAILED', status: 423 };
  }
  const set = await deps.setPIN({ accountId: account.id, pin: newPin });
  if (!set?.ok) return { ok: false, error: 'PIN_NOT_SAVED', line: 'The new PIN could not be saved just now, so your PIN is unchanged.', status: 500 };
  await audit(deps, { accountId: account.id, event: 'APP_PIN_CHANGE', metadata: { pinLength: newPin.length } }).catch(() => {});
  return { ok: true };
}

/** Remove one saved pay-out destination (the row must be this account's). */
export async function removeDestination(deps, { account, id }) {
  const did = String(id || '');
  if (!did || did.length > 64) return { ok: false, error: 'BAD_ID', status: 400 };
  const res = await deps.prisma.payoutDestination.deleteMany({ where: { id: did, accountId: account.id } });
  if (!res?.count) return { ok: false, error: 'NOT_FOUND', status: 404 };
  log('payout_destination_removed_app', { accountId: account.id });
  return { ok: true };
}

export async function forgetDetails(deps, { account }) {
  const out = await deps.forgetPayoutDetails({ prisma: deps.prisma, accountId: account.id });
  return out?.ok ? { ok: true, destinations: out.destinations, identities: out.identities } : { ok: false, error: 'FORGET_FAILED', status: 500 };
}

export async function nameDestination(deps, { account, id, nickname }) {
  const out = await deps.setPayoutDestinationNickname({ prisma: deps.prisma, accountId: account.id, id: String(id || ''), nickname });
  return out?.ok ? { ok: true, label: out.label } : { ok: false, error: out?.error || 'BAD_INPUT', status: out?.error === 'NOT_FOUND' ? 404 : 400 };
}

/** The member's own invite link: the referral code is issued here, on the customer's own ask (lib/referrals.js). */
export async function issueInvite(deps, { account }) {
  const code = await deps.ensureReferralCode({ prisma: deps.prisma, accountId: account.id });
  return { ok: true, code, link: referralLink(code), message: inviteMessage({ code }) };
}
