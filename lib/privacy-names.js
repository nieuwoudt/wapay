/**
 * The names a request knows, for the model boundary (@wapay/ai boundary.ts,
 * BUGLOG #111): the customer's own (WhatsApp profile, KYC, the pay-out
 * identity), the account holder typed in a flow, and the people in their
 * record (saved people, a pending pay-out's counterparty, movements with a
 * counterparty). Each becomes a [[N1]] token before any model call and is
 * restored after, so a model can greet "[[N1]]" without ever reading a name.
 * Pure.
 */

const NAME_FIELDS = ['name', 'fullName', 'displayName', 'counterparty', 'recipientName', 'senderName', 'nickname', 'holder'];

function fromObject(o, out, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 3) return;
  if (Array.isArray(o)) { for (const v of o) fromObject(v, out, depth + 1); return; }
  for (const k of NAME_FIELDS) if (typeof o[k] === 'string') out.push(o[k]);
}

export function privacyNamesFor({ account = null, data = null, pack = null, profileName = null } = {}) {
  const out = [];
  if (profileName) out.push(profileName);
  if (account) {
    out.push(account.displayName);
    const p = account.profile && typeof account.profile === 'object' ? account.profile : {};
    out.push(p.kyc?.fullName, p.name);
  }
  if (data && typeof data === 'object') {
    out.push(data.kycName, data.recipient?.fullName, data.identity?.fullName, data.recipientName, data.name);
  }
  if (pack && typeof pack === 'object') {
    out.push(pack.displayName, pack.payoutIdentity?.fullName, pack.pendingPayout?.counterparty);
    fromObject(pack.beneficiaries, out);
    fromObject(pack.movements, out);
    fromObject(pack.payoutDestinations, out);
  }
  return [...new Set(out.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim()))];
}
