/**
 * Operator alerts (founder, 2026-10-19): a WhatsApp line to the ops numbers the
 * moment money lands in a customer's balance from outside (a paid link, a card
 * deposit), carrying the float position, so the pay-out float is funded before
 * the withdrawal that tends to follow within minutes. A second line after a
 * pay-out when the float has dropped below its warn level or below what
 * customers hold.
 *
 *   WAPAY_OPS_ALERT_MSISDNS=27...,27...  recipients (unset = the alert is logged, not sent)
 *   WAPAY_OPS_ALERT_MIN_CENTS=0          ignore money-in below this amount
 *   WAPAY_TEMPLATE_OPS_ALERT=<name>      an approved one-parameter utility template, used
 *                                        outside a recipient's 24-hour window (lib/notify.js)
 *
 * Rules: best effort and never throws; never blocks or delays the money path
 * beyond a short cap; once per event (ProcessedMessage key); the money alerts
 * are aggregates only, no customer name, number or reference in the text
 * (docs/GOLDEN_THREAD.md). The person alert (`opsPersonAlert`, the WhatsApp
 * twin of the third-tier ops e-mail) carries the e-mail's references and masks
 * and never a full number, because the operator has to find the customer.
 */
import prisma from './prisma.js';
import { notifyCustomer } from './notify.js';
import { floatPosition } from './payout-float.js';

const R = (c) => `R${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const CAP_MS = 6000;

export function opsAlertRecipients(env = process.env) {
  return String(env.WAPAY_OPS_ALERT_MSISDNS || '').split(',').map((s) => s.trim().replace(/\D/g, '')).filter((s) => s.length >= 9);
}

export function opsAlertMinCents(env = process.env) {
  const n = Number(env.WAPAY_OPS_ALERT_MIN_CENTS);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

const KIND_LABEL = { LINK_PAID: 'payment link paid by card', DEPOSIT: 'card deposit', VOUCHER_LOAD: 'voucher load' };

function sourceLabel(account) {
  if (account?.profile?.attribution?.ctwaClid) return 'an ad-acquired customer';
  if (account?.profile?.acquisitionSource === 'paylink') return 'a customer who came in as a payer';
  return 'a customer';
}

function positionLines(pos) {
  const lines = [];
  lines.push(`Customer balances: ${R(pos.balancesCents)} across ${pos.accountsWithMoney ?? pos.wallets ?? '?'} accounts with money (${pos.walletsAbove20 ?? '?'} at or above R20; ${pos.finishedAccounts ?? '?'} accounts finished sign-up, ${pos.wallets ?? '?'} opened).`);
  if (pos.floatCents != null) {
    lines.push(`Pay-out float: ${R(pos.floatCents)} · cover ${pos.coverX != null ? pos.coverX + '× of balances' : 'n/a'}${pos.daysOfCover != null ? ` · ${pos.daysOfCover} days at the week's pace` : ''} · warn level ${R(pos.warnCents)}.`);
  } else {
    lines.push(`Pay-out float: not readable right now (${pos.floatError || 'unknown'}) · warn level ${R(pos.warnCents)}.`);
  }
  if (pos.openLinks) lines.push(`Open links: ${pos.openLinks.n} (${R(pos.openLinks.cents)}). Pay-outs today: ${pos.payoutsToday?.n ?? 0} (${R(pos.payoutsToday?.cents)}).`);
  return lines;
}

export function moneyInText({ amountCents, kind, account, position }) {
  const head = `💰 Money in: ${R(amountCents)} (${KIND_LABEL[kind] || String(kind || 'load').toLowerCase()}) to ${sourceLabel(account)}.`;
  const tail = position.low === true || (position.coverX != null && position.coverX < 1)
    ? 'Top up the OTT pay-out float now.'
    : 'Float is fine for now.';
  return [head, ...positionLines(position), tail].join('\n');
}

export function payoutLowText({ amountCents, method, position }) {
  return [
    `⚠️ Pay-out float ${position.floatCents != null ? R(position.floatCents) : 'unreadable'} after a ${R(amountCents)} ${method || ''} pay-out, ${position.low ? `below the warn level ${R(position.warnCents)}` : 'below what customers hold'}.`,
    ...positionLines(position),
    'Top up the OTT pay-out float now.',
  ].join('\n');
}

/** True the first time this key is seen (ProcessedMessage is the once-only ledger the webhooks use). */
async function firstTime(db, key) {
  try {
    await db.processedMessage.create({ data: { waMessageId: `ops-alert:${key}`.slice(0, 190), accountId: null } });
    return true;
  } catch (e) {
    if (e?.code === 'P2002') return false;
    return true; // a storage hiccup must not silence the alert
  }
}

async function deliver({ db, text, kind }) {
  const to = opsAlertRecipients();
  if (!to.length) {
    console.log(JSON.stringify({ type: 'ops_alert_unsent', reason: 'NO_RECIPIENTS', kind, preview: text.split('\n')[0] }));
    return { sent: 0, recipients: 0 };
  }
  let sent = 0;
  for (const msisdn of to) {
    const acct = await db.account.findFirst({ where: { waId: msisdn }, select: { id: true } }).catch(() => null);
    const r = await notifyCustomer({ to: msisdn, accountId: acct?.id || null, text, kind: 'ops', templateEnv: 'WAPAY_TEMPLATE_OPS_ALERT', templateParams: [text], deps: { prisma: db } }).catch((e) => ({ ok: false, error: e?.message }));
    console.log(JSON.stringify({ type: 'ops_alert', kind, to: msisdn.slice(0, 4) + '…' + msisdn.slice(-3), ok: !!r?.ok, rail: r?.rail || null, error: r?.error || null }));
    if (r?.ok) sent += 1;
  }
  return { sent, recipients: to.length };
}

async function defaultSendOpsAlert(args) {
  const { sendOpsAlert } = await import('./email.js');
  return sendOpsAlert(args);
}

function withCap(promise, ms = CAP_MS) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve({ skipped: 'TIMEOUT' }), ms))]);
}

/**
 * Money landed in a customer's balance from outside. Call AFTER the ledger
 * posting succeeded and only when it was not a replay.
 */
export async function opsMoneyIn({ amountCents, kind = 'LINK_PAID', accountId = null, idemKey, prisma: db = prisma, deps = {} } = {}) {
  try {
    if (!Number.isInteger(amountCents) || amountCents <= 0) return { skipped: 'NO_AMOUNT' };
    if (amountCents < opsAlertMinCents()) return { skipped: 'BELOW_MIN' };
    if (!idemKey) return { skipped: 'NO_KEY' };
    return await withCap((async () => {
      if (!(await firstTime(db, `in:${idemKey}`))) return { skipped: 'DUPLICATE' };
      const account = accountId ? await db.account.findUnique({ where: { id: accountId }, select: { profile: true } }).catch(() => null) : null;
      const position = await (deps.floatPosition || floatPosition)({ prisma: db });
      const text = moneyInText({ amountCents, kind, account, position });
      const delivered = await (deps.deliver || deliver)({ db, text, kind: 'MONEY_IN' });
      // The e-mail twin (founder 2026-10-20, "notify me as soon as links get paid"): outside a 24-hour window and
      // without a template the WhatsApp line cannot be delivered, so the same text goes to ALERT_EMAIL as well.
      const mail = await (deps.sendOpsAlert || defaultSendOpsAlert)({ subject: `Money in: ${R(amountCents)} (${KIND_LABEL[kind] || String(kind || 'load').toLowerCase()})`, detailsHtml: `<pre style="font-family:inherit;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>` }).catch(() => ({ success: false }));
      return { ...delivered, email: !!mail?.success, text };
    })());
  } catch (error) {
    console.error(JSON.stringify({ type: 'ops_alert_error', kind: 'MONEY_IN', error: error?.message }));
    return { error: error?.message };
  }
}

/** A pay-out settled. Alerts only when the float is now thin. */
export async function opsPayoutDone({ amountCents, method = null, reference, prisma: db = prisma, deps = {} } = {}) {
  try {
    if (!reference) return { skipped: 'NO_KEY' };
    return await withCap((async () => {
      const position = await (deps.floatPosition || floatPosition)({ prisma: db });
      const thin = position.low === true || (position.coverX != null && position.coverX < 1);
      if (!thin) return { skipped: 'FLOAT_OK', floatCents: position.floatCents };
      if (!(await firstTime(db, `out:${reference}`))) return { skipped: 'DUPLICATE' };
      const text = payoutLowText({ amountCents, method, position });
      return { ...(await (deps.deliver || deliver)({ db, text, kind: 'FLOAT_LOW' })), text };
    })());
  } catch (error) {
    console.error(JSON.stringify({ type: 'ops_alert_error', kind: 'FLOAT_LOW', error: error?.message }));
    return { error: error?.message };
  }
}

/**
 * A pay-out request (founder 2026-10-24: "keep me updated whenever someone requests a payout"): the
 * triage line (lib/payout-triage.js) as one WhatsApp message to the ops numbers, with the e-mail twin
 * because a WhatsApp line cannot reach a number outside its 24-hour window without the ops template.
 * Once per request key. Never throws; capped like the others.
 */
export async function opsPayoutRequest({ text, key, level = null, prisma: db = prisma, deps = {} } = {}) {
  try {
    if (!text || !String(text).trim()) return { skipped: 'NO_TEXT' };
    if (!key) return { skipped: 'NO_KEY' };
    return await withCap((async () => {
      if (!(await firstTime(db, `payreq:${key}`))) return { skipped: 'DUPLICATE' };
      const delivered = await (deps.deliver || deliver)({ db, text: String(text), kind: 'PAYOUT_REQUEST' });
      const subject = `Pay-out request${level ? `, fraud level ${level}/5` : ''}: ${String(text).split('\n')[1] || ''}`.slice(0, 140);
      const html = `<pre style="font-family:inherit;white-space:pre-wrap">${String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`;
      const mail = await (deps.sendOpsAlert || defaultSendOpsAlert)({ subject, detailsHtml: html }).catch(() => ({ success: false }));
      return { ...delivered, email: !!mail?.success, text: String(text) };
    })());
  } catch (error) {
    console.error(JSON.stringify({ type: 'ops_alert_error', kind: 'PAYOUT_REQUEST', error: error?.message }));
    return { error: error?.message };
  }
}

/**
 * A pay-out the rail did not complete (BUGLOG #146, 2026-10-28): the reason the customer was given, the rail's code
 * and words (masked), whether the next fee should be waived, and UNMAPPED when lib/payout-reasons.js has no row for
 * the code. WhatsApp to the ops numbers with the e-mail twin, once per reference. Never throws; capped.
 */
export async function opsPayoutFailed({ text, key, prisma: db = prisma, deps = {} } = {}) {
  try {
    if (!text || !String(text).trim()) return { skipped: 'NO_TEXT' };
    if (!key) return { skipped: 'NO_KEY' };
    return await withCap((async () => {
      if (!(await firstTime(db, `payfail:${key}`))) return { skipped: 'DUPLICATE' };
      const delivered = await (deps.deliver || deliver)({ db, text: String(text), kind: 'PAYOUT_FAILED' });
      const subject = String(text).split('\n')[0].slice(0, 140);
      const html = `<pre style="font-family:inherit;white-space:pre-wrap">${String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`;
      const mail = await (deps.sendOpsAlert || defaultSendOpsAlert)({ subject, detailsHtml: html }).catch(() => ({ success: false }));
      return { ...delivered, email: !!mail?.success, text: String(text) };
    })());
  } catch (error) {
    console.error(JSON.stringify({ type: 'ops_alert_error', kind: 'PAYOUT_FAILED', error: error?.message }));
    return { error: error?.message };
  }
}

/**
 * A customer reached the third withdraw gate (lib/payout-gate.js stuckAlert):
 * the ops e-mail's content as one WhatsApp message to the ops numbers, once per
 * key (account and day). Returns { sent, recipients } like the others.
 */
export async function opsPersonAlert({ text, key, prisma: db = prisma, deps = {} } = {}) {
  try {
    if (!text || !String(text).trim()) return { skipped: 'NO_TEXT' };
    if (!key) return { skipped: 'NO_KEY' };
    return await withCap((async () => {
      if (!(await firstTime(db, `person:${key}`))) return { skipped: 'DUPLICATE' };
      return { ...(await (deps.deliver || deliver)({ db, text: String(text), kind: 'PERSON' })), text: String(text) };
    })());
  } catch (error) {
    console.error(JSON.stringify({ type: 'ops_alert_error', kind: 'PERSON', error: error?.message }));
    return { error: error?.message };
  }
}
