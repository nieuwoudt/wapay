/**
 * Meta's verdict on WaPay's number, told to the founder the moment it lands (2026-10-27, BUGLOG #144).
 *
 * Meta flagged the number for spam on 23 October 20:03 UTC and again on 26 October 20:04 UTC, both
 * as webhook events (account_update, ACCOUNT_VIOLATION, SPAM). The webhook stored each as a pulse row
 * and nothing else happened until the 02:00 compliance run six hours later, whose WhatsApp line
 * looked like every other day's ("compliance RED", RED since 20 October) among dozens of money-in and
 * float alerts. A strike against the number is not a daily statistic: it is the warning before a
 * restriction (the 20 October one became a 30-day restriction thirteen hours later).
 *
 * Three watches, all called from the inbound webhook, all bounded and never throwing:
 *   metaEventAlert   an account_update / account_alerts / review / quality webhook event: alert at once
 *   qualityWatch     the number's quality rating, limit tier and status, read every ten minutes (the
 *                    phone_number_quality_update webhook field is not subscribed): alert on any change
 *   strangerCheck    a message Meta billed as utility, marketing or authentication went to a number
 *                    that never wrote to WaPay: the code refuses those, so one getting through is a bug
 *
 * Every alert goes by e-mail (ALERT_EMAIL, the rail that works outside a 24-hour window) and by
 * WhatsApp to the ops numbers, and leaves an `alert-out:` row saying whether each rail went, so
 * "did the founder get told" is answerable from the database. Aggregates and Meta's own enum words
 * only; a stranger alert carries the last four digits, never a full number.
 */
import prismaDefault from './prisma.js';

/** Meta enum words that mean enforcement against the account or number. */
export const SEVERE_EVENT_RE = /VIOLATION|RESTRICT|DISABLE|BAN|FLAGGED|DOWNGRADE|DELETED|REJECT|SUSPEND|LOCK|SCHEDULE_FOR/i;
/** Billing categories that only a template or Direct Send produces (a reply is "service" or "referral_conversion"). */
export const BUSINESS_INITIATED_CATEGORIES = new Set(['utility', 'marketing', 'marketing_lite', 'authentication', 'authentication_international']);
const QUALITY_RANK = { GREEN: 3, YELLOW: 2, RED: 1, UNKNOWN: 0 };
const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const minute = (now) => new Date(now).toISOString().slice(0, 16);

/** Meta's event, flattened to its enum words (the same words the webhook stores in the pulse row). Pure. */
export function eventBits({ field, value = {} } = {}) {
  const v = value || {};
  return [field, v.event, v.alert_type, v.alert_severity, v.alert_status, v.decision, v.current_limit,
    Array.isArray(v.restriction_info) ? v.restriction_info.map((r) => r?.restriction_type).filter(Boolean).join('+') : null,
    v.ban_info?.waba_ban_state, v.violation_info?.violation_type].filter(Boolean).map(String).join(':').replace(/[^\w:+.-]/g, '_').slice(0, 120);
}

/** What the founder reads. Pure. */
export function accountEventText({ bits, at, strikes7d = null, billed = null }) {
  const severe = SEVERE_EVENT_RE.test(bits);
  const spam = /SPAM/i.test(bits);
  const when = `${String(at).slice(0, 16).replace('T', ' ')} UTC`;
  const lines = [];
  if (severe) {
    lines.push(`🛑 META ${spam ? 'FLAGGED WAPAY\'S WHATSAPP NUMBER FOR SPAM' : 'ACTION ON WAPAY\'S WHATSAPP ACCOUNT'} (${when})`);
    lines.push(`Meta's event: ${bits.replace(/:/g, ' · ')}.`);
    if (strikes7d != null) lines.push(`Enforcement events in the last 7 days: ${strikes7d}. The 20 October spam strike became a 30-day restriction 13 hours later.`);
    if (billed) lines.push(`What Meta billed in the last 24 h: ${billed}.`);
    lines.push('Do now:');
    lines.push('1. Business Support Home, the WhatsApp account WaPay, Account overview (and WhatsApp Manager, Account quality): read the issue; request a review where offered.');
    lines.push('2. Decide on the click-to-WhatsApp ad: strangers from the ad are most of what WaPay answers, and their blocks and reports are what Meta counts.');
    lines.push('3. WaPay starts no conversation and refuses any number that never wrote to it (lib/outbound-guard.js); do not send catch-up or follow-up messages.');
  } else {
    lines.push(`ℹ️ Meta account event (${when}): ${bits.replace(/:/g, ' · ')}.`);
  }
  return { severe, text: lines.join('\n') };
}

async function claimOnce(prisma, key) {
  try {
    await prisma.processedMessage.create({ data: { waMessageId: key.slice(0, 190), accountId: null } });
    return true;
  } catch (e) {
    return e?.code !== 'P2002'; // a duplicate is "already told"; a storage hiccup must not silence the alert
  }
}

async function record(prisma, row) {
  try { await prisma.processedMessage.create({ data: { waMessageId: row.slice(0, 190), accountId: null } }); } catch { /* best effort */ }
}

/** E-mail and WhatsApp, together, with the outcome stored. Never throws. */
export async function tellFounder({ prisma = prismaDefault, kind, subject, text, key, now = Date.now(), deps = {} }) {
  try {
    const sendOpsAlert = deps.sendOpsAlert || (await import('./email.js')).sendOpsAlert;
    const opsPersonAlert = deps.opsPersonAlert || (await import('./ops-alerts.js')).opsPersonAlert;
    const [mail, wa] = await Promise.all([
      sendOpsAlert({ subject, detailsHtml: `<pre style="font-family:inherit;white-space:pre-wrap">${esc(text)}</pre>` }).catch(() => ({ success: false })),
      opsPersonAlert({ text, key, prisma }).catch(() => ({ sent: 0 })),
    ]);
    const out = { mail: !!mail?.success, whatsapp: Number(wa?.sent || 0) };
    await record(prisma, `alert-out:${kind}:mail-${out.mail ? 1 : 0}:wa-${out.whatsapp}:${minute(now)}`);
    return out;
  } catch (error) {
    console.error(JSON.stringify({ type: 'meta_alert_failed', kind, error: error?.message }));
    return { mail: false, whatsapp: 0, error: error?.message };
  }
}

/** Context for a strike: enforcement events in 7 days, and what Meta billed in 24 hours. Never throws. */
async function strikeContext(prisma, now) {
  try {
    const [events, priced] = await Promise.all([
      prisma.processedMessage.findMany({ where: { waMessageId: { startsWith: 'account-' }, processedAt: { gte: new Date(now - 7 * 864e5) } }, select: { waMessageId: true } }),
      prisma.processedMessage.findMany({ where: { waMessageId: { startsWith: 'price-' }, processedAt: { gte: new Date(now - 864e5) } }, select: { waMessageId: true } }),
    ]);
    const strikes = events.filter((r) => SEVERE_EVENT_RE.test(r.waMessageId)).length;
    const by = {};
    for (const r of priced) { const c = r.waMessageId.replace(/^price-/, '').replace(/:\d{4}-\d{2}-\d{2}T[\d:]+$/, ''); by[c] = (by[c] || 0) + 1; }
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    const billed = total ? Object.entries(by).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${Math.round((100 * n) / total)}%`).join(', ') + ' (minutes with a billed message)' : null;
    return { strikes, billed };
  } catch {
    return { strikes: null, billed: null };
  }
}

/**
 * A webhook account event: tell the founder now. Once per event per hour (Meta retries deliveries).
 * Called by the webhook right after it stores the pulse row. Never throws.
 */
export async function metaEventAlert({ field, value, prisma = prismaDefault, now = Date.now(), deps = {} } = {}) {
  try {
    const bits = eventBits({ field, value });
    if (!bits) return { skipped: 'EMPTY' };
    const key = `meta-event:${bits}:${new Date(now).toISOString().slice(0, 13)}`;
    if (!(await claimOnce(prisma, key))) return { skipped: 'DUPLICATE' };
    const ctx = SEVERE_EVENT_RE.test(bits) ? await strikeContext(prisma, now) : { strikes: null, billed: null };
    const { severe, text } = accountEventText({ bits, at: new Date(now).toISOString(), strikes7d: ctx.strikes, billed: ctx.billed });
    const subject = severe ? `🛑 ACTION NOW: Meta ${/SPAM/i.test(bits) ? 'flagged the WhatsApp number for spam' : `enforcement on WhatsApp (${bits.split(':').slice(1, 3).join(' ')})`}` : `Meta account event: ${bits.split(':').slice(0, 2).join(' ')}`;
    const told = await tellFounder({ prisma, kind: severe ? 'meta-strike' : 'meta-event', subject, text, key, now, deps });
    console.log(JSON.stringify({ type: 'meta_event_alert', bits, severe, ...told }));
    return { severe, ...told, text };
  } catch (error) {
    console.error(JSON.stringify({ type: 'meta_event_alert_failed', error: error?.message }));
    return { error: error?.message };
  }
}

/** Is `next` worse than `prev`? Pure. */
export function qualityWorse(prev, next) {
  if (!prev || !next) return false;
  if ((QUALITY_RANK[next.rating] ?? 0) < (QUALITY_RANK[prev.rating] ?? 0)) return true;
  if (prev.status === 'CONNECTED' && next.status && next.status !== 'CONNECTED') return true;
  const tier = (t) => { const m = String(t || '').match(/TIER_(\d+)(K|M)?/); return /UNLIMITED/.test(String(t || '')) ? 1e9 : m ? Number(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1) : 0; };
  return !!(prev.tier && next.tier && tier(next.tier) < tier(prev.tier));
}

const stateKey = (s) => `${s.rating || 'UNKNOWN'}:${s.tier || '-'}:${s.status || '-'}`;

/**
 * The number's quality, tier and status, compared with the last reading the database holds; any
 * change is stored, a worse one alerts at once, a better one says so. Never throws.
 */
export async function qualityWatch({ prisma = prismaDefault, now = Date.now(), deps = {} } = {}) {
  try {
    const read = deps.read || (await import('./whatsapp-quality.js')).readWhatsAppQuality;
    const q = await read({});
    if (!q?.configured || !q.qualityRating) return { skipped: q?.error || 'UNREADABLE' };
    const next = { rating: q.qualityRating, tier: q.messagingLimitTier || null, status: q.status || null };
    const last = await prisma.processedMessage.findFirst({ where: { waMessageId: { startsWith: 'meta-quality:' } }, orderBy: { processedAt: 'desc' }, select: { waMessageId: true } });
    const parts = last ? last.waMessageId.split(':') : null;
    const prev = parts ? { rating: parts[1], tier: parts[2] === '-' ? null : parts[2], status: parts[3] === '-' ? null : parts[3] } : null;
    if (prev && stateKey(prev) === stateKey(next)) return { changed: false, ...next };
    await record(prisma, `meta-quality:${stateKey(next)}:${minute(now)}`);
    if (!prev) return { changed: true, baseline: true, ...next };
    const worse = qualityWorse(prev, next);
    const text = worse
      ? `🛑 WhatsApp number ${next.rating !== prev.rating ? `quality fell from ${prev.rating} to ${next.rating}` : next.status !== prev.status ? `status changed from ${prev.status} to ${next.status}` : `messaging limit fell from ${prev.tier} to ${next.tier}`} (${minute(now).replace('T', ' ')} UTC). Meta is counting blocks and reports. Check WhatsApp Manager, Account quality, now, and decide on the ad.`
      : `✅ WhatsApp number now ${next.rating}${next.tier ? ` · limit ${next.tier}` : ''}${next.status ? ` · ${next.status}` : ''} (was ${prev.rating}${prev.tier ? ` · ${prev.tier}` : ''}).`;
    const subject = worse ? `🛑 ACTION NOW: WhatsApp quality ${next.rating}${next.status && next.status !== 'CONNECTED' ? ` (${next.status})` : ''}` : `WhatsApp quality now ${next.rating}`;
    const told = await tellFounder({ prisma, kind: worse ? 'quality-down' : 'quality-up', subject, text, key: `meta-quality:${stateKey(next)}:${minute(now)}`, now, deps });
    return { changed: true, worse, ...next, ...told };
  } catch (error) {
    console.error(JSON.stringify({ type: 'quality_watch_failed', error: error?.message }));
    return { error: error?.message };
  }
}

/**
 * A delivery status Meta billed as business-initiated (utility, marketing, authentication): did it go
 * to someone who wrote to WaPay? If not, count it (`stranger-<category>` row, RED in the compliance
 * check) and tell the founder once an hour. Independent of every sending path, so a path nobody
 * knew about is caught by what Meta itself reports. Never throws.
 */
export async function strangerCheck({ prisma = prismaDefault, status, now = Date.now(), deps = {} } = {}) {
  try {
    const cat = String(status?.pricing?.category || '').toLowerCase();
    if (status?.status !== 'sent' || !BUSINESS_INITIATED_CATEGORIES.has(cat) || !status?.recipient_id) return { skipped: true };
    const check = deps.recipientHasWritten || (await import('./outbound-guard.js')).recipientHasWritten;
    const r = await check({ prisma, waId: String(status.recipient_id) });
    if (r.wrote) return { stranger: false };
    await record(prisma, `stranger-${cat}:${minute(now)}`);
    const tail = String(status.recipient_id).slice(-4);
    const key = `stranger:${new Date(now).toISOString().slice(0, 13)}`;
    if (!(await claimOnce(prisma, `meta-${key}`))) return { stranger: true, told: false };
    const text = `🛑 WaPay's number sent a ${cat} message to •••${tail}, a number that never wrote to WaPay (${minute(now).replace('T', ' ')} UTC). The code refuses these (lib/outbound-guard.js), so a path is missing the gate: find it before anything else is sent. This is the kind of message people report as spam.`;
    const told = await tellFounder({ prisma, kind: 'stranger', subject: `🛑 ACTION NOW: WhatsApp ${cat} message to a number that never wrote`, text, key, now, deps });
    return { stranger: true, ...told };
  } catch (error) {
    console.error(JSON.stringify({ type: 'stranger_check_failed', error: error?.message }));
    return { error: error?.message };
  }
}
