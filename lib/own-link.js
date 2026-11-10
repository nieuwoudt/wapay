/**
 * Paying your own link (founder decision 2026-11-10).
 *
 * The stolen-card pattern of 20 Oct to 7 Nov ran through links paid by card with the requester's own
 * number typed as the payer (73% of Pay presses since launch; •••1332's three R3,000 links on 7 Nov).
 * The founder's rule: it is not refused, it needs an ID check.
 *
 *   payer number is not the requester's     → PASS, nothing changes
 *   requester's ID is verified               → PASS (pay-outs still wait for approval downstream)
 *   first own-link payment, under the line   → WARN: one page says we can see it is their own link and
 *                                              that next time a verified ID comes first; Continue pays
 *   an own link of theirs was already paid   → BLOCK until they verify
 *   at or above WAPAY_OWN_LINK_KYC_FIRST_CENTS (default R1,000; 'off' turns this test off) → BLOCK
 *   the history cannot be read               → BLOCK (unknown is not "first time")
 *
 * A block happens in /api/pay/checkout before any intent or rail session exists, so nothing is charged.
 * "Paid" = a SUCCESS payrequest intent on the requester's account whose payer number is the requester's,
 * not refunded to the card (lib/card-refund.js sets metadata.refund). The words never say whether a
 * number is on WaPay; the page only says the typed number is the one the link belongs to, which the
 * pay page's last-three-digits line already lets a payer check.
 */
import { configuredAppHost } from './app-host.js';

export const OWN_LINK_KYC_FIRST_DEFAULT_CENTS = 100000;
const HISTORY_LIMIT = 500;

/** The last nine digits of a South African number in any stored form, or ''. Pure. */
export function tail9(n) {
  const d = String(n || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : '';
}

/** Is this payer number the account's own (waId or msisdn, either form)? Pure. */
export function isOwnNumber(payerMsisdn, account) {
  const p = tail9(payerMsisdn);
  if (!p || !account) return false;
  return [account.waId, account.msisdn].some((n) => tail9(n) === p);
}

/** The first-payment line in cents, or null when switched off. Pure. */
export function ownLinkFirstThresholdCents(env = process.env) {
  const raw = String(env.WAPAY_OWN_LINK_KYC_FIRST_CENTS ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'none') return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  return OWN_LINK_KYC_FIRST_DEFAULT_CENTS;
}

/**
 * The rule. Pure.
 * @param {{ ownNumber: boolean, verified: boolean, priorPaid: number|null, amountCents: number, thresholdCents: number|null }} a
 * @returns {{ action: 'PASS'|'WARN'|'BLOCK', reason: 'OTHER_PAYER'|'VERIFIED'|'FIRST'|'REPEAT'|'AMOUNT'|'UNKNOWN' }}
 */
export function ownLinkDecision({ ownNumber, verified, priorPaid, amountCents, thresholdCents }) {
  if (!ownNumber) return { action: 'PASS', reason: 'OTHER_PAYER' };
  if (verified) return { action: 'PASS', reason: 'VERIFIED' };
  if (!Number.isInteger(priorPaid) || priorPaid < 0) return { action: 'BLOCK', reason: 'UNKNOWN' };
  if (priorPaid >= 1) return { action: 'BLOCK', reason: 'REPEAT' };
  if (thresholdCents != null && Number(amountCents) >= thresholdCents) return { action: 'BLOCK', reason: 'AMOUNT' };
  return { action: 'WARN', reason: 'FIRST' };
}

/**
 * How many of this account's links were paid by card with its own number (refunds excluded).
 * Returns null when it cannot be read: the caller treats unknown as a block.
 */
export async function countPaidOwnLinks({ prisma, account, limit = HISTORY_LIMIT }) {
  try {
    if (!account?.id || typeof prisma?.providerRequest?.findMany !== 'function') return null;
    const rows = await prisma.providerRequest.findMany({
      where: { route: 'payrequest', status: 'SUCCESS', accountId: account.id },
      select: { metadata: true },
      orderBy: { requestTs: 'desc' },
      take: limit,
    });
    return (rows || []).filter((r) => r?.metadata && !r.metadata.refund && isOwnNumber(r.metadata.payerMsisdn, account)).length;
  } catch (error) {
    console.error(JSON.stringify({ type: 'own_link_history_read_failed', error: error?.message }));
    return null;
  }
}

/** Where an ID check starts: the web portal's Profile (number + PIN), which opens the Didit check. Pure. */
export function verifyWhere(env = process.env) {
  const host = configuredAppHost(env);
  return host ? `${host}/app/profile` : null;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const rand = (cents) => {
  const r = Math.trunc(Number(cents) / 100);
  const c = Math.abs(Number(cents) % 100);
  return `R${String(r).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${c ? `.${String(c).padStart(2, '0')}` : ''}`;
};

function page({ title, body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#f4f6f5;color:#0b1411;margin:0;padding:24px 16px}main{max-width:440px;margin:8vh auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px}.btn{display:block;width:100%;box-sizing:border-box;text-align:center;font:inherit;font-weight:600;padding:14px 18px;border:0;border-radius:12px;background:#359853;color:#fff;text-decoration:none;cursor:pointer;margin-top:8px}.ghost{background:#eef3f0;color:#0b1411}.small{font-size:14px;color:#4a5a53}</style></head><body><main>${body}</main></body></html>`;
}

/** The text of the first-time page (exported for tests and the CHANGELOG). Pure. */
export function ownLinkWarnLines({ amountCents }) {
  return [
    'This is your own link',
    'The number you typed is the number this link belongs to, so you are paying your own link.',
    'This time it goes through. Paying your own link again needs a verified ID first.',
    'If this is not your number, go back and type your own.',
    `Continue to pay ${rand(amountCents)}`,
  ];
}

/**
 * The first-time page: Continue posts the same form again with ack=1. The ack only skips this page;
 * the rule is decided again on that post, so it cannot be used to pay past a block. Pure.
 */
export function ownLinkWarnHtml({ code, payer, rail = '', flow = '', amountCents }) {
  const [title, l1, l2, l3, cta] = ownLinkWarnLines({ amountCents });
  const c = String(code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 12);
  const fields = { code: c, payer: String(payer || '').replace(/[^0-9+ ]/g, '').slice(0, 15), ack: '1' };
  const r = String(rail || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 12);
  const f = String(flow || '').replace(/[^A-Za-z_]/g, '').slice(0, 24);
  if (r) fields.rail = r;
  if (f) fields.flow = f;
  const inputs = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return page({
    title,
    body: `<h1>${esc(title)}</h1><p>${esc(l1)}</p><p><strong>${esc(l2)}</strong></p><p class="small">${esc(l3)}</p><form method="POST" action="/api/pay/checkout">${inputs}<button class="btn" type="submit">${esc(cta)}</button></form><a class="btn ghost" href="/pay/${esc(c)}">Go back</a>`,
  });
}

/** The text of the block page (exported for tests and the CHANGELOG). Pure. */
export function ownLinkBlockLines({ reason, thresholdCents, where }) {
  const why = reason === 'AMOUNT'
    ? `The number you typed is the number this link belongs to. Paying your own link with ${rand(thresholdCents ?? OWN_LINK_KYC_FIRST_DEFAULT_CENTS)} or more needs a verified ID first.`
    : reason === 'REPEAT'
      ? 'The number you typed is the number this link belongs to, and one of your links was already paid this way. Paying your own link again needs a verified ID first.'
      : 'The number you typed is the number this link belongs to. Paying your own link needs a verified ID first.';
  const how = where
    ? `Verify once at ${where}: log in with your cellphone number and PIN and tap Verify. It takes about two minutes. Then open this link again.`
    : 'Verify your ID in WaPay first, then open this link again.';
  return ['Verify your ID first', why, how, 'If this is not your number, go back and type your own.', 'Nothing was charged.'];
}

/** The block page. Pure. */
export function ownLinkBlockHtml({ code, reason, thresholdCents = null, env = process.env }) {
  const where = verifyWhere(env);
  const [title, why, how, other, nothing] = ownLinkBlockLines({ reason, thresholdCents, where });
  const c = String(code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 12);
  const verifyBtn = where ? `<a class="btn" href="https://${esc(where)}">Verify my ID</a>` : '';
  return page({
    title,
    body: `<h1>${esc(title)}</h1><p>${esc(why)}</p><p>${esc(how)}</p><p class="small">${esc(other)} ${esc(nothing)}</p>${verifyBtn}<a class="btn ghost" href="/pay/${esc(c)}">Go back</a>`,
  });
}

/** The line the requester's paid notice carries after a first own-link payment by an unverified account. Pure. */
export function ownLinkRequesterLine(env = process.env) {
  const where = verifyWhere(env);
  return `This link was paid with your own number. Paying your own link again needs a verified ID${where ? `: verify once at ${where}` : ''}.`;
}
