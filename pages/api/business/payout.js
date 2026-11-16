/**
 * WaPay for Business — pay out the balance (founder ask 2026-09-10).
 *
 * GET  → { enabled, configured, kyc:{required, verified}, balance, methods,
 *          limits, history }   (methods come from OTT's live provider list)
 * POST {action:'quote', method, amountCents}                     → fee / total
 * POST {action:'request', intentId, method, amountCents, recipient,
 *       currentPassword? | code?}                                 → the payout
 *
 * Money moves here, so a fresh factor is required on every request (the
 * portal password, or a one-time code from `business login`): a 24h cookie
 * alone never pays anyone. The owner's ACCOUNT is the one paid out (a
 * business is the owner's wallet wearing a hat). Fails closed unless
 * WAPAY_PAYOUT_ENABLED=true and the OTT_PAYOUT_* credentials exist.
 */

import prisma from '../../../lib/prisma.js';
import { requireBusinessContext, verifyStepUp } from '../../../lib/business-auth.js';
import {
  payoutEnabled, payoutConfigured, kycRequired, accountKycVerified, quotePayout, resolveProviders,
  payoutBalances, listPayouts, requestPayout, PAYOUT_METHODS, MIN_PAYOUT_CENTS, MAX_PAYOUT_CENTS,
} from '../../../lib/payouts.js';
import { expressFor, recentReceipts, expressFeeLine } from '../../../lib/payout-express.js';
import { speedFor, sameDayCheck, nextBusinessDayAt } from '../../../lib/payout-speed.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const ctx = await requireBusinessContext(req);
  if (!ctx.ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const business = ctx.business;
  const account = await prisma.account.findUnique({ where: { id: business.accountId } });
  if (!account) return res.status(401).json({ error: 'UNAUTHORIZED' });
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'GET') {
    const enabled = payoutEnabled();
    const configured = payoutConfigured();
    let methods = Object.entries(PAYOUT_METHODS).map(([method, d]) => ({ method, label: d.label, hint: d.hint, requiredFields: d.fields, live: false }));
    if (enabled && configured) {
      try {
        const live = await resolveProviders({});
        methods = methods.map((m) => { const p = live.find((x) => x.method === m.method); return p ? { ...m, ...p, live: true } : m; });
      } catch (error) {
        console.error(JSON.stringify({ type: 'payout_providers_error', error: error?.message }));
      }
    }
    const [balance, history] = await Promise.all([payoutBalances({ accountId: account.id }), listPayouts({ accountId: account.id })]);
    return res.status(200).json({
      enabled, configured,
      kyc: { required: kycRequired(), verified: accountKycVerified(account) },
      balance,
      methods,
      limits: { minCents: MIN_PAYOUT_CENTS, maxCents: MAX_PAYOUT_CENTS },
      history,
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const body = req.body || {};
  try {
    if (body.action === 'quote') {
      // The express fee (lib/payout-express.js, 2026-10-24) is quoted here, so the owner sees it before confirming.
      // A bank account has two speeds instead (lib/payout-speed.js, 2026-11-11): body.speed 'SAME_DAY' or the
      // next business day; same day only when the pay-out needs no money under 2 hours old.
      const method = String(body.method || ''); const amountCents = Number(body.amountCents);
      const speed = speedFor(method, body.speed);
      const base = quotePayout({ method, amountCents, speed });
      const [bal, receipts] = await Promise.all([payoutBalances({ accountId: account.id }).catch(() => null), recentReceipts({ prisma, accountId: account.id }).catch(() => [])]);
      if (speed) {
        const sameDay = quotePayout({ method, amountCents, speed: 'SAME_DAY' });
        const check = bal ? sameDayCheck({ balanceCents: bal.totalCents, receipts, amountCents, feeCents: sameDay.feeCents }) : { cleared: true, clearedFromAt: null };
        const nextDay = quotePayout({ method, amountCents, speed: 'NEXT_DAY' });
        return res.status(200).json({ ok: true, quote: { ...base, feeNote: null, releaseAt: speed === 'NEXT_DAY' ? new Date(nextBusinessDayAt()).toISOString() : null, speeds: { NEXT_DAY: { feeCents: nextDay.feeCents, totalCents: nextDay.totalCents, releaseAt: new Date(nextBusinessDayAt()).toISOString() }, SAME_DAY: { feeCents: sameDay.feeCents, totalCents: sameDay.totalCents, available: check.cleared, clearedFromAt: check.clearedFromAt } } } });
      }
      const ex = bal ? expressFor({ balanceCents: bal.totalCents, receipts, amountCents, normalFeeCents: base.feeCents }) : null;
      const quote = ex?.express ? quotePayout({ method, amountCents, feeMultiplier: ex.multiplier }) : base;
      return res.status(200).json({ ok: true, quote: { ...quote, feeNote: ex?.express ? expressFeeLine(ex) : null } });
    }
    if (body.action === 'request') {
      if (!payoutEnabled()) return res.status(503).json({ ok: false, error: 'DISABLED' });
      const source = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
      // The fresh factor approves THIS intent and amount; requestPayout refuses without its proof (BUGLOG #112).
      const step = await verifyStepUp({ business, msisdn: account.msisdn || account.waId, currentPassword: body.currentPassword, code: body.code, source, approves: { intentId: body.intentId, amountCents: Number(body.amountCents) } });
      if (!step.ok) return res.status(step.error === 'LOCKED_OUT' ? 429 : 403).json({ ok: false, error: step.error, needs: business.passwordHash ? 'currentPassword' : 'code' });
      const out = await requestPayout({
        account,
        intentId: body.intentId,
        method: String(body.method || ''),
        amountCents: Number(body.amountCents),
        recipient: body.recipient || {},
        businessId: business.id,
        authorization: step.proof || null,
        // The fee the owner saw in the quote: a higher one is refused, never charged (2026-10-24).
        expectedFeeCents: Number.isInteger(body.feeCents) ? body.feeCents : null,
        // A bank account's speed (2026-11-11): the next business day unless 'SAME_DAY' is named.
        speed: body.speed || null,
      });
      const status = out.ok ? 200 : out.error === 'KYC_REQUIRED' ? 403 : out.error === 'INSUFFICIENT_FUNDS' ? 402 : ['DISABLED', 'NOT_CONFIGURED', 'NO_PROVIDER', 'PAYOUT_HOLD'].includes(out.error) ? 503 : ['FEE_CHANGED', 'DAILY_CAP', 'NOT_CLEARED'].includes(out.error) ? 409 : out.error === 'REVIEW' ? 423 : 400;
      console.log(JSON.stringify({ type: 'business_payout', businessId: business.id, via: step.via, ok: out.ok, status: out.status || out.error, reference: out.reference || null }));
      return res.status(status).json(out);
    }
    return res.status(400).json({ error: 'action' });
  } catch (error) {
    if (['BAD_METHOD', 'BAD_AMOUNT', 'BAD_RECIPIENT'].includes(error?.code)) return res.status(400).json({ ok: false, error: error.code, field: error.field, minCents: error.minCents, maxCents: error.maxCents });
    console.error(JSON.stringify({ type: 'business_payout_error', businessId: business.id, action: body.action, error: error?.message }));
    return res.status(500).json({ ok: false, error: 'PAYOUT_FAILED' });
  }
}
