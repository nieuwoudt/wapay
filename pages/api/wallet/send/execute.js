/**
 * POST /api/wallet/send/execute  (internal key)
 *
 * Move the money for a confirmed send (BUGLOG #116). The sender's PIN is
 * verified HERE (golden thread 2.7) and approves exactly this preview and
 * amount; lib/send-money.js checks that proof before any write (2.1). A member
 * is credited at once (P2P_SEND); anyone else's money is held for them
 * (GIFT_HELD) until they join. No rail client is imported in this route or in
 * lib/send-money.js (tests/send-money.test.mjs checks it statically).
 * Answers the processor with { ok, delivered, newBalance } and never sends a
 * WhatsApp message itself.
 */
import prisma from '../../../../lib/prisma.js';
import { FROZEN_SEND_COPY } from '../../../../lib/payout-freeze.js';
import { verifyPIN } from '@wapay/auth';
import { BALANCE } from '../../../../lib/ledger-core.js';
import { requireInternalAuth } from '../../../../lib/internal-auth.js';
import { sendMoney } from '../../../../lib/send-money.js';

const EXEC_TAKEOVER_MS = 120 * 1000;
const log = (type, data) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', ['POST']); return res.status(405).json({ error: 'METHOD' }); }
  if (!requireInternalAuth(req, res)) return;
  const { previewId, accountId, pin } = req.body || {};
  if (!previewId || !accountId || !pin) return res.status(400).json({ error: 'USER_INPUT', message: 'Missing previewId, accountId or PIN' });
  try {
    const preview = await prisma.providerRequest.findUnique({ where: { id: previewId } });
    const meta = preview?.metadata || {};
    if (!preview || preview.route !== 'send-preview') return res.status(404).json({ error: 'USER_INPUT', message: 'Preview not found' });
    // Ownership before a PIN attempt is spent (BUGLOG #56 class).
    if (preview.accountId !== accountId) return res.status(403).json({ error: 'AUTH', message: 'Unauthorized' });
    if (preview.status === 'SUCCESS') return res.status(200).json({ ok: true, replayed: true, delivered: meta.delivered || null, amountCents: meta.amountCents, newBalance: meta.newBalance ?? null });
    const stale = preview.status === 'EXECUTING' && Date.now() - (Date.parse(meta.executingAt || '') || 0) > EXEC_TAKEOVER_MS;
    if (preview.status === 'EXECUTING' && !stale) return res.status(409).json({ error: 'IN_PROGRESS', message: 'That send is already being processed.' });
    if (!(preview.status === 'PENDING' || stale)) return res.status(404).json({ error: 'USER_INPUT', message: 'Preview not found or already processed' });
    if (new Date() > new Date(meta.expiresAt)) return res.status(400).json({ error: 'USER_INPUT', message: 'Preview expired. Please start again.' });

    const pinResult = await verifyPIN({ accountId, pin, approves: { intentId: previewId, amountCents: meta.amountCents } });
    if (!pinResult.ok) return res.status(401).json({ error: 'AUTH', message: pinResult.lockedUntil ? 'PIN locked' : 'Invalid PIN', lockedUntil: pinResult.lockedUntil || null });

    // One execution per preview (fuel's shape, golden thread O6).
    const claim = await prisma.providerRequest.updateMany({ where: { id: previewId, status: stale ? 'EXECUTING' : 'PENDING' }, data: { status: 'EXECUTING', metadata: { ...meta, executingAt: new Date().toISOString() } } });
    if (claim.count !== 1) return res.status(409).json({ error: 'IN_PROGRESS', message: 'That send is already being processed.' });

    const sender = await prisma.account.findUnique({ where: { id: accountId } });
    const out = await sendMoney({ prisma, sender, previewId, recipientMsisdn: meta.recipientMsisdn, amountCents: meta.amountCents, authorization: pinResult.proof || null });
    if (!out.ok) {
      await prisma.providerRequest.update({ where: { id: previewId }, data: { status: 'FAILED', metadata: { ...meta, error: out.error } } }).catch(() => {});
      log('send_execute_refused', { accountId, previewId, error: out.error });
      return res.status(out.error === 'INSUFFICIENT_FUNDS' ? 400 : out.error === 'NOT_AUTHORISED' ? 401 : out.error === 'FROZEN' ? 423 : 400).json({ error: out.error, message: out.error === 'FROZEN' ? FROZEN_SEND_COPY : out.error });
    }
    const wallet = await prisma.wallet.findFirst({ where: { accountId, balanceType: BALANCE.SPEND } });
    const newBalance = wallet?.availableCents ?? null;
    await prisma.providerRequest.update({ where: { id: previewId }, data: { status: 'SUCCESS', metadata: { ...meta, delivered: out.delivered, giftId: out.giftId || null, newBalance } } });
    log('send_execute', { accountId, previewId, delivered: out.delivered, amountCents: out.amountCents, replayed: out.replayed });
    // delivered tells the processor which informational line the RECIPIENT gets; the sender's copy is the same for both.
    return res.status(200).json({ ok: true, delivered: out.delivered, amountCents: out.amountCents, newBalance, recipientAccountId: out.recipientAccountId || null });
  } catch (error) {
    log('send_execute_fail', { accountId, previewId, error: error?.message });
    await prisma.providerRequest.updateMany({ where: { id: previewId, status: 'EXECUTING' }, data: { status: 'PENDING' } }).catch(() => {});
    return res.status(500).json({ error: 'RETRYABLE', message: 'Something went wrong; nothing was sent. Please try again.' });
  }
}
