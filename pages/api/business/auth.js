/**
 * WaPay for Business — sign-in / registration.
 *
 * GET                                   → { authed, configured, business? }
 * POST {action:'request', msisdn}       → always {ok:true} (never an oracle)
 * POST {action:'verify', msisdn, code}  → Set-Cookie when the number owns a
 *                                          business; else a registrationToken
 * POST {action:'register', registrationToken, name, category?, password?}
 *                                       → creates the business, Set-Cookie
 * POST {action:'password', msisdn, password} → Set-Cookie
 * POST {action:'logout'}                → clears the cookie
 *
 * Fails closed without a session secret. Wrong number, wrong code and wrong
 * password all answer identically. Nothing here logs a code, a password or a
 * token.
 */

import { sendWhatsAppText, sendWhatsAppTemplate } from '@wapay/whatsapp';
import prisma from '../../../lib/prisma.js';
import {
  businessAuthConfigured,
  requestBusinessOtp,
  verifyBusinessOtp,
  verifyBusinessPassword,
  verifyRegistrationToken,
  hashBusinessPassword,
  passwordAcceptable,
  mayRegister,
  mintBusinessToken,
  businessCookie,
  clearBusinessCookie,
  requireBusinessContext,
  BUSINESS_PASSWORD_MIN,
} from '../../../lib/business-auth.js';
import { createBusiness } from '../../../lib/business.js';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const ctx = await requireBusinessContext(req).catch(() => ({ ok: false }));
    return res.status(200).json({
      authed: ctx.ok,
      configured: businessAuthConfigured(),
      business: ctx.ok ? { id: ctx.business.id, name: ctx.business.name, hasPassword: !!ctx.business.passwordHash } : null,
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { action, msisdn, code, password, registrationToken, name, category } = req.body || {};
  // The caller's network source, for per-source lockouts (first hop of the
  // proxy chain; Vercel sets it). Hashed before storage, never logged raw.
  const source = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

  if (action === 'logout') {
    res.setHeader('Set-Cookie', clearBusinessCookie());
    return res.status(200).json({ ok: true });
  }
  if (!businessAuthConfigured()) return res.status(503).json({ ok: false, error: 'BUSINESS_LOGIN_NOT_CONFIGURED' });

  if (action === 'request') {
    await requestBusinessOtp({ msisdn, sendTemplate: sendWhatsAppTemplate, send: sendWhatsAppText });
    return res.status(200).json({ ok: true }); // generic, always
  }

  if (action === 'verify') {
    const out = await verifyBusinessOtp({ msisdn, code, source });
    if (!out.ok) return res.status(out.error === 'LOCKED_OUT' ? 429 : 401).json({ ok: false, error: out.error === 'LOCKED_OUT' ? 'LOCKED_OUT' : undefined });
    if (out.token) {
      res.setHeader('Set-Cookie', businessCookie(out.token));
      return res.status(200).json({ ok: true, registered: true });
    }
    if (out.allowed === false) {
      // Verified owner, no business, not invited yet (registration is closed
      // by default during the pilot). Honest answer, no token.
      return res.status(200).json({ ok: true, registered: false, inviteRequired: true });
    }
    return res.status(200).json({ ok: true, registered: false, registrationToken: out.registrationToken });
  }

  if (action === 'register') {
    const reg = verifyRegistrationToken(registrationToken);
    if (!reg.ok) return res.status(401).json({ ok: false, error: 'VERIFY_FIRST' });
    const account = await prisma.account.findUnique({ where: { id: reg.accountId } });
    if (!account || !mayRegister(account.msisdn || account.waId)) return res.status(403).json({ ok: false, error: 'NOT_ALLOWED' });
    let passwordHash = null;
    if (password !== undefined && password !== '') {
      if (!passwordAcceptable(password)) return res.status(400).json({ ok: false, error: 'PASSWORD_TOO_SHORT', min: BUSINESS_PASSWORD_MIN });
      passwordHash = await hashBusinessPassword(password);
    }
    let business;
    try {
      business = await createBusiness({ accountId: account.id, name, category, passwordHash });
    } catch (error) {
      if (error?.code === 'P2002') {
        // Already registered (double submit): the OTP was verified, so sign them in.
        business = await prisma.business.findUnique({ where: { accountId: account.id } });
      } else if (error?.code === 'NAME_TOO_SHORT' || error?.code === 'NAME_NOT_ALLOWED') {
        return res.status(400).json({ ok: false, error: error.code });
      } else {
        console.error(JSON.stringify({ type: 'business_register_error', error: error?.message }));
        return res.status(500).json({ ok: false, error: 'REGISTER_FAILED' });
      }
    }
    if (!business || business.status !== 'ACTIVE') return res.status(403).json({ ok: false, error: 'NOT_ALLOWED' });
    console.log(JSON.stringify({ type: 'business_registered', businessId: business.id, accountId: account.id }));
    res.setHeader('Set-Cookie', businessCookie(mintBusinessToken({ businessId: business.id, accountId: account.id })));
    return res.status(200).json({ ok: true, business: { id: business.id, name: business.name } });
  }

  if (action === 'password') {
    const out = await verifyBusinessPassword({ msisdn, password, source });
    if (!out.ok) {
      const status = out.error === 'LOCKED_OUT' ? 429 : out.error === 'NOT_CONFIGURED' ? 503 : 401;
      return res.status(status).json({ ok: false, error: out.error === 'LOCKED_OUT' ? 'LOCKED_OUT' : 'BAD_CREDENTIALS' });
    }
    res.setHeader('Set-Cookie', businessCookie(out.token));
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'action' });
}
