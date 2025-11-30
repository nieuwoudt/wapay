/**
 * VAS Category Configuration
 * 
 * Determines which VAS categories are enabled for purchase.
 * Used to control "coming soon" messages and filter available products.
 */

/**
 * VAS Category Status
 * - enabled: Category is live and can be purchased
 * - comingSoon: Category shows in catalogue but cannot be purchased yet
 * - provider: Which provider handles this category
 */
export const VAS_CATEGORY_CONFIG = {
  AIRTIME: { 
    enabled: true, 
    provider: 'BLU',
    displayName: 'Mobile Airtime',
  },
  DATA: { 
    enabled: true, 
    provider: 'BLU',
    displayName: 'Data Bundles',
  },
  ELECTRICITY: { 
    enabled: true, 
    provider: 'BLU',
    displayName: 'Prepaid Electricity',
  },
  LIFESTYLE: { 
    enabled: true, 
    provider: 'BLU',
    displayName: 'Lifestyle & OTT Vouchers',
  },
  BILLPAY: { 
    enabled: false, 
    comingSoon: true,
    provider: 'BLU',
    displayName: 'Bill Payments (DStv)',
  },
  GAMING: { 
    enabled: false, 
    comingSoon: true,
    provider: 'BLU',
    displayName: 'Betting & Gaming',
  },
  REMITTANCE: { 
    enabled: false, 
    comingSoon: true,
    provider: 'BLU',
    displayName: 'Money Transfers',
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
 * Get all categories (for listing)
 * @returns {Array} - Array of category objects with name and config
 */
export function getAllCategories() {
  return Object.entries(VAS_CATEGORY_CONFIG).map(([name, config]) => ({
    name,
    ...config,
  }));
}

