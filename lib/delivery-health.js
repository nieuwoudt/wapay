/**
 * Delivery health (2026-10-21, BUGLOG #136): did Meta actually deliver what WaPay sent?
 *
 * The WhatsApp webhook already records every delivery status as a pulse row in
 * processed_messages ("status-delivered:<minute>", "status-failed-131031:<minute>"), so a
 * restriction shows up here long before anyone notices a silent chat: on 20 October the API kept
 * accepting our replies from 21:30 UTC while every status came back failed 131031, and our own
 * logs looked normal for nine hours. This module reads those rows, gives a verdict, and raises
 * an ops alert (e-mail first, because the WhatsApp alert fails under the same restriction).
 *
 * STALLED  = in the last 15 minutes at least 5 failures of one code and nothing delivered, sent or read
 * DEGRADED = in the last 60 minutes failures outnumber successes with at least 3 failures
 * OK       = anything else (including quiet periods with no traffic)
 */
import prismaDefault from './prisma.js';

const MINUTE = 60 * 1000;

export async function deliveryCounts({ prisma = prismaDefault, now = Date.now(), minutes }) {
  const since = new Date(now - minutes * MINUTE).toISOString();
  const rows = await prisma.$queryRawUnsafe(
    `select regexp_replace("waMessageId", ':[0-9T:-]+$', '') as kind, count(*)::int as n, min("processedAt") as first_at, max("processedAt") as last_at
       from processed_messages where "processedAt" >= '${since}' and "waMessageId" like 'status-%' group by 1`,
  );
  const out = { ok: 0, failed: 0, byCode: {}, firstFailAt: null, lastOkAt: null };
  for (const r of rows) {
    const kind = String(r.kind || '');
    const n = Number(r.n) || 0;
    if (/^status-(delivered|sent|read)$/.test(kind)) { out.ok += n; if (!out.lastOkAt || new Date(r.last_at) > new Date(out.lastOkAt)) out.lastOkAt = r.last_at; }
    else if (/^status-failed/.test(kind)) { out.failed += n; const code = kind.replace('status-failed-', '').replace('status-failed', 'unknown'); out.byCode[code] = (out.byCode[code] || 0) + n; if (!out.firstFailAt || new Date(r.first_at) < new Date(out.firstFailAt)) out.firstFailAt = r.first_at; }
  }
  return out;
}

export function verdictFor({ last15, last60 }) {
  const top = (c) => Object.entries(c.byCode || {}).sort((a, b) => b[1] - a[1])[0] || null;
  if (last15.failed >= 5 && last15.ok === 0) return { verdict: 'STALLED', code: top(last15)?.[0] || null };
  if (last60.failed >= 3 && last60.failed > last60.ok) return { verdict: 'DEGRADED', code: top(last60)?.[0] || null };
  return { verdict: 'OK', code: null };
}

/** The read the Health tab and the alert share. Never throws; an unreadable table reads as unknown. */
export async function deliveryHealth({ prisma = prismaDefault, now = Date.now() } = {}) {
  try {
    const [last15, last60, last24h] = await Promise.all([
      deliveryCounts({ prisma, now, minutes: 15 }),
      deliveryCounts({ prisma, now, minutes: 60 }),
      deliveryCounts({ prisma, now, minutes: 24 * 60 }),
    ]);
    const v = verdictFor({ last15, last60 });
    return { at: new Date(now).toISOString(), ...v, last15, last60, last24h };
  } catch (e) {
    return { at: new Date(now).toISOString(), verdict: 'UNKNOWN', code: null, error: e?.message || String(e) };
  }
}

export const CODE_MEANING = {
  131031: 'account locked or restricted by Meta (policy enforcement or failed verification): appeal in Account quality',
  131049: 'Meta held the message to protect engagement (marketing throttle)',
  131026: 'message undeliverable (number not on WhatsApp, or the person blocked WaPay)',
  131047: 'more than 24 hours since the customer wrote; only an approved template can be sent',
  131042: 'payment or billing problem on the business account',
  130429: 'rate limit hit',
  131056: 'pair rate limit: too many messages to this one number',
};

export function deliveryAlertText(h) {
  const meaning = h.code && CODE_MEANING[h.code] ? ` (${CODE_MEANING[h.code]})` : '';
  return `🚨 WhatsApp delivery ${h.verdict}: in the last 15 minutes ${h.last15.failed} of WaPay's messages failed${h.code ? ` with code ${h.code}` : ''}${meaning} and ${h.last15.ok} were delivered. Last hour: ${h.last60.failed} failed, ${h.last60.ok} delivered. Customers are writing and hearing nothing. Check Meta Business Suite → Account quality.`;
}

/**
 * Alert ops while delivery is stalled, once per hour per code. Called from the inbound webhook
 * (throttled by the caller) and from the daily cron. `deps` lets tests inject the alert senders.
 */
export async function deliveryStallCheck({ prisma = prismaDefault, now = Date.now(), deps = {} } = {}) {
  const h = await deliveryHealth({ prisma, now });
  if (h.verdict !== 'STALLED') return { ...h, alerted: false };
  const hour = new Date(now).toISOString().slice(0, 13);
  const key = `wa-delivery:${h.code || 'unknown'}:${hour}`;
  const text = deliveryAlertText(h);
  try {
    const { opsPersonAlert } = deps.opsPersonAlert ? { opsPersonAlert: deps.opsPersonAlert } : await import('./ops-alerts.js');
    const { sendOpsAlert } = deps.sendOpsAlert ? { sendOpsAlert: deps.sendOpsAlert } : await import('./email.js');
    const [person, mail] = await Promise.all([
      opsPersonAlert({ text, key, prisma }).catch(() => ({ sent: 0 })),
      sendOpsAlert({ subject: `WhatsApp delivery ${h.verdict}${h.code ? ` (${h.code})` : ''}`, detailsHtml: `<pre style="font-family:inherit;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>` }).catch(() => ({ success: false })),
    ]);
    return { ...h, alerted: true, key, person: person?.sent ?? person?.skipped ?? null, mail: !!mail?.success };
  } catch (e) {
    return { ...h, alerted: false, error: e?.message || String(e) };
  }
}
