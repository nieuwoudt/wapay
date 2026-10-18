/**
 * POST /api/wallet/send/preview  (internal key)
 *
 * Quote a "send money" before the PIN (BUGLOG #116): the amount, the fee (R0,
 * the quote of record), the total, and a preview id the execute route
 * consumes. Membership-neutral: the answer is the same whether or not the
 * number belongs to a WaPay customer, so it cannot be used to find out who is
 * on WaPay. No rail, no money moves here.
 */
import { randomUUID } from 'crypto';
import prisma from '../../../../lib/prisma.js';
import { BALANCE } from '../../../../lib/ledger-core.js';
import { isValidSaMsisdn, normaliseMsisdn } from '../../../../lib/msisdn.js';
import { requireInternalAuth } from '../../../../lib/internal-auth.js';
import { sendFeeCents, SEND_MIN_CENTS, SEND_MAX_CENTS } from '../../../../lib/send-money.js';

const PREVIEW_TTL_MS = 5 * 60 * 1000;
const log = (type, data) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', ['POST']); return res.status(405).json({ error: 'METHOD' }); }
  if (!requireInternalAuth(req, res)) return;
  const { accountId, amountCents, recipientMsisdn } = req.body || {};
  const to = normaliseMsisdn(recipientMsisdn || '');
  try {
    if (!accountId || !Number.isInteger(amountCents) || !to) return res.status(400).json({ error: 'USER_INPUT', message: 'Missing accountId, amountCents or recipientMsisdn' });
    if (amountCents < SEND_MIN_CENTS || amountCents > SEND_MAX_CENTS) return res.status(400).json({ error: 'USER_INPUT', message: 'You can send between R10 and R1000 at a time.' });
    if (!isValidSaMsisdn(to)) return res.status(400).json({ error: 'USER_INPUT', message: 'That does not look like a South African cellphone number, like 0781234567.' });
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account) return res.status(404).json({ error: 'USER_INPUT', message: 'Account not found' });
    if (normaliseMsisdn(account.msisdn || account.waId || '') === to) return res.status(400).json({ error: 'SELF', message: 'That is your own number.' });
    const feeCents = sendFeeCents();
    const totalCents = amountCents + feeCents;
    const wallet = await prisma.wallet.findFirst({ where: { accountId, balanceType: BALANCE.SPEND } });
    const availableBalance = wallet?.availableCents || 0;
    if (availableBalance < totalCents) return res.status(400).json({ error: 'INSUFFICIENT_FUNDS', totalCents, availableBalance });
    const previewId = `preview-send-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
    await prisma.providerRequest.create({ data: { id: previewId, idemKey: previewId, route: 'send-preview', status: 'PENDING', accountId, provider: 'WAPAY', metadata: { amountCents, feeCents, totalCents, recipientMsisdn: to, expiresAt } } });
    log('send_preview', { accountId, previewId, amountCents, feeCents, recipientMasked: `${to.slice(0, 3)}•••${to.slice(-3)}` });
    return res.status(200).json({ ok: true, previewId, amountCents, feeCents, totalCents, recipientMsisdn: to });
  } catch (error) {
    log('send_preview_fail', { accountId, error: error?.message });
    return res.status(500).json({ error: 'RETRYABLE', message: 'Sending is not available right now.' });
  }
}
