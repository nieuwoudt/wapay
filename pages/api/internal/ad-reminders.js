/**
 * Run the ad arrival's reminder sweep on demand (docs/AD_CHAT_FLOW.md section
 * 10). The daily cron runs it at 02:00 UTC; the Hobby plan allows one cron,
 * so an operator (or an external scheduler) can call this hourly to land the
 * reminder closer to the 20-hour mark. Internal-key gated, POST only.
 * Sends at most `limit` reminders (default 20), each locked before the send
 * so no customer can ever get two. Never touches money.
 *
 *   curl -X POST -H "x-internal-api-key: $KEY" https://wapay-api.vercel.app/api/internal/ad-reminders
 */
import crypto from 'node:crypto';
import prisma from '../../../lib/prisma.js';
import { sendAdReminders, dueAdReminders } from '../../../lib/ad-reminders.js';
import { notifyCustomer } from '../../../lib/notify.js';

export const config = { maxDuration: 25 };

function keyOk(req) {
  const internalKey = process.env.WAPAY_INTERNAL_API_KEY || '';
  const presented = req.headers['x-internal-api-key'];
  if (!internalKey || typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(internalKey).digest();
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'method' });
  if (!keyOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const now = new Date();
  if (req.method === 'GET') {
    // A dry look: who is due, as counts only.
    const due = await dueAdReminders({ prisma, now, limit: 100 }).catch(() => []);
    return res.status(200).json({ checkedAt: now.toISOString(), due: due.length, midOnboarding: due.filter((d) => d.kind === 'mid_onboarding').length, noLink: due.filter((d) => d.kind === 'no_link').length });
  }
  const limit = Math.min(50, Math.max(1, Number(req.query?.limit || 20)));
  const out = await sendAdReminders({ prisma, now, limit, send: ({ to, text, kind }) => notifyCustomer({ to, text, kind }) });
  return res.status(200).json({ ranAt: now.toISOString(), ...out });
}
