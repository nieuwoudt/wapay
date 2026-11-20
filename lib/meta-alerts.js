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
 *                    that never wrote to WaPay. If WaPay's code sent it (it carries WaPay's mark), the
 *                    code refuses those, so one getting through is a bug: alert at once. If it carries
 *                    no mark, something else that holds the number sent it (UniFuel's voucher delivery
 *                    sends from the same number): counted, reported daily, alerted only on volume
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
 * The alert's facts as an incident an agent can pick up (lib/incidents.js): the reference is known before
 * anything is written (it is a hash of the words), so the alert can quote it and the write runs beside
 * the alert, never ahead of it. Never throws; `deps.recordIncident` is the test seam.
 */
async function incidentFor(deps, kind, args) {
  try {
    const kinds = await import('./incident-kinds.js');
    const { incidentRow, recordIncident, incidentLine } = await import('./incidents.js');
    const incident = kinds[kind](args);
    const ref = incidentRow(incident)?.fingerprint?.slice(0, 10) || null;
    const line = ref ? `\n${incidentLine({ ok: true, ref })}` : '';
    return { ref, line, record: (prisma, now) => (deps.recordIncident || recordIncident)({ prisma, now: new Date(now), ...incident }).catch(() => null) };
  } catch (error) {
    console.error(JSON.stringify({ type: 'incident_build_failed', kind, error: error?.message }));
    return { ref: null, line: '', record: async () => null };
  }
}

/** Minutes in 24 hours with an unmarked business-initiated message to a never-wrote number before it is an alarm. */
export const OTHER_SENDER_ALARM_AT = 5;

/**
 * The first minute (UTC) from which a `stranger-` row means "the status carried WaPay's mark".
 * The build that marks WaPay's sends went live on 20 November 2026 at 14:54 UTC. Before it, every
 * business-initiated message to a number that never wrote was stored under that name, whoever sent
 * it: such a row says a message went out and cannot say whose code sent it (BUGLOG #156).
 */
export const MARK_LIVE_SINCE = '2026-11-20T14:55';

/** WaPay's mark on its own business-initiated sends (packages/whatsapp/src/send.ts WAPAY_SEND_TAG). Pure. */
export function sentByWaPay(status) {
  return typeof status?.biz_opaque_callback_data === 'string' && /^wapay(?:$|[:\s])/.test(status.biz_opaque_callback_data);
}

/**
 * A delivery status Meta billed as business-initiated (utility, marketing, authentication): did it go
 * to someone who wrote to WaPay? Independent of every sending path, so a path nobody knew about is
 * caught by what Meta itself reports. Never throws.
 *
 * Whose code sent it decides what happens (2026-11-18, BUGLOG #154). WaPay's number is also used by
 * UniFuel's voucher delivery, which sends its own templates with its own code, and until this date the
 * check reported each of those as a missing gate in WaPay's code:
 *   - the status carries WaPay's mark: WaPay's code sent it past lib/outbound-guard.js. A bug. Counted
 *     (`stranger-<category>` row, RED in the compliance check) and the founder is told once an hour.
 *   - no mark: another holder of the number sent it. Counted (`external-<category>` row, reported by the
 *     daily compliance check) and alerted only when a day holds OTHER_SENDER_ALARM_AT such minutes, which
 *     is what a leaked token or a runaway sender looks like.
 *   - a status for another phone number on the account is not this number's business: skipped.
 *   - the recipient could not be read (a database error): not counted as a stranger; an `unread` row
 *     says the check was blind for that message.
 *   - every marked status also leaves a `marked-<category>` row, so the daily check can show that the
 *     mark comes back from Meta at all (if it never did, WaPay's own sends would read as another sender's).
 */
export async function strangerCheck({ prisma = prismaDefault, status, phoneNumberId = null, env = process.env, now = Date.now(), deps = {} } = {}) {
  try {
    const cat = String(status?.pricing?.category || '').toLowerCase();
    if (status?.status !== 'sent' || !BUSINESS_INITIATED_CATEGORIES.has(cat) || !status?.recipient_id) return { skipped: true };
    const ours = String(env.META_WHATSAPP_PHONE_NUMBER_ID || env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
    if (phoneNumberId && ours && String(phoneNumberId) !== ours) return { skipped: 'OTHER_NUMBER' };
    const check = deps.recipientHasWritten || (await import('./outbound-guard.js')).recipientHasWritten;
    // Proof that Meta returns the mark (BUGLOG #156): one `marked-<category>` row a minute for a
    // business-initiated message whose status carried it, whoever received it. The daily check counts
    // them, so "does the mark come back" is answered from the database, without Vercel's logs.
    const [r] = await Promise.all([
      check({ prisma, waId: String(status.recipient_id) }),
      sentByWaPay(status) ? record(prisma, `marked-${cat}:${minute(now)}`) : null,
    ]);
    if (r.wrote) return { stranger: false };
    if (r.reason === 'UNKNOWN') {
      await record(prisma, `stranger-unread-${cat}:${minute(now)}`);
      console.error(JSON.stringify({ type: 'stranger_check_unreadable', category: cat }));
      return { skipped: 'UNREADABLE' };
    }
    const tail = String(status.recipient_id).slice(-4);
    const when = `${minute(now).replace('T', ' ')} UTC`;
    if (!sentByWaPay(status)) {
      await record(prisma, `external-${cat}:${minute(now)}`);
      console.log(JSON.stringify({ type: 'other_sender_on_number', category: cat, reason: r.reason, to: `…${tail}` }));
      // Volume is the alarm: one voucher delivery is another product working; many in a day is not.
      let minutes = null;
      try {
        minutes = await prisma.processedMessage.count({ where: { waMessageId: { startsWith: 'external-' }, processedAt: { gte: new Date(now - 864e5) } } });
      } catch {
        minutes = null;
      }
      if (minutes == null || minutes < OTHER_SENDER_ALARM_AT) return { stranger: true, external: true, told: false, minutes };
      const dayKey = `other-sender:${new Date(now).toISOString().slice(0, 10)}`;
      if (!(await claimOnce(prisma, `meta-${dayKey}`))) return { stranger: true, external: true, told: false, minutes };
      const volume = await incidentFor(deps, 'otherSenderVolumeIncident', { category: cat, minutes });
      const text = `🛑 ${minutes} minutes in the last 24 hours held a ${cat} message from WaPay's number that WaPay's code did not send, each to a number that never wrote to WaPay (latest •••${tail}, ${when}). UniFuel's voucher delivery sends from this number; this many in a day is either a busy day there or someone else holding the WhatsApp token. Check UniFuel's deliveries for today; if they do not account for it, replace the WhatsApp token.${volume.line}`;
      const [told] = await Promise.all([
        tellFounder({ prisma, kind: 'other-sender', subject: `🛑 ACTION NOW: ${minutes} WhatsApp messages in a day that WaPay's code did not send`, text, key: dayKey, now, deps }),
        volume.record(prisma, now),
      ]);
      return { stranger: true, external: true, minutes, incident: volume.ref, ...told };
    }
    await record(prisma, `stranger-${cat}:${minute(now)}`);
    const key = `stranger:${new Date(now).toISOString().slice(0, 13)}`;
    if (!(await claimOnce(prisma, `meta-${key}`))) return { stranger: true, external: false, told: false };
    const own = await incidentFor(deps, 'ownStrangerSendIncident', { category: cat, reason: r.reason });
    const text = `🛑 WaPay's own code sent a ${cat} message to •••${tail}, a number that never wrote to WaPay (${when}). The code refuses these (lib/outbound-guard.js), so a path is missing the gate: find it before anything else is sent. This is the kind of message people report as spam.${own.line}`;
    const [told] = await Promise.all([
      tellFounder({ prisma, kind: 'stranger', subject: `🛑 ACTION NOW: WaPay's code sent a WhatsApp ${cat} message to a number that never wrote`, text, key, now, deps }),
      own.record(prisma, now),
    ]);
    return { stranger: true, external: false, incident: own.ref, ...told };
  } catch (error) {
    console.error(JSON.stringify({ type: 'stranger_check_failed', error: error?.message }));
    return { error: error?.message };
  }
}
