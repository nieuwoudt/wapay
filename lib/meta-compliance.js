/**
 * Meta compliance, checked every day (founder 2026-10-23, after the 30-day "Sending spam"
 * restriction of 20 October: "make sure Meta never, ever blocks us again").
 *
 * Nothing on our side can promise that Meta never acts: its decision rests on what people
 * report and on rules it can change. What this does is hold WaPay to every rule in
 * docs/WHATSAPP_POLICY_COMPLIANCE.md every day, from two independent sources, and raise the
 * alarm the first day anything drifts:
 *
 *   Meta's view (Graph API, production token): the number's quality rating, messaging limit
 *   tier, status and health; every template on the account with its category and status, and
 *   whether a template WE send has been filed as MARKETING, paused or disabled.
 *
 *   Our behaviour (database, last 24 hours):
 *     - what Meta billed: pricing categories from the delivery statuses (price-<category> pulse
 *       rows, recorded by the webhook since 2026-10-23); any MARKETING message is a red line
 *     - Meta's own refusals: 131031 restricted, 131042 billing, 131049 marketing limit,
 *       131047 messaging outside the 24-hour window, 131026 undeliverable
 *     - account events Meta sent (account-* pulse rows: restrictions, violations, reviews)
 *     - reminders or nudges to people who stopped answering (must stay zero)
 *     - "stop" honoured: no message after a stop unless the person writes again
 *     - complaints: customer messages that say spam, unsubscribe, who is this, block, report
 *     - replies of three or more messages to one customer message (one reply is the rule)
 *
 * Verdict RED / AMBER / GREEN with plain reasons. A summary e-mail goes daily; a WhatsApp alert
 * to ops goes when the verdict is not GREEN and a reason is new since yesterday. Aggregates only:
 * no customer number, name or message text leaves this module.
 */
import prismaDefault from './prisma.js';

const DAY = 24 * 60 * 60 * 1000;
const GRAPH = 'https://graph.facebook.com/v21.0';

/** Template names held in env vars by the code paths that send templates. */
export const TEMPLATE_ENVS = Object.freeze([
  'WAPAY_TEMPLATE_REQUEST_PAID', 'WAPAY_TEMPLATE_PAYMENT_RECEIPT', 'WAPAY_TEMPLATE_PAYMENT_RECEIPT_V2',
  'WAPAY_TEMPLATE_PAYOUT_OUTCOME', 'WAPAY_TEMPLATE_SUPPORT_FOLLOWUP', 'WAPAY_TEMPLATE_OPS_ALERT',
  'WAPAY_TEMPLATE_BUSINESS_REQUEST', 'WAPAY_TEMPLATE_ADMIN_OTP', 'WAPAY_TEMPLATE_SEND_REFUND', 'WAPAY_TEMPLATE_BUSINESS_OTP',
]);
/** Template names written into the code itself (the MARKETING ones are blocked at the sender). */
export const CODE_TEMPLATES = Object.freeze(['otp_register', 'otp_register_step_2', 'onboarding_step_3_pin_creation', 'wapay_support_followup']);

export function templatesWeSend(env = process.env) {
  return [...new Set([...CODE_TEMPLATES, ...TEMPLATE_ENVS.map((k) => String(env[k] || '').trim()).filter(Boolean)])];
}

export const COMPLAINT_RE = /\b(spam|scam|unsubscribe|who is this|who are you|leave me alone|stop (sending|messaging|texting)|block(ed)?|report(ed|ing)?)\b/i;
export const STOP_RE = /^\s*(stop|unsubscribe|opt ?out|stop all|cancel all)\s*[.!]*\s*$/i;

/** Meta's view of the number and the templates. Never throws. */
export async function readMetaSide({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const token = env.META_WHATSAPP_TOKEN || env.WHATSAPP_ACCESS_TOKEN || '';
  const phoneNumberId = env.META_WHATSAPP_PHONE_NUMBER_ID || env.WHATSAPP_PHONE_NUMBER_ID || '';
  const wabaId = env.WHATSAPP_BUSINESS_ACCOUNT_ID || '';
  if (!token || !phoneNumberId) return { ok: false, error: 'NOT_CONFIGURED' };
  const get = async (path) => {
    try {
      const r = await fetchImpl(`${GRAPH}/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => ({}));
      return r.ok ? j : { error: j?.error?.message ? String(j.error.message).slice(0, 160) : `HTTP ${r.status}` };
    } catch (e) {
      return { error: String(e?.name === 'TimeoutError' ? 'TIMEOUT' : e?.message || 'ERROR').slice(0, 80) };
    }
  };
  const [pn, hs, tpl] = await Promise.all([
    get(`${phoneNumberId}?fields=quality_rating,messaging_limit_tier,status,name_status`),
    get(`${phoneNumberId}?fields=health_status`),
    wabaId ? get(`${wabaId}/message_templates?fields=name,status,category&limit=200`) : Promise.resolve({ error: 'NO_WABA_ID' }),
  ]);
  return {
    ok: !pn.error,
    quality: pn.quality_rating || null,
    tier: pn.messaging_limit_tier || null,
    status: pn.status || null,
    canSend: hs.health_status?.can_send_message || null,
    templates: Array.isArray(tpl.data) ? tpl.data.map((t) => ({ name: t.name, status: t.status, category: t.category })) : null,
    error: pn.error || null,
    templatesError: tpl.error || null,
  };
}

/** Per-account turn sequences → the behaviour measures. Pure. */
export function measureTurns({ turns = [], accounts = [], excludeIds = new Set(), now = Date.now() }) {
  const since = now - DAY;
  const by = {};
  for (const t of turns) if (!excludeIds.has(t.accountId)) (by[t.accountId] ||= []).push(t);
  let customersWhoWrote = 0, answered = 0, threePlus = 0, reminders = 0, stopViolations = 0, complaints = 0, worstBurst = 0;
  for (const [id, list0] of Object.entries(by)) {
    const list = [...list0].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    let wrote = false, run = 0, stoppedAt = null, replyAfterStop = 0;
    const close = () => { if (run) { answered++; if (run >= 3) threePlus++; if (run > worstBurst) worstBurst = run; } run = 0; };
    for (const t of list) {
      const at = new Date(t.createdAt).getTime();
      const recent = at >= since;
      if (t.role === 'user') {
        if (recent) {
          close();
          wrote = true;
          const text = String(t.text || '');
          if (COMPLAINT_RE.test(text)) complaints++;
          if (STOP_RE.test(text)) { stoppedAt = at; replyAfterStop = 0; } else stoppedAt = null;
        } else { run = 0; stoppedAt = STOP_RE.test(String(t.text || '')) ? at : null; replyAfterStop = 0; }
        continue;
      }
      if (t.role !== 'assistant' || !recent) continue;
      run++;
      if (/reminder/i.test(String(t.kind || ''))) reminders++;
      if (stoppedAt != null) { replyAfterStop++; if (replyAfterStop > 1) stopViolations++; }
    }
    close();
    if (wrote) customersWhoWrote++;
  }
  return { customersWhoWrote, answered, threePlus, threePlusPct: answered ? Math.round((1000 * threePlus) / answered) / 10 : 0, worstBurst, reminders, stopViolations, complaints };
}

/** Pulse rows of the last 24 hours → Meta's refusals, billed categories and account events. Pure. */
export function measurePulses(rows = []) {
  const failures = {}, priced = {}, accountEvents = [];
  let delivered = 0;
  for (const r of rows) {
    const k = String(r.waMessageId || '').replace(/:\d{4}-\d{2}-\d{2}T[\d:]+$/, '');
    let m;
    if ((m = k.match(/^status-failed-(\d+)$/))) failures[m[1]] = (failures[m[1]] || 0) + 1;
    else if (/^status-(delivered|read|sent)$/.test(k)) delivered++;
    else if ((m = k.match(/^price-([a-z_]+)/))) priced[m[1]] = (priced[m[1]] || 0) + 1;
    else if (k.startsWith('account-')) accountEvents.push(k.slice(0, 120));
  }
  return { failures, delivered, priced, accountEvents: [...new Set(accountEvents)] };
}

/** The verdict. Pure. `previous` = yesterday's reason codes, to say what is new. */
export function complianceVerdict({ meta = {}, pulses = {}, behaviour = {}, weSend = [], marketingBlocked = new Set(), previousCodes = [], previousTier = null, env = null }) {
  const reasons = [];
  const add = (level, code, text) => reasons.push({ level, code, text });
  // Receipts to payers outside their window go only by the approved template (2026-10-23).
  if (env && !String(env.WAPAY_TEMPLATE_PAYMENT_RECEIPT || '').trim()) add('AMBER', 'NO_RECEIPT_TEMPLATE', 'WAPAY_TEMPLATE_PAYMENT_RECEIPT is not set: payers who never wrote to WaPay cannot get their receipt. Set it to wapay_payment_receipt.');
  // Meta's view
  if (meta.ok === false) add('AMBER', 'META_UNREADABLE', `Meta's view could not be read (${meta.error || 'error'}); the behaviour checks below still ran.`);
  if (meta.quality === 'RED') add('RED', 'QUALITY_RED', 'Quality rating is RED: people have been blocking or reporting WaPay. Keep ad volume flat until it recovers.');
  else if (meta.quality === 'YELLOW') add('AMBER', 'QUALITY_YELLOW', 'Quality rating is YELLOW.');
  if (meta.canSend === 'BLOCKED') add('RED', 'CANNOT_SEND', 'Meta reports the number cannot send messages.');
  if (meta.tier && previousTier && meta.tier !== previousTier && tierRank(meta.tier) < tierRank(previousTier)) add('AMBER', 'TIER_DOWN', `Messaging limit fell from ${previousTier} to ${meta.tier}.`);
  if (Array.isArray(meta.templates)) {
    const byName = new Map(meta.templates.map((t) => [t.name, t]));
    for (const name of weSend) {
      const t = byName.get(name);
      if (!t) continue;
      if (t.category === 'MARKETING') add('RED', `SEND_MARKETING_${name}`.slice(0, 60), `Template "${name}", which the code sends, is filed by Meta as MARKETING.`);
      if (['PAUSED', 'DISABLED', 'REJECTED'].includes(t.status)) add('AMBER', `TEMPLATE_${t.status}_${name}`.slice(0, 60), `Template "${name}" is ${t.status}.`);
    }
    for (const t of meta.templates) if (t.category === 'MARKETING' && !marketingBlocked.has(t.name)) add('AMBER', `UNBLOCKED_MARKETING_${t.name}`.slice(0, 60), `New MARKETING template "${t.name}" is not on the sender's block list yet.`);
  }
  // What Meta billed and refused
  const f = pulses.failures || {};
  if ((pulses.priced?.marketing || 0) > 0) add('RED', 'MARKETING_SENT', `Meta billed ${pulses.priced.marketing} minute(s) of MARKETING messages in the last 24 hours.`);
  if (f['131031']) add('RED', 'RESTRICTED_131031', `Meta refused messages as restricted (131031) in ${f['131031']} minute(s): check Business Support Home, WhatsApp account overview.`);
  if (f['131042']) add('RED', 'BILLING_131042', `Meta refused messages over billing (131042) in ${f['131042']} minute(s): check the owning portfolio's payment method.`);
  if (f['131049']) add('RED', 'MARKETING_LIMIT_131049', 'Meta held back marketing messages (131049): something tried to send marketing.');
  if ((f['131047'] || 0) >= 5) add('AMBER', 'OUTSIDE_WINDOW_131047', `Something tried to message people outside their 24-hour window (131047) in ${f['131047']} minute(s).`);
  if ((pulses.accountEvents || []).length) add('RED', 'ACCOUNT_EVENT', `Meta sent account events: ${pulses.accountEvents.slice(0, 3).join(', ')}.`);
  // Our behaviour
  if (behaviour.reminders > 0) add('RED', 'REMINDERS', `${behaviour.reminders} reminder or nudge message(s) went out; WaPay never follows up on its own.`);
  if (behaviour.stopViolations > 0) add('RED', 'STOP_IGNORED', `${behaviour.stopViolations} message(s) went to people after they said stop.`);
  if (behaviour.complaints >= 3) add('AMBER', 'COMPLAINTS', `${behaviour.complaints} customer message(s) mention spam, scam, unsubscribe, block or report.`);
  if (behaviour.threePlusPct > 8) add('AMBER', 'BURSTS', `${behaviour.threePlusPct}% of customer messages got three or more replies (the rule is one).`);
  const verdict = reasons.some((r) => r.level === 'RED') ? 'RED' : reasons.some((r) => r.level === 'AMBER') ? 'AMBER' : 'GREEN';
  const prev = new Set(previousCodes);
  const fresh = reasons.filter((r) => !prev.has(r.code)).map((r) => r.code);
  return { verdict, reasons, newCodes: fresh };
}

function tierRank(t) {
  const m = String(t || '').match(/TIER_(\d+)(K|M)?|UNLIMITED/);
  if (!m) return 0;
  if (String(t).includes('UNLIMITED')) return 1e9;
  return Number(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1);
}

export function summaryText({ verdict, reasons, meta, pulses, behaviour, at }) {
  const head = `${verdict === 'GREEN' ? '✅' : verdict === 'AMBER' ? '⚠️' : '🚨'} WhatsApp compliance ${verdict} (${String(at).slice(0, 10)})`;
  const lines = reasons.length ? reasons.map((r) => `• ${r.level}: ${r.text}`) : ['• Every rule held in the last 24 hours.'];
  const facts = `Quality ${meta.quality || '?'}, limit ${meta.tier || '?'}, health ${meta.canSend || '?'}. Last 24 h: ${behaviour.customersWhoWrote ?? '?'} customers wrote, ${behaviour.answered ?? '?'} answered, ${behaviour.threePlusPct ?? '?'}% got 3+ replies, ${behaviour.complaints ?? 0} complaint words, ${behaviour.reminders ?? 0} reminders, ${behaviour.stopViolations ?? 0} after-stop messages; billed categories ${JSON.stringify(pulses.priced || {})}; Meta refusals ${JSON.stringify(pulses.failures || {})}.`;
  return [head, ...lines, facts].join('\n');
}

/**
 * Run the check. `alert`: send the daily e-mail summary (once a day) and, when the verdict is
 * not GREEN and a reason is new since yesterday, a WhatsApp alert to ops. Never throws.
 */
export async function runComplianceCheck({ prisma = prismaDefault, now = Date.now(), env = process.env, alert = false, deps = {} } = {}) {
  const at = new Date(now).toISOString();
  const day = at.slice(0, 10);
  const yday = new Date(now - DAY).toISOString().slice(0, 10);
  try {
    const { MARKETING_TEMPLATES } = deps.whatsapp || (await import('@wapay/whatsapp'));
    const meta = deps.readMetaSide ? await deps.readMetaSide() : await readMetaSide({ env });
    const since = new Date(now - DAY);
    const [pulseRows, turns, prevRows] = await Promise.all([
      prisma.processedMessage.findMany({ where: { processedAt: { gte: since }, OR: [{ waMessageId: { startsWith: 'status-' } }, { waMessageId: { startsWith: 'price-' } }, { waMessageId: { startsWith: 'account-' } }] }, select: { waMessageId: true } }),
      prisma.conversationTurn.findMany({ where: { createdAt: { gte: new Date(now - 3 * DAY) } }, select: { accountId: true, role: true, kind: true, text: true, createdAt: true } }),
      prisma.processedMessage.findMany({ where: { waMessageId: { startsWith: `compliance:${yday}` } }, select: { waMessageId: true } }),
    ]);
    const { opsAlertRecipients } = deps.opsAlerts || (await import('./ops-alerts.js'));
    const opsTails = new Set(opsAlertRecipients(env).map((n) => n.slice(-9)));
    const ids = [...new Set(turns.map((t) => t.accountId))];
    const accounts = ids.length ? await prisma.account.findMany({ where: { id: { in: ids } }, select: { id: true, waId: true } }) : [];
    const excludeIds = new Set(accounts.filter((a) => opsTails.has(String(a.waId).slice(-9)) || String(a.waId).startsWith('276000009')).map((a) => a.id));
    const behaviour = measureTurns({ turns, accounts, excludeIds, now });
    const pulses = measurePulses(pulseRows);
    const prev = prevRows[0]?.waMessageId || '';
    const previousCodes = prev.split(':').slice(3).join(':').split(',').filter(Boolean);
    const previousTier = prev.split(':')[2] || null;
    const v = complianceVerdict({ meta, pulses, behaviour, weSend: templatesWeSend(env), marketingBlocked: MARKETING_TEMPLATES, previousCodes, previousTier, env });
    const out = { at, ...v, templates: Object.fromEntries(TEMPLATE_ENVS.map((k) => [k, String(env[k] || '').trim() || null])), meta: { quality: meta.quality, tier: meta.tier, status: meta.status, canSend: meta.canSend, error: meta.error, templatesError: meta.templatesError }, pulses, behaviour };
    if (alert) {
      const { claimMessage } = deps.ledger || (await import('./ledger-post.js'));
      // One stored line per day: verdict, tier, reason codes (tomorrow's "what is new").
      await claimMessage({ waMessageId: `compliance:${day}:${meta.tier || '-'}:${v.reasons.map((r) => r.code).join(',')}`.slice(0, 900) }).catch(() => null);
      const text = summaryText({ ...out, at });
      if (await claimMessage({ waMessageId: `compliance-mail:${day}` }).catch(() => false)) {
        const { sendOpsAlert } = deps.email || (await import('./email.js'));
        const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        out.mail = await sendOpsAlert({ subject: `WhatsApp compliance ${v.verdict} (${day})`, detailsHtml: `<pre style="font-family:inherit;white-space:pre-wrap">${esc(text)}</pre>` }).then((r) => !!r?.success).catch(() => false);
      }
      if (v.verdict !== 'GREEN' && v.newCodes.length) {
        const { opsPersonAlert } = deps.opsAlerts || (await import('./ops-alerts.js'));
        out.whatsapp = await opsPersonAlert({ text, key: `compliance:${day}:${v.newCodes.join(',')}`.slice(0, 200), prisma }).catch(() => null);
      }
    }
    return out;
  } catch (e) {
    return { at, verdict: 'UNKNOWN', error: String(e?.message || e).slice(0, 200) };
  }
}
