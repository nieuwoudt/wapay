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
  code: 'VODACOM' | 'MTN' | 'CELL_C' | 'TELKOM';
  raw: string;
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

/**
 * Extract network from text
 * 
 * Patterns:
 * - vodacom, Vodacom, VODACOM
 * - mtn, MTN
 * - cell c, cellc, Cell C
 * - telkom
 */
export function extractNetwork(text: string): ExtractedNetwork | null {
  const networkPatterns: Array<{ pattern: RegExp; code: ExtractedNetwork['code'] }> = [
    { pattern: /vodacom/i, code: 'VODACOM' },
    { pattern: /\bmtn\b/i, code: 'MTN' },
    { pattern: /cell\s*c/i, code: 'CELL_C' },
    { pattern: /cellc/i, code: 'CELL_C' },
    { pattern: /telkom/i, code: 'TELKOM' },
  ];

  for (const { pattern, code } of networkPatterns) {
    const match = text.match(pattern);
    if (match) {
      return {
        code,
        raw: match[0],
      };
    }
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

