/**
 * The personal portal's development fixture (2026-10-21): an in-memory
 * database and fake rails, so the whole portal can be clicked through on
 * `next dev` with no database, no PIN of a real customer and no money.
 *
 * Reached only through lib/app-deps.js when NODE_ENV is 'development',
 * WAPAY_APP_DEV_FIXTURE is '1' and no Vercel variable is present (a
 * production build can never select it), and built from scratch: the shared
 * database client and the real rails are not in this object at all. The
 * pure helpers (fees, limits, the rules, the vault's label reads, link
 * creation) are the real ones, run against the fake tables.
 *
 * The fixture customer: cell 060 000 0919, PIN 2580 (a fake account that
 * exists only in this process's memory). Proofs here are fixture strings the
 * fixture verifier accepts; the real verifier is never replaced outside it.
 *
 * The in-memory client is also what the unit tests use (tests/app-portal.test.mjs).
 */
import crypto from 'node:crypto';
import { validatePINFormat } from '@wapay/auth';
import { quotePayout, methodLimits, payoutAllowedFor, kycRequired, accountKycVerified, passportIdType, PAYOUT_METHODS, SYSTEM_LIMITS_CENTS } from './payouts.js';
import { checkPayoutRules } from './payout-rules.js';
import { readPayoutFreeze } from './payout-freeze.js';
import { listPayoutDestinations, getPayoutIdentity, touchPayoutDestination, forgetPayoutDetails, setPayoutDestinationNickname, DESTINATION_FAMILY, fingerprintOf, destinationLabel, cleanNickname } from './payout-beneficiaries.js';
import { createPaymentRequest, cancelPaymentRequest } from './payment-requests.js';
import { getDepositIntent, depositFeeCents } from './deposits.js';
import { referralCodeFor } from './referrals.js';
import { cashoutFeeCents } from './ledger-core.js';
import { dbLimiter } from './app-auth.js';

// ---------------------------------------------------------------------------
// A small in-memory stand-in for the Prisma client: only the query shapes the
// portal and the libraries it calls actually use.
// ---------------------------------------------------------------------------

const cuid = () => `c${crypto.randomBytes(12).toString('hex')}`;
// A deep copy that keeps Dates as Dates and JSON strings as strings, like the real client.
const clone = (v) => (v == null ? v : structuredClone(v));
const asTime = (v) => (v instanceof Date ? v.getTime() : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);

function cmp(a, b) {
  const x = asTime(a);
  const y = asTime(b);
  if (x === y) return 0;
  if (x == null) return -1;
  if (y == null) return 1;
  return x < y ? -1 : 1;
}

function matchValue(rv, cond) {
  if (cond === null) return rv === null || rv === undefined;
  if (cond instanceof Date) return asTime(rv) === cond.getTime();
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    // A JSON field read by path, as Prisma's { metadata: { path: ['reference'], equals: 'WP…' } } (the pay-out rows).
    if (Array.isArray(cond.path)) {
      let at = rv;
      for (const k of cond.path) at = at == null ? undefined : at[k];
      return 'equals' in cond ? at === cond.equals : at !== undefined;
    }
    for (const [op, v] of Object.entries(cond)) {
      if (op === 'in') { if (!v.includes(rv)) return false; continue; }
      if (op === 'notIn') { if (v.includes(rv)) return false; continue; }
      if (op === 'startsWith') { if (!String(rv ?? '').startsWith(v)) return false; continue; }
      if (op === 'contains') { if (!String(rv ?? '').includes(v)) return false; continue; }
      if (op === 'equals') { if (rv !== v) return false; continue; }
      if (op === 'not') { if (v === null ? rv == null : rv === v) return false; continue; }
      if (op === 'gt') { if (!(cmp(rv, v) > 0)) return false; continue; }
      if (op === 'gte') { if (!(cmp(rv, v) >= 0)) return false; continue; }
      if (op === 'lt') { if (!(cmp(rv, v) < 0)) return false; continue; }
      if (op === 'lte') { if (!(cmp(rv, v) <= 0)) return false; continue; }
      return false;
    }
    return true;
  }
  return rv === cond;
}

export function createMemoryPrisma(seed = {}) {
  const tables = {
    account: [], authFactor: [], wallet: [], journalEntry: [], journalLine: [], providerRequest: [], paymentRequest: [],
    auditLog: [], processedMessage: [], payoutDestination: [], payoutIdentity: [], hold: [], pendingGift: [],
  };
  for (const [k, rows] of Object.entries(seed)) tables[k] = (rows || []).map((r) => ({ ...r }));
  const uniques = {
    account: ['id', 'waId'], authFactor: ['id'], wallet: ['id'], journalEntry: ['id', 'idemKey'], journalLine: ['id'], providerRequest: ['id', 'idemKey'],
    paymentRequest: ['id'], auditLog: ['id'], processedMessage: ['id', 'waMessageId'], payoutDestination: ['id'], payoutIdentity: ['accountId'], hold: ['id'], pendingGift: ['id', 'idemKey'],
  };
  const stamps = { account: 'createdAt', journalEntry: 'createdAt', providerRequest: 'requestTs', paymentRequest: 'createdAt', auditLog: 'timestamp', processedMessage: 'processedAt', payoutDestination: 'createdAt', pendingGift: 'createdAt', authFactor: 'setAt' };
  const relations = {
    journalLine: { entry: (row) => tables.journalEntry.find((e) => e.id === row.entryId) || null },
    account: { authFactors: (row) => tables.authFactor.filter((f) => f.accountId === row.id) },
  };

  function rowMatches(model, row, where = {}) {
    for (const [k, v] of Object.entries(where || {})) {
      if (k === 'OR') { if (!v.some((w) => rowMatches(model, row, w))) return false; continue; }
      if (k === 'AND') { if (!(Array.isArray(v) ? v : [v]).every((w) => rowMatches(model, row, w))) return false; continue; }
      if (k === 'NOT') { if (rowMatches(model, row, v)) return false; continue; }
      if (k === 'accountId_fingerprint') { if (row.accountId !== v.accountId || row.fingerprint !== v.fingerprint) return false; continue; }
      if (k === 'accountId_type') { if (row.accountId !== v.accountId || row.type !== v.type) return false; continue; }
      const rel = relations[model]?.[k];
      if (rel) { const target = rel(row); if (!target || !rowMatches(model === 'journalLine' ? 'journalEntry' : model, target, v)) return false; continue; }
      if (!matchValue(row[k], v)) return false;
    }
    return true;
  }

  function project(model, row, include) {
    const out = clone(row);
    for (const [k, spec] of Object.entries(include || {})) {
      const rel = relations[model]?.[k];
      if (!rel) continue;
      let value = rel(row);
      if (Array.isArray(value) && spec && typeof spec === 'object' && spec.where) value = value.filter((r) => rowMatches('authFactor', r, spec.where));
      out[k] = clone(value);
    }
    return out;
  }

  function sorted(model, rows, orderBy) {
    const list = [...rows];
    const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    list.sort((a, b) => {
      for (const o of orders) {
        const [field, dir] = Object.entries(o)[0];
        let x;
        let y;
        if (dir && typeof dir === 'object') {
          const [sub, d2] = Object.entries(dir)[0];
          const rel = relations[model]?.[field];
          x = rel ? rel(a)?.[sub] : undefined;
          y = rel ? rel(b)?.[sub] : undefined;
          const c = cmp(x, y);
          if (c) return d2 === 'desc' ? -c : c;
          continue;
        }
        const c = cmp(a[field], b[field]);
        if (c) return dir === 'desc' ? -c : c;
      }
      return 0;
    });
    return list;
  }

  function applyData(row, data) {
    for (const [k, v] of Object.entries(data || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && ('increment' in v || 'decrement' in v)) {
        row[k] = (Number(row[k]) || 0) + (Number(v.increment) || 0) - (Number(v.decrement) || 0);
      } else {
        row[k] = v === undefined ? row[k] : clone(v);
      }
    }
    if ('updatedAt' in row && data?.updatedAt === undefined) row.updatedAt = new Date();
    return row;
  }

  function uniqueClash(model, row, ignore = null) {
    for (const f of uniques[model] || []) {
      if (row[f] == null) continue;
      if (tables[model].some((r) => r !== ignore && r[f] === row[f])) return f;
    }
    return null;
  }

  const p2002 = (field) => Object.assign(new Error(`Unique constraint failed on ${field}`), { code: 'P2002' });

  const delegate = (model) => ({
    async findUnique({ where, include } = {}) {
      const row = tables[model].find((r) => rowMatches(model, r, where));
      return row ? project(model, row, include) : null;
    },
    async findFirst({ where, orderBy, include } = {}) {
      const rows = sorted(model, tables[model].filter((r) => rowMatches(model, r, where)), orderBy);
      return rows[0] ? project(model, rows[0], include) : null;
    },
    async findMany({ where, orderBy, take, skip, include } = {}) {
      let rows = sorted(model, tables[model].filter((r) => rowMatches(model, r, where)), orderBy);
      if (skip) rows = rows.slice(skip);
      if (take) rows = rows.slice(0, take);
      return rows.map((r) => project(model, r, include));
    },
    async count({ where } = {}) {
      return tables[model].filter((r) => rowMatches(model, r, where)).length;
    },
    async create({ data, include } = {}) {
      const row = { ...clone(data) };
      if (row.id === undefined && model !== 'payoutIdentity') row.id = cuid();
      const stamp = stamps[model];
      if (stamp && row[stamp] == null) row[stamp] = new Date();
      if (model === 'payoutDestination') { row.lastUsedAt ??= new Date(); row.timesUsed ??= 1; }
      if (model === 'authFactor') { row.attempts ??= 0; row.lockedUntil ??= null; }
      if (model === 'paymentRequest') { row.status ??= 'PENDING'; row.businessId ??= null; row.payerRef ??= null; row.paidAt ??= null; }
      const clash = uniqueClash(model, row);
      if (clash) throw p2002(clash);
      tables[model].push(row);
      return project(model, row, include);
    },
    async update({ where, data, include } = {}) {
      const row = tables[model].find((r) => rowMatches(model, r, where));
      if (!row) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
      applyData(row, data);
      return project(model, row, include);
    },
    async updateMany({ where, data } = {}) {
      const rows = tables[model].filter((r) => rowMatches(model, r, where));
      rows.forEach((r) => applyData(r, data));
      return { count: rows.length };
    },
    async upsert({ where, create, update } = {}) {
      const row = tables[model].find((r) => rowMatches(model, r, where));
      if (row) { applyData(row, update); return clone(row); }
      return this.create({ data: create });
    },
    async deleteMany({ where } = {}) {
      const keep = tables[model].filter((r) => !rowMatches(model, r, where));
      const count = tables[model].length - keep.length;
      tables[model] = keep;
      return { count };
    },
    async delete({ where } = {}) {
      const row = tables[model].find((r) => rowMatches(model, r, where));
      if (!row) throw Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' });
      tables[model] = tables[model].filter((r) => r !== row);
      return clone(row);
    },
  });

  const client = {
    _tables: tables,
    async $transaction(fn) { return typeof fn === 'function' ? fn(client) : Promise.all(fn); },
    async $executeRaw() { return 0; },
    async $queryRaw() { return []; },
  };
  for (const model of Object.keys(tables)) client[model] = delegate(model);
  return client;
}

// ---------------------------------------------------------------------------
// The fixture customer and the fake rails
// ---------------------------------------------------------------------------

export const FIXTURE_CELL = '0600000919';
export const FIXTURE_PIN = '2580';
const ACCOUNT_ID = 'cfixtureaccount000000000001';
const WA = '27600000919';
const day = 24 * 3600 * 1000;

function seed(now = Date.now()) {
  const at = (ms) => new Date(now - ms);
  const wallet = (balanceType, availableCents) => ({ id: cuid(), accountId: ACCOUNT_ID, balanceType, currency: 'ZAR', availableCents, pendingCents: 0, updatedAt: new Date(now) });
  const entries = [];
  const lines = [];
  const entry = (source, idemKey, ms, metadata, walletLines) => {
    const id = cuid();
    entries.push({ id, idemKey, source, metadata, createdAt: at(ms) });
    for (const l of walletLines) lines.push({ id: cuid(), entryId: id, ...l });
  };
  const SPEND = `WALLET:${ACCOUNT_ID}:SPEND`;
  const CASH = `WALLET:${ACCOUNT_ID}:CASH`;
  entry('LOAD_PAYFAST', 'wapay-payreq-PRDEMOAB', 3 * day, { customerFeeCents: 1070 }, [{ accountCode: SPEND, creditCents: 287170 }]);
  entry('BALANCE_UPGRADE', 'payout-x-upgrade', 2 * day + 3600000, {}, [{ accountCode: SPEND, debitCents: 285750 }, { accountCode: CASH, creditCents: 285750 }]);
  entry('CASHOUT_PAYSHAP', `payout-${ACCOUNT_ID}-apo-demo-cashout`, 2 * day, { amountCents: 284900, feeCents: 850, method: 'PAYSHAP' }, [{ accountCode: CASH, debitCents: 285750 }]);
  entry('LOAD_PAYFAST', 'wapay-pfdep-demo1', 1 * day, { customerFeeCents: 700 }, [{ accountCode: SPEND, creditCents: 10000 }]);
  entry('LOAD_PAYFAST', 'wapay-payreq-PRDEMOCD', 4 * 3600000, { customerFeeCents: 1070 }, [{ accountCode: SPEND, creditCents: 279000 }]);
  const spend = 287170 - 285750 + 10000 + 279000;
  return {
    account: [{
      id: ACCOUNT_ID, waId: WA, msisdn: FIXTURE_CELL, displayName: 'Demo Customer', status: 'ACTIVE', onboardingState: 'S5_COMPLETED', onboardingStatus: 'COMPLETED',
      createdAt: at(30 * day), profile: { language: 'en', kyc: { status: 'NONE' } },
    }],
    authFactor: [{ id: cuid(), accountId: ACCOUNT_ID, type: 'PIN', secretHash: 'fixture', attempts: 0, lockedUntil: null, setAt: at(30 * day), updatedAt: at(day) }],
    wallet: [wallet('SPEND', spend), wallet('CASH', 0)],
    journalEntry: entries,
    journalLine: lines,
    providerRequest: [{ id: cuid(), provider: 'OTT', route: 'ott-payout', idemKey: `payout-${ACCOUNT_ID}-apo-demo`, status: 'SUCCESS', accountId: ACCOUNT_ID, requestTs: at(2 * day), metadata: { method: 'PAYSHAP', amountCents: 284900, feeCents: 850, reference: 'WPDEMO000000001', recipient: { name: 'Demo Customer', mobile: '•••0919', account: '•••595' } } }],
    paymentRequest: [
      { id: 'PRDEMOCD', accountId: ACCOUNT_ID, amountCents: 290000, note: 'Rent', status: 'PAID', payerRef: 'PAYFAST:1234567', paidAt: at(4 * 3600000), createdAt: at(5 * 3600000), expiresAt: new Date(now + 6 * day), businessId: null },
      { id: 'PRDEMOEF', accountId: ACCOUNT_ID, amountCents: 25000, note: null, status: 'PENDING', payerRef: null, paidAt: null, createdAt: at(3600000), expiresAt: new Date(now + 7 * day - 3600000), businessId: null },
    ],
    auditLog: [{ id: 'app_link_demo_cd', accountId: ACCOUNT_ID, event: 'APP_LINK_CREATED', metadata: { code: 'PRDEMOCD', label: 'Landlord' }, timestamp: at(5 * 3600000) }],
    payoutDestination: [{ id: 'cfixturedest0000000001', accountId: ACCOUNT_ID, method: 'PAYSHAP', label: 'TymeBank account •••595', nickname: 'Mine', bankName: 'TymeBank', branchCode: '678910', accountEnc: 'fixture', accountLast3: '595', mobileEnc: null, mobileLast3: null, mobileLast4: null, keyVersion: 1, fingerprint: fingerprintOf(ACCOUNT_ID, 'PAYSHAP', '5100000595'), consentAt: at(9 * day), createdAt: at(9 * day), lastUsedAt: at(2 * day), timesUsed: 4 }],
    payoutIdentity: [{ accountId: ACCOUNT_ID, fullName: 'Demo Customer', idType: 'RSAID', idEnc: 'fixture', idLast3: '083', countryOfIssue: null, keyVersion: 1, consentAt: at(9 * day), updatedAt: at(9 * day) }],
  };
}

const fixtureProof = (accountId, intentId, amountCents) => `fixture.${Buffer.from(JSON.stringify({ a: accountId, i: intentId, c: amountCents, t: Date.now() })).toString('base64url')}`;
function fixtureVerifyProof(proof, expect) {
  try {
    const [kind, body] = String(proof || '').split('.');
    if (kind !== 'fixture') return { ok: false, reason: 'BAD_SIGNATURE' };
    const b = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (b.a !== expect.accountId) return { ok: false, reason: 'WRONG_ACCOUNT' };
    if (b.i !== String(expect.intentId)) return { ok: false, reason: 'WRONG_INTENT' };
    if (b.c !== expect.amountCents) return { ok: false, reason: 'WRONG_AMOUNT' };
    if (Date.now() - b.t > 120000) return { ok: false, reason: 'EXPIRED' };
    return { ok: true, via: 'FIXTURE' };
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
}

/** The fixture's dependency object: same shape as realAppDeps(), nothing real behind it. */
export function createFixtureDeps({ now = Date.now() } = {}) {
  const prisma = createMemoryPrisma(seed(now));
  const t = prisma._tables;
  const acc = () => t.account.find((a) => a.id === ACCOUNT_ID);
  const pinState = { pin: FIXTURE_PIN };
  const factor = () => t.authFactor.find((f) => f.accountId === ACCOUNT_ID);
  const wallet = (type) => t.wallet.find((w) => w.accountId === ACCOUNT_ID && w.balanceType === type);
  const mergeProfile = (key, patch) => { const a = acc(); a.profile = { ...(a.profile || {}), [key]: { ...((a.profile || {})[key] || {}), ...patch } }; return true; };

  return {
    prisma,
    limiter: dbLimiter(prisma),
    now: () => Date.now(),
    fixture: { cell: FIXTURE_CELL, pin: FIXTURE_PIN },
    async verifyPIN({ accountId, pin, approves }) {
      const f = factor();
      if (!f || accountId !== ACCOUNT_ID) return { ok: false, error: 'PIN_NOT_SET' };
      if (f.lockedUntil && new Date(f.lockedUntil).getTime() > Date.now()) return { ok: false, error: f.attempts >= 10 ? 'HARD_LOCKOUT' : 'SOFT_LOCKOUT', lockedUntil: f.lockedUntil };
      if (pin !== pinState.pin) {
        f.attempts += 1;
        f.lockedUntil = f.attempts >= 10 ? new Date(Date.now() + 365 * day) : f.attempts >= 5 ? new Date(Date.now() + 15 * 60000) : null;
        return { ok: false, error: 'INVALID_PIN', lockedUntil: f.lockedUntil || undefined };
      }
      f.attempts = 0; f.lockedUntil = null;
      return { ok: true, ...(approves ? { proof: fixtureProof(accountId, approves.intentId, approves.amountCents) } : {}) };
    },
    async setPIN({ accountId, pin }) { if (accountId !== ACCOUNT_ID) return { ok: false }; pinState.pin = pin; const f = factor(); f.setAt = new Date(); f.attempts = 0; f.lockedUntil = null; return { ok: true }; },
    async resetPIN({ accountId, newPin, otpVerified }) { if (!otpVerified || accountId !== ACCOUNT_ID) return { ok: false }; pinState.pin = newPin; const f = factor(); f.setAt = new Date(); f.attempts = 0; f.lockedUntil = null; return { ok: true }; },
    validatePINFormat,
    verifyPinProof: fixtureVerifyProof,
    async requestPayout({ account, intentId, method, amountCents, recipient, authorization }) {
      const v = fixtureVerifyProof(authorization, { accountId: account.id, intentId, amountCents });
      if (!v.ok) return { ok: false, error: 'NOT_AUTHORISED' };
      const idemKey = `payout-${account.id}-${intentId}`;
      const prior = t.providerRequest.find((r) => r.idemKey === idemKey);
      const reference = `WP${crypto.createHash('sha256').update(idemKey).digest('hex').slice(0, 14).toUpperCase()}`;
      if (prior) return { ok: true, replayed: true, status: 'PENDING', reference, amountCents, feeCents: prior.metadata.feeCents };
      const feeCents = cashoutFeeCents(method, amountCents);
      const w = wallet('SPEND');
      if (w.availableCents < amountCents + feeCents) return { ok: false, error: 'INSUFFICIENT_FUNDS', totalCents: amountCents + feeCents };
      w.availableCents -= amountCents + feeCents; w.pendingCents += amountCents + feeCents;
      const masked = { name: `${recipient.firstname} ${recipient.surname}`, mobile: recipient.mobile ? `•••${String(recipient.mobile).slice(-4)}` : null, account: recipient.account_number ? `•••${String(recipient.account_number).slice(-3)}` : null };
      await prisma.providerRequest.create({ data: { provider: 'OTT', route: 'ott-payout', idemKey, status: 'PENDING', accountId: account.id, metadata: { method, amountCents, feeCents, reference, recipient: masked, intentId } } });
      return { ok: true, status: 'PENDING', reference, amountCents, feeCents, outcome: 'PENDING' };
    },
    quotePayout,
    async payoutBalances({ accountId }) { const s = wallet('SPEND')?.availableCents || 0; const c = wallet('CASH')?.availableCents || 0; return { spendCents: s, cashCents: c, totalCents: s + c }; },
    async resolveProviders() {
      return [
        { method: 'PAYSHAP', providerCode: '66', providerName: 'PayShap Account', minCents: SYSTEM_LIMITS_CENTS['PayShap Account'].min, maxCents: SYSTEM_LIMITS_CENTS['PayShap Account'].max, requiredFields: ['firstname', 'surname', 'id_number', 'account_number', 'branch_code', 'mobile'] },
        { method: 'CASHSEND', providerCode: '4', providerName: 'ABSA CashSend', minCents: SYSTEM_LIMITS_CENTS['ABSA CashSend'].min, maxCents: SYSTEM_LIMITS_CENTS['ABSA CashSend'].max, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
        { method: 'NEDCASH', providerCode: '67', providerName: 'Nedbank Cardless Withdrawal', minCents: SYSTEM_LIMITS_CENTS['Nedbank Cardless Withdrawal'].min, maxCents: SYSTEM_LIMITS_CENTS['Nedbank Cardless Withdrawal'].max, requiredFields: ['firstname', 'surname', 'id_number', 'mobile'] },
      ];
    },
    methodLimits,
    payoutEnabled: () => true,
    payoutAllowedFor: () => true,
    payoutConfigured: () => true,
    kycRequired: () => false,
    accountKycVerified,
    passportIdType,
    PAYOUT_METHODS,
    checkPayoutRules,
    kycConfigured: () => true,
    readPayoutFreeze,
    listPayoutDestinations,
    async loadPayoutDestinationSecret({ accountId, id }) {
      const r = t.payoutDestination.find((d) => d.id === id && d.accountId === accountId);
      if (!r) return null;
      const out = { id: r.id, method: r.method, family: DESTINATION_FAMILY[r.method], label: r.nickname ? `${r.nickname}: ${r.label}` : r.label, nickname: r.nickname };
      return DESTINATION_FAMILY[r.method] === 'BANK' ? { ...out, account_number: `5100000${r.accountLast3}`, branch_code: r.branchCode, branch_name: r.bankName } : { ...out, mobile: `2760000${r.mobileLast4 || '0919'}` };
    },
    async loadPayoutIdentitySecret({ accountId }) { const r = t.payoutIdentity.find((i) => i.accountId === accountId); return r ? { fullName: r.fullName, idType: r.idType, countryOfIssue: r.countryOfIssue, idNumber: `9001015800${r.idLast3}` } : null; },
    async loadPayoutIdentitySecretStrict({ accountId }) { const r = t.payoutIdentity.find((i) => i.accountId === accountId); return r ? { fullName: r.fullName, idType: r.idType, countryOfIssue: r.countryOfIssue, idNumber: `9001015800${r.idLast3}` } : null; },
    getPayoutIdentity,
    async savePayoutDestination({ accountId, method, recipient, nickname }) {
      const family = DESTINATION_FAMILY[method];
      const number = family === 'BANK' ? recipient.account_number : recipient.mobile;
      const row = await prisma.payoutDestination.create({ data: { accountId, method, label: destinationLabel(method, recipient), nickname: cleanNickname(nickname), bankName: recipient.branch_name || null, branchCode: recipient.branch_code || null, accountEnc: family === 'BANK' ? 'fixture' : null, accountLast3: family === 'BANK' ? String(number).slice(-3) : null, mobileEnc: family === 'CASH' ? 'fixture' : null, mobileLast3: family === 'CASH' ? String(number).slice(-3) : null, mobileLast4: family === 'CASH' ? String(number).slice(-4) : null, keyVersion: 1, fingerprint: fingerprintOf(accountId, method, number), consentAt: new Date() } });
      return { ok: true, id: row.id, label: row.nickname ? `${row.nickname}: ${row.label}` : row.label };
    },
    async savePayoutIdentity({ accountId, fullName, idNumber, idType, countryOfIssue }) {
      await prisma.payoutIdentity.upsert({ where: { accountId }, create: { accountId, fullName, idType, idEnc: 'fixture', idLast3: String(idNumber).slice(-3), countryOfIssue, keyVersion: 1, consentAt: new Date(), updatedAt: new Date() }, update: { fullName } });
      return { ok: true };
    },
    touchPayoutDestination,
    forgetPayoutDetails,
    setPayoutDestinationNickname,
    beneficiariesAvailable: () => true,
    createPaymentRequest,
    cancelPaymentRequest,
    async sendMoney({ sender, previewId, recipientMsisdn, amountCents, authorization }) {
      const v = fixtureVerifyProof(authorization, { accountId: sender.id, intentId: previewId, amountCents });
      if (!v.ok) return { ok: false, error: 'NOT_AUTHORISED' };
      const w = wallet('SPEND');
      if (w.availableCents < amountCents) return { ok: false, error: 'INSUFFICIENT_FUNDS' };
      w.availableCents -= amountCents;
      const e = await prisma.journalEntry.create({ data: { idemKey: `gift-held-gift-${previewId}`, source: 'GIFT_HELD', metadata: { amountCents, recipientMasked: `${recipientMsisdn.slice(0, 3)}•••${recipientMsisdn.slice(-3)}` } } });
      await prisma.journalLine.create({ data: { entryId: e.id, accountCode: `WALLET:${sender.id}:SPEND`, debitCents: amountCents } });
      return { ok: true, delivered: 'HELD', amountCents, giftId: `gift-${previewId}` };
    },
    async startKycSession() { mergeProfile('kyc', { status: 'VERIFIED', fullName: 'Demo Customer', verifiedAt: new Date().toISOString() }); return { ok: true, url: '/app/pay-out?kyc=done' }; },
    async rememberPendingWithdraw({ ask }) { return mergeProfile('kyc', { pendingWithdraw: { ...ask, at: new Date().toISOString() } }); },
    async clearPendingWithdraw() { return mergeProfile('kyc', { pendingWithdraw: null }); },
    async ensureReferralCode({ accountId }) { const code = referralCodeFor(accountId); mergeProfile('referral', { code }); return code; },
    async createDepositIntent({ accountId, waId, amountCents }) {
      const feeCents = depositFeeCents(amountCents);
      const id = cuid();
      await prisma.providerRequest.create({ data: { id, provider: 'PAYFAST', route: 'deposit', idemKey: `wapay-pfdep-${id}`, status: 'PENDING', accountId, metadata: { accountId, waId, amountCents, feeCents, grossCents: amountCents + feeCents } } });
      return { paymentId: id, idemKey: `wapay-pfdep-${id}`, feeCents, grossCents: amountCents + feeCents };
    },
    getDepositIntent,
    buildCheckoutUrl({ mPaymentId, returnUrl }) {
      // The fixture "pays" at once: the intent is marked paid and the wallet credited, then the browser goes to the return page.
      const row = t.providerRequest.find((r) => r.id === mPaymentId);
      if (row && row.status === 'PENDING') {
        row.status = 'SUCCESS';
        wallet('SPEND').availableCents += row.metadata.amountCents;
        prisma.journalEntry.create({ data: { idemKey: row.idemKey, source: 'LOAD_PAYFAST', metadata: { customerFeeCents: row.metadata.feeCents } } })
          .then((e) => prisma.journalLine.create({ data: { entryId: e.id, accountCode: `WALLET:${ACCOUNT_ID}:SPEND`, creditCents: row.metadata.amountCents } }));
      }
      return String(returnUrl).replace(/^https?:\/\/[^/]+/, '');
    },
    async mergeProfileSubkey({ key, patch }) { return mergeProfile(key, patch); },
  };
}
