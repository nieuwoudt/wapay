#!/usr/bin/env node
/**
 * Blu (Blue Label Telecoms) UAT evidence pack, generated from the ledger.
 *
 * Reads production records and writes docs/testing/BLU_UAT_EVIDENCE_v2.md and
 * .csv. Nothing is hand-typed: every line comes from ProviderRequest (the
 * preview row that carries Blu's reference), holds (reserve/settle/release),
 * JournalEntry + JournalLine (the double-entry postings), and
 * conversation_turns (the customer-visible receipt as it was sent, already
 * redacted at write time by lib/turns.js).
 *
 * READ-ONLY: this script never writes to the database.
 *
 * Usage:
 *   node --env-file=.env scripts/blu-uat-evidence.mjs
 *   node --env-file=.env scripts/blu-uat-evidence.mjs --since 2026-10-04 --out docs/testing/BLU_UAT_EVIDENCE_v2
 *   node --env-file=.env scripts/blu-uat-evidence.mjs --blu-env "Trade QA (api.qa.bltelecoms.net)"
 *
 * Masking (bearer secrets and personal data never leave the database in clear):
 *   - MSISDNs: shown in full only when they are Blu's published QA test numbers;
 *     every other number keeps its first three and last three digits.
 *   - Meter numbers: shown in full only for Blu's compliance test meter.
 *   - Electricity tokens: last four digits only.
 *   - Voucher PINs: never stored, so never present.
 *   - Any other run of 12 or more digits in free text is masked to its last four.
 */

import fs from 'node:fs';
import path from 'node:path';
import prisma from '../lib/prisma.js';
import { BLU_QA_TEST_NUMBERS, normaliseMsisdn } from '../lib/msisdn.js';

const COMPLIANCE_METER = '000001020001';
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const RECEIPT_WINDOW_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SINCE = new Date(`${argValue('--since', '2026-10-04')}T00:00:00Z`);
const OUT_BASE = argValue('--out', 'docs/testing/BLU_UAT_EVIDENCE_v2');
const BLU_ENV = argValue('--blu-env', 'Trade QA (api.qa.bltelecoms.net), Blu QA credentials');
const GENERATED_AT = new Date();

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
function fmtUtc(d) {
  if (!d) return '';
  const x = new Date(d);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())} ${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}:${pad(x.getUTCSeconds())}`;
}
function fmtSast(d) {
  if (!d) return '';
  return fmtUtc(new Date(new Date(d).getTime() + 2 * 60 * 60 * 1000));
}
const rands = (cents) => (cents == null || Number.isNaN(Number(cents)) ? '' : `R${(Number(cents) / 100).toFixed(2)}`);

function maskMsisdn(raw) {
  const m = normaliseMsisdn(raw || '');
  if (!m) return '';
  if (BLU_QA_TEST_NUMBERS.has(m)) return m;
  if (m.length <= 6) return m.replace(/\d(?=\d{2})/g, '*');
  return `${m.slice(0, 3)}${'*'.repeat(m.length - 6)}${m.slice(-3)}`;
}
function maskMeter(raw) {
  const m = String(raw || '').replace(/\D/g, '');
  if (!m) return '';
  if (m === COMPLIANCE_METER) return m;
  if (m.length <= 6) return '*'.repeat(m.length);
  return `${m.slice(0, 2)}${'*'.repeat(m.length - 6)}${m.slice(-4)}`;
}
function last4(raw) {
  const s = String(raw || '');
  if (!s) return '';
  return `${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
}
/** Free text only (receipts): any 12+ digit run (with or without spaces) keeps its last four. Never applied to references or request ids. */
function maskLongDigits(text) {
  return String(text || '')
    .replace(/(?<!\d)(?:\d[\s-]?){12,}\d(?!\d)/g, (m) => last4(m.replace(/\D/g, '')))
    .replace(/\d{12,}/g, (m) => last4(m));
}
const csvCell = (v) => {
  const s = v == null ? '' : String(v).replace(/\r?\n/g, ' ⏎ ');
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const mdCell = (v) => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ⏎ ');

// ---------------------------------------------------------------------------
// Data access (read-only)
// ---------------------------------------------------------------------------
const PRODUCT_BY_ROUTE = {
  'airtime-preview': { product: 'Airtime', execPrefix: 'wapay-air-exec-', spendPrefix: 'wapay-air-spend-' },
  'data-preview': { product: 'Data bundle', execPrefix: 'wapay-data-exec-', spendPrefix: 'wapay-data-spend-' },
  'electricity-preview': { product: 'Electricity', execPrefix: 'wapay-elec-exec-', spendPrefix: 'wapay-elec-spend-' },
};

async function loadVasRows() {
  const rows = await prisma.providerRequest.findMany({
    where: { provider: 'BLU', route: { in: Object.keys(PRODUCT_BY_ROUTE) } },
    orderBy: { requestTs: 'asc' },
  });
  const out = [];
  for (const r of rows) {
    const def = PRODUCT_BY_ROUTE[r.route];
    const md = r.metadata || (r.responseJson && r.route !== 'electricity-preview' ? safeJson(r.responseJson) : {}) || {};
    const execIdemKey = `${def.execPrefix}${r.id}`;
    const hold = await prisma.hold.findUnique({ where: { idemKey: execIdemKey } }).catch(() => null);
    const entries = await prisma.journalEntry.findMany({
      where: { idemKey: { contains: r.id } },
      include: { lines: true },
      orderBy: { createdAt: 'asc' },
    });
    const resp = r.route === 'electricity-preview' && r.responseJson ? safeJson(r.responseJson) : null;
    // Legacy flows (before the preview-derived keys of January 2026) sent Blu a
    // requestId of the form wapay-air-<epoch>-<accountId> and posted the journal
    // under that same key, so the preview id never appears in it. Join those by
    // the account and a ten minute window after the preview, each entry once.
    let requestIdSent = r.status === 'PENDING' ? '' : execIdemKey;
    let legacy = false;
    if (!entries.length && r.status !== 'PENDING') {
      const from = new Date(r.requestTs);
      const to = new Date(from.getTime() + 10 * 60 * 1000);
      const candidate = await prisma.journalEntry.findFirst({
        where: {
          source: { in: ['VAS_AIRTIME', 'VAS_AIRTIME_FAILED', 'VAS_DATA', 'VAS_ELECTRICITY'] },
          idemKey: { endsWith: r.accountId || '', not: { in: Array.from(claimedLegacy) } },
          createdAt: { gte: from, lte: to },
        },
        include: { lines: true },
        orderBy: { createdAt: 'asc' },
      });
      if (candidate) {
        claimedLegacy.add(candidate.idemKey);
        entries.push(candidate);
        requestIdSent = candidate.idemKey;
        legacy = true;
      }
    }
    if (!legacy && entries.length && !hold && new Date(r.requestTs) < LEDGER_CORE_DATE) legacy = true;
    out.push({ row: r, def, md, execIdemKey, requestIdSent, legacy, hold, entries, resp });
  }
  return out;
}
const claimedLegacy = new Set();
const LEDGER_CORE_DATE = new Date('2026-08-10T00:00:00Z');
const TURNS_SINCE = new Date('2026-09-17T00:00:00Z');

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

async function loadVoucherLoads() {
  // Blu Voucher redemptions post straight to the journal: the legacy source
  // BLU_DEPOSIT (2025) and the ledger-core source LOAD_BLU (2026). externalRef
  // carries Blu's redemption reference.
  return prisma.journalEntry.findMany({
    where: { source: { in: ['BLU_DEPOSIT', 'LOAD_BLU'] } },
    include: { lines: true },
    orderBy: { createdAt: 'asc' },
  });
}

async function loadOttRedeems() {
  // Blu's 14 September batch includes supplier-code-41 vouchers (12-digit PINs)
  // that may belong to the OTT redemption rail. Listed separately so Blu can
  // see them, never mixed into the Blu Voucher table.
  return prisma.providerRequest.findMany({
    where: { provider: 'OTT', route: 'ott-redeem' },
    orderBy: { requestTs: 'asc' },
  });
}

const turnsCache = new Map();
async function turnsFor(accountId, from, to) {
  const key = `${accountId}|${+from}|${+to}`;
  if (turnsCache.has(key)) return turnsCache.get(key);
  const rows = await prisma.$queryRaw`
    SELECT role, kind, text, "createdAt" FROM conversation_turns
    WHERE "accountId" = ${accountId} AND role = 'assistant'
      AND "createdAt" >= ${from} AND "createdAt" <= ${to}
    ORDER BY "createdAt" ASC`;
  turnsCache.set(key, rows);
  return rows;
}

/** The customer-visible receipt (or failure line) as it was actually sent. */
async function receiptFor({ accountId, from, needle, failure = false }) {
  const start = new Date(from || 0);
  if (start < TURNS_SINCE) return { text: '', at: null, note: 'receipt not retained (turn storage began 17 Sep 2026)' };
  if (!accountId) return { text: '', at: null, note: 'no account on the row' };
  const end = new Date(start.getTime() + RECEIPT_WINDOW_MS);
  const turns = await turnsFor(accountId, start, end);
  if (!turns.length) {
    return { text: '', at: null, note: 'no stored reply in the 15 minute window' };
  }
  let hit = null;
  if (needle) hit = turns.find((t) => String(t.text || '').includes(String(needle)));
  if (!hit && failure) hit = turns.find((t) => /❌|⚠️|could not|couldn't|failed|rejecting|not enabled|coming soon/i.test(t.text || ''));
  if (!hit && !failure) hit = turns.find((t) => /✅/.test(t.text || '') && !/withdraw|pay link|deposit/i.test(t.text || ''));
  if (!hit) return { text: '', at: null, note: 'no matching stored reply' };
  return { text: maskLongDigits(hit.text), at: hit.createdAt, note: '' };
}

function postingsOf(entry) {
  return entry.lines
    .map((l) => {
      const code = l.accountCode.replace(/^WALLET:[^:]+:/i, 'WALLET:customer:').replace(/^Wallet:MAIN$/i, 'WALLET:customer');
      return l.debitCents ? `Dr ${code} ${l.debitCents}` : `Cr ${code} ${l.creditCents}`;
    })
    .join('; ');
}

function classify({ row, hold, entries, md }) {
  const status = row.status;
  const ageMs = GENERATED_AT - new Date(row.requestTs);
  if (status === 'SUCCESS') return { label: 'Vend confirmed by Blu, hold settled, journal posted', outcome: 'SUCCESS' };
  if (status === 'RECONCILE') return { label: 'Sale timed out at our end (indeterminate): hold kept, same requestId re-sent by the reconciler', outcome: 'RECONCILE' };
  if (status === 'EXECUTING') return { label: 'Sale in flight, or the invocation died before it could say: hold kept, reconciler takes it over when stale', outcome: 'EXECUTING' };
  if (status === 'FAILED') {
    const reason = hold?.reason || entries.find((e) => /FAILED/.test(e.source))?.source || '';
    if (/INVALID_PHONE_NUMBER/i.test(reason)) return { label: 'Declined by Blu QA (number not on the QA whitelist); hold released, nothing booked', outcome: 'DECLINED' };
    if (/RETRYABLE|timeout|ETIMEDOUT|socket/i.test(reason)) return { label: `Timeout or upstream error (${reason}); hold released`, outcome: 'TIMEOUT' };
    if (reason) return { label: `Declined (${reason}); hold released`, outcome: 'DECLINED' };
    return { label: 'Declined by provider; funds released, nothing booked', outcome: 'DECLINED' };
  }
  if (status === 'PENDING') {
    if (ageMs > PREVIEW_TTL_MS) return { label: 'Preview shown, customer did not confirm or PIN within 5 minutes; nothing sent to Blu, no money moved', outcome: 'ABANDONED' };
    return { label: 'Preview open (inside its 5 minute window)', outcome: 'OPEN' };
  }
  return { label: status, outcome: status };
}

// ---------------------------------------------------------------------------
// Build the pack
// ---------------------------------------------------------------------------
async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set (run with --env-file=.env).');
    process.exit(2);
  }

  const vas = await loadVasRows();
  const loads = await loadVoucherLoads();
  const otts = await loadOttRedeems();

  const lines = []; // CSV lines
  const csvHeader = [
    'section', 'phase', 'product', 'network_or_utility', 'outcome', 'test_case',
    'our_preview_id', 'our_request_id_sent_to_blu', 'blu_reference', 'blu_quote_reference',
    'requested_at_utc', 'requested_at_sast', 'resolved_at_utc',
    'amount_rands', 'fee_rands', 'total_rands', 'target', 'bundle_or_sku',
    'hold_status', 'hold_reason', 'journal_entries', 'postings_cents', 'token_last4',
    'receipt_sent_at_utc', 'receipt_as_sent',
  ];
  lines.push(csvHeader.join(','));

  const records = [];
  for (const v of vas) {
    const { row, def, md, requestIdSent, legacy, hold, entries, resp } = v;
    const cls = classify(v);
    const phase = new Date(row.requestTs) >= SINCE ? 'UAT round' : 'Historical';
    const isElec = row.route === 'electricity-preview';
    const target = isElec ? maskMeter(md.meterNumber) : maskMsisdn(md.msisdn);
    const network = isElec ? (md.utility || md.consumer?.utility || 'Prepaid electricity') : (md.vendorName || md.vendorId || '');
    const amountCents = isElec ? md.amountCents : (row.route === 'data-preview' ? (md.priceCents ?? md.amountCents) : md.amountCents);
    const feeCents = isElec ? md.serviceFee : (md.feeCents ?? 0);
    const totalCents = md.totalCents ?? (amountCents != null ? Number(amountCents) + Number(feeCents || 0) : null);
    const sku = row.route === 'data-preview' ? `${md.productName || ''}${md.productId ? ` (Blu product ${md.productId})` : ''}` : '';
    const tokenLast4 = isElec && (resp?.token || md.token) ? last4(resp?.token || md.token) : '';
    const resolvedAt = hold?.resolvedAt || entries.at(-1)?.createdAt || null;
    const receipt = row.status === 'PENDING'
      ? { text: '', at: null, note: 'no receipt (nothing executed)' }
      : await receiptFor({ accountId: row.accountId, from: row.requestTs, needle: row.status === 'SUCCESS' ? row.providerRef : null, failure: row.status !== 'SUCCESS' });

    const rec = {
      section: def.product,
      phase,
      product: def.product,
      network,
      outcome: cls.outcome,
      testCase: cls.label,
      previewId: row.id,
      requestId: requestIdSent,
      bluRef: row.providerRef || '',
      quoteRef: isElec ? (md.reference || '') : '',
      requestedUtc: fmtUtc(row.requestTs),
      requestedSast: fmtSast(row.requestTs),
      resolvedUtc: fmtUtc(resolvedAt),
      amount: rands(amountCents),
      fee: rands(feeCents),
      total: rands(totalCents),
      target,
      sku,
      totalCents: totalCents == null ? 0 : Number(totalCents),
      holdStatus: hold?.status || (legacy ? 'legacy flow (pre ledger-core, no hold row)' : (row.status === 'PENDING' ? 'none (not executed)' : 'none')),
      holdReason: hold?.reason || '',
      journal: entries.map((e) => `${e.source} ${e.idemKey}`).join(' ; '),
      postings: entries.map(postingsOf).join(' ; '),
      tokenLast4,
      receiptAt: fmtUtc(receipt.at),
      receipt: receipt.text || (receipt.note ? `[${receipt.note}]` : ''),
    };
    records.push(rec);
    lines.push([
      rec.section, rec.phase, rec.product, rec.network, rec.outcome, rec.testCase, rec.previewId, rec.requestId, rec.bluRef, rec.quoteRef,
      rec.requestedUtc, rec.requestedSast, rec.resolvedUtc, rec.amount, rec.fee, rec.total, rec.target, rec.sku,
      rec.holdStatus, rec.holdReason, rec.journal, rec.postings, rec.tokenLast4, rec.receiptAt, rec.receipt,
    ].map(csvCell).join(','));
  }

  const loadRecords = [];
  for (const e of loads) {
    const meta = e.metadata || {};
    const face = meta.faceCents ?? e.lines.find((l) => /WALLET|Wallet/.test(l.accountCode))?.creditCents ?? null;
    const credited = meta.creditCents ?? e.lines.find((l) => /WALLET|Wallet/.test(l.accountCode))?.creditCents ?? null;
    const phase = new Date(e.createdAt) >= SINCE ? 'UAT round' : 'Historical';
    const accountId = meta.accountId || (e.lines.find((l) => /^WALLET:/.test(l.accountCode))?.accountCode.split(':')[1]) || null;
    const receipt = await receiptFor({ accountId, from: new Date(new Date(e.createdAt).getTime() - 60 * 1000), needle: e.externalRef });
    const rec = {
      section: 'Voucher redemption (Blu Voucher)',
      phase,
      product: 'Blu Voucher redemption',
      network: 'Blu Voucher (16-digit PIN)',
      outcome: 'SUCCESS',
      testCase: e.source === 'BLU_DEPOSIT' ? 'Redeemed; face value credited (legacy ledger, face credit)' : 'Redeemed; credited net of the rail discount (ledger-core LOAD_BLU)',
      previewId: '',
      requestId: e.idemKey,
      bluRef: e.externalRef || '',
      quoteRef: '',
      requestedUtc: fmtUtc(e.createdAt),
      requestedSast: fmtSast(e.createdAt),
      resolvedUtc: fmtUtc(e.createdAt),
      amount: rands(face),
      fee: face != null && credited != null ? rands(Number(face) - Number(credited)) : '',
      total: rands(credited),
      totalCents: Number(credited || 0),
      faceCents: Number(face || 0),
      target: 'customer wallet',
      sku: '',
      holdStatus: 'n/a (load, no hold)',
      holdReason: '',
      journal: `${e.source} ${e.idemKey}`,
      postings: postingsOf(e),
      tokenLast4: '',
      receiptAt: fmtUtc(receipt.at),
      receipt: receipt.text || (receipt.note ? `[${receipt.note}]` : ''),
    };
    loadRecords.push(rec);
    lines.push([
      rec.section, rec.phase, rec.product, rec.network, rec.outcome, rec.testCase, rec.previewId, rec.requestId, rec.bluRef, rec.quoteRef,
      rec.requestedUtc, rec.requestedSast, rec.resolvedUtc, rec.amount, rec.fee, rec.total, rec.target, rec.sku,
      rec.holdStatus, rec.holdReason, rec.journal, rec.postings, rec.tokenLast4, rec.receiptAt, rec.receipt,
    ].map(csvCell).join(','));
  }

  const ottRecords = [];
  for (const r of otts) {
    const md = r.metadata || {};
    const entries = await prisma.journalEntry.findMany({ where: { idemKey: { contains: r.id.replace(/^wapay-rdm-/, '') } }, include: { lines: true } });
    const phase = new Date(r.requestTs) >= SINCE ? 'UAT round' : 'Historical';
    const receipt = await receiptFor({ accountId: r.accountId, from: r.requestTs, needle: r.providerRef, failure: r.status !== 'SUCCESS' });
    const rec = {
      section: 'Voucher redemption (OTT rail, supplier code 41 candidates)',
      phase, product: 'OTT voucher redemption', network: 'OTT (12-digit PIN)', outcome: r.status,
      testCase: r.status === 'SUCCESS' ? 'Redeemed on the OTT rail' : `OTT redemption ${r.status}`,
      previewId: r.id, requestId: r.idemKey, bluRef: r.providerRef || '', quoteRef: '',
      requestedUtc: fmtUtc(r.requestTs), requestedSast: fmtSast(r.requestTs), resolvedUtc: fmtUtc(entries.at(-1)?.createdAt),
      amount: rands(md.valueCents), fee: '', total: '', target: 'customer wallet', sku: md.serial ? `serial ${md.serial}` : '',
      holdStatus: 'n/a (load, no hold)', holdReason: '',
      journal: entries.map((e) => `${e.source} ${e.idemKey}`).join(' ; '), postings: entries.map(postingsOf).join(' ; '), tokenLast4: '',
      receiptAt: fmtUtc(receipt.at), receipt: receipt.text || (receipt.note ? `[${receipt.note}]` : ''),
    };
    ottRecords.push(rec);
    lines.push([
      rec.section, rec.phase, rec.product, rec.network, rec.outcome, rec.testCase, rec.previewId, rec.requestId, rec.bluRef, rec.quoteRef,
      rec.requestedUtc, rec.requestedSast, rec.resolvedUtc, rec.amount, rec.fee, rec.total, rec.target, rec.sku,
      rec.holdStatus, rec.holdReason, rec.journal, rec.postings, rec.tokenLast4, rec.receiptAt, rec.receipt,
    ].map(csvCell).join(','));
  }

  // -------------------------------------------------------------------------
  // Ledger check: CLEARING:BLU movement against the vended face values
  // -------------------------------------------------------------------------
  const clearingLines = await prisma.journalLine.findMany({
    where: { accountCode: { in: ['CLEARING:BLU', 'Clearing:Blu', 'LIABILITY:VAS_CLEARING'] } },
    include: { entry: true },
  });
  const sumBy = (pred, side) => clearingLines.filter(pred).reduce((a, l) => a + Number(l[side] || 0), 0);
  const spendSources = ['SPEND_AIRTIME', 'SPEND_DATA', 'SPEND_ELECTRICITY', 'VAS_AIRTIME', 'VAS_DATA', 'VAS_ELECTRICITY'];
  const clearingCreditedBySpends = sumBy((l) => spendSources.includes(l.entry.source), 'creditCents');
  const clearingDebitedByLoads = sumBy((l) => ['LOAD_BLU', 'BLU_DEPOSIT'].includes(l.entry.source), 'debitCents');
  const vendedTotal = records.filter((r) => r.outcome === 'SUCCESS').reduce((a, r) => a + r.totalCents, 0);
  const commissionLines = await prisma.journalLine.findMany({ where: { accountCode: { startsWith: 'REVENUE:COMMISSION:' } }, include: { entry: true } });
  const commissionOnVas = commissionLines.filter((l) => spendSources.includes(l.entry.source)).reduce((a, l) => a + Number(l.creditCents || 0), 0);
  const loadsFace = loadRecords.reduce((a, r) => a + r.faceCents, 0);

  // Books balance overall (debits equal credits) over every entry, as a whole-ledger sanity line.
  const totals = await prisma.$queryRaw`SELECT COALESCE(SUM("debitCents"),0)::bigint AS d, COALESCE(SUM("creditCents"),0)::bigint AS c FROM "JournalLine"`;
  const booksBalanced = String(totals[0].d) === String(totals[0].c);

  // -------------------------------------------------------------------------
  // Markdown
  // -------------------------------------------------------------------------
  const count = (arr, pred) => arr.filter(pred).length;
  const inRound = (r) => r.phase === 'UAT round';
  const md = [];
  md.push(`# WaPay x Blue Label Telecoms (Blu Trade API): UAT test evidence, v2`);
  md.push('');
  md.push(`**Prepared for:** Phuti Maphoto, Branded Voucher Coordinator, Blue Label Telecoms`);
  md.push(`**From:** WaPay (Pty) Ltd, registration 2025/759220/07`);
  md.push(`**Generated:** ${fmtUtc(GENERATED_AT)} UTC (${fmtSast(GENERATED_AT)} SAST) by \`scripts/blu-uat-evidence.mjs\` from WaPay's production records`);
  md.push(`**Blu environment under test:** ${BLU_ENV}`);
  md.push(`**UAT round window:** from ${fmtUtc(SINCE)} UTC; earlier rows are listed as historical (integration period)`);
  md.push('');
  md.push('Every line below is read from the production database: the provider request row that carries Blu\'s');
  md.push('reference, the funds hold (reserve, settle or release), the double-entry journal postings, and the');
  md.push('customer-visible WhatsApp reply exactly as it was sent (stored redacted). Nothing is typed by hand; the');
  md.push('pack is regenerated by running the script. Our `requestId` on every vend is the hold key shown in the');
  md.push('"Our request id" column, so Blu can match each line against its own transaction log.');
  md.push('');
  md.push('## 1. Summary');
  md.push('');
  md.push('| Product | UAT round: confirmed vends | UAT round: declines, timeouts, abandoned previews | Historical: confirmed | Historical: other |');
  md.push('|---|---|---|---|---|');
  for (const p of ['Airtime', 'Data bundle', 'Electricity']) {
    const rs = records.filter((r) => r.product === p);
    md.push(`| ${p} | ${count(rs, (r) => inRound(r) && r.outcome === 'SUCCESS')} | ${count(rs, (r) => inRound(r) && r.outcome !== 'SUCCESS')} | ${count(rs, (r) => !inRound(r) && r.outcome === 'SUCCESS')} | ${count(rs, (r) => !inRound(r) && r.outcome !== 'SUCCESS')} |`);
  }
  md.push(`| Blu Voucher redemption | ${count(loadRecords, inRound)} | 0 (declined PINs never post) | ${count(loadRecords, (r) => !inRound(r))} | 0 |`);
  if (ottRecords.length) md.push(`| OTT rail (supplier 41 candidates) | ${count(ottRecords, (r) => inRound(r) && r.outcome === 'SUCCESS')} | ${count(ottRecords, (r) => inRound(r) && r.outcome !== 'SUCCESS')} | ${count(ottRecords, (r) => !inRound(r) && r.outcome === 'SUCCESS')} | ${count(ottRecords, (r) => !inRound(r) && r.outcome !== 'SUCCESS')} |`);
  md.push('');
  md.push('Networks covered by confirmed vends in the UAT round: ' + (Array.from(new Set(records.filter((r) => inRound(r) && r.outcome === 'SUCCESS').map((r) => `${r.product}: ${r.network}`))).join(', ') || 'none yet'));
  md.push('');

  const vasTable = (rs) => {
    const out = [];
    out.push('| # | Requested (UTC) | SAST | Network / utility | Target | Amount | Fee | Total | Bundle | Our preview id | Our request id (Blu requestId) | Blu reference | Outcome | Hold | Journal postings (cents) | Receipt as sent |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    rs.forEach((r, i) => {
      out.push(`| ${i + 1} | ${r.requestedUtc} | ${r.requestedSast} | ${mdCell(r.network)} | ${mdCell(r.target)} | ${r.amount} | ${r.fee} | ${r.total} | ${mdCell(r.sku)} | \`${r.previewId}\` | ${r.requestId ? `\`${r.requestId}\`` : ''} | ${r.bluRef ? `\`${r.bluRef}\`` : ''}${r.quoteRef ? ` (quote \`${mdCell(r.quoteRef)}\`)` : ''}${r.tokenLast4 ? ` token …${r.tokenLast4.slice(-4)}` : ''} | ${mdCell(r.testCase)} | ${mdCell(r.holdStatus)}${r.holdReason ? ` (${mdCell(r.holdReason)})` : ''} | ${mdCell(r.postings) || '(none: nothing booked)'} | ${mdCell(r.receipt)} |`);
    });
    return out;
  };

  let section = 2;
  for (const p of ['Airtime', 'Data bundle', 'Electricity']) {
    const rs = records.filter((r) => r.product === p);
    md.push(`## ${section++}. ${p}`);
    md.push('');
    md.push(p === 'Electricity'
      ? 'Flow: amount and meter in WhatsApp, meter confirmed with `GET /electricity/info` (the quote reference is shown next to Blu\'s sale reference), priced preview, customer confirms and enters the wallet PIN, funds reserved, `POST /electricity/sales`, token delivered in the receipt (masked here to its last four digits), hold settled and journal posted. A failed vend releases the hold.'
      : p === 'Data bundle'
        ? 'Flow: bundle chosen from the Blu catalogue (`GET /mobile/bundle/products`, synced daily), priced preview, customer confirms and enters the wallet PIN, funds reserved, `POST /mobile/data/sales`, hold settled and journal posted. A failed vend releases the hold.'
        : 'Flow: amount and number in WhatsApp, network detected (`GET /mobile/airtime/mobile-number/check` or the QA test-number map), priced preview, customer confirms and enters the wallet PIN, funds reserved, `POST /mobile/airtime/sales`, hold settled and journal posted. A failed vend releases the hold.');
    md.push('');
    const round = rs.filter(inRound);
    const hist = rs.filter((r) => !inRound(r));
    md.push(`### ${section - 1}.1 UAT round (${round.length} rows)`);
    md.push('');
    md.push(...(round.length ? vasTable(round) : ['_No rows in the UAT round window yet._']));
    md.push('');
    md.push(`### ${section - 1}.2 Historical, integration period (${hist.length} rows)`);
    md.push('');
    md.push(...(hist.length ? vasTable(hist) : ['_None._']));
    md.push('');
  }

  md.push(`## ${section++}. Voucher redemption (Blu Voucher, 16-digit PIN)`);
  md.push('');
  md.push('Flow: customer sends the 16-digit PIN in WhatsApp, `GET /voucher/variable/vouchers` (status and value), `POST /voucher/variable/redemptions` with a `requestId` derived from a hash of the PIN (never the PIN), wallet credited, receipt sent. Replaying the same PIN is refused by the status check (USED) and can never credit twice. PINs are bearer secrets and are not stored anywhere, so they do not appear here. "Amount" is the voucher face value Blu redeemed; "Credited" is what the customer wallet received under WaPay\'s load policy.');
  md.push('');
  const loadTable = (rs) => {
    const out = [];
    out.push('| # | Redeemed (UTC) | SAST | Face value | Credited | Our requestId | Blu reference | Journal postings (cents) | Receipt as sent |');
    out.push('|---|---|---|---|---|---|---|---|---|');
    rs.forEach((r, i) => out.push(`| ${i + 1} | ${r.requestedUtc} | ${r.requestedSast} | ${r.amount} | ${r.total} | \`${r.requestId}\` | \`${r.bluRef}\` | ${mdCell(r.postings)} | ${mdCell(r.receipt)} |`));
    return out;
  };
  md.push(`### ${section - 1}.1 UAT round (${loadRecords.filter(inRound).length} rows)`);
  md.push('');
  md.push(...(loadRecords.filter(inRound).length ? loadTable(loadRecords.filter(inRound)) : ['_No redemptions in the UAT round window yet._']));
  md.push('');
  md.push(`### ${section - 1}.2 Historical (${loadRecords.filter((r) => !inRound(r)).length} rows)`);
  md.push('');
  md.push(...loadTable(loadRecords.filter((r) => !inRound(r))));
  md.push('');

  if (ottRecords.length) {
    md.push(`## ${section++}. Vouchers redeemed on the OTT rail (supplier code 41 candidates)`);
    md.push('');
    md.push('| # | Requested (UTC) | SAST | Value | Our reference | Rail reference | Outcome | Journal postings (cents) | Receipt as sent |');
    md.push('|---|---|---|---|---|---|---|---|---|');
    ottRecords.forEach((r, i) => md.push(`| ${i + 1} | ${r.requestedUtc} | ${r.requestedSast} | ${r.amount} | \`${r.requestId}\` | ${r.bluRef ? `\`${r.bluRef}\`` : ''} | ${mdCell(r.testCase)} | ${mdCell(r.postings)} | ${mdCell(r.receipt)} |`));
    md.push('');
  }

  md.push(`## ${section++}. Failure paths (every non-success row, all products)`);
  md.push('');
  const fails = records.filter((r) => r.outcome !== 'SUCCESS');
  md.push('| # | Requested (UTC) | Product | Network / utility | Target | Total | Our preview id | Our request id | What happened | Hold | Journal | Reply as sent |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  fails.forEach((r, i) => md.push(`| ${i + 1} | ${r.requestedUtc} | ${r.product} | ${mdCell(r.network)} | ${mdCell(r.target)} | ${r.total} | \`${r.previewId}\` | ${r.requestId ? `\`${r.requestId}\`` : ''} | ${mdCell(r.testCase)} | ${mdCell(r.holdStatus)}${r.holdReason ? ` (${mdCell(r.holdReason)})` : ''} | ${mdCell(r.postings) || 'nothing booked'} | ${mdCell(r.receipt)} |`));
  md.push('');
  md.push('Reading the table: an abandoned preview never reached Blu (no request id, no hold, no journal). A decline or timeout reached Blu, the hold was released and nothing was booked against the customer; the reply tells the customer their money has not moved.');
  md.push('');

  md.push(`## ${section++}. Ledger check`);
  md.push('');
  md.push('| Check | Value |');
  md.push('|---|---|');
  md.push(`| Confirmed VAS vends (all time), customer totals | ${rands(vendedTotal)} |`);
  md.push(`| Supplier clearing credited by those vends (CLEARING:BLU, incl. legacy VAS_CLEARING) | ${rands(clearingCreditedBySpends)} |`);
  md.push(`| Commission booked on those vends (REVENUE:COMMISSION:*) | ${rands(commissionOnVas)} |`);
  md.push(`| Vends = clearing + commission | ${vendedTotal === clearingCreditedBySpends + commissionOnVas ? 'TRUE' : `FALSE (difference ${rands(vendedTotal - clearingCreditedBySpends - commissionOnVas)})`} |`);
  md.push(`| Blu Voucher face value redeemed (all time) | ${rands(loadsFace)} |`);
  md.push(`| Supplier clearing debited by those redemptions | ${rands(clearingDebitedByLoads)} |`);
  md.push(`| Whole ledger: total debits equal total credits | ${booksBalanced ? 'TRUE' : 'FALSE'} (${String(totals[0].d)} / ${String(totals[0].c)}) |`);
  md.push('');
  md.push(`## ${section++}. Method and masking`);
  md.push('');
  md.push('- Source tables: `ProviderRequest` (one row per priced preview; `status` SUCCESS, FAILED, PENDING or RECONCILE; `providerRef` is Blu\'s reference), `holds` (reserve, settle, release by the same request id we send Blu), `JournalEntry` and `JournalLine` (double-entry postings in integer cents), `conversation_turns` (the WhatsApp reply as sent; stored redacted since 17 September 2026, so earlier receipts are not retained).');
  md.push('- Our `requestId` to Blu equals the hold key (`wapay-air-exec-…`, `wapay-data-exec-…`, `wapay-elec-exec-…`); for voucher redemption it is `wapay-redeem-<hash prefix>` (the 2025 redemptions were keyed on Blu\'s own reference). Rows marked "legacy flow" predate the ledger-core hold pattern (August 2026): their request id is the journal key of the time (`wapay-air-<stamp>-<account>`), joined by account and a ten minute window.');
  md.push('- Masking: MSISDNs are shown in full only when they are Blu\'s QA test numbers; other numbers keep their first three and last three digits. Meter numbers are shown in full only for the compliance test meter. Electricity tokens show their last four digits. Voucher PINs are never stored. In receipt text any run of 12 or more digits is reduced to its last four. References and request ids are reproduced exactly.');
  md.push('- Times are UTC with SAST (UTC+2) alongside. Money is in rands from integer cents; nothing is rounded.');
  md.push(`- Machine-readable copy: \`${path.basename(OUT_BASE)}.csv\` next to this file, one row per line above.`);
  md.push('');

  const mdPath = `${OUT_BASE}.md`;
  const csvPath = `${OUT_BASE}.csv`;
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  // References and request ids are reproduced exactly (Blu matches on them); receipt text was masked field by field above.
  const mdText = md.join('\n').replace(/\u2014/g, ', ');
  fs.writeFileSync(mdPath, mdText + '\n');
  fs.writeFileSync(csvPath, lines.join('\n') + '\n');
  console.log(`Wrote ${mdPath} (${records.length} VAS rows, ${loadRecords.length} voucher loads, ${ottRecords.length} OTT rows) and ${csvPath}`);
  console.log(`UAT round rows since ${fmtUtc(SINCE)} UTC: VAS ${records.filter(inRound).length}, voucher ${loadRecords.filter(inRound).length}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
