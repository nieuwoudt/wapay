/**
 * Admin KYC actions — start a verification for a customer, or re-sync one.
 *
 * POST {action:'start', msisdn}   → create the Didit hosted session and send
 *                                   the link to the CUSTOMER's own WhatsApp
 *                                   (never to a caller-supplied destination).
 * POST {action:'refresh', msisdn} → fetch the decision now (manual sync).
 * GET                             → {configured} probe for the console UI.
 *
 * Session-cookie or internal-key gated; fails closed. The verification link
 * itself is only ever delivered to the account's registered waId — an admin
 * cannot exfiltrate a customer's KYC session URL through this route.
 */

import prisma from '../../../lib/prisma.js';
import { sendWhatsAppText } from '@wapay/whatsapp';
import { localizeOutbound } from '../../../lib/localize.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { diditConfigured, startKycSession, syncKycFromDecision } from '../../../lib/didit-kyc.js';

export const config = { maxDuration: 25 };

function tail9(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : null;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
    return res.status(200).json({ configured: diditConfigured() });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!requireAdmin(req).ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  if (!diditConfigured()) {
    return res.status(503).json({ error: 'Set DIDIT_API_KEY, DIDIT_WORKFLOW_ID and DIDIT_WEBHOOK_SECRET in Vercel first.' });
  }

  const { action, msisdn } = req.body || {};
  const t = tail9(msisdn);
  if (!t) return res.status(400).json({ error: 'Give me the customer number.' });
  const candidates = await prisma.account.findMany({
    where: { OR: [{ msisdn: { endsWith: t } }, { waId: { endsWith: t } }] },
    take: 3,
  });
  const account = candidates.find((a) => tail9(a.msisdn) === t || tail9(a.waId) === t);
  if (!account) return res.status(404).json({ error: 'No account with that number.' });

  if (action === 'start') {
    // Never silently reset a VERIFIED customer to PENDING (review 2026-08-28):
    // re-sending a link mints a new session and would orphan the approved one.
    // Require an explicit force flag to re-verify someone already verified.
    if (account.profile?.kyc?.status === 'VERIFIED' && !req.body?.force) {
      return res.status(409).json({ error: 'ALREADY_VERIFIED', hint: 'Pass force:true to re-verify.' });
    }
    const started = await startKycSession({ account });
    if (!started.ok) return res.status(502).json({ error: started.error });
    // The link goes to the account's own registered WhatsApp — never to a
    // number the caller typed.
    const text = await localizeOutbound(
      `🪪 *WaPay identity verification*\n\nTap the link and follow the steps with your SA ID or passport. It takes about two minutes:\n${started.url}\n\nThe link is personal to you. If you did not expect this, reply "help".`,
      account.profile?.language
    );
    const sent = await sendWhatsAppText({ to: account.waId, text });
    return res.status(200).json({ ok: true, delivered: !!sent?.ok, kycStatus: 'PENDING' });
  }

  if (action === 'refresh') {
    const sessionId = account.profile?.kyc?.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'No verification session for this customer yet.' });
    const synced = await syncKycFromDecision({ accountId: account.id, sessionId });
    if (!synced.ok) return res.status(502).json({ error: synced.error });
    // On an unmapped/unchanged status synced.kyc may be absent — fall back to
    // the stored status so the console never shows "undefined".
    const kycStatus = synced.kyc?.status || account.profile?.kyc?.status || 'UNKNOWN';
    // A manual sync that lands VERIFIED continues the customer where the check interrupted them (lib/kyc-resume.js).
    let resumed = false;
    if (kycStatus === 'VERIFIED' && synced.changed) {
      try {
        const [{ resumeAfterKyc }, { startWithdraw }, { updateConversationState }, { sendWhatsAppText }, { localizeOutbound }, fresh] = await Promise.all([
          import('../../../lib/kyc-resume.js'), import('../../../lib/payout-chat.js'), import('../webhooks/user-manager.js'), import('../../../lib/say.js'), import('../../../lib/localize.js'),
          prisma.account.findUnique({ where: { id: account.id } }),
        ]);
        const r = await resumeAfterKyc({ prisma, account: fresh || account, deps: { startWithdraw, updateConversationState, send: sendWhatsAppText, localize: (t) => localizeOutbound(t, (fresh || account).profile?.language) } });
        resumed = !!r.resumed;
      } catch (e) {
        console.error(JSON.stringify({ type: 'kyc_resume_failed', accountId: account.id, error: e?.message }));
      }
    }
    return res.status(200).json({ ok: true, kycStatus, changed: !!synced.changed, resumed });
  }

  return res.status(400).json({ error: 'action' });
}
