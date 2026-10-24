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
 */
import prisma from './prisma.js';
import { requestPayout, quotePayout, payoutBalances, payoutEnabled, payoutConfigured, PAYOUT_METHODS, MAX_PAYOUT_CENTS, passportIdType } from './payouts.js';
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
  let float = null;
  try { float = await d.float({ prisma: db }); } catch { float = null; }

  const base = {
    dryRun,
    account: { id: account.id, phone: mask(account.waId), name: kycName || identityOnFile?.fullName || account.displayName || null },
    destination: { id: chosen.id, method, label: chosen.label, family: DESTINATION_FAMILY[method] || null },
    identity: identityOnFile ? { fullName: identityOnFile.fullName, idType: identityOnFile.idType, idLast3: identityOnFile.idLast3 || null } : null,
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
  if (!identityOnFile && !kycName) blockers.push('NO_IDENTITY');
  if (dryRun) return { ok: blockers.length === 0, ...base, blockers };
  if (blockers.length) return { ok: false, ...base, blockers, error: blockers[0] };
  if (!reason || !by) return { ok: false, ...base, error: 'NEED_REASON' };

  // Live: decrypt at the moment of use, build the recipient as the chat does.
  const secret = await d.loadDestination({ prisma: db, accountId: account.id, id: chosen.id }).catch(() => null);
  if (!secret) return { ok: false, ...base, error: 'DESTINATION_UNREADABLE' };
  const rec = {};
  if (DESTINATION_FAMILY[method] === 'BANK') Object.assign(rec, { account_number: secret.account_number, branch_code: secret.branch_code, branch_name: secret.branch_name });
  else rec.mobile = secret.mobile;
  if ((PAYOUT_METHODS[method].fields || []).includes('mobile') && !rec.mobile) rec.mobile = account.waId;
  const identity = await d.loadIdentity({ prisma: db, accountId: account.id }).catch(() => null);
  if (identity?.idNumber) {
    rec.id_number = identity.idNumber;
    if (identity.idType === 'PASSPORT') Object.assign(rec, { id_type: passportIdType(), country_of_issue: identity.countryOfIssue || null, nationality: identity.countryOfIssue || null });
  }
  if (!rec.id_number && (PAYOUT_METHODS[method].fields || []).includes('id_number')) return { ok: false, ...base, error: 'NO_IDENTITY' };
  const recipient = { ...recipientName(account, identity?.fullName || null), ...rec };

  // A caller may fix the intent (the tap-to-pay link does): requestPayout
  // dedupes on it, so a second tap or a retry returns the first result.
  const intentId = fixedIntentId && /^[A-Za-z0-9-]{8,64}$/.test(String(fixedIntentId)) ? String(fixedIntentId) : newOpsIntentId(now);
  const authorization = d.issueProof({ accountId: account.id, intentId, amountCents: amount, via: 'STEP_UP', now });
  if (!authorization) return { ok: false, ...base, error: 'NO_PROOF_SECRET' };
  // An operator pay-out never carries the express fee (2026-10-24): the founder chose when it goes, not the customer.
  const out = await d.requestPayout({ prisma: db, account, intentId, method, amountCents: amount, recipient, authorization, allowExpress: false });
  const accepted = !!out?.ok && (out.status === 'SETTLED' || out.status === 'PENDING');
  if (accepted) await d.touchDestination({ prisma: db, accountId: account.id, id: chosen.id }).catch(() => {});

  const record = { event: 'OPS_PAYOUT', accountId: account.id, metadata: { by: String(by).slice(0, 60), reason: String(reason).slice(0, 200), amountCents: amount, feeCents: quote.feeCents, method, destination: chosen.label, intentId, status: out?.status || null, error: out?.error || null, reference: out?.reference || null } };
  try { if (d.audit) await d.audit(record); else await db.auditLog.create({ data: { accountId: account.id, event: record.event, metadata: record.metadata } }); } catch {}
  if (accepted && d.alert) { try { await d.alert({ amountCents: amount, method, reference: out.reference, by }); } catch {} }
  if (accepted && d.send) {
    const text = `✅ Your pay-out of R${(amount / 100).toFixed(2)} to ${chosen.label || PAYOUT_METHODS[method].label} has been sent by the WaPay team${out.status === 'PENDING' ? ' and is being processed by the bank' : ''}. Reply if anything is wrong.`;
    try { await d.send({ accountId: account.id, to: account.waId, text }); } catch {}
  }
  return { ok: accepted, ...base, intentId, result: { status: out?.status || null, error: out?.error || null, reference: out?.reference || null, providerRef: out?.providerRef || null, floatCents: out?.floatCents ?? null } };
}
