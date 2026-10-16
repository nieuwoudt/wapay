/**
 * One gate for every cron route (golden thread O4, 2026-10-16).
 *
 * Vercel calls a scheduled function with `Authorization: Bearer <CRON_SECRET>`
 * when CRON_SECRET is set in the project. That header is the only thing a
 * cron route may trust: the `x-vercel-cron: 1` header is set by any caller
 * who types it, and a secret in a query string lands in access logs, browser
 * history and the Referer of anything the page loads. Both are gone.
 *
 * Without CRON_SECRET the gate FAILS CLOSED, loudly: a cron that cannot prove
 * itself does not run, and the log line says why. The internal API key stays
 * an accepted alternative on the reconcile routes (operator runs), checked by
 * lib/internal-auth.js, never here.
 */
import crypto from 'node:crypto';

const log = (type, data) => console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));

export function cronSecretSet(env = process.env) {
  return typeof env.CRON_SECRET === 'string' && env.CRON_SECRET.length >= 16;
}

/** Timing-safe equality on same-length UTF-8 buffers; false on any length difference. */
function sameSecret(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * True only for `Authorization: Bearer <CRON_SECRET>`.
 * @param {{ headers?: Record<string, string | string[] | undefined> }} req
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isCronAuthed(req, env = process.env) {
  if (!cronSecretSet(env)) {
    log('cron_auth_refused', { reason: 'CRON_SECRET_NOT_SET' });
    return false;
  }
  const raw = req?.headers?.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  const m = typeof header === 'string' ? header.match(/^Bearer\s+(\S+)\s*$/i) : null;
  if (!m) return false;
  return sameSecret(m[1], env.CRON_SECRET);
}
