/**
 * WaPay for Business — the domain logic behind the business portal
 * (founder brief 2026-09-04; design partner: a local laundry that today
 * reconciles every customer's payment links by hand).
 *
 * A business is a WaPay account wearing a hat. Everything it is paid arrives
 * in the OWNER's SPEND wallet through the ordinary payment-request rail
 * (lib/payment-requests.js → pages/pay/[code].js → PayFast ITN or in-chat
 * balance pay). This module therefore NEVER moves money: it names customers,
 * composes links with POS line items, and DERIVES every number the dashboard
 * shows from payment_requests (PAID rows are the truth; totals are never
 * stored, so they can never drift).
 *
 * Cross-user rule (memory: cross-user-actions-need-consent-gate): the default
 * way a link reaches a customer is the BUSINESS'S OWN WhatsApp — we build a
 * wa.me deep link with the message prefilled and the owner taps send. WaPay
 * itself pushes a link only when WAPAY_BUSINESS_NOTIFY=true AND the customer
 * has a VERIFIED relationship with the business (they paid it from their own
 * WaPay account — a typed number at a card checkout is not proof of anything),
 * informational-only, sanitised label, rate-limited.
 *
 * Adversarial review 2026-09-05 (docs/testing/adversarial-review-2026-09-05.md):
 * fees and card/balance method are read from the BOOKED intent, never
 * recomputed from today's env; buckets are SAST; lifetime/outstanding totals
 * use aggregates, never a truncated slice.
 */

import prisma from './prisma.js';
import { normaliseMsisdn, isValidSaMsisdn } from './msisdn.js';
import {
  createPaymentRequest,
  cancelPaymentRequest,
  paymentRequestUrl,
  MIN_REQUEST_CENTS,
  MAX_REQUEST_CENTS,
  MAX_BUSINESS_TTL_DAYS,
  REQUEST_TTL_DAYS,
} from './payment-requests.js';
import { paymentRequestFeeCents, centsToRandString, PAYREQ_FREE_BELOW_CENTS } from './deposits.js';

export const BUSINESS_NAME_MAX = 60;
export const ITEM_NAME_MAX = 60;
export const MAX_ITEMS = 25;
export const MAX_ITEM_QTY = 999;
export const MAX_IMPORT_ROWS = 500;
export const MAX_CUSTOMERS_LISTED = 2000;
export const RECENT_ITEMS_KEPT = 12;
/** Bounded scan for per-row detail (fees, items); totals never depend on it. */
export const MAX_PAID_ROWS_SCANNED = 5000;
export const PROFILE_LINKS_SCANNED = 500;
export const EXPORT_MAX_ROWS = 10000;
export const NUDGES_PER_DAY = Number(process.env.WAPAY_BUSINESS_NUDGES_PER_DAY ?? 20);
/** South Africa is UTC+2 all year (no DST): every bucket the owner sees is SAST. */
export const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

const IMPERSONATION_WORDS = /\b(wapay|wa-pay|payfast|whatsapp|pleasepayme|please\s*pay\s*me|meta|sars|eskom|capitec|fnb|absa|nedbank|standard\s*bank|tymebank|tyme\s*bank|discovery\s*bank|african\s*bank|vodacom|mtn|telkom|cell\s*c|sassa|home\s*affairs|saps|police|government|municipality|city\s*of|shoprite|checkers|pick\s*n\s*pay|spar|takealot|netflix|dstv|multichoice)\b/i;
/** Brands that must not appear even split or spaced ("Wa Pay", "W a P a y"). */
const PLATFORM_BRANDS = /(wapay|payfast|whatsapp|pleasepayme)/i;
/** Cyrillic / fullwidth lookalikes → Latin, so "WaPaу" (Cyrillic у) reads as "wapay". */
const CONFUSABLES = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'к': 'k', 'і': 'i', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ј': 'j', 'ӏ': 'l', 'ո': 'n', 'ԛ': 'q', 'ԝ': 'w', 'ա': 'a', 'ɑ': 'a', '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
/** Customers a business may hold before imports/adds are refused. */
export const MAX_CUSTOMERS_PER_BUSINESS = 5000;

function log(type, data) {
  console.log(JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }));
}

// ---------------------------------------------------------------------------
// Labels & numbers
// ---------------------------------------------------------------------------

/**
 * A label that may be rendered to a THIRD PARTY (pay page, WhatsApp text):
 * strip control chars, zero-width and bidi characters, and WhatsApp/markdown
 * formatting glyphs; collapse whitespace; cap length. Attacker-controlled
 * labels never carry authority.
 */
export function sanitizeLabel(raw, max = BUSINESS_NAME_MAX) {
  return String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g, " ")
    .replace(/[*_~`<>\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Business names may not impersonate WaPay, our rails, banks or the state.
 * Checked on a lookalike-folded copy too (unicode confusables, separators),
 * so "W​aPay", "Wa-Pay" or "W a P a y" fail like "WaPay".
 */
export function validateBusinessName(raw) {
  const name = sanitizeLabel(raw);
  if (name.length < 2) return { ok: false, error: 'NAME_TOO_SHORT' };
  const folded = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split('')
    .map((ch) => CONFUSABLES[ch] || ch)
    .join('')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const squeezed = folded.replace(/\s+/g, '');
  const forbidden = IMPERSONATION_WORDS.test(name) || IMPERSONATION_WORDS.test(folded) || PLATFORM_BRANDS.test(squeezed);
  if (forbidden) return { ok: false, error: 'NAME_NOT_ALLOWED' };
  return { ok: true, name };
}

/** 0XXXXXXXXX or null. */
export function normaliseCustomerMsisdn(raw) {
  if (!isValidSaMsisdn(raw)) return null;
  return normaliseMsisdn(raw);
}

/** 0731234567 → 27731234567 (what wa.me and the Cloud API want). */
export function waIdFor(msisdn0) {
  const d = String(msisdn0 || '').replace(/\D/g, '');
  return d.startsWith('0') ? `27${d.slice(1)}` : d;
}

/** 073•••4567 for lists a third party might see. */
export function maskNumber(msisdn0) {
  const s = String(msisdn0 || '');
  return s.length >= 7 ? `${s.slice(0, 3)}•••${s.slice(-4)}` : s;
}

const rands = (cents) => `R${centsToRandString(cents).replace(/\.00$/, '')}`;

// ---------------------------------------------------------------------------
// Time buckets (SAST)
// ---------------------------------------------------------------------------

const sast = (d) => new Date(new Date(d).getTime() + SAST_OFFSET_MS);

/** Month key 'YYYY-MM' of the instant in SAST. */
export function monthKey(d) {
  const x = sast(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Day key 'YYYY-MM-DD' of the instant in SAST. */
export function dayKey(d) {
  return sast(d).toISOString().slice(0, 10);
}

/** The last N month keys ending this SAST month, oldest first. */
export function lastMonths(n, now = new Date()) {
  const x = sast(now);
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** The UTC instant at which the SAST month `monthsAgo` months back began. */
export function monthStartUtc(monthsAgo, now = new Date()) {
  const x = sast(now);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() - monthsAgo, 1) - SAST_OFFSET_MS);
}

// ---------------------------------------------------------------------------
// Business
// ---------------------------------------------------------------------------

export async function createBusiness({ prisma: prismaClient = prisma, accountId, name, category = null, passwordHash = null }) {
  if (!accountId || typeof accountId !== 'string') throw new Error('accountId is required');
  const v = validateBusinessName(name);
  if (!v.ok) {
    const err = new Error(v.error);
    err.code = v.error;
    throw err;
  }
  const cat = category ? sanitizeLabel(category, 40) : null;
  return prismaClient.business.create({
    data: { accountId, name: v.name, category: cat || null, passwordHash: passwordHash || null, settings: { defaultTtlDays: REQUEST_TTL_DAYS, recentItems: [] } },
  });
}

export async function getBusinessForAccount({ prisma: prismaClient = prisma, accountId }) {
  return prismaClient.business.findUnique({ where: { accountId } });
}

/** The label a third party sees for a request: the business name when it is a business link. */
export async function businessLabelForRequest({ prisma: prismaClient = prisma, request }) {
  if (!request?.businessId) return null;
  try {
    const b = await prismaClient.business.findUnique({ where: { id: request.businessId } });
    return b?.name ? sanitizeLabel(b.name) : null;
  } catch {
    return null;
  }
}

/**
 * The line that reconciles a PAID business ticket in the owner's WhatsApp:
 * "🧾 from Thabo Nkosi · ref T-1042". Shared by both rails (ITN notify and
 * the in-chat balance leg). null for personal links or when nothing is known.
 */
export async function businessPaidLine({ prisma: prismaClient = prisma, request }) {
  if (!request?.businessId) return null;
  try {
    const parts = [];
    if (request.customerId) {
      const c = await prismaClient.businessCustomer.findUnique({ where: { id: request.customerId } });
      if (c) parts.push(`from ${sanitizeLabel(c.name || c.msisdn, 80)}`);
    }
    if (request.reference) parts.push(`ref ${sanitizeLabel(request.reference, 40)}`);
    return parts.length ? `🧾 ${parts.join(' · ')}` : null;
  } catch {
    return null;
  }
}

/**
 * Can this request still be paid, as far as the BUSINESS is concerned?
 * Personal links: always. Business links: only while the business row exists
 * and is ACTIVE. The pay page, checkout, the in-chat confirm AND the in-chat
 * PIN settle all ask this, so suspending a business really does stop its
 * till on every rail (critics 2026-09-05).
 */
export async function businessRequestPayable({ prisma: prismaClient = prisma, request }) {
  if (!request?.businessId) return true;
  try {
    const b = await prismaClient.business.findUnique({ where: { id: request.businessId } });
    return !!b && b.status === 'ACTIVE';
  } catch {
    return false; // fail closed: an unreadable business row never takes money
  }
}

/** Merge into settings (cosmetic data; read-modify-write is acceptable). */
export async function updateBusinessSettings({ prisma: prismaClient = prisma, businessId, patch }) {
  const row = await prismaClient.business.findUnique({ where: { id: businessId } });
  if (!row) throw new Error('business not found');
  const settings = { ...(row.settings && typeof row.settings === 'object' ? row.settings : {}), ...patch };
  return prismaClient.business.update({ where: { id: businessId }, data: { settings } });
}

export async function updateBusinessProfile({ prisma: prismaClient = prisma, businessId, name, category }) {
  const data = {};
  if (name !== undefined) {
    const v = validateBusinessName(name);
    if (!v.ok) {
      const err = new Error(v.error);
      err.code = v.error;
      throw err;
    }
    data.name = v.name;
  }
  if (category !== undefined) data.category = category ? sanitizeLabel(category, 40) || null : null;
  return prismaClient.business.update({ where: { id: businessId }, data });
}

/** Keep the last N distinct items the business sold, for one-tap re-add. */
export function mergeRecentItems(existing, items) {
  const out = [];
  const seen = new Set();
  for (const it of [...items, ...(Array.isArray(existing) ? existing : [])]) {
    const key = String(it?.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    if (!Number.isInteger(it.unitCents) || it.unitCents < 0) continue;
    seen.add(key);
    out.push({ name: it.name, unitCents: it.unitCents });
    if (out.length >= RECENT_ITEMS_KEPT) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

function cleanCustomerFields({ name, email, notes, tags }) {
  const out = {};
  if (name !== undefined) out.name = name ? sanitizeLabel(name, 80) || null : null;
  if (email !== undefined) {
    const e = String(email || '').trim().slice(0, 120);
    out.email = e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
  }
  // eslint-disable-next-line no-control-regex
  if (notes !== undefined) out.notes = notes ? String(notes).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500) || null : null;
  if (tags !== undefined) {
    out.tags = Array.isArray(tags) ? [...new Set(tags.map((t) => sanitizeLabel(t, 24)).filter(Boolean))].slice(0, 10) : [];
  }
  return out;
}

/**
 * Create or update a customer by number. Updates fill in blanks (a name we
 * learn later) but never erase a name already on file with an empty one.
 */
export async function upsertCustomer({ prisma: prismaClient = prisma, businessId, msisdn, name, email, notes, tags, source = 'MANUAL', accountId }) {
  const n = normaliseCustomerMsisdn(msisdn);
  if (!n) {
    const err = new Error('A valid South African cellphone number is required');
    err.code = 'BAD_MSISDN';
    throw err;
  }
  const fields = cleanCustomerFields({ name, email, notes, tags });
  const existing = await prismaClient.businessCustomer.findUnique({ where: { businessId_msisdn: { businessId, msisdn: n } } });
  if (existing) {
    const data = {};
    if (fields.name) data.name = fields.name;
    if (fields.email) data.email = fields.email;
    if (fields.notes !== undefined && fields.notes !== null) data.notes = fields.notes;
    if (fields.tags && fields.tags.length) data.tags = fields.tags;
    if (accountId && !existing.accountId) data.accountId = accountId;
    if (existing.archivedAt) data.archivedAt = null;
    if (!Object.keys(data).length) return { customer: existing, created: false, updated: false };
    const customer = await prismaClient.businessCustomer.update({ where: { id: existing.id }, data });
    return { customer, created: false, updated: true };
  }
  const total = await prismaClient.businessCustomer.count({ where: { businessId } });
  if (total >= MAX_CUSTOMERS_PER_BUSINESS) {
    const err = new Error(`A business may hold at most ${MAX_CUSTOMERS_PER_BUSINESS} customers`);
    err.code = 'CUSTOMER_LIMIT';
    throw err;
  }
  const data = {
    businessId,
    msisdn: n,
    name: fields.name ?? null,
    email: fields.email ?? null,
    notes: fields.notes ?? null,
    tags: fields.tags ?? [],
    source: ['MANUAL', 'IMPORT', 'PAYLINK'].includes(source) ? source : 'MANUAL',
    accountId: accountId || null,
  };
  try {
    const customer = await prismaClient.businessCustomer.create({ data });
    return { customer, created: true, updated: false };
  } catch (err) {
    // Two callers raced on the same number (two tabs, the linker running
    // twice): the loser adopts the winner's row instead of failing.
    if (err?.code !== 'P2002') throw err;
    const winner = await prismaClient.businessCustomer.findUnique({ where: { businessId_msisdn: { businessId, msisdn: n } } });
    if (!winner) throw err;
    return { customer: winner, created: false, updated: false };
  }
}

export async function updateCustomer({ prisma: prismaClient = prisma, businessId, customerId, name, email, notes, tags }) {
  const existing = await prismaClient.businessCustomer.findUnique({ where: { id: customerId } });
  if (!existing || existing.businessId !== businessId) return null; // scoped: never another business's customer
  const data = cleanCustomerFields({ name, email, notes, tags });
  return prismaClient.businessCustomer.update({ where: { id: customerId }, data });
}

export async function archiveCustomer({ prisma: prismaClient = prisma, businessId, customerId, restore = false }) {
  const existing = await prismaClient.businessCustomer.findUnique({ where: { id: customerId } });
  if (!existing || existing.businessId !== businessId) return null;
  return prismaClient.businessCustomer.update({ where: { id: customerId }, data: { archivedAt: restore ? null : new Date() } });
}

/**
 * Parse a pasted contact list. Accepts, mixed, per line:
 *   "Thabo Nkosi, 073 123 4567"   (CSV / TSV / semicolon; either order)
 *   "0731234567"                   (bare number)
 *   "Sipho 076 222 3333"           (no delimiter)
 *   vCard blocks (FN: / N: and TEL: lines, as exported from a phone)
 * Header rows ("name,phone") are skipped; duplicates collapse to one row
 * (first name wins); at most MAX_IMPORT_ROWS rows are returned.
 */
export function parseContactsImport(text) {
  const src = String(text || '');
  const rows = new Map();
  const add = (msisdn, name) => {
    const n = normaliseCustomerMsisdn(msisdn);
    if (!n || rows.size >= MAX_IMPORT_ROWS) return;
    const cleanName = name ? sanitizeLabel(name, 80) : '';
    if (!rows.has(n)) rows.set(n, { msisdn: n, name: cleanName || null });
    else if (!rows.get(n).name && cleanName) rows.get(n).name = cleanName;
  };

  // vCard blocks first (a phone export), then whatever else was pasted
  // around them as plain lines — a mixed paste loses nothing.
  const VCARD = /BEGIN:VCARD[\s\S]*?END:VCARD/gi;
  for (const card of src.match(VCARD) || []) {
    const fn = card.match(/^FN[^:]*:(.+)$/im)?.[1]?.trim();
    const nField = card.match(/^N[^:]*:(.+)$/im)?.[1];
    const nName = nField ? nField.split(';').filter(Boolean).reverse().join(' ').trim() : '';
    const tels = [...card.matchAll(/^TEL[^:]*:(.+)$/gim)].map((m) => m[1]);
    for (const tel of tels) add(tel, fn || nName);
  }
  const rest = src.replace(VCARD, '');

  for (const rawLine of rest.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(name|full ?name|customer)\s*[,;\t]\s*(phone|number|cell|mobile|msisdn|tel)/i.test(line)) continue;
    if (/^(phone|number|cell|mobile|msisdn|tel)\s*[,;\t]\s*(name|customer)/i.test(line)) continue;
    const parts = line.split(/[,;\t]/).map((p) => p.trim().replace(/^"|"$/g, ''));
    let number = null;
    const names = [];
    for (const p of parts) {
      // Only a number-SHAPED part is the number: "Sipho 076 222 3333" carries
      // ten digits but is a name + number, handled by the fallback below.
      if (!number && /^[\s+()\d-]+$/.test(p) && normaliseCustomerMsisdn(p)) number = p;
      else if (p) names.push(p);
    }
    if (!number) {
      const m = line.match(/(\+?27|0)[\s-]?\d[\d\s-]{7,12}\d/);
      if (m && normaliseCustomerMsisdn(m[0])) {
        number = m[0];
        const restOfLine = line.replace(m[0], '').replace(/[,;]/g, ' ').trim();
        names.length = 0; // the un-split line itself is not a name
        if (restOfLine) names.push(restOfLine);
      }
    }
    if (number) add(number, names.join(' ').trim());
  }
  return [...rows.values()];
}

/**
 * Bulk import: ONE read for the numbers already on file, ONE createMany for
 * the new ones (skipDuplicates absorbs a race), and per-row updates only for
 * existing customers that gain a name — a 500-row paste is a handful of
 * round trips, not a thousand (review 2026-09-05).
 */
export async function importCustomers({ prisma: prismaClient = prisma, businessId, rows }) {
  const out = { added: 0, updated: 0, skipped: 0, refused: 0 };
  const clean = [];
  const seen = new Set();
  for (const r of (rows || []).slice(0, MAX_IMPORT_ROWS)) {
    const n = normaliseCustomerMsisdn(r?.msisdn);
    if (!n || seen.has(n)) { out.skipped += 1; continue; }
    seen.add(n);
    clean.push({ msisdn: n, name: r?.name ? sanitizeLabel(r.name, 80) || null : null });
  }
  if (!clean.length) return out;
  const existing = await prismaClient.businessCustomer.findMany({ where: { businessId, msisdn: { in: clean.map((c) => c.msisdn) } } });
  const byMsisdn = new Map(existing.map((e) => [e.msisdn, e]));
  const fresh = clean.filter((c) => !byMsisdn.has(c.msisdn));
  const total = await prismaClient.businessCustomer.count({ where: { businessId } });
  const room = Math.max(0, MAX_CUSTOMERS_PER_BUSINESS - total);
  const toCreate = fresh.slice(0, room);
  out.refused = fresh.length - toCreate.length;
  if (toCreate.length) {
    const created = await prismaClient.businessCustomer.createMany({
      data: toCreate.map((c) => ({ businessId, msisdn: c.msisdn, name: c.name, tags: [], source: 'IMPORT' })),
      skipDuplicates: true,
    });
    out.added = Number(created?.count ?? toCreate.length);
    out.skipped += toCreate.length - out.added;
  }
  for (const c of clean) {
    const e = byMsisdn.get(c.msisdn);
    if (!e) continue;
    const data = {};
    if (c.name && !e.name) data.name = c.name;
    if (e.archivedAt) data.archivedAt = null;
    if (!Object.keys(data).length) { out.skipped += 1; continue; }
    // eslint-disable-next-line no-await-in-loop
    await prismaClient.businessCustomer.update({ where: { id: e.id }, data }).catch(() => {});
    out.updated += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Paid-row classification: the BOOKED truth, never today's env
// ---------------------------------------------------------------------------

/**
 * The PayFast intents for a set of request codes, keyed by code. One query.
 * An intent exists only for card checkouts; its metadata carries the fee that
 * was actually deducted at the time (the credit posted = face - feeCents).
 */
export async function loadIntents(prismaClient, codes) {
  const ids = [...new Set((codes || []).filter(Boolean).map((c) => `wapay-payreq-${String(c).toUpperCase()}`))];
  if (!ids.length) return new Map();
  const rows = await prismaClient.providerRequest.findMany({
    where: { idemKey: { in: ids } },
    select: { idemKey: true, status: true, providerRef: true, metadata: true },
  });
  return new Map(rows.map((r) => [r.idemKey.slice('wapay-payreq-'.length), r]));
}

/**
 * How a PAID request was settled and what it cost the business.
 * CARD: payerRef PAYFAST:* OR a successful intent exists (covers the
 * 'REPAIR:replayed' rows where the balance leg lost to a card credit).
 * Fee = the intent's booked feeCents when present; the current banded fee
 * only for legacy rows without it. Balance payments cost nothing.
 */
export function classifyPaid(r, intent) {
  if (r.status !== 'PAID') return { method: null, feeCents: 0 };
  const ref = String(r.payerRef || '');
  const cardSettled = ref.startsWith('PAYFAST:') || !!(intent && (intent.status === 'SUCCESS' || intent.providerRef));
  if (cardSettled) {
    const booked = intent?.metadata?.feeCents;
    return { method: 'CARD', feeCents: Number.isInteger(booked) ? booked : paymentRequestFeeCents(r.amountCents) };
  }
  if (ref.startsWith('WAPAY:')) return { method: 'WAPAY', feeCents: 0 };
  return { method: 'OTHER', feeCents: 0 };
}

function serialiseLink(r, customerName = null, intent = null) {
  const { method, feeCents } = classifyPaid(r, intent);
  return {
    code: r.id,
    amountCents: r.amountCents,
    feeCents,
    netCents: r.amountCents - feeCents,
    status: r.status === 'PENDING' && r.expiresAt < new Date() ? 'EXPIRED' : r.status,
    method,
    items: Array.isArray(r.items) ? r.items : [],
    reference: r.reference || null,
    note: r.note || null,
    customerId: r.customerId || null,
    customerName,
    channel: r.channel || null,
    sentAt: r.sentAt || null,
    createdAt: r.createdAt,
    paidAt: r.paidAt || null,
    expiresAt: r.expiresAt,
    url: paymentRequestUrl(r.id),
  };
}

/** Aggregate a business's payment_requests per customer (JS, over a bounded scan). */
function statsByCustomer(requests, now = new Date()) {
  const map = new Map();
  for (const r of requests) {
    if (!r.customerId) continue;
    if (!map.has(r.customerId)) map.set(r.customerId, { paidCents: 0, paidCount: 0, lastPaidAt: null, openCents: 0, openCount: 0, firstPaidAt: null });
    const s = map.get(r.customerId);
    if (r.status === 'PAID') {
      s.paidCents += r.amountCents;
      s.paidCount += 1;
      if (!s.lastPaidAt || (r.paidAt && r.paidAt > s.lastPaidAt)) s.lastPaidAt = r.paidAt;
      if (!s.firstPaidAt || (r.paidAt && r.paidAt < s.firstPaidAt)) s.firstPaidAt = r.paidAt;
    } else if (r.status === 'PENDING' && r.expiresAt > now) {
      s.openCents += r.amountCents;
      s.openCount += 1;
    }
  }
  return map;
}

/**
 * Customers + derived money stats. Search matches name or digits; sort by
 * 'recent' (default), 'spend', 'name', 'outstanding'.
 */
export async function listCustomersWithStats({ prisma: prismaClient = prisma, businessId, q = '', sort = 'recent', includeArchived = false }) {
  const digits = String(q || '').replace(/\D/g, '');
  const text = String(q || '').trim();
  const where = { businessId, ...(includeArchived ? {} : { archivedAt: null }) };
  if (text) {
    where.OR = [
      ...(digits.length >= 3 ? [{ msisdn: { contains: digits } }] : []),
      { name: { contains: text, mode: 'insensitive' } },
    ];
  }
  const [customers, requests] = await Promise.all([
    prismaClient.businessCustomer.findMany({ where, orderBy: { createdAt: 'desc' }, take: MAX_CUSTOMERS_LISTED }),
    prismaClient.paymentRequest.findMany({
      where: { businessId },
      select: { customerId: true, status: true, amountCents: true, paidAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_PAID_ROWS_SCANNED,
    }),
  ]);
  const stats = statsByCustomer(requests);
  const rows = customers.map((c) => {
    const s = stats.get(c.id) || { paidCents: 0, paidCount: 0, lastPaidAt: null, openCents: 0, openCount: 0 };
    return {
      id: c.id,
      name: c.name,
      msisdn: c.msisdn,
      email: c.email,
      tags: Array.isArray(c.tags) ? c.tags : [],
      source: c.source,
      createdAt: c.createdAt,
      archivedAt: c.archivedAt,
      isWaPayUser: !!c.accountId,
      paidCents: s.paidCents,
      paidCount: s.paidCount,
      avgCents: s.paidCount ? Math.round(s.paidCents / s.paidCount) : null,
      lastPaidAt: s.lastPaidAt || c.lastPaidAt || null,
      openCents: s.openCents,
      openCount: s.openCount,
    };
  });
  const by = {
    spend: (a, b) => b.paidCents - a.paidCents || b.paidCount - a.paidCount,
    name: (a, b) => String(a.name || 'zz').localeCompare(String(b.name || 'zz')),
    outstanding: (a, b) => b.openCents - a.openCents,
    recent: (a, b) => (new Date(b.lastPaidAt || b.createdAt) - new Date(a.lastPaidAt || a.createdAt)),
  };
  rows.sort(by[sort] || by.recent);
  return { total: rows.length, customers: rows, truncated: requests.length >= MAX_PAID_ROWS_SCANNED };
}

const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v || 0));

export async function getCustomerProfile({ prisma: prismaClient = prisma, businessId, customerId }) {
  const customer = await prismaClient.businessCustomer.findUnique({ where: { id: customerId } });
  if (!customer || customer.businessId !== businessId) return null;
  const now = new Date();
  // Lifetime and outstanding totals come from AGGREGATES over every row; the
  // bounded scan below only feeds the per-link detail, items and series.
  const [lifetime, open, requests] = await Promise.all([
    prismaClient.paymentRequest.aggregate({
      where: { businessId, customerId, status: 'PAID' },
      _sum: { amountCents: true },
      _count: { _all: true },
      _min: { paidAt: true },
      _max: { paidAt: true },
    }),
    prismaClient.paymentRequest.aggregate({
      where: { businessId, customerId, status: 'PENDING', expiresAt: { gt: now } },
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    prismaClient.paymentRequest.findMany({ where: { businessId, customerId }, orderBy: { createdAt: 'desc' }, take: PROFILE_LINKS_SCANNED }),
  ]);
  const paid = requests.filter((r) => r.status === 'PAID');
  const intents = await loadIntents(prismaClient, paid.map((r) => r.id));
  const months = lastMonths(12, now);
  const monthly = new Map(months.map((m) => [m, { cents: 0, n: 0 }]));
  const itemTotals = new Map();
  let feeCents = 0;
  for (const r of paid) {
    const mk = monthKey(r.paidAt || r.createdAt);
    if (monthly.has(mk)) { monthly.get(mk).cents += r.amountCents; monthly.get(mk).n += 1; }
    feeCents += classifyPaid(r, intents.get(r.id)).feeCents;
    for (const it of Array.isArray(r.items) ? r.items : []) {
      const key = String(it.name || '').toLowerCase();
      if (!key) continue;
      if (!itemTotals.has(key)) itemTotals.set(key, { name: it.name, qty: 0, cents: 0 });
      itemTotals.get(key).qty += Number(it.qty) || 0;
      itemTotals.get(key).cents += (Number(it.qty) || 0) * (Number(it.unitCents) || 0);
    }
  }
  const paidCents = num(lifetime?._sum?.amountCents);
  const paidCount = num(lifetime?._count?._all ?? lifetime?._count);
  const truncated = requests.length >= PROFILE_LINKS_SCANNED;
  return {
    customer: {
      id: customer.id,
      name: customer.name,
      msisdn: customer.msisdn,
      email: customer.email,
      notes: customer.notes,
      tags: Array.isArray(customer.tags) ? customer.tags : [],
      source: customer.source,
      isWaPayUser: !!customer.accountId,
      createdAt: customer.createdAt,
      archivedAt: customer.archivedAt,
    },
    stats: {
      paidCents,
      paidCount,
      avgCents: paidCount ? Math.round(paidCents / paidCount) : null,
      // Fees are summed over the scanned rows; when truncated they are a lower
      // bound and the flag says so.
      feeCents,
      netCents: paidCents - feeCents,
      feesTruncated: truncated,
      firstPaidAt: lifetime?._min?.paidAt || null,
      lastPaidAt: lifetime?._max?.paidAt || null,
      openCents: num(open?._sum?.amountCents),
      openCount: num(open?._count?._all ?? open?._count),
    },
    monthly: months.map((m) => ({ month: m, ...monthly.get(m) })),
    topItems: [...itemTotals.values()].sort((a, b) => b.cents - a.cents).slice(0, 8),
    links: requests.map((r) => serialiseLink(r, customer.name, intents.get(r.id))),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Links (the POS composer)
// ---------------------------------------------------------------------------

/** Validate POS line items; returns { items, totalCents }. */
export function validateItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { items: [], totalCents: 0 };
  if (raw.length > MAX_ITEMS) throw Object.assign(new Error(`At most ${MAX_ITEMS} items`), { code: 'TOO_MANY_ITEMS' });
  const items = [];
  let totalCents = 0;
  for (const it of raw) {
    const name = sanitizeLabel(it?.name, ITEM_NAME_MAX);
    const qty = Number(it?.qty ?? 1);
    const unitCents = Number(it?.unitCents);
    if (!name) throw Object.assign(new Error('Every item needs a name'), { code: 'BAD_ITEM' });
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_ITEM_QTY) throw Object.assign(new Error(`Quantity must be 1-${MAX_ITEM_QTY}`), { code: 'BAD_ITEM' });
    if (!Number.isInteger(unitCents) || unitCents < 0 || unitCents > MAX_REQUEST_CENTS) throw Object.assign(new Error('Price must be whole cents'), { code: 'BAD_ITEM' });
    items.push({ name, qty, unitCents });
    totalCents += qty * unitCents;
  }
  return { items, totalCents };
}

/** What the business nets, both ways. Same fee function as every pay link. */
export function quoteLink(amountCents) {
  const feeCents = paymentRequestFeeCents(amountCents);
  return { amountCents, feeCents, netCardCents: amountCents - feeCents, netBalanceCents: amountCents, freeBelowCents: PAYREQ_FREE_BELOW_CENTS };
}

/**
 * The WhatsApp message the OWNER sends from their own business WhatsApp.
 * Plain text, no formatting glyphs (the wa.me prefill renders them raw), no
 * em dashes (founder style rule), never more than ~700 chars.
 */
export const MESSAGE_MAX = 700;
export function composeLinkMessage({ businessName, customerName, amountCents, items = [], reference, note, url }) {
  const who = customerName ? `Hi ${sanitizeLabel(customerName.split(' ')[0], 30)} 👋` : 'Hi 👋';
  const head = [`${who} ${sanitizeLabel(businessName)} here.`, `Please pay ${rands(amountCents)}${reference ? ` for ref ${sanitizeLabel(reference, 40)}` : ''}.`];
  // The link and the no-fee line are mandatory: build them first, then fit
  // the optional detail into what is left, so the URL is never cut.
  const tail = [`Pay here: ${url}`, 'No fees for you: pay from a WaPay balance or by card. Thank you!'];
  let budget = MESSAGE_MAX - (head.join('\n').length + tail.join('\n').length + 2);
  const optional = [];
  if (items.length) {
    const shown = [];
    for (const it of items.slice(0, 6)) {
      const line = `• ${sanitizeLabel(it.name, 30)}${it.qty > 1 ? ` x${it.qty}` : ''} ${rands(it.qty * it.unitCents)}`;
      if (line.length + 1 > budget) break;
      shown.push(line);
      budget -= line.length + 1;
    }
    const hidden = items.length - shown.length;
    if (hidden > 0 && budget > 20) { shown.push(`• and ${hidden} more`); budget -= 20; }
    if (shown.length) optional.push(shown.join('\n'));
  }
  if (note) {
    const n = sanitizeLabel(note, Math.max(0, Math.min(120, budget - 1)));
    if (n) optional.push(n);
  }
  return [...head, ...optional, ...tail].join('\n');
}

/** https://wa.me/27…?text=… — opens the owner's OWN WhatsApp with the text prefilled. */
export function waDeepLink({ msisdn, text }) {
  const waId = waIdFor(msisdn);
  if (!/^27\d{9}$/.test(waId)) throw new Error('waDeepLink needs a valid SA number');
  return `https://wa.me/${waId}?text=${encodeURIComponent(text)}`;
}

/**
 * Create a business payment link. amountCents may be given explicitly (a
 * quick "please pay R150") or derived from the items; when both are given
 * they must agree (the quote is binding).
 */
export async function createBusinessLink({ prisma: prismaClient = prisma, business, customerId = null, items: rawItems, amountCents: rawAmount, reference, note, ttlDays }) {
  const { items, totalCents } = validateItems(rawItems);
  let amountCents = Number.isInteger(rawAmount) ? rawAmount : totalCents;
  if (items.length && Number.isInteger(rawAmount) && rawAmount !== totalCents) {
    throw Object.assign(new Error('Amount does not match the items'), { code: 'AMOUNT_MISMATCH' });
  }
  if (!Number.isInteger(amountCents) || amountCents < MIN_REQUEST_CENTS || amountCents > MAX_REQUEST_CENTS) {
    throw Object.assign(new Error(`Total must be between ${rands(MIN_REQUEST_CENTS)} and ${rands(MAX_REQUEST_CENTS)}`), { code: 'BAD_AMOUNT' });
  }
  let customer = null;
  if (customerId) {
    customer = await prismaClient.businessCustomer.findUnique({ where: { id: customerId } });
    if (!customer || customer.businessId !== business.id) throw Object.assign(new Error('Unknown customer'), { code: 'BAD_CUSTOMER' });
  }
  const settings = business.settings && typeof business.settings === 'object' ? business.settings : {};
  const ttl = Number.isInteger(ttlDays) ? ttlDays : Number.isInteger(settings.defaultTtlDays) ? settings.defaultTtlDays : REQUEST_TTL_DAYS;
  const request = await createPaymentRequest({
    prisma: prismaClient,
    accountId: business.accountId,
    amountCents,
    note,
    business: { businessId: business.id, customerId: customer?.id || null, items, reference: sanitizeLabel(reference, 40) || null, ttlDays: Math.min(Math.max(1, ttl), MAX_BUSINESS_TTL_DAYS) },
  });
  if (items.length) {
    // Awaited: a fire-and-forget write after the response is frozen on Vercel.
    await updateBusinessSettings({ prisma: prismaClient, businessId: business.id, patch: { recentItems: mergeRecentItems(settings.recentItems, items) } }).catch(() => {});
  }
  const url = paymentRequestUrl(request.id);
  const message = composeLinkMessage({ businessName: business.name, customerName: customer?.name, amountCents, items, reference: request.reference, note: request.note, url });
  log('business_link_created', { businessId: business.id, code: request.id, amountCents, items: items.length, hasCustomer: !!customer });
  return {
    link: serialiseLink(request, customer?.name || null),
    quote: quoteLink(amountCents),
    message,
    waLink: customer ? waDeepLink({ msisdn: customer.msisdn, text: message }) : null,
  };
}

/**
 * Record how a link went out. A WaPay-originated send (channel WAPAY) is
 * never downgraded by a later copy/WhatsApp click: the nudge's once-per-link
 * guard and daily rate limit read that column.
 */
export async function markLinkSent({ prisma: prismaClient = prisma, businessId, code, channel }) {
  // Only the two OWNER-side channels can be recorded here; 'WAPAY' is claimed
  // atomically inside sendLinkViaWaPay and can never arrive from a browser.
  const ch = channel === 'WHATSAPP_BUSINESS' ? 'WHATSAPP_BUSINESS' : 'COPY';
  const updated = await prismaClient.paymentRequest.updateMany({
    where: { id: String(code || '').toUpperCase(), businessId, NOT: { channel: 'WAPAY' } },
    data: { channel: ch, sentAt: new Date() },
  });
  return updated.count === 1;
}

export async function cancelBusinessLink({ prisma: prismaClient = prisma, business, code }) {
  const row = await prismaClient.paymentRequest.findUnique({ where: { id: String(code || '').toUpperCase() } });
  if (!row || row.businessId !== business.id) return false; // scoped to this business
  return cancelPaymentRequest({ prisma: prismaClient, code: row.id, accountId: business.accountId });
}

export async function listBusinessLinks({ prisma: prismaClient = prisma, businessId, status = 'all', customerId = null, limit = 100, offset = 0 }) {
  const where = { businessId, ...(customerId ? { customerId } : {}) };
  const now = new Date();
  if (status === 'open') Object.assign(where, { status: 'PENDING', expiresAt: { gt: now } });
  else if (status === 'paid') where.status = 'PAID';
  else if (status === 'closed') where.OR = [{ status: 'CANCELLED' }, { status: 'EXPIRED' }, { status: 'PENDING', expiresAt: { lte: now } }];
  const take = Math.min(500, Math.max(1, Number(limit) || 100));
  const [total, rows] = await Promise.all([
    prismaClient.paymentRequest.count({ where }),
    prismaClient.paymentRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip: Math.max(0, Number(offset) || 0), take }),
  ]);
  const ids = [...new Set(rows.map((r) => r.customerId).filter(Boolean))];
  const names = new Map();
  if (ids.length) {
    const cs = await prismaClient.businessCustomer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, msisdn: true } });
    for (const c of cs) names.set(c.id, c.name || maskNumber(c.msisdn));
  }
  const intents = await loadIntents(prismaClient, rows.filter((r) => r.status === 'PAID').map((r) => r.id));
  return { total, links: rows.map((r) => serialiseLink(r, r.customerId ? names.get(r.customerId) || null : null, intents.get(r.id))) };
}

// ---------------------------------------------------------------------------
// Walk-in payers → customers (lazy, idempotent, covers both rails)
// ---------------------------------------------------------------------------

/**
 * A PAID business link with no customer (a walk-in / QR link) still tells us
 * who paid: card payers left their number at checkout (intent metadata
 * payerMsisdn, signed via custom_str1), balance payers are a WaPay account
 * (payerRef WAPAY:<id>). Turn them into customers and link the request, so
 * "who joined the business" is complete without a processor change.
 * Best effort, never throws. A card payer's typed number is a CONTACT, not a
 * verified identity: accountId stays null for them (see the nudge gate).
 */
export async function linkWalkInPayers({ prisma: prismaClient = prisma, businessId }) {
  const out = { linked: 0 };
  try {
    const orphans = await prismaClient.paymentRequest.findMany({
      where: { businessId, status: 'PAID', customerId: null },
      orderBy: { paidAt: 'desc' },
      take: 50,
    });
    for (const r of orphans) {
      let msisdn = null;
      let accountId = null;
      const ref = String(r.payerRef || '');
      if (ref.startsWith('WAPAY:')) {
        accountId = ref.slice('WAPAY:'.length);
        // eslint-disable-next-line no-await-in-loop
        const acc = await prismaClient.account.findUnique({ where: { id: accountId } }).catch(() => null);
        msisdn = acc ? normaliseCustomerMsisdn(acc.msisdn || acc.waId) : null;
        if (!acc) accountId = null;
      } else if (ref.startsWith('PAYFAST:')) {
        // eslint-disable-next-line no-await-in-loop
        const intent = await prismaClient.providerRequest.findUnique({ where: { idemKey: `wapay-payreq-${r.id}` } }).catch(() => null);
        msisdn = normaliseCustomerMsisdn(intent?.metadata?.payerMsisdn || '');
      }
      if (!msisdn) continue;
      // eslint-disable-next-line no-await-in-loop
      const { customer } = await upsertCustomer({ prisma: prismaClient, businessId, msisdn, source: 'PAYLINK', accountId });
      // eslint-disable-next-line no-await-in-loop
      await prismaClient.paymentRequest.updateMany({ where: { id: r.id, customerId: null }, data: { customerId: customer.id } });
      // eslint-disable-next-line no-await-in-loop
      await prismaClient.businessCustomer.update({ where: { id: customer.id }, data: { lastPaidAt: r.paidAt || new Date() } }).catch(() => {});
      out.linked += 1;
    }
  } catch (error) {
    log('business_link_walkins_error', { businessId, error: error?.message });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The business dashboard
// ---------------------------------------------------------------------------

/**
 * One payload for the Overview tab. Everything derives from payment_requests
 * (PAID = revenue; PENDING & unexpired = outstanding). Card fees come from
 * the booked intents, per row, so "net received" is what actually landed.
 */
export async function businessOverview({ prisma: prismaClient = prisma, businessId, rangeDays = 30 }) {
  const now = new Date();
  const since = new Date(now.getTime() - rangeDays * 24 * 3600 * 1000);
  const prevSince = new Date(since.getTime() - rangeDays * 24 * 3600 * 1000);
  const twelveMonthsAgo = monthStartUtc(11, now);
  const scanSince = new Date(Math.min(twelveMonthsAgo.getTime(), prevSince.getTime()));

  const [paidRows, openAgg, openRows, cancelled, expired, createdInPeriod, paidOfCreatedInPeriod, customersTotal, customersNew] = await Promise.all([
    prismaClient.paymentRequest.findMany({
      where: { businessId, status: 'PAID', paidAt: { gte: scanSince } },
      // `status` must travel with the row: classifyPaid reads it (the real DB
      // caught a missing select here on 2026-09-05; the stub now honours select).
      select: { id: true, status: true, amountCents: true, payerRef: true, paidAt: true, customerId: true, reference: true, items: true, createdAt: true },
      orderBy: { paidAt: 'desc' },
      take: MAX_PAID_ROWS_SCANNED,
    }),
    prismaClient.paymentRequest.aggregate({
      where: { businessId, status: 'PENDING', expiresAt: { gt: now } },
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    prismaClient.paymentRequest.findMany({
      where: { businessId, status: 'PENDING', expiresAt: { gt: now } },
      select: { id: true, amountCents: true, customerId: true, reference: true, createdAt: true, expiresAt: true, sentAt: true },
      orderBy: { createdAt: 'desc' },
      take: 12,
    }),
    prismaClient.paymentRequest.count({ where: { businessId, status: 'CANCELLED', createdAt: { gt: since } } }),
    prismaClient.paymentRequest.count({ where: { businessId, OR: [{ status: 'EXPIRED' }, { status: 'PENDING', expiresAt: { lte: now } }], createdAt: { gt: since } } }),
    prismaClient.paymentRequest.count({ where: { businessId, createdAt: { gt: since } } }),
    // Conversion compares like with like: links CREATED in the period that got paid.
    prismaClient.paymentRequest.count({ where: { businessId, status: 'PAID', createdAt: { gt: since } } }),
    prismaClient.businessCustomer.count({ where: { businessId, archivedAt: null } }),
    prismaClient.businessCustomer.count({ where: { businessId, archivedAt: null, createdAt: { gt: since } } }),
    null,
  ]);
  // Names only for the customers the payload actually mentions (bounded).
  const referenced = [...new Set([...paidRows, ...openRows].map((r) => r.customerId).filter(Boolean))];
  const customerRows = referenced.length
    ? await prismaClient.businessCustomer.findMany({ where: { id: { in: referenced } }, select: { id: true, name: true, msisdn: true } })
    : [];
  const names = new Map(customerRows.map((c) => [c.id, c.name || maskNumber(c.msisdn)]));
  const intents = await loadIntents(prismaClient, paidRows.map((r) => r.id));

  const period = { paidCents: 0, paidCount: 0, feeCents: 0, cardCents: 0, cardCount: 0, balanceCents: 0, balanceCount: 0 };
  const prior = { paidCents: 0, paidCount: 0 };
  const months = lastMonths(12, now);
  const monthly = new Map(months.map((m) => [m, { cents: 0, n: 0, feeCents: 0 }]));
  const byCustomer = new Map();
  const daily = new Map();
  const method = new Map();
  for (const r of paidRows) {
    const at = r.paidAt || r.createdAt;
    const c = classifyPaid(r, intents.get(r.id));
    method.set(r.id, c.method);
    const mk = monthKey(at);
    if (monthly.has(mk)) { const m = monthly.get(mk); m.cents += r.amountCents; m.n += 1; m.feeCents += c.feeCents; }
    if (at >= since) {
      period.paidCents += r.amountCents; period.paidCount += 1; period.feeCents += c.feeCents;
      if (c.method === 'CARD') { period.cardCents += r.amountCents; period.cardCount += 1; } else { period.balanceCents += r.amountCents; period.balanceCount += 1; }
      const dk = dayKey(at);
      daily.set(dk, (daily.get(dk) || 0) + r.amountCents);
      if (r.customerId) {
        if (!byCustomer.has(r.customerId)) byCustomer.set(r.customerId, { customerId: r.customerId, name: names.get(r.customerId) || 'Walk-in', cents: 0, n: 0 });
        byCustomer.get(r.customerId).cents += r.amountCents; byCustomer.get(r.customerId).n += 1;
      }
    } else if (at >= prevSince) {
      prior.paidCents += r.amountCents; prior.paidCount += 1;
    }
  }
  const sumMonths = (n) => months.slice(-n).reduce((acc, m) => acc + monthly.get(m).cents, 0);
  const outstandingCents = num(openAgg?._sum?.amountCents);
  const outstandingCount = num(openAgg?._count?._all ?? openAgg?._count);

  return {
    generatedAt: now.toISOString(),
    rangeDays,
    truncated: paidRows.length >= MAX_PAID_ROWS_SCANNED,
    freeBelowCents: PAYREQ_FREE_BELOW_CENTS,
    vitals: {
      paidCents: period.paidCents,
      paidCount: period.paidCount,
      priorPaidCents: prior.paidCents,
      deltaPct: prior.paidCents > 0 ? Math.round((1000 * (period.paidCents - prior.paidCents)) / prior.paidCents) / 10 : null,
      feeCents: period.feeCents,
      netCents: period.paidCents - period.feeCents,
      avgTicketCents: period.paidCount ? Math.round(period.paidCents / period.paidCount) : null,
      outstandingCents,
      outstandingCount,
      customers: customersTotal,
      newCustomers: customersNew,
      linksCreated: createdInPeriod,
      cancelled,
      expired,
      conversionPct: createdInPeriod ? Math.round((1000 * paidOfCreatedInPeriod) / createdInPeriod) / 10 : null,
    },
    methods: {
      card: { cents: period.cardCents, count: period.cardCount },
      wapay: { cents: period.balanceCents, count: period.balanceCount },
    },
    monthly: months.map((m) => ({ month: m, ...monthly.get(m) })),
    totals: { last3mCents: sumMonths(3), last6mCents: sumMonths(6), last12mCents: sumMonths(12) },
    daily: [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, cents]) => ({ day, cents })),
    topCustomers: [...byCustomer.values()].sort((a, b) => b.cents - a.cents).slice(0, 8),
    recentPayments: paidRows.filter((r) => (r.paidAt || r.createdAt) >= since).slice(0, 12).map((r) => ({
      code: r.id,
      amountCents: r.amountCents,
      paidAt: r.paidAt,
      method: method.get(r.id) || 'OTHER',
      customerId: r.customerId || null,
      customerName: r.customerId ? names.get(r.customerId) || 'Walk-in' : 'Walk-in',
      reference: r.reference,
    })),
    outstanding: openRows.map((r) => ({
      code: r.id,
      amountCents: r.amountCents,
      customerId: r.customerId || null,
      customerName: r.customerId ? names.get(r.customerId) || 'Walk-in' : 'Walk-in',
      reference: r.reference,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      sentAt: r.sentAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Reconciliation export
// ---------------------------------------------------------------------------

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // A leading = + - @ would be executed as a formula by Excel/Sheets: neutralise.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * CSV of every link in the window (all statuses), newest first.
 * Returns { csv, rows, truncated }: when the window holds more than
 * EXPORT_MAX_ROWS links the file ends with an explicit marker row so a
 * reconciliation is never silently short.
 */
export async function exportLinksCsv({ prisma: prismaClient = prisma, businessId, sinceDays = 90 }) {
  const since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000);
  // Created OR paid inside the window: a 30-day ticket paid this month must
  // appear in this month's export even though it was created last month, or
  // the CSV never reconciles to the Overview (critic 2026-09-05).
  const rows = await prismaClient.paymentRequest.findMany({
    where: { businessId, OR: [{ createdAt: { gt: since } }, { paidAt: { gt: since } }] },
    orderBy: { createdAt: 'desc' },
    take: EXPORT_MAX_ROWS,
  });
  const ids = [...new Set(rows.map((r) => r.customerId).filter(Boolean))];
  const cs = ids.length ? await prismaClient.businessCustomer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, msisdn: true } }) : [];
  const byId = new Map(cs.map((c) => [c.id, c]));
  const intents = await loadIntents(prismaClient, rows.filter((r) => r.status === 'PAID').map((r) => r.id));
  const header = ['created', 'paid', 'code', 'status', 'method', 'customer', 'number', 'reference', 'items', 'amount', 'fee', 'net', 'link'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const l = serialiseLink(r, null, intents.get(r.id));
    const c = r.customerId ? byId.get(r.customerId) : null;
    lines.push([
      r.createdAt.toISOString(),
      r.paidAt ? r.paidAt.toISOString() : '',
      r.id,
      l.status,
      l.method || '',
      c?.name || '',
      c?.msisdn || '',
      r.reference || '',
      l.items.map((it) => `${it.name} x${it.qty} @ ${centsToRandString(it.unitCents)}`).join('; '),
      centsToRandString(r.amountCents),
      centsToRandString(l.feeCents),
      centsToRandString(l.netCents),
      l.url,
    ].map(csvCell).join(','));
  }
  const truncated = rows.length >= EXPORT_MAX_ROWS;
  if (truncated) lines.push(`# truncated: only the newest ${EXPORT_MAX_ROWS} links in this window are listed; older links are missing from this file`);
  return { csv: lines.join('\r\n') + '\r\n', rows: rows.length, truncated };
}

// ---------------------------------------------------------------------------
// WaPay-originated nudge (flag-gated, relationship-gated)
// ---------------------------------------------------------------------------

export function nudgeEnabled() {
  return process.env.WAPAY_BUSINESS_NOTIFY === 'true';
}

/**
 * A customer may be nudged from WaPay's own number ONLY on a VERIFIED
 * relationship: they paid this business from their OWN WaPay account
 * (payerRef WAPAY:<accountId>), or the customer row is bound to an account.
 * A card payment is NOT proof: the number at checkout is whatever the payer
 * typed, so a business could type a victim's number into its own R5 card
 * payment and manufacture "consent" (review 2026-09-05, HIGH).
 */
export async function customerEligibleForNudge({ prisma: prismaClient = prisma, businessId, customerId }) {
  if (!nudgeEnabled()) return false;
  const customer = await prismaClient.businessCustomer.findUnique({ where: { id: customerId } });
  if (!customer || customer.businessId !== businessId) return false;
  // The payer's WaPay account must be THIS customer's number: a business
  // paying its own ticket from its own wallet proves nothing about the
  // customer whose row the ticket was filed under.
  const paid = await prismaClient.paymentRequest.findMany({
    where: { businessId, customerId, status: 'PAID', payerRef: { startsWith: 'WAPAY:' } },
    select: { payerRef: true },
    take: 20,
  });
  const accountIds = [...new Set([...(customer.accountId ? [customer.accountId] : []), ...paid.map((p) => String(p.payerRef).slice('WAPAY:'.length))])];
  if (!accountIds.length) return false;
  const accounts = await prismaClient.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, msisdn: true, waId: true } });
  return accounts.some((a) => normaliseCustomerMsisdn(a.msisdn || a.waId) === customer.msisdn);
}

/**
 * Informational-only delivery from WaPay's number: names the business as a
 * WaPay business (never as WaPay), no conversation state is written on the
 * recipient, one nudge per link, NUDGES_PER_DAY per business.
 * Text in-window → Direct Send (utility) → approved template, like every
 * other proactive notify (lib/request-notify.js).
 */
export async function sendLinkViaWaPay({ prisma: prismaClient = prisma, business, customer, code, send }) {
  if (!nudgeEnabled()) return { ok: false, error: 'DISABLED' };
  const request = await prismaClient.paymentRequest.findUnique({ where: { id: String(code || '').toUpperCase() } });
  if (!request || request.businessId !== business.id || request.status !== 'PENDING' || request.expiresAt <= new Date()) return { ok: false, error: 'NOT_OPEN' };
  if (!customer || customer.businessId !== business.id || request.customerId !== customer.id) return { ok: false, error: 'BAD_CUSTOMER' };
  if (request.channel === 'WAPAY' && request.sentAt) return { ok: false, error: 'ALREADY_SENT' };
  const eligible = await customerEligibleForNudge({ prisma: prismaClient, businessId: business.id, customerId: customer.id });
  if (!eligible) return { ok: false, error: 'NOT_ELIGIBLE' };
  const sentToday = await prismaClient.paymentRequest.count({
    where: { businessId: business.id, channel: 'WAPAY', sentAt: { gt: new Date(Date.now() - 24 * 3600 * 1000) } },
  });
  if (NUDGES_PER_DAY > 0 && sentToday >= NUDGES_PER_DAY) return { ok: false, error: 'RATE_LIMITED' };
  // CLAIM before sending: an atomic conditional update is the once-per-link
  // guard; two concurrent taps leave exactly one winner (critics 2026-09-05).
  const claimed = await prismaClient.paymentRequest.updateMany({
    where: { id: request.id, businessId: business.id, status: 'PENDING', NOT: { channel: 'WAPAY' } },
    data: { channel: 'WAPAY', sentAt: new Date() },
  });
  if (claimed.count !== 1) return { ok: false, error: 'ALREADY_SENT' };
  const releaseClaim = () =>
    prismaClient.paymentRequest
      .updateMany({ where: { id: request.id, businessId: business.id, channel: 'WAPAY' }, data: { channel: request.channel || null, sentAt: request.sentAt || null } })
      .catch(() => {});

  const url = paymentRequestUrl(request.id);
  const label = sanitizeLabel(business.name);
  const text =
    `📩 A WaPay business, ${label}, sent you a payment request for ${rands(request.amountCents)}` +
    `${request.reference ? ` (ref ${sanitizeLabel(request.reference, 40)})` : ''}.\n\n` +
    `Tap to pay: ${url}\n\n` +
    `No fees for you: pay from your WaPay balance or by card. If you don't recognise this business, ignore this message.`;
  const to = waIdFor(customer.msisdn);
  // A nudge is by definition OUT of the customer's 24h window (they paid
  // weeks ago). Meta ACCEPTS a free-form text and drops it later, so text
  // "ok" proves nothing (BUGLOG #33). Rails that cross the window go first:
  // Direct Send (utility) → approved template → free-form as a last resort.
  let delivered = false;
  let r = null;
  if (typeof send.direct === 'function' && send.directEnabled?.()) {
    r = await send.direct({ to, text }).catch((e) => ({ ok: false, error: e?.message }));
    if (r?.ok) delivered = true;
  }
  const tpl = process.env.WAPAY_TEMPLATE_BUSINESS_REQUEST || '';
  if (!delivered && tpl && typeof send.template === 'function') {
    r = await send.template({
      to,
      templateName: tpl,
      language: 'en',
      components: [{ type: 'body', parameters: [{ type: 'text', text: label }, { type: 'text', text: rands(request.amountCents) }, { type: 'text', text: url }] }],
    }).catch((e) => ({ ok: false, error: e?.message }));
    if (r?.ok) delivered = true;
  }
  if (!delivered) {
    r = await send.text({ to, text }).catch((e) => ({ ok: false, error: e?.message }));
    if (r?.ok) delivered = true;
  }
  if (!delivered) {
    await releaseClaim(); // nothing went out: give the link its previous mark back
    log('business_nudge_failed', { businessId: business.id, code: request.id, error: String(r?.error || 'unknown').slice(0, 120) });
    return { ok: false, error: 'UNDELIVERABLE' };
  }
  log('business_nudge_sent', { businessId: business.id, code: request.id });
  return { ok: true };
}
