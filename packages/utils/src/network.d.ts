/**
 * Network Inference Utility
 *
 * Infers mobile network from MSISDN prefix
 */
export type NetworkCode = 'VODACOM' | 'MTN' | 'CELL_C' | 'TELKOM' | 'UNKNOWN';
export interface NetworkInfo {
    code: NetworkCode;
    displayName: string;
    apiCode: string;
}
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
export declare function normalizeMSISDN(msisdn: string): string;
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
export declare function inferNetwork(msisdn: string): NetworkCode;
/**
 * Get full network information
 *
 * @param msisdn - Phone number
 * @returns Network info object
 */
export declare function getNetworkInfo(msisdn: string): NetworkInfo;
/**
 * Validate South African MSISDN
 *
 * @param msisdn - Phone number
 * @returns true if valid SA number
 */
export declare function isValidSANumber(msisdn: string): boolean;
/**
 * Format MSISDN for display
 *
 * @param msisdn - Phone number
 * @returns Formatted number (e.g., "082 123 4567")
 */
export declare function formatMSISDN(msisdn: string): string;
