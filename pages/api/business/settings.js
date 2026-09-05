/**
 * WaPay for Business — settings.
 *
 * GET → { business: {id, name, category, settings}, hasPassword, owner: {msisdn masked} }
 * POST {action:'profile', name?, category?}
 * POST {action:'defaults', defaultTtlDays}          (1..30)
 * POST {action:'set-password', password, currentPassword? | code?}
 *      Step-up required: the current password when one exists, else a fresh
 *      one-time code (owner types `business login` to WaPay). A 24h cookie
 *      alone can never mint permanent password access (critics 2026-09-05).
 * POST {action:'clear-password', currentPassword}   same step-up
 *
 * Session-gated; the password is never logged or echoed. The owner gets a
 * WhatsApp notice after a password change (best effort).
 */

import prisma from '../../../lib/prisma.js';
import { requireBusinessContext, hashBusinessPassword, passwordAcceptable, verifyStepUp, BUSINESS_PASSWORD_MIN } from '../../../lib/business-auth.js';
import { sendWhatsAppText } from '@wapay/whatsapp';
import { updateBusinessProfile, updateBusinessSettings, maskNumber, normaliseCustomerMsisdn } from '../../../lib/business.js';
import { MAX_BUSINESS_TTL_DAYS } from '../../../lib/payment-requests.js';
import { PAYREQ_FREE_BELOW_CENTS } from '../../../lib/deposits.js';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  const ctx = await requireBusinessContext(req);
  if (!ctx.ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const business = ctx.business;

  if (req.method === 'GET') {
    let ownerMasked = null;
    try {
      const owner = await prisma.account.findUnique({ where: { id: business.accountId }, select: { msisdn: true } });
      ownerMasked = owner ? maskNumber(normaliseCustomerMsisdn(owner.msisdn) || owner.msisdn) : null; // accounts store 27-form
    } catch {
      // cosmetic
    }
    return res.status(200).json({
      business: { id: business.id, name: business.name, category: business.category, settings: business.settings || {}, createdAt: business.createdAt },
      hasPassword: !!business.passwordHash,
      owner: { msisdn: ownerMasked },
      maxTtlDays: MAX_BUSINESS_TTL_DAYS,
      freeBelowCents: PAYREQ_FREE_BELOW_CENTS,
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const body = req.body || {};
  try {
    if (body.action === 'profile') {
      const row = await updateBusinessProfile({ businessId: business.id, name: body.name, category: body.category });
      return res.status(200).json({ ok: true, business: { id: row.id, name: row.name, category: row.category } });
    }
    if (body.action === 'defaults') {
      const ttl = Number(body.defaultTtlDays);
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_BUSINESS_TTL_DAYS) return res.status(400).json({ ok: false, error: 'BAD_TTL' });
      await updateBusinessSettings({ businessId: business.id, patch: { defaultTtlDays: ttl } });
      return res.status(200).json({ ok: true });
    }
    if (body.action === 'set-password' || body.action === 'clear-password') {
      const owner = await prisma.account.findUnique({ where: { id: business.accountId }, select: { msisdn: true, waId: true } });
      const source = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
      const step = await verifyStepUp({ business, msisdn: owner?.msisdn || owner?.waId, currentPassword: body.currentPassword, code: body.code, source });
      if (!step.ok) return res.status(step.error === 'LOCKED_OUT' ? 429 : 403).json({ ok: false, error: step.error, needs: business.passwordHash ? 'currentPassword' : 'code' });
      let passwordHash = null;
      if (body.action === 'set-password') {
        if (!passwordAcceptable(body.password)) return res.status(400).json({ ok: false, error: 'PASSWORD_TOO_SHORT', min: BUSINESS_PASSWORD_MIN });
        passwordHash = await hashBusinessPassword(body.password);
      }
      await prisma.business.update({ where: { id: business.id }, data: { passwordHash } });
      console.log(JSON.stringify({ type: body.action === 'set-password' ? 'business_password_set' : 'business_password_cleared', businessId: business.id, via: step.via }));
      if (owner?.waId) {
        // Best effort, in-window only: the owner just used the portal from a
        // computer, so this may not deliver; the log line above is the record.
        sendWhatsAppText({ to: owner.waId, text: body.action === 'set-password' ? `🔐 Your WaPay for Business password was just changed. Not you? Reply "business login" for a code and change it back, and tell us right away.` : `🔐 Your WaPay for Business password was removed. Sign in with a one-time code from now on.` }).catch(() => {});
      }
      return res.status(200).json({ ok: true, hasPassword: !!passwordHash });
    }
    return res.status(400).json({ error: 'action' });
  } catch (error) {
    if (error?.code === 'NAME_TOO_SHORT' || error?.code === 'NAME_NOT_ALLOWED') return res.status(400).json({ ok: false, error: error.code });
    console.error(JSON.stringify({ type: 'business_settings_error', businessId: business.id, action: body.action, error: error?.message }));
    return res.status(500).json({ ok: false, error: 'WRITE_FAILED' });
  }
}
