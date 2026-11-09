/**
 * Operator pay-out (2026-10-21, the day Meta restricted the WhatsApp number
 * for 30 days and no customer could see the withdrawal prompts): pay a
 * customer's OWN balance to a destination THEY saved, from the operator's
 * side, through the very same rail, rules and ledger as the chat
 * (`requestPayout`). Nothing here invents a destination or an identity: the
 * saved vault rows are decrypted at the moment of use, exactly as the chat
 * does (lib/payout-chat.js), and the authorisation is a STEP_UP proof bound
 * to this account, this intent and this amount, which `requestPayout`
 * verifies like any PIN proof.
 *
 * Dry run (the default) reads everything and sends nothing: the quote, the
 * pay-out rules, the freeze, the balance, the destination label and whether
 * an identity is on file. The live run is a deliberate second call with
 * `dryRun: false` and a `by` + `reason` that go to the audit log and the ops
 * alert. Account and ID numbers never appear in a response, only last digits.
 *
 * The ID number (2026-11-09, BUGLOG #147): OTT's live provider list started
 * asking for id_number on PayShap while this file still read the static list,
 * so a link the dry run called clear failed at the rail with BAD_RECIPIENT.
 * Both runs now take the required fields from the live list (the same one the
 * rail's cleanRecipient reads), and when an ID is needed it comes from, in
 * order: the identity vault; the sealed recipient of the customer's most
 * recent pay-out request, only when its name matches the verified (KYC) name;
 * otherwise the dry run blocks with NO_IDENTITY and says why in plain words.
 */
import prisma from './prisma.js';
import { requestPayout, quotePayout, payoutBalances, payoutEnabled, payoutConfigured, accountKycVerified, resolveProviders, requiredRecipientFields, PAYOUT_METHODS, MAX_PAYOUT_CENTS, passportIdType } from './payouts.js';
import { decryptPii, last3Alnum } from './pii-vault.js';
import { checkPayoutRules } from './payout-rules.js';
import { readPayoutFreeze } from './payout-freeze.js';
import { isPayoutHeld } from './payout-hold.js';
import { listPayoutDestinations, loadPayoutDestinationSecret, loadPayoutIdentitySecret, getPayoutIdentity, touchPayoutDestination, DESTINATION_FAMILY } from './payout-beneficiaries.js';
import { floatPosition } from './payout-float.js';
import { issuePinProof } from '@wapay/auth/pin-proof';

const mask = (v) => (v ? `•••${String(v).slice(-3)}` : null);

function recipientName(account, fullName = null) {
  const full = String(account?.profile?.kyc?.fullName || fullName || '').trim();
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return { firstname: parts[0], surname: parts.slice(1).join(' ') };
  const one = parts[0] || String(account?.displayName || '').trim().split(/\s+/)[0] || 'WaPay';
  return { firstname: one, surname: 'Customer' };
}

/** A name as a set of words: case, accents, punctuation and word order do not matter ("JELE Ncamsile" = "Ncamsile Jele"). */
export function nameKey(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean).sort().join(' ');
}
export function sameName(a, b) {
  const x = nameKey(a);
  return !!x && x === nameKey(b);
}

/**
 * The newest ID number this account typed for a pay-out request (BUGLOG #147). A request waiting for the
 * founder keeps its recipient sealed on its row (lib/payouts.js, APPROVAL MODE, lib/pii-vault.js); approving
 * or rejecting it drops the seal, so only a request still waiting has one. Decrypted in memory for the
 * caller, never logged. Returns { fullName, idNumber, idType, countryOfIssue, reference } or null.
 */
export async function idFromLastPayoutRequest({ prisma: db = prisma, accountId, take = 10 } = {}) {
  if (!accountId || typeof db?.providerRequest?.findMany !== 'function') return null;
  const rows = await db.providerRequest.findMany({ where: { accountId: String(accountId), route: 'ott-payout' }, orderBy: { requestTs: 'desc' }, take, select: { metadata: true } });
  for (const row of rows || []) {
    const m = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    if (!m.approval?.enc) continue;
    let sealed;
    try { sealed = JSON.parse(decryptPii(m.approval.enc, m.approval.keyVersion || 1)); } catch { continue; }
    const r = sealed?.recipient || {};
    if (!r.id_number) continue;
    const passport = !!r.id_type && String(r.id_type).toUpperCase() !== 'RSAID';
    return { fullName: `${r.firstname || ''} ${r.surname || ''}`.trim(), idNumber: String(r.id_number), idType: passport ? 'PASSPORT' : 'RSAID', countryOfIssue: passport ? r.country_of_issue || null : null, reference: m.reference || null };
  }
  return null;
}

/**
 * Whether an ID found on a pay-out request may be used for this account: the customer's ID is verified, the
 * request's name is the verified name, and, when the verification kept the ID's last three characters, they
 * match too. { ok } or { ok:false, problem }.
 */
export function usableRequestId(found, account) {
  if (!found?.idNumber) return { ok: false, problem: 'NOT_ON_FILE' };
  const kyc = account?.profile?.kyc || {};
  if (!accountKycVerified(account) || !kyc.fullName) return { ok: false, problem: 'NO_VERIFIED_NAME' };
  if (!sameName(found.fullName, kyc.fullName)) return { ok: false, problem: 'NAME_MISMATCH' };
  const kycLast3 = last3Alnum(kyc.idNumberMasked);
  if (kycLast3.length === 3 && kycLast3 !== last3Alnum(found.idNumber)) return { ok: false, problem: 'ID_MISMATCH' };
  if (found.idType === 'RSAID' && !/^\d{13}$/.test(found.idNumber)) return { ok: false, problem: 'NOT_ON_FILE' };
  return { ok: true };
}

const FIELD_WORDS = { id_number: 'ID number', mobile: 'cellphone number', account_number: 'bank account number', branch_code: 'branch code', branch_name: 'bank name', email: 'email address', date_of_birth: 'date of birth', id_type: 'ID document type', country_of_issue: 'ID issuing country', nationality: 'nationality', title: 'title', middle_name: 'middle name', bank_id: 'bank', account_name: 'account holder name', swift_code: 'SWIFT code', firstname: 'first name', surname: 'surname' };
export const fieldWords = (f) => FIELD_WORDS[f] || String(f || '').replace(/_/g, ' ');
const listWords = (fields) => {
  const w = fields.map(fieldWords);
  return w.length > 1 ? `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}` : w[0] || '';
};

/** One blocker in plain words, for the founder on the link page and the internal route. */
export function blockerText(code, ctx = {}) {
  const label = ctx.methodLabel || 'This method';
  const R = (c) => `R${(Number(c || 0) / 100).toFixed(2)}`;
  switch (code) {
    case 'PAYOUT_HOLD': return 'Pay-outs are on hold for everyone (the global pay-out hold is on).';
    case 'DISABLED': return 'Pay-outs are switched off in this deployment.';
    case 'NOT_CONFIGURED': return 'The pay-out rail is not set up in this deployment.';
    case 'FROZEN': return "The customer's account is frozen for pay-outs.";
    case 'DAILY_CAP': return `This is over the customer's daily pay-out limit${Number.isInteger(ctx.rules?.remainingCents) ? ` (${R(ctx.rules.remainingCents)} left today)` : ''}.`;
    case 'KYC_REQUIRED': return 'The customer must verify their ID before a pay-out of this size.';
    case 'MISSING_FIELDS': return `${label} now asks for the customer's ${listWords(ctx.missingFields || [])}, which WaPay does not hold for this customer.`;
    case 'NO_IDENTITY':
      switch (ctx.idProblem) {
        case 'NAME_MISMATCH': return `The customer's ID number is not on file. Their last pay-out request has one, but under a different name than their verified ID, so it was not used.`;
        case 'ID_MISMATCH': return `The customer's ID number is not on file. Their last pay-out request has one, but it does not end like their verified ID, so it was not used.`;
        case 'NO_VERIFIED_NAME': return `The customer's ID number is not on file. Their last pay-out request has one, but the customer has no verified ID to check it against, so it was not used.`;
        case 'NO_NAME': return "The customer's name is not on file (no verified ID and no saved identity).";
        default: return `The customer's ID number is not on file, and ${label} asks for one.`;
      }
    default: return `A check failed: ${code}.`;
  }
}

/** What the rail said about a refused pay-out, in plain words (null when it was not refused). */
export function railText(out, methodLabel = 'The rail') {
  if (!out || out.ok) return null;
  if (out.error === 'BAD_RECIPIENT') return out.field ? `${methodLabel} refused the details: the customer's ${fieldWords(out.field)} is missing or not valid. No money moved.` : `${methodLabel} refused the recipient details. No money moved.`;
  return null;
}

export function newOpsIntentId(now = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `ops-${now.toString(36)}-${rand}`;
}

/**
 * @returns {Promise<object>} always { ok, dryRun, ... }; never throws for an
 * expected refusal (NO_ACCOUNT, NEED_DESTINATION, NO_IDENTITY, DISABLED, …).
 */
export async function opsPayout({
  prisma: db = prisma,
  accountId,
  destinationId = null,
  amountCents,
  by = 'ops',
  reason = '',
  dryRun = true,
  now = Date.now(),
  intentId: fixedIntentId = null,
  deps = {},
} = {}) {
  const d = {
    listDestinations: listPayoutDestinations,
    loadDestination: loadPayoutDestinationSecret,
    loadIdentity: loadPayoutIdentitySecret,
    identityOnFile: getPayoutIdentity,
    idFromRequests: idFromLastPayoutRequest,
    providers: () => resolveProviders({}),
    touchDestination: touchPayoutDestination,
    requestPayout,
    balances: payoutBalances,
    rules: checkPayoutRules,
    freeze: readPayoutFreeze,
    held: isPayoutHeld,
    float: floatPosition,
    issueProof: issuePinProof,
    enabled: payoutEnabled,
    configured: payoutConfigured,
    send: null,
    audit: null,
    alert: null,
    ...deps,
  };
  if (!accountId) return { ok: false, dryRun, error: 'NO_ACCOUNT' };
  const account = await db.account.findUnique({ where: { id: String(accountId) } });
  if (!account) return { ok: false, dryRun, error: 'NO_ACCOUNT' };

  const saved = await d.listDestinations({ prisma: db, accountId: account.id });
  const list = (saved || []).map((s) => ({ id: s.id, method: s.method, label: s.label || s.nickname || null, timesUsed: s.timesUsed ?? null }));
  const chosen = destinationId ? list.find((s) => s.id === destinationId) : (list.length === 1 ? list[0] : null);
  if (!chosen) return { ok: false, dryRun, error: 'NEED_DESTINATION', destinations: list };
  const method = chosen.method;
  if (!PAYOUT_METHODS[method]) return { ok: false, dryRun, error: 'BAD_METHOD', method };

  const balances = await d.balances({ prisma: db, accountId: account.id });
  const cents = amountCents === 'max' ? null : Number(amountCents);
  if (amountCents !== 'max' && (!Number.isInteger(cents) || cents <= 0)) return { ok: false, dryRun, error: 'BAD_AMOUNT' };

  // "max" = the whole balance minus the rail fee, the way the chat offers it,
  // capped at the per-pay-out ceiling (MAX_PAYOUT_CENTS, R3,000 by default):
  // a bigger balance goes out in more than one pay-out, each under the rules.
  let amount = cents;
  let quote = null;
  try {
    if (amountCents === 'max') {
      let probe = Math.min(balances.totalCents, MAX_PAYOUT_CENTS);
      for (let i = 0; i < 4 && probe > 0; i++) { const q = quotePayout({ method, amountCents: probe }); if (q.totalCents <= balances.totalCents) { quote = q; amount = probe; break; } probe = Math.min(balances.totalCents - q.feeCents, MAX_PAYOUT_CENTS); }
      if (!quote) return { ok: false, dryRun, error: 'BAD_AMOUNT', balances, destination: chosen, maxPayoutCents: MAX_PAYOUT_CENTS };
    } else {
      quote = quotePayout({ method, amountCents: amount });
    }
  } catch (e) {
    return { ok: false, dryRun, error: e?.code || 'BAD_AMOUNT', message: e?.message, balances, destination: chosen, maxPayoutCents: MAX_PAYOUT_CENTS };
  }
  if (quote.totalCents > balances.totalCents) return { ok: false, dryRun, error: 'INSUFFICIENT', quote, balances };

  const held = await d.held({ prisma: db }).catch(() => true);
  const frozen = await d.freeze({ prisma: db, accountId: account.id, fallbackProfile: account.profile || null });
  const rules = await d.rules({ prisma: db, account, amountCents: amount });
  const identityOnFile = await d.identityOnFile({ prisma: db, accountId: account.id }).catch(() => null);
  const kycName = account?.profile?.kyc?.fullName || null;

  // The recipient fields this method needs: OTT's live list when it answers (the list the rail's
  // cleanRecipient checks), else the static one. BUGLOG #147: OTT added id_number to PayShap and this
  // file read only the static list, so the dry run said "all clear" and the rail refused the pay-out.
  let providers = null;
  if (d.configured()) { try { providers = await d.providers({ prisma: db }); } catch { providers = null; } }
  const live = Array.isArray(providers) ? providers.find((p) => p.method === method) : null;
  const liveFields = Array.isArray(live?.requiredFields) && live.requiredFields.length ? live.requiredFields : null;
  const needFields = requiredRecipientFields(method, liveFields);
  const needsId = needFields.includes('id_number');

  // Where the ID comes from: the vault; else the most recent pay-out request's sealed recipient, only when it
  // passes usableRequestId; else nowhere. Never invented. Only the last three characters leave this function.
  let idFound = identityOnFile ? { source: 'VAULT', fullName: identityOnFile.fullName, idType: identityOnFile.idType, idLast3: identityOnFile.idLast3 || null } : null;
  let requestId = null;
  let idProblem = null;
  if (!identityOnFile && needsId) {
    const found = await d.idFromRequests({ prisma: db, accountId: account.id }).catch(() => null);
    const use = usableRequestId(found, account);
    if (use.ok) {
      requestId = found;
      idFound = { source: 'LAST_PAYOUT_REQUEST', fullName: found.fullName, idType: found.idType, idLast3: last3Alnum(found.idNumber), reference: found.reference || null };
    } else idProblem = use.problem;
  }
  if (!idProblem && !identityOnFile && !kycName) idProblem = 'NO_NAME';
  // Every other field the rail will ask for must be one this pay-out can fill.
  const family = DESTINATION_FAMILY[method] || null;
  const canFill = (f) => ['firstname', 'surname', 'mobile'].includes(f)
    || (family === 'BANK' && ['account_number', 'branch_code', 'branch_name'].includes(f))
    || (idFound?.idType === 'PASSPORT' && ['id_type', 'country_of_issue', 'nationality'].includes(f));
  const missingFields = needFields.filter((f) => f !== 'id_number' && !canFill(f));
  let float = null;
  try { float = await d.float({ prisma: db }); } catch { float = null; }

  const base = {
    dryRun,
    account: { id: account.id, phone: mask(account.waId), name: kycName || identityOnFile?.fullName || account.displayName || null },
    destination: { id: chosen.id, method, label: chosen.label, family: DESTINATION_FAMILY[method] || null },
    identity: idFound,
    requiredFields: { fields: needFields, from: liveFields ? 'OTT' : 'STATIC' },
    quote,
    balances,
    payoutHold: !!held,
    frozen: frozen || null,
    rules,
    float: float ? { balanceCents: float.balanceCents ?? float.floatCents ?? null } : null,
    enabled: d.enabled(),
    configured: d.configured(),
    maxPayoutCents: MAX_PAYOUT_CENTS,
  };
  const blockers = [];
  if (held) blockers.push('PAYOUT_HOLD');
  if (!base.enabled) blockers.push('DISABLED');
  if (!base.configured) blockers.push('NOT_CONFIGURED');
  if (frozen) blockers.push('FROZEN');
  if (!rules.ok) blockers.push(rules.error || 'RULES');
  if ((needsId && !idFound) || idProblem === 'NO_NAME') blockers.push('NO_IDENTITY');
  if (missingFields.length) blockers.push('MISSING_FIELDS');
  const methodLabel = PAYOUT_METHODS[method].label;
  const blockerDetails = blockers.map((code) => ({ code, text: blockerText(code, { methodLabel, rules, idProblem, missingFields }) }));
  const why = blockerDetails.length ? { blockerDetails, message: blockerDetails[0].text, ...(missingFields.length ? { missingFields } : {}) } : { blockerDetails };
  if (dryRun) return { ok: blockers.length === 0, ...base, blockers, ...why };
  if (blockers.length) return { ok: false, ...base, blockers, ...why, error: blockers[0] };
  if (!reason || !by) return { ok: false, ...base, error: 'NEED_REASON' };

  // Live: decrypt at the moment of use, build the recipient as the chat does.
  const secret = await d.loadDestination({ prisma: db, accountId: account.id, id: chosen.id }).catch(() => null);
  if (!secret) return { ok: false, ...base, error: 'DESTINATION_UNREADABLE' };
  const rec = {};
  if (DESTINATION_FAMILY[method] === 'BANK') Object.assign(rec, { account_number: secret.account_number, branch_code: secret.branch_code, branch_name: secret.branch_name });
  else rec.mobile = secret.mobile;
  if (needFields.includes('mobile') && !rec.mobile) rec.mobile = account.waId;
  // The vault's ID, decrypted now; else the request's ID the checks above accepted (already in memory).
  let identity = await d.loadIdentity({ prisma: db, accountId: account.id }).catch(() => null);
  if (!identity?.idNumber && requestId) identity = requestId;
  if (identity?.idNumber) {
    rec.id_number = identity.idNumber;
    if (identity.idType === 'PASSPORT') Object.assign(rec, { id_type: passportIdType(), country_of_issue: identity.countryOfIssue || null, nationality: identity.countryOfIssue || null });
  }
  if (!rec.id_number && needsId) return { ok: false, ...base, error: 'NO_IDENTITY', message: blockerText('NO_IDENTITY', { methodLabel, idProblem }) };
  const recipient = { ...recipientName(account, identity?.fullName || null), ...rec };

  // A caller may fix the intent (the tap-to-pay link does): requestPayout
  // dedupes on it, so a second tap or a retry returns the first result.
  const intentId = fixedIntentId && /^[A-Za-z0-9-]{8,64}$/.test(String(fixedIntentId)) ? String(fixedIntentId) : newOpsIntentId(now);
  const authorization = d.issueProof({ accountId: account.id, intentId, amountCents: amount, via: 'STEP_UP', now });
  if (!authorization) return { ok: false, ...base, error: 'NO_PROOF_SECRET' };
  // An operator pay-out never carries the express fee (2026-10-24): the founder chose when it goes, not the customer.
  // Never waits for the founder's approval either: the founder started it (2026-10-26).
  // The provider list the checks above read goes with it, so the rail validates against the same fields.
  const out = await d.requestPayout({ prisma: db, account, intentId, method, amountCents: amount, recipient, ...(live ? { providers } : {}), authorization, allowExpress: false, allowApproval: false });
  const accepted = !!out?.ok && (out.status === 'SETTLED' || out.status === 'PENDING');
  if (accepted) await d.touchDestination({ prisma: db, accountId: account.id, id: chosen.id }).catch(() => {});

  const record = { event: 'OPS_PAYOUT', accountId: account.id, metadata: { by: String(by).slice(0, 60), reason: String(reason).slice(0, 200), amountCents: amount, feeCents: quote.feeCents, method, destination: chosen.label, intentId, status: out?.status || null, error: out?.error || null, reference: out?.reference || null } };
  try { if (d.audit) await d.audit(record); else await db.auditLog.create({ data: { accountId: account.id, event: record.event, metadata: record.metadata } }); } catch {}
  if (accepted && d.alert) { try { await d.alert({ amountCents: amount, method, reference: out.reference, by }); } catch {} }
  if (accepted && d.send) {
    const text = `✅ Your pay-out of R${(amount / 100).toFixed(2)} to ${chosen.label || PAYOUT_METHODS[method].label} has been sent by the WaPay team${out.status === 'PENDING' ? ' and is being processed by the bank' : ''}. Reply if anything is wrong.`;
    try { await d.send({ accountId: account.id, to: account.waId, text }); } catch {}
  }
  const said = railText(out, methodLabel);
  return { ok: accepted, ...base, intentId, ...(said ? { message: said } : {}), result: { status: out?.status || null, error: out?.error || null, field: out?.field || null, message: said, reference: out?.reference || null, providerRef: out?.providerRef || null, floatCents: out?.floatCents ?? null } };
}
