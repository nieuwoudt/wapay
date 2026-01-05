/**
 * Agentic Commerce Slot Parser
 *
 * This is the single shared, deterministic slot parser used across:
 * - all commerce intents (SMART_PRODUCT_QUERY, BUY_AIRTIME, BUY_DATA, etc.)
 * - all conversation states (so users can "jump" with a single message)
 *
 * IMPORTANT: This parser must be called BEFORE routing decisions and BEFORE
 * any conversation state transitions.
 */

import { isValidSaMsisdn, normaliseMsisdn } from './msisdn.js';

export const RETAILERS = [
  'BOXER',
  'CHECKERS',
  'SHOPRITE',
  'USAVE',
  'PICKNPAY',
  'ENGEN',
];

const NETWORK_ALIASES = [
  { code: 'VODACOM', aliases: ['vodacom', 'voda', 'vodacomn'] },
  { code: 'MTN', aliases: ['mtn', 'm t n', 'mtnn'] },
  { code: 'CELLC', aliases: ['cell c', 'cellc', 'cell-c', 'celc', 'sell c', 'c c'] },
  { code: 'TELKOM', aliases: ['telkom', 'telcom', 'tellkom', 'telk'] },
];

function sanitize(text = '') {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function scoreAlias(input, alias) {
  const a = sanitize(alias).replace(/\s+/g, '');
  const b = sanitize(input).replace(/\s+/g, '');
  if (!a || !b) return 0;
  if (b === a) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

function extractAmountCents(text = '') {
  const t = String(text || '').toLowerCase();
  // Accept: "R10", "R 10", "10 rand", "10 rande" (language-ish), and "R10.50"
  const m = t.match(/\br?\s*(\d+(?:[.,]\d{1,2})?)\s*(?:zar|rand|rande)?\b/i);
  if (!m) return null;
  const raw = m[1].replace(',', '.');
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  if (cents <= 0) return null;
  return cents;
}

function extractMsisdn(text = '') {
  // WhatsApp formatting can insert non-digits between digits; be tolerant.
  // Match: 0XXXXXXXXX OR 27XXXXXXXXX OR +27XXXXXXXXX (9 trailing digits)
  const s = String(text || '');
  // IMPORTANT: do NOT allow letters between digits, otherwise we can match the '0' in 'R10 airtime...'
  // and accidentally consume digits later in the sentence.
  const re = /(?:\+?27|0)(?:[^\dA-Za-z]*\d){9}/g;
  const matches = s.match(re);
  if (!matches || matches.length === 0) return null;

  // Prefer last match (e.g., "R10 ... for 084..." should pick number, not amount)
  const raw = matches[matches.length - 1];
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('27') && digits.length === 11) digits = `0${digits.slice(2)}`;

  // Validate using shared MSISDN rules + allowlist
  const normalized = normaliseMsisdn(digits);
  if (!isValidSaMsisdn(normalized)) return null;
  return normalized;
}

function extractMeterNumber(text = '') {
  // Meter numbers tend to be 8-20 digits. Avoid returning an MSISDN.
  const s = String(text || '');
  const candidates = s.match(/\b(\d{8,20})\b/g) || [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    if (c.length === 10 && c.startsWith('0') && isValidSaMsisdn(c)) continue;
    return c;
  }
  return null;
}

function extractRetailer(text = '') {
  const t = String(text || '').toLowerCase();
  if (/(^|\b)(pnp|pick\s*n\s*pay|pick\s*and\s*pay|picknpay)(\b|$)/i.test(t)) return 'PICKNPAY';
  if (/(^|\b)(checkers)(\b|$)/i.test(t)) return 'CHECKERS';
  if (/(^|\b)(shoprite)(\b|$)/i.test(t)) return 'SHOPRITE';
  if (/(^|\b)(u\s*save|usave)(\b|$)/i.test(t)) return 'USAVE';
  if (/(^|\b)(boxer)(\b|$)/i.test(t)) return 'BOXER';
  if (/(^|\b)(engen)(\b|$)/i.test(t)) return 'ENGEN';
  return null;
}

function extractProductHint(text = '') {
  const t = String(text || '').toLowerCase();
  if (/(airtime|prepaid airtime|talk time|imeyili|umoya)/i.test(t)) return 'AIRTIME';
  if (/(data|bundle|bundles|gb|mb)/i.test(t)) return 'DATA';
  if (/(electricity|elec|meter|token|eskom)/i.test(t)) return 'ELECTRICITY';
  if (/(voucher|netflix|showmax|dstv|gift card|giftcard)/i.test(t)) return 'VOUCHER';
  if (/(send\s+money|transfer|remit|remittance|zimbabwe)/i.test(t)) return 'SEND_MONEY';
  // Common shorthand: "Send R30 to 08..." (no explicit "money" word)
  if (/\bsend\b/i.test(t) && /\bto\b/i.test(t)) return 'SEND_MONEY';
  if (/(pay\s+merchant|pay\s+at|scan\s+to\s+pay|retail|shop|boxer|checkers|shoprite|usave|pick\s*n\s*pay|engen)/i.test(t)) return 'RETAIL_PAY';
  return null;
}

function matchNetwork(text = '') {
  const tokens = sanitize(text).split(/\s+/).filter(Boolean);
  let best = null;
  let second = 0;

  for (const tok of tokens.length ? tokens : [sanitize(text)]) {
    for (const { code, aliases } of NETWORK_ALIASES) {
      for (const alias of aliases) {
        const score = scoreAlias(tok, alias);
        if (score > (best?.score || 0)) {
          second = best?.score || 0;
          best = { code, score, raw: tok };
        } else if (score > second) {
          second = score;
        }
      }
    }
  }

  if (best && best.score >= 0.6) {
    return { code: best.code, confidence: best.score, candidates: [best.code] };
  }
  return null;
}

function extractPeriodType(text = '') {
  const t = String(text || '').toLowerCase();
  if (t.includes('daily') || /\bday\b/i.test(t)) return 'DAILY';
  if (t.includes('weekly') || /\bweek\b/i.test(t)) return 'WEEKLY';
  if (t.includes('monthly') || /\bmonth\b/i.test(t)) return 'MONTHLY';
  if (t.includes('night')) return 'NIGHT';
  return null;
}

function extractDataMb(text = '') {
  const t = String(text || '').toLowerCase();
  const m = t.match(/(\d+(?:\.\d+)?)\s*(gb|mb)\b/);
  if (!m) return null;
  const qty = Number(m[1]);
  if (!Number.isFinite(qty)) return null;
  const unit = m[2];
  const mb = unit === 'gb' ? Math.round(qty * 1024) : Math.round(qty);
  return mb > 0 ? mb : null;
}

export function parseSlots(text = '', context = {}) {
  const amountCents = extractAmountCents(text);
  const msisdn = extractMsisdn(text);
  const meterNumber = extractMeterNumber(text);
  const retailer = extractRetailer(text);
  const productHint = extractProductHint(text);
  const networkMatch = matchNetwork(text);
  const networkCode = networkMatch?.code || null;
  const periodType = extractPeriodType(text);
  const dataMb = extractDataMb(text);

  // Basic confidence heuristic: more slots == higher confidence
  const present = [amountCents, msisdn, meterNumber, retailer, productHint].filter(Boolean).length;
  const confidence = Math.min(1, 0.2 + present * 0.15);

  return {
    amountCents,
    msisdn,
    meterNumber,
    retailer,
    productHint,
    currency: 'ZAR',
    dataMb,
    periodType,
    networkCode,
    networkConfidence: networkMatch?.confidence || null,
    networkCandidates: networkMatch?.candidates || [],
    confidence,
    context: context || {},
  };
}


