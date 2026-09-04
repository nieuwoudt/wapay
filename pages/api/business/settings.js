/**
 * WaPay for Business — settings.
 *
 * GET → { business: {id, name, category, settings}, hasPassword, owner: {msisdn masked} }
 * POST {action:'profile', name?, category?}
 * POST {action:'defaults', defaultTtlDays}          (1..30)
 * POST {action:'set-password', password}            (10+ chars; argon2id at rest)
 *
 * Session-gated; the password is never logged or echoed.
 */

import prisma from '../../../lib/prisma.js';
import { requireBusinessContext, hashBusinessPassword, passwordAcceptable, BUSINESS_PASSWORD_MIN } from '../../../lib/business-auth.js';
import { updateBusinessProfile, updateBusinessSettings, maskNumber } from '../../../lib/business.js';
import { MAX_BUSINESS_TTL_DAYS } from '../../../lib/payment-requests.js';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  const ctx = await requireBusinessContext(req);
  if (!ctx.ok) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const business = ctx.business;

  if (req.method === 'GET') {
    let ownerMasked = null;
    try {
      const owner = await prisma.account.findUnique({ where: { id: business.accountId }, select: { msisdn: true } });
      ownerMasked = owner ? maskNumber(owner.msisdn) : null;
    } catch {
      // cosmetic
    }
    return res.status(200).json({
      business: { id: business.id, name: business.name, category: business.category, settings: business.settings || {}, createdAt: business.createdAt },
      hasPassword: !!business.passwordHash,
      owner: { msisdn: ownerMasked },
      maxTtlDays: MAX_BUSINESS_TTL_DAYS,
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
    if (body.action === 'set-password') {
      if (!passwordAcceptable(body.password)) return res.status(400).json({ ok: false, error: 'PASSWORD_TOO_SHORT', min: BUSINESS_PASSWORD_MIN });
      const passwordHash = await hashBusinessPassword(body.password);
      await prisma.business.update({ where: { id: business.id }, data: { passwordHash } });
      console.log(JSON.stringify({ type: 'business_password_set', businessId: business.id }));
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'action' });
  } catch (error) {
    if (error?.code === 'NAME_TOO_SHORT' || error?.code === 'NAME_NOT_ALLOWED') return res.status(400).json({ ok: false, error: error.code });
    console.error(JSON.stringify({ type: 'business_settings_error', businessId: business.id, action: body.action, error: error?.message }));
    return res.status(500).json({ ok: false, error: 'WRITE_FAILED' });
  }
}
