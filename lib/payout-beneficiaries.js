/**
 * Remembered pay-out details: the recipient's name and ID number once per
 * account, and up to MAX_DESTINATIONS destinations (a bank account for
 * PayShap / RTC, a cellphone for cash collection). Founder ask 2026-10-04:
 * "it should ask if you should remember it for the next payment … we only
 * have to ask them once … list beneficiaries or payout people."
 *
 * Rules (agreed with the architecture session the same day):
 *   - written ONLY on an explicit YES, after a pay-out the rail accepted;
 *   - the account number and the ID number are encrypted (lib/pii-vault.js)
 *     with the key version they were written with; last-3 masks in clear;
 *   - nothing full leaves this module except through load*Secret, whose
 *     only caller builds the rail request; the context pack and the chat
 *     menus get labels and masks (listPayoutDestinations, getPayoutIdentity);
 *   - one row per account number or cellphone (fingerprint), newest use
 *     first, pruned to MAX_DESTINATIONS;
 *   - forgetPayoutDetails deletes both tables for the account in one call;
 *   - without WAPAY_PII_KEY nothing is ever offered or saved
 *     (beneficiariesAvailable).
 * Every read is best-effort (null / []), so the withdraw flow never fails
 * because a convenience table was unreachable.
 */
import crypto from 'node:crypto';
import prisma from './prisma.js';
import { encryptPii, decryptPii, vaultConfigured, last3, maskDigits } from './pii-vault.js';

export const MAX_DESTINATIONS = 5;
/** Bank destinations serve PayShap and RTC alike; cash destinations serve the three cash methods. */
export const DESTINATION_FAMILY = Object.freeze({ PAYSHAP: 'BANK', RTC: 'BANK', CASHSEND: 'CASH', NEDCASH: 'CASH', EWALLET: 'CASH' });

const log = (type, data) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
const digits = (v) => String(v ?? '').replace(/\D/g, '');

export function beneficiariesAvailable() {
  return vaultConfigured();
}

/** sha256(accountId | family | number): the same bank account saved via PayShap and RTC is one row. */
export function fingerprintOf(accountId, method, number) {
  const family = DESTINATION_FAMILY[method] || String(method || '');
  return crypto.createHash('sha256').update(`${accountId}|${family}|${digits(number)}`).digest('hex');
}

/**
 * "FNB account •••394" / "Cellphone •••175": the only rendering the customer
 * or the model ever sees. A cash destination is the cellphone, whichever bank
 * the code comes from (the same number serves Absa, Nedbank and FNB), so its
 * label names no bank. With a nickname: "Mine: FNB account •••394".
 */
export function destinationLabel(method, recipient = {}, nickname = null) {
  const base = DESTINATION_FAMILY[method] === 'BANK'
    ? `${String(recipient.branch_name || 'Bank').trim()} account ${maskDigits(recipient.account_number)}`
    : `Cellphone ${maskDigits(recipient.mobile)}`;
  const nick = cleanNickname(nickname);
  return nick ? `${nick}: ${base}` : base;
}

/** "mine" / "my mom" / "Mother": one or two words of letters, title-cased, or null. */
export function cleanNickname(raw) {
  const t = String(raw ?? '').trim().replace(/\s+/g, ' ').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  if (!t || t.length > 24 || !/^[\p{L}][\p{L}' -]*$/u.test(t) || t.split(' ').length > 3) return null;
  if (/^(?:me|myself|my own|mine|my number|my account|my bank account|own)$/i.test(t)) return 'Mine';
  return t.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/** The number a destination is addressed by, for the fingerprint. */
function destinationNumber(method, recipient = {}) {
  return DESTINATION_FAMILY[method] === 'BANK' ? digits(recipient.account_number) : digits(recipient.mobile);
}

// ---------------------------------------------------------------- identity

/** Masked view: { fullName, idType, idLast3, consentAt } or null. Never throws. */
export async function getPayoutIdentity({ prisma: db = prisma, accountId } = {}) {
  if (!accountId) return null;
  try {
    const row = await db.payoutIdentity.findUnique({ where: { accountId } });
    return row ? { fullName: row.fullName, idType: row.idType, idLast3: row.idLast3, consentAt: row.consentAt } : null;
  } catch (error) {
    log('payout_identity_read_failed', { accountId, error: error?.message });
    return null;
  }
}

/** The decrypted identity for the rail request only: { fullName, idNumber, idType } or null. */
export async function loadPayoutIdentitySecret({ prisma: db = prisma, accountId } = {}) {
  if (!accountId) return null;
  try {
    const row = await db.payoutIdentity.findUnique({ where: { accountId } });
    if (!row) return null;
    return { fullName: row.fullName, idType: row.idType, idNumber: decryptPii(row.idEnc, row.keyVersion) };
  } catch (error) {
    log('payout_identity_load_failed', { accountId, error: error?.code || error?.message });
    return null;
  }
}

/** Upsert the name and the ID number (encrypted). Requires the vault; validates the 13 digits. */
export async function savePayoutIdentity({ prisma: db = prisma, accountId, fullName, idNumber, idType = 'RSAID' } = {}) {
  if (!accountId) return { ok: false, error: 'NO_ACCOUNT' };
  if (!beneficiariesAvailable()) return { ok: false, error: 'VAULT_NOT_CONFIGURED' };
  const name = String(fullName || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const id = digits(idNumber);
  if (name.split(' ').length < 2) return { ok: false, error: 'BAD_NAME' };
  if (idType === 'RSAID' && id.length !== 13) return { ok: false, error: 'BAD_ID' };
  if (!id) return { ok: false, error: 'BAD_ID' };
  const { enc, keyVersion } = encryptPii(id);
  const data = { fullName: name, idType, idEnc: enc, idLast3: last3(id), keyVersion, consentAt: new Date() };
  await db.payoutIdentity.upsert({ where: { accountId }, create: { accountId, ...data }, update: data });
  log('payout_identity_saved', { accountId, idLast3: data.idLast3, keyVersion });
  return { ok: true, fullName: name, idLast3: data.idLast3 };
}

// ------------------------------------------------------------ destinations

/** The label a row shows today, from its masked fields, never from a stored string (a stored label went stale when the wording changed, 2026-10-09). */
export function displayLabelOf(r) {
  const last3 = DESTINATION_FAMILY[r.method] === 'BANK' ? r.accountLast3 : r.mobileLast3;
  // A row without its masked fields (a reader's stub, an old shape) keeps the label it stored.
  const base = !last3
    ? String(r.label || '')
    : DESTINATION_FAMILY[r.method] === 'BANK'
      ? `${String(r.bankName || 'Bank').trim()} account •••${String(last3).slice(-3)}`
      : `Cellphone •••${String(last3).slice(-3)}`;
  return r.nickname ? `${r.nickname}: ${base}` : base;
}

/** Masked list, newest use first: [{ id, method, family, label (with the nickname prefix), nickname, bankName, fingerprint, lastUsedAt, timesUsed }]. Never throws. */
export async function listPayoutDestinations({ prisma: db = prisma, accountId, family = null } = {}) {
  if (!accountId) return [];
  try {
    const rows = await db.payoutDestination.findMany({ where: { accountId }, orderBy: { lastUsedAt: 'desc' }, take: MAX_DESTINATIONS });
    return rows
      .map((r) => ({ id: r.id, method: r.method, family: DESTINATION_FAMILY[r.method] || null, label: displayLabelOf(r), nickname: r.nickname || null, bankName: r.bankName || null, fingerprint: r.fingerprint, lastUsedAt: r.lastUsedAt, timesUsed: r.timesUsed }))
      .filter((r) => !family || r.family === family);
  } catch (error) {
    log('payout_destinations_read_failed', { accountId, error: error?.message });
    return [];
  }
}

/** The decrypted recipient fields for the rail request only, or null. Must belong to the account. */
export async function loadPayoutDestinationSecret({ prisma: db = prisma, accountId, id } = {}) {
  if (!accountId || !id) return null;
  try {
    const r = await db.payoutDestination.findUnique({ where: { id } });
    if (!r || r.accountId !== accountId) return null;
    const out = { id: r.id, method: r.method, family: DESTINATION_FAMILY[r.method] || null, label: displayLabelOf(r), nickname: r.nickname || null };
    if (r.accountEnc) Object.assign(out, { account_number: decryptPii(r.accountEnc, r.keyVersion), branch_code: r.branchCode || '', branch_name: r.bankName || '' });
    if (r.mobileEnc) out.mobile = decryptPii(r.mobileEnc, r.keyVersion);
    return out;
  } catch (error) {
    log('payout_destination_load_failed', { accountId, id, error: error?.code || error?.message });
    return null;
  }
}

/** Save (or refresh) one destination after consent, with an optional nickname; prunes the oldest beyond MAX_DESTINATIONS. */
export async function savePayoutDestination({ prisma: db = prisma, accountId, method, recipient = {}, nickname = null } = {}) {
  if (!accountId) return { ok: false, error: 'NO_ACCOUNT' };
  if (!beneficiariesAvailable()) return { ok: false, error: 'VAULT_NOT_CONFIGURED' };
  const family = DESTINATION_FAMILY[method];
  if (!family) return { ok: false, error: 'BAD_METHOD' };
  const number = destinationNumber(method, recipient);
  if (number.length < 6) return { ok: false, error: 'BAD_NUMBER' };
  const label = destinationLabel(method, recipient);
  const nick = cleanNickname(nickname);
  const fingerprint = fingerprintOf(accountId, method, number);
  const { enc, keyVersion } = encryptPii(number);
  const fields = family === 'BANK'
    ? { bankName: String(recipient.branch_name || '').slice(0, 40) || null, branchCode: digits(recipient.branch_code) || null, accountEnc: enc, accountLast3: last3(number), mobileEnc: null, mobileLast3: null }
    : { bankName: null, branchCode: null, accountEnc: null, accountLast3: null, mobileEnc: enc, mobileLast3: last3(number) };
  const now = new Date();
  const row = await db.payoutDestination.upsert({
    where: { accountId_fingerprint: { accountId, fingerprint } },
    create: { accountId, method, label, nickname: nick, fingerprint, keyVersion, consentAt: now, lastUsedAt: now, ...fields },
    update: { method, label, keyVersion, lastUsedAt: now, timesUsed: { increment: 1 }, ...fields, ...(nick ? { nickname: nick } : {}) },
  });
  // Bounded: the sixth save drops the one used longest ago.
  let pruned = 0;
  const all = await db.payoutDestination.findMany({ where: { accountId }, orderBy: { lastUsedAt: 'desc' }, select: { id: true } });
  if (all.length > MAX_DESTINATIONS) {
    const drop = all.slice(MAX_DESTINATIONS).map((x) => x.id);
    const res = await db.payoutDestination.deleteMany({ where: { id: { in: drop } } });
    pruned = res?.count ?? drop.length;
  }
  const shown = (row.nickname || nick) ? `${row.nickname || nick}: ${label}` : label;
  log('payout_destination_saved', { accountId, method, label: shown, pruned });
  return { ok: true, id: row.id, label: shown, nickname: row.nickname || nick || null, pruned };
}

/** A saved destination was used again: bump the counters. Best-effort. */
export async function touchPayoutDestination({ prisma: db = prisma, accountId, id } = {}) {
  if (!accountId || !id) return;
  await db.payoutDestination.updateMany({ where: { id, accountId }, data: { lastUsedAt: new Date(), timesUsed: { increment: 1 } } }).catch(() => {});
}

/** "forget my bank details": every saved destination and the identity, gone in one call. Never throws. */
export async function forgetPayoutDetails({ prisma: db = prisma, accountId } = {}) {
  if (!accountId) return { ok: false, identities: 0, destinations: 0 };
  try {
    const d = await db.payoutDestination.deleteMany({ where: { accountId } });
    const i = await db.payoutIdentity.deleteMany({ where: { accountId } });
    log('payout_details_forgotten', { accountId, identities: i?.count ?? 0, destinations: d?.count ?? 0 });
    return { ok: true, identities: i?.count ?? 0, destinations: d?.count ?? 0 };
  } catch (error) {
    log('payout_details_forget_failed', { accountId, error: error?.message });
    return { ok: false, identities: 0, destinations: 0 };
  }
}
