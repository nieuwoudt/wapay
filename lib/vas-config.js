/**
 * VAS Category Configuration
 * 
 * Determines which VAS categories are enabled for purchase.
 * Used to control "coming soon" messages and filter available products.
 */

/**
 * LIVE/Not-live toggles for VAS categories.
 * Defaults are conservative; can be overridden via env vars VAS_LIVE_<CATEGORY>.
 */
export const VAS_LIVE = {
  AIRTIME: process.env.VAS_LIVE_AIRTIME ? process.env.VAS_LIVE_AIRTIME === 'true' : true,
  DATA: process.env.VAS_LIVE_DATA ? process.env.VAS_LIVE_DATA === 'true' : true,
  ELECTRICITY: process.env.VAS_LIVE_ELECTRICITY ? process.env.VAS_LIVE_ELECTRICITY === 'true' : true,
  LIFESTYLE: process.env.VAS_LIVE_LIFESTYLE ? process.env.VAS_LIVE_LIFESTYLE === 'true' : false,
  BILLPAY: process.env.VAS_LIVE_BILLPAY ? process.env.VAS_LIVE_BILLPAY === 'true' : false,
  REMITTANCE: process.env.VAS_LIVE_REMITTANCE ? process.env.VAS_LIVE_REMITTANCE === 'true' : false,
  GAMING: process.env.VAS_LIVE_GAMING ? process.env.VAS_LIVE_GAMING === 'true' : false,
  // Fuel (wiCode via UniFuel/Yoyo) is gated on the wiCode PRODUCTION flag —
  // Yoyo test vouchers do not work at pumps, so the customer-facing flow and
  // every real-redemption claim stay off until WAPAY_WICODE_LIVE=true
  // (see lib/spend-catalogue.js and docs/UNIFUEL_INTEGRATION.md).
  FUEL: process.env.WAPAY_WICODE_LIVE === 'true',
};

/**
 * VAS Category Status (derived from LIVE flags)
 * - enabled: Category is live and can be purchased
 * - comingSoon: Category shows as not-yet-live
 * - provider: Which provider handles this category
 */
export const VAS_CATEGORY_CONFIG = {
  AIRTIME: { 
    enabled: !!VAS_LIVE.AIRTIME, 
    provider: 'BLU',
    displayName: 'Mobile Airtime',
  },
  DATA: { 
    enabled: !!VAS_LIVE.DATA, 
    provider: 'BLU',
    displayName: 'Data Bundles',
  },
  ELECTRICITY: { 
    enabled: !!VAS_LIVE.ELECTRICITY, 
    comingSoon: !VAS_LIVE.ELECTRICITY,
    provider: 'BLU',
    displayName: 'Prepaid Electricity',
  },
  LIFESTYLE: { 
    enabled: !!VAS_LIVE.LIFESTYLE, 
    comingSoon: !VAS_LIVE.LIFESTYLE,
    provider: 'BLU',
    displayName: 'Entertainment Vouchers',
  },
  BILLPAY: { 
    enabled: !!VAS_LIVE.BILLPAY, 
    comingSoon: !VAS_LIVE.BILLPAY,
    provider: 'BLU',
    displayName: 'Bill Payments (DStv)',
  },
  GAMING: { 
    enabled: !!VAS_LIVE.GAMING, 
    comingSoon: !VAS_LIVE.GAMING,
    provider: 'BLU',
    displayName: 'Gaming Top-ups',
  },
  REMITTANCE: {
    enabled: !!VAS_LIVE.REMITTANCE,
    comingSoon: !VAS_LIVE.REMITTANCE,
    provider: 'BLU',
    displayName: 'Money Transfers',
  },
  FUEL: {
    enabled: !!VAS_LIVE.FUEL,
    comingSoon: !VAS_LIVE.FUEL,
    provider: 'YOYO',
    displayName: 'Fuel Vouchers',
  },
};

/**
 * Check if a VAS category is enabled for purchase
 * @param {string} category - The category name (AIRTIME, DATA, ELECTRICITY, etc.)
 * @returns {boolean} - Whether the category is enabled
 */
export function isCategoryEnabled(category) {
  const config = VAS_CATEGORY_CONFIG[category];
  return config?.enabled === true;
}

/**
 * Optional per-user allowlist for sensitive categories (e.g., electricity).
 *
 * If VAS_ALLOWLIST_<CATEGORY> is set (comma-separated waIds), only those waIds are allowed
 * even if the category is otherwise enabled.
 *
 * Example:
 * - VAS_ALLOWLIST_ELECTRICITY=27787051175,27760000000
 */
export function isCategoryEnabledForWaId(category, waId) {
  if (!isCategoryEnabled(category)) return false;
  const key = `VAS_ALLOWLIST_${String(category || '').toUpperCase()}`;
  const raw = process.env[key];
  if (!raw) return true; // no allowlist => enabled for everyone
  const allowed = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return true;
  return allowed.includes(String(waId || '').trim());
}

/**
 * Alias for enabled check to make intent gating explicit.
 */
export function isCategoryLive(category) {
  return isCategoryEnabled(category);
}

/**
 * Check if a VAS category is coming soon
 * @param {string} category - The category name
 * @returns {boolean} - Whether the category is marked as coming soon
 */
export function isCategoryComingSoon(category) {
  const config = VAS_CATEGORY_CONFIG[category];
  return config?.comingSoon === true;
}

/**
 * Get display name for a category
 * @param {string} category - The category name
 * @returns {string} - Human-readable name
 */
export function getCategoryDisplayName(category) {
  const config = VAS_CATEGORY_CONFIG[category];
  return config?.displayName || category;
}

/**
 * Get all enabled categories
 * @returns {string[]} - Array of enabled category names
 */
export function getEnabledCategories() {
  return Object.keys(VAS_CATEGORY_CONFIG).filter(cat => 
    VAS_CATEGORY_CONFIG[cat].enabled === true
  );
}

/**
 * Get categories that are live today.
 */
export function getLiveCategories() {
  return Object.keys(VAS_LIVE).filter(cat => VAS_LIVE[cat]);
}

/**
 * Get all categories (for listing)
 * @returns {Array} - Array of category objects with name and config
 */
export function getAllCategories() {
  return Object.entries(VAS_CATEGORY_CONFIG).map(([name, config]) => ({
    name,
    ...config,
  }));
}

