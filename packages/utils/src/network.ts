/**
 * Network Inference Utility
 * 
 * Infers mobile network from MSISDN prefix
 */

export type NetworkCode = 'VODACOM' | 'MTN' | 'CELL_C' | 'TELKOM' | 'UNKNOWN';

export interface NetworkInfo {
  code: NetworkCode;
  displayName: string;
  apiCode: string; // Code used in provider APIs
}

/**
 * South African mobile network prefixes
 * Based on ICASA numbering plan
 * 
 * Note: Some prefixes are shared between networks.
 * For production, use HLR lookup for accurate detection.
 * This is a best-effort mapping.
 */
const NETWORK_PREFIXES: Record<string, NetworkCode> = {
  // Vodacom (primary)
  '082': 'VODACOM',
  '083': 'VODACOM', // Shared with MTN
  '084': 'VODACOM', // Shared with MTN/Cell C
  '072': 'VODACOM',
  '073': 'VODACOM',
  '074': 'VODACOM', // Shared with Cell C
  
  // MTN (primary)
  '081': 'MTN', // Shared with Telkom
  '071': 'MTN',
  
  // Note: 083, 084 default to Vodacom above (most common)
  // Note: 074 defaults to Vodacom above
  // Note: 081 defaults to MTN above (most common)
};

const NETWORK_INFO: Record<NetworkCode, NetworkInfo> = {
  VODACOM: {
    code: 'VODACOM',
    displayName: 'Vodacom',
    apiCode: 'VODACOM',
  },
  MTN: {
    code: 'MTN',
    displayName: 'MTN',
    apiCode: 'MTN',
  },
  CELL_C: {
    code: 'CELL_C',
    displayName: 'Cell C',
    apiCode: 'CELLC',
  },
  TELKOM: {
    code: 'TELKOM',
    displayName: 'Telkom Mobile',
    apiCode: 'TELKOM',
  },
  UNKNOWN: {
    code: 'UNKNOWN',
    displayName: 'Unknown Network',
    apiCode: 'UNKNOWN',
  },
};

/**
 * Normalize MSISDN to standard format
 * 
 * @param msisdn - Phone number in various formats
 * @returns Normalized MSISDN starting with +27
 * 
 * @example
 * normalizeMSISDN('0821234567') // '+27821234567'
 * normalizeMSISDN('27821234567') // '+27821234567'
 * normalizeMSISDN('+27821234567') // '+27821234567'
 */
export function normalizeMSISDN(msisdn: string): string {
  // Remove all non-digit characters
  let cleaned = msisdn.replace(/\D/g, '');
  
  // Remove leading zeros
  cleaned = cleaned.replace(/^0+/, '');
  
  // Add country code if missing
  if (!cleaned.startsWith('27')) {
    cleaned = '27' + cleaned;
  }
  
  // Add + prefix
  return '+' + cleaned;
}

/**
 * Infer network from MSISDN
 * 
 * @param msisdn - Phone number (any format)
 * @returns Network code or UNKNOWN
 * 
 * @example
 * inferNetwork('0821234567') // 'VODACOM'
 * inferNetwork('0711234567') // 'MTN'
 */
export function inferNetwork(msisdn: string): NetworkCode {
  const normalized = normalizeMSISDN(msisdn);
  
  // Extract prefix (first 3 digits after +27)
  const prefix = normalized.substring(3, 6); // e.g., +27821234567 -> 821 -> 082
  const prefixWithZero = '0' + prefix.substring(0, 2); // 082
  
  // Look up network
  const network = NETWORK_PREFIXES[prefixWithZero];
  
  // Handle shared prefixes (need HLR lookup in future)
  if (!network) {
    return 'UNKNOWN';
  }
  
  return network;
}

/**
 * Get full network information
 * 
 * @param msisdn - Phone number
 * @returns Network info object
 */
export function getNetworkInfo(msisdn: string): NetworkInfo {
  const code = inferNetwork(msisdn);
  return NETWORK_INFO[code];
}

/**
 * Validate South African MSISDN
 * 
 * @param msisdn - Phone number
 * @returns true if valid SA number
 */
export function isValidSANumber(msisdn: string): boolean {
  const normalized = normalizeMSISDN(msisdn);
  
  // Must be +27XXXXXXXXX (12 chars total)
  if (normalized.length !== 12) {
    return false;
  }
  
  // Must start with +27
  if (!normalized.startsWith('+27')) {
    return false;
  }
  
  // First digit after +27 must be 6, 7, or 8 (mobile)
  const firstDigit = normalized.charAt(3);
  if (!['6', '7', '8'].includes(firstDigit)) {
    return false;
  }
  
  return true;
}

/**
 * Format MSISDN for display
 * 
 * @param msisdn - Phone number
 * @returns Formatted number (e.g., "082 123 4567")
 */
export function formatMSISDN(msisdn: string): string {
  const normalized = normalizeMSISDN(msisdn);
  
  // Remove +27 prefix
  const withoutCountry = normalized.substring(3);
  
  // Format as 0XX XXX XXXX
  return `0${withoutCountry.substring(0, 2)} ${withoutCountry.substring(2, 5)} ${withoutCountry.substring(5)}`;
}

