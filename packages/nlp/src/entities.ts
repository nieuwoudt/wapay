/**
 * NLP Entity Extraction
 * 
 * Deterministic extraction of entities from user messages:
 * - Amounts (currency)
 * - Networks (Vodacom, MTN, etc.)
 * - Phone numbers (MSISDNs)
 * - Data quantities (MB/GB)
 * - Operators (betting)
 */

export interface ExtractedAmount {
  cents: number;
  raw: string; // Original text (e.g., "R50", "50 rand")
}

export interface ExtractedNetwork {
  code: 'VODACOM' | 'MTN' | 'CELLC' | 'TELKOM';
  raw: string;
  confidence?: number;
  candidates?: string[];
}

export interface ExtractedMSISDN {
  normalized: string; // +27XXXXXXXXX
  raw: string;
}

export interface ExtractedDataQuantity {
  mb: number;
  raw: string; // "1gb", "500mb"
}

export interface ExtractedOperator {
  code: string; // 'HOLLYWOODBETS', 'BETWAY', etc.
  displayName: string;
  raw: string;
}

/**
 * Extract amount from text
 * 
 * Patterns:
 * - R50, R 50, r50
 * - 50 rand, 50 rands
 * - 50.00, 50,00
 * - fifty rand (future: NLP number parsing)
 */
export function extractAmount(text: string): ExtractedAmount | null {
  const patterns = [
    // R50, R 50, r50
    /(?:r|R)\s*(\d+(?:[.,]\d{2})?)/,
    // 50 rand, 50 rands
    /(\d+(?:[.,]\d{2})?)\s*rands?/i,
    // Just a number (if it's the only thing in the message)
    /^(\d+(?:[.,]\d{2})?)$/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = match[1].replace(',', '.');
      const cents = Math.round(parseFloat(value) * 100);
      if (!isNaN(cents) && cents > 0) {
        return {
          cents,
          raw: match[0],
        };
      }
    }
  }

  return null;
}

const NETWORK_ALIASES: Array<{ code: ExtractedNetwork['code']; aliases: string[] }> = [
  { code: 'VODACOM', aliases: ['vodacom', 'voda', 'vodacomn'] },
  { code: 'MTN', aliases: ['mtn', 'm t n', 'mtnn'] },
  { code: 'CELLC', aliases: ['cellc', 'cell c', 'cell-c', 'celc', 'sell c', 'c c'] },
  { code: 'TELKOM', aliases: ['telkom', 'telcom', 'tellkom', 'telk'] },
];

function sanitize(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function levenshtein(a: string, b: string) {
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

function scoreAlias(input: string, alias: string) {
  const a = sanitize(alias).replace(/\s+/g, '');
  const b = sanitize(input).replace(/\s+/g, '');
  if (!a || !b) return 0;
  if (b === a) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

export function extractNetwork(text: string): ExtractedNetwork | null {
  const tokens = sanitize(text).split(/\s+/).filter(Boolean);
  let best: { code: ExtractedNetwork['code']; score: number; raw: string } | null = null;
  let second = 0;

  for (const tok of tokens.length ? tokens : [sanitize(text)]) {
    for (const { code, aliases } of NETWORK_ALIASES) {
      for (const alias of aliases) {
        const score = scoreAlias(tok, alias);
        if (score > (best?.score ?? 0)) {
          second = best?.score ?? 0;
          best = { code, score, raw: tok };
        } else if (score > second) {
          second = score;
        }
      }
    }
  }

  if (best && best.score >= 0.6) {
    return {
      code: best.code,
      raw: best.raw,
      confidence: best.score,
      candidates: [best.code],
    };
  }

  return null;
}

/**
 * Extract phone number (MSISDN) from text
 * 
 * Patterns:
 * - 0821234567
 * - 082 123 4567
 * - +27 82 123 4567
 * - 27821234567
 */
export function extractMSISDN(text: string): ExtractedMSISDN | null {
  // Extract all digit sequences
  const digitPattern = /(\+?\d[\d\s-]{8,15})/g;
  const matches = text.match(digitPattern);

  if (!matches) return null;

  for (const match of matches) {
    // Remove spaces and dashes
    const cleaned = match.replace(/[\s-]/g, '');
    
    // Check if it looks like a phone number
    if (cleaned.length >= 10 && cleaned.length <= 13) {
      // Normalize to +27XXXXXXXXX
      let normalized = cleaned;
      
      // Remove leading + if present
      if (normalized.startsWith('+')) {
        normalized = normalized.substring(1);
      }
      
      // Remove leading 0 if present
      if (normalized.startsWith('0')) {
        normalized = normalized.substring(1);
      }
      
      // Add 27 if not present
      if (!normalized.startsWith('27')) {
        normalized = '27' + normalized;
      }
      
      // Add + prefix
      normalized = '+' + normalized;
      
      // Validate length
      if (normalized.length === 12) {
        return {
          normalized,
          raw: match,
        };
      }
    }
  }

  return null;
}

/**
 * Extract data quantity from text
 * 
 * Patterns:
 * - 1gb, 1 gb, 1GB
 * - 500mb, 500 mb, 500MB
 * - 2 gig, 2 gigs
 */
export function extractDataQuantity(text: string): ExtractedDataQuantity | null {
  const patterns = [
    // GB patterns
    /(\d+(?:\.\d+)?)\s*(?:gb|gig|gigs?)\b/i,
    // MB patterns
    /(\d+)\s*(?:mb|meg|megs?)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = parseFloat(match[1]);
      let mb: number;

      // Check if it's GB or MB
      const unit = match[0].toLowerCase();
      if (unit.includes('gb') || unit.includes('gig')) {
        mb = Math.round(value * 1024);
      } else {
        mb = Math.round(value);
      }

      if (!isNaN(mb) && mb > 0) {
        return {
          mb,
          raw: match[0],
        };
      }
    }
  }

  return null;
}

/**
 * Extract betting operator from text
 * 
 * Patterns:
 * - hollywoodbets, hollywood bets, Hollywood Bets
 * - betway, Betway
 * - lottostar, lotto star
 * - supabets, supa bets
 */
export function extractBettingOperator(text: string): ExtractedOperator | null {
  const operators: Array<{ patterns: RegExp[]; code: string; displayName: string }> = [
    {
      patterns: [/hollywood\s*bets?/i, /hollywoodbets/i],
      code: 'HOLLYWOODBETS',
      displayName: 'Hollywoodbets',
    },
    {
      patterns: [/betway/i],
      code: 'BETWAY',
      displayName: 'Betway',
    },
    {
      patterns: [/lotto\s*star/i, /lottostar/i],
      code: 'LOTTOSTAR',
      displayName: 'LottoStar',
    },
    {
      patterns: [/supa\s*bets?/i, /supabets/i],
      code: 'SUPABETS',
      displayName: 'Supabets',
    },
    {
      patterns: [/world\s*sports/i, /worldsports/i],
      code: 'WORLDSPORTS',
      displayName: 'World Sports Betting',
    },
  ];

  for (const operator of operators) {
    for (const pattern of operator.patterns) {
      const match = text.match(pattern);
      if (match) {
        return {
          code: operator.code,
          displayName: operator.displayName,
          raw: match[0],
        };
      }
    }
  }

  return null;
}

/**
 * Extract all entities from text
 * 
 * @param text - User message
 * @returns Object with all extracted entities
 */
export function extractAllEntities(text: string) {
  return {
    amount: extractAmount(text),
    network: extractNetwork(text),
    msisdn: extractMSISDN(text),
    dataQuantity: extractDataQuantity(text),
    bettingOperator: extractBettingOperator(text),
  };
}

