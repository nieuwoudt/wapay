/**
 * Float loads and the float reconciliation (founder, 2026-10-20: "record a float load recon
 * on the dashboard in the UI card where we show the current float levels").
 *
 * A load is the founder's transfer to a supplier's prepaid float, typed in on the Floats tab
 * (amount, the day it cleared, the bank reference). It posts `FLOAT_LOAD` to the journal
 * (lib/ledger-core.js buildFloatLoad). Usage is what the journal already books against that
 * supplier: for the OTT pay-out float every CASHOUT_* entry's credit to CLEARING:OTT (the
 * amount paid plus the rail cost). Expected balance = loads - usage; the supplier's live
 * balance from its API sits next to it and the difference is the drift to chase.
 *
 * Only the OTT pay-out float has a usage rule today; the others record loads and show them.
 */
import prismaDefault from './prisma.js';
import { postEntry } from './ledger-post.js';
import { buildFloatLoad } from './ledger-core.js';

export const FLOAT_KEYS = ['OTT_PAYOUT', 'OTT', 'BLU', 'YOYO', 'PAYFAST'];

/** CLEARING credits that draw a float down, by float key. */
export const USAGE_RULES = {
  OTT_PAYOUT: { accountCode: 'CLEARING:OTT', sourcePrefix: 'CASHOUT' },
};

export function loadIdemKey({ key, loadedAt, amountCents, reference }) {
  const day = String(loadedAt || '').slice(0, 10) || 'undated';
  const ref = String(reference || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'noref';
  return `float-load:${String(key).toUpperCase()}:${day}:${amountCents}:${ref}`;
}

export function validateLoad({ key, amountCents, loadedAt, reference }) {
  if (!FLOAT_KEYS.includes(String(key || '').toUpperCase())) return { ok: false, error: 'BAD_KEY' };
  const cents = Number(amountCents);
  if (!Number.isInteger(cents) || cents <= 0 || cents > 100000000) return { ok: false, error: 'BAD_AMOUNT' };
  if (loadedAt && !/^\d{4}-\d{2}-\d{2}/.test(String(loadedAt))) return { ok: false, error: 'BAD_DATE' };
  if (reference && String(reference).length > 60) return { ok: false, error: 'BAD_REFERENCE' };
  return { ok: true, key: String(key).toUpperCase(), amountCents: cents, loadedAt: loadedAt ? String(loadedAt).slice(0, 10) : new Date().toISOString().slice(0, 10), reference: reference ? String(reference).trim() : null };
}

export async function recordFloatLoad({ prisma = prismaDefault, key, amountCents, loadedAt, reference, note = null, by = 'ops', post = postEntry }) {
  const v = validateLoad({ key, amountCents, loadedAt, reference });
  if (!v.ok) return v;
  const idemKey = loadIdemKey({ key: v.key, loadedAt: v.loadedAt, amountCents: v.amountCents, reference: v.reference });
  const entry = buildFloatLoad({ key: v.key, amountCents: v.amountCents, idemKey, reference: v.reference, loadedAt: v.loadedAt, note: note ? String(note).slice(0, 200) : null, by: String(by).slice(0, 40) });
  const posted = await post(entry, { prisma });
  return { ok: true, idemKey, replayed: !!posted?.replayed, journalEntryId: posted?.journalEntryId || null, load: { key: v.key, amountCents: v.amountCents, loadedAt: v.loadedAt, reference: v.reference } };
}

export async function listFloatLoads({ prisma = prismaDefault, key = null, limit = 50 } = {}) {
  const rows = await prisma.journalEntry.findMany({ where: { source: 'FLOAT_LOAD' }, select: { id: true, idemKey: true, createdAt: true, metadata: true }, orderBy: { createdAt: 'desc' }, take: 500 });
  const k = key ? String(key).toUpperCase() : null;
  return rows
    .map((r) => ({ id: r.id, idemKey: r.idemKey, recordedAt: r.createdAt, key: r.metadata?.key || null, amountCents: Number(r.metadata?.amountCents || 0), loadedAt: r.metadata?.loadedAt || null, reference: r.metadata?.reference || null, note: r.metadata?.note || null, by: r.metadata?.by || null }))
    .filter((l) => !k || l.key === k)
    .sort((a, b) => String(b.loadedAt || '').localeCompare(String(a.loadedAt || '')) || b.recordedAt - a.recordedAt)
    .slice(0, limit);
}

/** Loads, usage and the expected balance for one float. Never throws; unknown parts are null. */
export async function floatRecon({ prisma = prismaDefault, key }) {
  const k = String(key || '').toUpperCase();
  const loads = await listFloatLoads({ prisma, key: k, limit: 500 }).catch(() => []);
  const loadedCents = loads.reduce((s, l) => s + l.amountCents, 0);
  const rule = USAGE_RULES[k];
  let usageCents = null; let usageEntries = null;
  if (rule) {
    try {
      const entries = await prisma.journalEntry.findMany({ where: { source: { startsWith: rule.sourcePrefix } }, select: { lines: { select: { accountCode: true, creditCents: true, debitCents: true } } }, take: 5000 });
      usageCents = 0; usageEntries = entries.length;
      for (const e of entries) for (const l of e.lines || []) if (l.accountCode === rule.accountCode) usageCents += (Number(l.creditCents) || 0) - (Number(l.debitCents) || 0);
    } catch {
      usageCents = null;
    }
  }
  return { key: k, loads: loads.length, loadedCents, lastLoad: loads[0] || null, usageCents, usageEntries, expectedCents: usageCents == null ? null : loadedCents - usageCents };
}
