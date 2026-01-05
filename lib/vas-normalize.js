const APP_ALIASES = [
  { tag: 'WHATSAPP', patterns: ['whatsapp', 'whatapp', 'wa ', 'wa-data', 'chat'] },
  { tag: 'TIKTOK', patterns: ['tiktok', 'tik tok', 'tik-tok'] },
  { tag: 'YOUTUBE', patterns: ['youtube', 'yt', 'you tube'] },
  { tag: 'FACEBOOK', patterns: ['facebook', 'fb'] },
  { tag: 'INSTAGRAM', patterns: ['instagram', 'insta', 'ig'] },
  { tag: 'SOCIAL', patterns: ['social', 'social bundle', 'social media'] },
  { tag: 'STREAMING', patterns: ['stream', 'streaming', 'video'] },
];

function sanitize(str = '') {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function inferAppTagsFromName(name = '') {
  const s = sanitize(name);
  const tags = new Set();
  for (const { tag, patterns } of APP_ALIASES) {
    for (const p of patterns) {
      if (s.includes(p.replace(/\s+/g, ' '))) {
        tags.add(tag);
        break;
      }
    }
  }
  return Array.from(tags);
}

export function inferProductTypeFromName(name = '', appTags = []) {
  const s = sanitize(name);
  if (appTags.length > 0) return 'SOCIAL_APP';
  if (/voice|minute|min\b|talk/i.test(name)) return 'VOICE';
  if (/combo|all[-\s]?in|data\s*and\s*minutes/i.test(name)) return 'COMBO';
  if (/night/i.test(name)) return 'NIGHT';
  if (/stream/i.test(name)) return 'STREAMING';
  return 'GENERIC_DATA';
}

export function inferDataMbFromName(name = '') {
  const m = name.match(/(\d+(?:\.\d+)?)\s*(gb|gig|gigs|mb|meg)/i);
  if (!m) return null;
  const qty = parseFloat(m[1]);
  if (!Number.isFinite(qty)) return null;
  const unit = m[2].toLowerCase();
  return unit.startsWith('g') ? Math.round(qty * 1024) : Math.round(qty);
}

export function inferValidityDaysFromName(name = '') {
  const s = sanitize(name);
  if (/\bday\b|\bdaily\b|1d\b|24h\b/.test(s)) return 1;
  if (/\bweek\b|\bweekly\b|7d\b/.test(s)) return 7;
  if (/\bmonth\b|\bmonthly\b|30d\b/.test(s)) return 30;
  if (/\bhour\b|\bhourly\b/.test(s)) return 0; // treated as <1d
  return null;
}

export function inferPeriodTypeFromName(name = '', validityDays = null) {
  const s = sanitize(name);
  if (/\bweekly\b|\bweek\b/.test(s)) return 'WEEKLY';
  if (/\bmonthly\b|\bmonth\b/.test(s)) return 'MONTHLY';
  if (/\bdaily\b|\bday\b/.test(s)) return 'DAILY';
  if (/\bnight\b/.test(s)) return 'NIGHT';
  if (validityDays != null) {
    if (validityDays <= 1) return 'DAILY';
    if (validityDays <= 7) return 'WEEKLY';
    if (validityDays <= 31) return 'MONTHLY';
  }
  return null;
}

export function buildSearchTokens({ name = '', networkCode = '' } = {}) {
  const tokens = new Set();
  const base = sanitize(`${name} ${networkCode}`);
  for (const tok of base.split(/\s+/)) {
    if (tok) tokens.add(tok);
  }
  return Array.from(tokens);
}

export function normalizeBluProduct(p) {
  const dataMb = p.sizeMb ?? inferDataMbFromName(p.name);
  const validityDays = p.validityDays ?? inferValidityDaysFromName(p.name);
  const periodType = p.periodType ?? inferPeriodTypeFromName(p.name, validityDays);
  const appTags = inferAppTagsFromName(p.name);
  const productType = inferProductTypeFromName(p.name, appTags);
  const searchTokens = buildSearchTokens({ name: p.name, networkCode: p.vendorId });
  const priceCents = Number(p.amountCents || p.fixedPriceCents || p.priceCents || 0);
  const valueScore = dataMb && priceCents > 0 ? dataMb / (priceCents / 100) : null;
  const isDataLikely = Boolean(dataMb) || (appTags && appTags.length > 0);

  return {
    dataMb,
    validityDays,
    periodType,
    appTags,
    productType,
    searchTokens,
    valueScore,
    derivedCategory: isDataLikely ? 'DATA' : undefined,
  };
}

export function shouldClarify({ bestScore = 0, secondScore = 0, threshold = 0.72, gap = 0.15 } = {}) {
  if (bestScore < threshold) return true;
  if (secondScore > 0 && bestScore - secondScore < gap) return true;
  return false;
}

