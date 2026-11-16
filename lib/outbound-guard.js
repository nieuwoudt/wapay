/**
 * Who WaPay may write to first (2026-10-27, BUGLOG #144: Meta's second "Sending spam" notice).
 *
 * Meta's rule as WaPay holds it (docs/WHATSAPP_POLICY_COMPLIANCE.md §3): WaPay writes only to
 * people who wrote to it, and outside a reply only with the receipt of their own transaction.
 * A number that never wrote to WaPay gets nothing from WaPay's number: no receipt, no notice, no
 * template, no Direct Send, whoever typed the number and wherever (a pay page, a business portal,
 * an ops list). On 22 October fraudsters typed made-up and other people's numbers as the payer on
 * the pay page, and the receipt rail tried 37 of them; on 26 October one receipt template reached a
 * number that had never written. Every business-initiated rail asks this module first.
 *
 * "Wrote" means an account exists for the number AND it was opened by the person's own message
 * (every account is, except a pre-registered payer's S0 record, profile.origin.kind PAYER), or a
 * message from them is on record. Unknown (a read error, a store without the table) is NOT wrote:
 * a skipped notice costs a customer one tap on "Get my receipt"; a message to a stranger is a
 * spam report against the number the business runs on.
 *
 * Each refusal leaves a pulse row (`bi-refused:<purpose>:<minute>`) that the compliance check
 * reports. Aggregates only: no number is stored in the row.
 */
import prismaDefault from './prisma.js';

/** Both stored forms of a South African number: 27XXXXXXXXX and 0XXXXXXXXX. Pure. */
export function numberForms(n) {
  const d = String(n || '').replace(/\D/g, '');
  if (/^27\d{9}$/.test(d)) return [d, `0${d.slice(2)}`];
  if (/^0\d{9}$/.test(d)) return [`27${d.slice(1)}`, d];
  return d ? [d] : [];
}

/**
 * Has this number ever written to WaPay? Never throws.
 * @returns {Promise<{ wrote: boolean, reason: string, accountId?: string|null }>}
 */
export async function recipientHasWritten({ prisma = prismaDefault, waId } = {}) {
  try {
    const forms = numberForms(waId);
    if (!forms.length) return { wrote: false, reason: 'NO_NUMBER' };
    if (typeof prisma?.account?.findFirst !== 'function') return { wrote: false, reason: 'UNKNOWN' };
    const account = await prisma.account.findFirst({
      where: { OR: forms.flatMap((f) => [{ waId: f }, { msisdn: f }]) },
      select: { id: true, profile: true },
    });
    if (!account) return { wrote: false, reason: 'NO_ACCOUNT' };
    if (account.profile?.origin?.kind !== 'PAYER') return { wrote: true, reason: 'OPENED_BY_THEM', accountId: account.id };
    if (typeof prisma?.conversationTurn?.findFirst !== 'function') return { wrote: false, reason: 'UNKNOWN', accountId: account.id };
    const turn = await prisma.conversationTurn.findFirst({ where: { accountId: account.id, role: 'user' }, select: { id: true } });
    return turn ? { wrote: true, reason: 'WROTE', accountId: account.id } : { wrote: false, reason: 'PRE_REGISTERED_ONLY', accountId: account.id };
  } catch (error) {
    console.error(JSON.stringify({ type: 'outbound_guard_read_failed', error: error?.message }));
    return { wrote: false, reason: 'UNKNOWN' };
  }
}

/** A refusal as a pulse row the compliance check counts. Best effort, never throws. */
export async function recordRefusal({ prisma = prismaDefault, purpose, now = Date.now() } = {}) {
  try {
    const p = String(purpose || 'other').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
    await prisma.processedMessage.create({ data: { waMessageId: `bi-refused:${p}:${new Date(now).toISOString().slice(0, 16)}`, accountId: null } });
  } catch {
    // one row per purpose per minute; a duplicate or a store without the table is fine
  }
}

/**
 * The gate every business-initiated send (template, Direct Send, a notice outside a reply) passes.
 * Refuses a number that never wrote to WaPay, logs and counts the refusal. Never throws.
 * @returns {Promise<{ ok: boolean, reason: string, accountId?: string|null }>}
 */
export async function businessInitiatedAllowed({ prisma = prismaDefault, to, purpose = 'other', now = Date.now() } = {}) {
  const r = await recipientHasWritten({ prisma, waId: to });
  if (r.wrote) return { ok: true, reason: r.reason, accountId: r.accountId ?? null };
  console.log(JSON.stringify({ type: 'outbound_refused_never_wrote', purpose, reason: r.reason, to: `…${String(to || '').slice(-4)}` }));
  await recordRefusal({ prisma, purpose, now });
  return { ok: false, reason: r.reason, accountId: r.accountId ?? null };
}
