/**
 * The personal portal's read side and its copy (2026-10-21).
 *
 * What the screens show: the balance, the status banner, the recent and full
 * activity, the payment links, the profile and the coming-soon tiles. All of
 * it is read from the ledger, the intent rows and the vault's masked views;
 * nothing here writes or moves money, and nothing here reaches a model.
 *
 * Copy rule (brief, binding): where a rule or a fee is shown, the words come
 * from the chat's own functions (dailyCapCopy, kycThresholdCopy, rulesNote,
 * FROZEN_*_COPY, the send confirm, the collection lines), so the two surfaces
 * never disagree. webLine() only replaces what is chat-only: "reply VERIFY",
 * "or cancel", WhatsApp bold, and "contact you here" (WhatsApp is the thing
 * that is paused). No em dashes, no time promises, no partner named for
 * pay-outs, "coming soon" never with a date.
 */
import { BALANCE, ACCT } from './ledger-core.js';
import { paymentRequestUrl, MIN_REQUEST_CENTS, MAX_REQUEST_CENTS, REQUEST_TTL_DAYS } from './payment-requests.js';
import { paymentRequestFeeCents, grossedUpRequestCents, depositFeeCents, MIN_DEPOSIT_CENTS, MAX_DEPOSIT_CENTS } from './deposits.js';
import { isCapabilityLiveFor, capabilityById } from './capabilities.js';
import { VIRTUAL_CARD_LIVE } from './vas-config.js';
import { referralLink, isWellFormedCode } from './referrals.js';
import { kycMode, rulesNote } from './payout-rules.js';
import { PAYOUT_METHODS } from './payouts.js';
import { DESTINATION_FAMILY } from './payout-beneficiaries.js';
import { pinResetCoolOff } from './pin-reset.js';
import { sanitizeLabel } from './business.js';

// ---------------------------------------------------------------------------
// Small formatting helpers (integer cents in, strings out)
// ---------------------------------------------------------------------------

/** "R2,872.40" (always two decimals). */
export function rands(cents) {
  const c = Math.round(Number(cents) || 0);
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}R${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** "R250" when whole, else "R239.30". */
export function randsShort(cents) {
  const c = Math.round(Number(cents) || 0);
  return c % 100 === 0 ? rands(c).replace(/\.00$/, '') : rands(c);
}

export function supportEmail(env = process.env) {
  const v = String(env.WAPAY_SUPPORT_EMAIL || '').trim();
  return /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(v) ? v : 'help@wapay.co.za';
}

/** The account's own number in its local form, spaced: "083 752 5381". */
export function formatCell(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const local = d.startsWith('27') && d.length === 11 ? `0${d.slice(2)}` : d;
  return local.length === 10 ? `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}` : local;
}

const maskTail = (raw, n = 4) => {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length < 6) return null;
  const local = d.startsWith('27') && d.length === 11 ? `0${d.slice(2)}` : d;
  return `${local.slice(0, 3)}•••${local.slice(-n)}`;
};

export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'W';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

const LANGUAGE_NAMES = Object.freeze({
  en: 'English', af: 'Afrikaans', zu: 'isiZulu', xh: 'isiXhosa', st: 'Sesotho', tn: 'Setswana',
  nso: 'Sepedi', ts: 'Xitsonga', ve: 'Tshivenda', ss: 'siSwati', nr: 'isiNdebele',
});
export function languageName(code) {
  return LANGUAGE_NAMES[String(code || 'en').toLowerCase()] || 'English';
}

// ---------------------------------------------------------------------------
// Copy: the chat's lines, adapted only where they are chat-only
// ---------------------------------------------------------------------------

/**
 * A chat line made fit for a web page. The rule sentences stay word for word;
 * only the chat's own instructions change.
 */
export function webLine(text, env = process.env) {
  let t = String(text || '');
  t = t.replace(/ Reply \*VERIFY\* and I will send you the secure link, or type a smaller amount\./, ' Verify your ID below, or choose a smaller amount.');
  t = t.replace(/ Reply \*VERIFY\* and I'll send you the secure link, or "cancel"\./, ' Verify your ID below to continue.');
  t = t.replace(/ Type a smaller amount, or "cancel"\./, ' Choose a smaller amount.');
  t = t.replace(/ Say "withdraw" to try a smaller amount\./, ' Choose a smaller amount.');
  t = t.replace(/, or "cancel"\./g, '.');
  t = t.replace(/ A person from WaPay will contact you here, and you can reply with any question\./, ` A person from WaPay will contact you. Questions: ${supportEmail(env)}.`);
  t = t.replace(/ If anything is unclear, just ask and I will guide you step by step\./, '');
  t = t.replace(/\*([^*\n]+)\*/g, '$1');
  return t.trim();
}

/** The status banner (founder brief): on until WAPAY_APP_WHATSAPP_PAUSED says off; text overridable. */
export const DEFAULT_BANNER = 'WhatsApp replies are paused by WhatsApp until further notice. Your money is safe and everything here works.';
export function bannerFor(env = process.env) {
  const raw = String(env.WAPAY_APP_WHATSAPP_PAUSED ?? '').trim().toLowerCase();
  const show = !/^(off|false|0|no)$/.test(raw);
  const custom = sanitizeLabel(env.WAPAY_APP_BANNER || '', 240);
  return { show, text: custom || DEFAULT_BANNER };
}

export const PIN_SAFETY_LINE = 'WaPay never asks for your PIN by message.';

// ---------------------------------------------------------------------------
// Coming soon tiles (the capability registry and the launch switches)
// ---------------------------------------------------------------------------

const TILES = Object.freeze([
  { id: 'AIRTIME', label: 'Airtime', icon: 'phone' },
  { id: 'DATA', label: 'Data', icon: 'signal' },
  { id: 'ELECTRICITY', label: 'Electricity', icon: 'bolt' },
  { id: 'FUEL', label: 'Fuel', icon: 'fuel' },
  { id: 'IN_STORE', label: 'In-store', icon: 'store' },
  { id: 'OTT_SELF', label: 'Vouchers', icon: 'ticket' },
]);

/**
 * Each tile is live exactly when the chat would sell it to this customer
 * (lib/capabilities.js, which reads VAS_LIVE_* and the launch hold at call
 * time), so a tile lights up by env, not by deploy. In-store is the card,
 * which does not exist yet. Buying on the web is not in v1: a live tile says
 * where it works.
 */
export function comingSoonTiles({ account } = {}) {
  const ctx = { waId: account?.waId || null, account };
  return TILES.map((t) => {
    const live = t.id === 'IN_STORE' ? !!VIRTUAL_CARD_LIVE : isCapabilityLiveFor(t.id, ctx);
    return { id: t.id, label: t.label, icon: t.icon, live, note: live ? 'In the WaPay chat' : 'Coming soon' };
  });
}

// ---------------------------------------------------------------------------
// Balance and KYC
// ---------------------------------------------------------------------------

export async function balancesOf({ prisma }, accountId) {
  const wallets = await prisma.wallet.findMany({ where: { accountId } });
  const pick = (t, f) => wallets.filter((w) => w.balanceType === t).reduce((s, w) => s + (Number(w[f]) || 0), 0);
  const spendCents = pick(BALANCE.SPEND, 'availableCents');
  const cashCents = pick(BALANCE.CASH, 'availableCents');
  const heldCents = pick(BALANCE.SPEND, 'pendingCents') + pick(BALANCE.CASH, 'pendingCents');
  return { totalCents: spendCents + cashCents, spendCents, cashCents, heldCents };
}

export function kycView(account, { configured = false, env = process.env } = {}) {
  const k = account?.profile?.kyc && typeof account.profile.kyc === 'object' ? account.profile.kyc : {};
  const status = ['VERIFIED', 'PENDING', 'PENDING_REVIEW', 'DECLINED', 'EXPIRED'].includes(k.status) ? k.status : 'NONE';
  const mode = kycMode(env);
  return {
    status,
    verified: status === 'VERIFIED',
    mode,
    configured: !!configured,
    canVerify: !!configured && status !== 'VERIFIED' && status !== 'PENDING_REVIEW',
    // The pill on the balance card: only when a rule can ask for the check.
    nudge: status !== 'VERIFIED' && mode !== 'off' && !!configured,
  };
}

/** The pay-out cool-off after a reset without a second factor (the chat's rule, lib/pin-reset.js). */
export function coolOffOf(account, now = new Date()) {
  const c = pinResetCoolOff({ account, now });
  return c?.until ? { until: new Date(c.until).toISOString(), web: account?.profile?.pinReset?.via === 'app' } : null;
}

// ---------------------------------------------------------------------------
// Activity: journal entries on the customer's wallets + pay-outs not yet booked
// ---------------------------------------------------------------------------

const METHOD_SHORT = Object.freeze({ PAYSHAP: 'PayShap', RTC: 'Bank transfer', CASHSEND: 'Absa cash', NEDCASH: 'Nedbank cash', EWALLET: 'FNB eWallet' });
export const methodShort = (m) => METHOD_SHORT[m] || PAYOUT_METHODS[m]?.label || 'Pay-out';
const SPEND_TITLES = Object.freeze({ AIRTIME: 'Airtime', DATA: 'Data', ELECTRICITY: 'Electricity', FUEL: 'Fuel voucher', RETAIL: 'In-store voucher', VOUCHER: 'Voucher' });
const meta = (x) => (x && typeof x.metadata === 'object' && x.metadata ? x.metadata : {});
const asIso = (d) => { const t = d ? new Date(d) : null; return t && !Number.isNaN(t.getTime()) ? t.toISOString() : null; };

function payoutWhere(m) {
  const r = m.recipient && typeof m.recipient === 'object' ? m.recipient : {};
  return r.account ? `account ${r.account}` : r.mobile ? `cellphone ${r.mobile}` : null;
}

/** One journal entry, as the customer reads it. null when it nets to nothing on their wallets. */
function itemFromEntry(entry, net, ctx) {
  const src = String(entry.source || '');
  const key = String(entry.idemKey || '');
  const m = meta(entry);
  const base = { id: `j:${entry.id}`, at: asIso(entry.createdAt), amountCents: net, direction: net > 0 ? 'in' : 'out', feeCents: 0 };
  if (key.startsWith('wapay-payreq-')) {
    const code = key.slice('wapay-payreq-'.length);
    const label = ctx.linkLabels.get(code) || null;
    const card = src.startsWith('LOAD_');
    if (net > 0) {
      const fee = card ? Number(m.customerFeeCents) || 0 : 0;
      return { ...base, kind: 'LINK_PAID', icon: 'link', title: `Link paid${label ? ` · ${label}` : ''}`, sub: card ? `card${fee ? ` · ${randsShort(fee)} card fee taken off` : ''}` : 'from a WaPay balance', reference: code };
    }
    return { ...base, kind: 'LINK_PAID_OUT', icon: 'link', title: 'Paid a payment link', sub: 'from your balance', reference: code };
  }
  if (src.startsWith('LOAD_')) {
    const voucher = /LOAD_(BLU|OTT|ONEVOUCHER)/.test(src);
    return { ...base, kind: 'TOP_UP', icon: 'plus', title: 'Top-up', sub: voucher ? 'voucher' : 'card or Instant EFT', reference: null };
  }
  if (src === 'P2P_SEND' || src === 'GIFT_HELD') {
    if (net < 0) {
      // A send reads the same for a member and anyone else (membership-neutral).
      const to = src === 'GIFT_HELD' ? m.recipientMasked || null : ctx.sendRecipients.get(key) || null;
      return { ...base, kind: 'SEND', icon: 'send', title: `Sent${to ? ` · ${maskTail(to) || to}` : ''}`, sub: 'free', reference: null };
    }
    return { ...base, kind: 'RECEIVED', icon: 'in', title: 'Money received', sub: 'sent to your number', reference: null };
  }
  if (src === 'GIFT_CLAIM_BALANCE') return { ...base, kind: 'RECEIVED', icon: 'in', title: 'Money received', sub: 'sent to your number before you joined', reference: null };
  if (src === 'GIFT_REFUND') return { ...base, kind: 'REFUND', icon: 'refund', title: 'Refund', sub: `not collected in time${m.recipientMasked ? ` · ${m.recipientMasked}` : ''}`, reference: null };
  if (src.startsWith('CASHOUT_') && !src.startsWith('CASHOUT_COST_')) {
    const method = src.slice('CASHOUT_'.length);
    const pr = ctx.payoutRows.get(key.replace(/-cashout$/, '')) || null;
    const where = pr ? payoutWhere(meta(pr)) : null;
    const amount = Number(m.amountCents) || null;
    const fee = Number(m.feeCents) || 0;
    return {
      ...base,
      amountCents: amount ? -amount : net,
      feeCents: amount ? fee : 0,
      kind: 'PAYOUT', icon: 'bank',
      title: `Pay-out · ${methodShort(method)}`,
      sub: ['paid', where].filter(Boolean).join(' · '),
      reference: pr ? meta(pr).reference || null : null,
    };
  }
  if (src.startsWith('SPEND_')) {
    const cat = src.slice('SPEND_'.length);
    return { ...base, kind: 'SPEND', icon: 'cart', title: SPEND_TITLES[cat] || 'Purchase', sub: 'from your balance', reference: null };
  }
  if (src.startsWith('VOUCHER_GIFT_')) return { ...base, kind: 'VOUCHER', icon: 'ticket', title: 'Voucher', sub: 'from your balance', reference: null };
  if (src === 'REFERRAL_REWARD') return { ...base, kind: 'REWARD', icon: 'gift', title: 'Invite reward', sub: 'thank you for inviting a friend', reference: null };
  return { ...base, kind: 'ADJUSTMENT', icon: 'dot', title: 'Balance correction', sub: 'by WaPay', reference: null };
}

function itemFromPayoutRow(pr) {
  const m = meta(pr);
  const amount = Number(m.amountCents) || 0;
  const fee = Number(m.feeCents) || 0;
  const where = payoutWhere(m);
  const at = asIso(pr.requestTs || pr.createdAt);
  if (pr.status === 'FAILED') {
    return { id: `p:${pr.id}`, at, amountCents: -amount, feeCents: 0, direction: 'out', muted: true, kind: 'PAYOUT_FAILED', icon: 'bank', title: `Pay-out · ${methodShort(m.method)}`, sub: ['did not go through, nothing left your balance', where].filter(Boolean).join(' · '), reference: m.reference || null };
  }
  return { id: `p:${pr.id}`, at, amountCents: -amount, feeCents: fee, direction: 'out', pending: true, kind: 'PAYOUT_PENDING', icon: 'bank', title: `Pay-out · ${methodShort(m.method)}`, sub: ['in progress, held from your balance', where].filter(Boolean).join(' · '), reference: m.reference || null };
}

export const ACTIVITY_PAGE = 50;

/**
 * Everything in and out, newest first, one page of up to 50: the journal
 * entries on this customer's two wallets (an entry that nets to nothing, like
 * the SPEND to CASH step of a pay-out, is left out), plus pay-outs the ledger
 * has not booked yet (in progress) or never will (did not go through).
 * `before` (ISO) pages backwards; the answer carries `nextBefore`.
 */
export async function activityPage({ prisma }, account, { before = null, limit = ACTIVITY_PAGE } = {}) {
  const lim = Math.min(ACTIVITY_PAGE, Math.max(1, Number(limit) || ACTIVITY_PAGE));
  const beforeDate = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : null;
  const codes = [ACCT.wallet(account.id, BALANCE.SPEND), ACCT.wallet(account.id, BALANCE.CASH)];

  // Step 1: the newest entries touching these wallets (ids only), then every line of those entries on them.
  const heads = await prisma.journalLine.findMany({
    where: { accountCode: { in: codes }, ...(beforeDate ? { entry: { createdAt: { lt: beforeDate } } } : {}) },
    include: { entry: true },
    orderBy: { entry: { createdAt: 'desc' } },
    take: lim * 3 + 3,
  });
  const entryIds = [];
  for (const l of heads) if (l.entryId && !entryIds.includes(l.entryId)) entryIds.push(l.entryId);
  const pageIds = entryIds.slice(0, lim + 1);
  const [lines, payoutRows] = await Promise.all([
    pageIds.length ? prisma.journalLine.findMany({ where: { entryId: { in: pageIds }, accountCode: { in: codes } }, include: { entry: true } }) : [],
    prisma.providerRequest.findMany({
      where: { accountId: account.id, route: 'ott-payout', status: { in: ['INIT', 'PENDING', 'FAILED', 'NEEDS_OPERATOR'] }, ...(beforeDate ? { requestTs: { lt: beforeDate } } : {}) },
      orderBy: { requestTs: 'desc' },
      take: lim + 1,
    }),
  ]);
  const byEntry = new Map();
  for (const l of lines) {
    if (!l.entry) continue;
    const cur = byEntry.get(l.entryId) || { entry: l.entry, net: 0 };
    cur.net += (Number(l.creditCents) || 0) - (Number(l.debitCents) || 0);
    byEntry.set(l.entryId, cur);
  }

  // The labels the entries need: link names (APP_LINK_CREATED), send recipients (the preview rows), pay-out destinations.
  const entries = [...byEntry.values()];
  const sendPreviewIds = entries.map((e) => String(e.entry.idemKey || '')).filter((k) => k.startsWith('send-preview-send-')).map((k) => k.slice('send-'.length));
  const payoutKeys = entries.map((e) => String(e.entry.idemKey || '')).filter((k) => /-cashout$/.test(k)).map((k) => k.replace(/-cashout$/, ''));
  const hasLinks = entries.some((e) => String(e.entry.idemKey || '').startsWith('wapay-payreq-'));
  const [previews, paidPayouts, linkRows] = await Promise.all([
    sendPreviewIds.length ? prisma.providerRequest.findMany({ where: { id: { in: sendPreviewIds } } }) : [],
    payoutKeys.length ? prisma.providerRequest.findMany({ where: { idemKey: { in: payoutKeys } } }) : [],
    hasLinks ? prisma.auditLog.findMany({ where: { accountId: account.id, event: 'APP_LINK_CREATED' }, orderBy: { timestamp: 'desc' }, take: 200 }) : [],
  ]);
  const ctx = {
    sendRecipients: new Map(previews.map((p) => [`send-${p.id}`, meta(p).recipientMsisdn || null])),
    payoutRows: new Map(paidPayouts.map((p) => [p.idemKey, p])),
    linkLabels: new Map(linkRows.map((r) => [meta(r).code, meta(r).label || null]).filter(([c]) => c)),
  };

  const items = [];
  for (const { entry, net } of entries) {
    if (!net) continue;
    const it = itemFromEntry(entry, net, ctx);
    if (it) items.push(it);
  }
  for (const pr of payoutRows) items.push(itemFromPayoutRow(pr));
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const hasMore = items.length > lim || entryIds.length > lim || payoutRows.length > lim;
  const page = items.slice(0, lim);
  return { items: page, nextBefore: hasMore && page.length ? page[page.length - 1].at : null };
}

// ---------------------------------------------------------------------------
// Payment links
// ---------------------------------------------------------------------------

/** What a link of this amount pays the requester, both ways (the pay page's own fee). */
export function linkQuote(amountCents) {
  const amount = Number(amountCents);
  if (!Number.isInteger(amount) || amount < MIN_REQUEST_CENTS || amount > MAX_REQUEST_CENTS) {
    return { ok: false, error: 'BAD_AMOUNT', minCents: MIN_REQUEST_CENTS, maxCents: MAX_REQUEST_CENTS };
  }
  const feeCents = paymentRequestFeeCents(amount);
  const gross = grossedUpRequestCents(amount);
  return {
    ok: true,
    amountCents: amount,
    feeCents,
    netCardCents: amount - feeCents,
    netBalanceCents: amount,
    // "Ask R261 to receive R250 by card": offered only when the card fee exists and the ask still fits.
    askForFullCents: feeCents > 0 && gross <= MAX_REQUEST_CENTS ? gross : null,
    ttlDays: REQUEST_TTL_DAYS,
    minCents: MIN_REQUEST_CENTS,
    maxCents: MAX_REQUEST_CENTS,
  };
}

function linkStatus(row, now) {
  const s = String(row.status || '').toUpperCase();
  if (s === 'PAID') return 'PAID';
  if (s === 'CANCELLED') return 'CANCELLED';
  if (s === 'EXPIRED') return 'EXPIRED';
  const exp = row.expiresAt ? new Date(row.expiresAt).getTime() : 0;
  return exp && exp < now ? 'EXPIRED' : 'OPEN';
}

export function linkView(row, label = null, now = Date.now()) {
  const status = linkStatus(row, now);
  const payer = String(row.payerRef || '');
  return {
    code: row.id,
    url: paymentRequestUrl(row.id),
    amountCents: row.amountCents,
    note: row.note || null,
    label: label || null,
    status,
    createdAt: asIso(row.createdAt),
    expiresAt: asIso(row.expiresAt),
    paidAt: asIso(row.paidAt),
    paidBy: status === 'PAID' ? (payer.startsWith('WAPAY:') ? 'WaPay balance' : 'card') : null,
  };
}

/** The customer's own personal links (never a business's), newest first, with the names they gave them. */
export async function linksOf({ prisma }, account, { take = 30, now = Date.now() } = {}) {
  const [rows, labels] = await Promise.all([
    prisma.paymentRequest.findMany({ where: { accountId: account.id, businessId: null }, orderBy: { createdAt: 'desc' }, take: Math.min(100, take) }),
    prisma.auditLog.findMany({ where: { accountId: account.id, event: 'APP_LINK_CREATED' }, orderBy: { timestamp: 'desc' }, take: 200 }),
  ]);
  const byCode = new Map(labels.map((r) => [meta(r).code, meta(r).label || null]).filter(([c]) => c));
  return rows.map((r) => linkView(r, byCode.get(r.id) || null, now));
}

/** The message a requester forwards: the chat's forwardable line, plus their note. */
export function linkShareText({ account, amountCents, url, note = null }) {
  const who = account?.displayName || maskTail(account?.msisdn || account?.waId, 3) || 'A WaPay user';
  const lines = [`🙏 *Pay ${who} now* · ${randsShort(amountCents)} on WaPay`, '', `Tap the link to pay. Free from a WaPay balance, or pay by card:`, url];
  if (note) lines.splice(1, 0, `For: ${note}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Top-up quote
// ---------------------------------------------------------------------------

export function topupQuote(amountCents) {
  const amount = Number(amountCents);
  if (!Number.isInteger(amount) || amount < MIN_DEPOSIT_CENTS || amount > MAX_DEPOSIT_CENTS) {
    return { ok: false, error: 'BAD_AMOUNT', minCents: MIN_DEPOSIT_CENTS, maxCents: MAX_DEPOSIT_CENTS };
  }
  const feeCents = depositFeeCents(amount);
  return { ok: true, amountCents: amount, feeCents, grossCents: amount + feeCents, minCents: MIN_DEPOSIT_CENTS, maxCents: MAX_DEPOSIT_CENTS };
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

export function displayNameOf(account, identity = null) {
  const kycName = account?.profile?.kyc?.fullName || null;
  return String(kycName || identity?.fullName || account?.displayName || '').trim() || null;
}

/** Home: balance, banner, quick actions, the last five, the tiles. */
export async function homeView(deps, account) {
  const [balance, recent] = await Promise.all([
    balancesOf(deps, account.id),
    activityPage(deps, account, { limit: 5 }),
  ]);
  const name = displayNameOf(account);
  return {
    name,
    firstName: name ? name.split(/\s+/)[0] : null,
    initials: initialsOf(name),
    balance,
    banner: bannerFor(),
    kyc: kycView(account, { configured: deps.kycConfigured ? deps.kycConfigured() : false }),
    payoutsOn: deps.payoutAllowedFor ? !!deps.payoutAllowedFor(account.waId) : false,
    recent: recent.items,
    tiles: comingSoonTiles({ account }),
    pinSafety: PIN_SAFETY_LINE,
  };
}

/** Profile: who, KYC, saved pay-out details (labels only), the invite link if one was issued. */
export async function profileView(deps, account) {
  const [destinations, identity] = await Promise.all([
    deps.listPayoutDestinations({ prisma: deps.prisma, accountId: account.id }).catch(() => []),
    deps.getPayoutIdentity({ prisma: deps.prisma, accountId: account.id }).catch(() => null),
  ]);
  const name = displayNameOf(account, identity);
  const code = account?.profile?.referral?.code;
  return {
    name,
    initials: initialsOf(name),
    cell: formatCell(account.msisdn || account.waId),
    memberSince: asIso(account.createdAt),
    language: languageName(account?.profile?.language),
    kyc: kycView(account, { configured: deps.kycConfigured ? deps.kycConfigured() : false }),
    destinations: (destinations || []).map((d) => ({ id: d.id, label: d.label, method: d.method, family: d.family || DESTINATION_FAMILY[d.method] || null, timesUsed: d.timesUsed ?? null, lastUsedAt: asIso(d.lastUsedAt) })),
    identity: identity ? { idType: identity.idType || 'RSAID', idLast3: identity.idLast3 || null, fullName: identity.fullName || null } : null,
    vault: deps.beneficiariesAvailable ? !!deps.beneficiariesAvailable() : false,
    invite: isWellFormedCode(code) ? { code, link: referralLink(code) } : null,
    banner: bannerFor(),
    supportEmail: supportEmail(),
    pinSafety: PIN_SAFETY_LINE,
  };
}

/** The pay-out rule note for this account, in the chat's words, made fit for the web. */
export function payoutRulesNote(account) {
  return webLine(rulesNote({ createdAt: account?.createdAt, verified: account?.profile?.kyc?.status === 'VERIFIED' })) || null;
}

/** The send screen's lines: the fee and the 30-day rule from the registry, as the chat says them. */
export function sendRuleLine() {
  return webLine(capabilityById('SEND')?.feeLine?.() || '');
}
