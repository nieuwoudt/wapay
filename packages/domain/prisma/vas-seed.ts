/**
 * VAS Product Catalogue Seed Data
 * 
 * Based on Blu VAS product catalogue and Top 10 spreadsheet.
 * Categories: AIRTIME, DATA, ELECTRICITY, LIFESTYLE, BILLPAY, REMITTANCE, GAMING
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ==============================================================================
// AIRTIME PRODUCTS (PINNED - Fixed denominations)
// ==============================================================================
const AIRTIME_PRODUCTS = [
  // Vodacom Airtime
  { networkCode: 'VODACOM', externalCode: 'VODA_AIR_5', label: 'Vodacom R5 Airtime', fixedPriceCents: 500 },
  { networkCode: 'VODACOM', externalCode: 'VODA_AIR_10', label: 'Vodacom R10 Airtime', fixedPriceCents: 1000 },
  { networkCode: 'VODACOM', externalCode: 'VODA_AIR_15', label: 'Vodacom R15 Airtime', fixedPriceCents: 1500 },
  { networkCode: 'VODACOM', externalCode: 'VODA_AIR_25', label: 'Vodacom R25 Airtime', fixedPriceCents: 2500 },
  { networkCode: 'VODACOM', externalCode: 'VODA_AIR_35', label: 'Vodacom R35 Airtime', fixedPriceCents: 3500 },
  { networkCode: 'VODACOM', externalCode: 'VODA_AIR_50', label: 'Vodacom R50 Airtime', fixedPriceCents: 5000 },
  { networkCode: 'VODACOM', externalCode: 'VODA_AIR_100', label: 'Vodacom R100 Airtime', fixedPriceCents: 10000 },
  { networkCode: 'VODACOM', externalCode: 'VODA_AIR_200', label: 'Vodacom R200 Airtime', fixedPriceCents: 20000 },
  
  // MTN Airtime
  { networkCode: 'MTN', externalCode: 'MTN_AIR_5', label: 'MTN R5 Airtime', fixedPriceCents: 500 },
  { networkCode: 'MTN', externalCode: 'MTN_AIR_10', label: 'MTN R10 Airtime', fixedPriceCents: 1000 },
  { networkCode: 'MTN', externalCode: 'MTN_AIR_15', label: 'MTN R15 Airtime', fixedPriceCents: 1500 },
  { networkCode: 'MTN', externalCode: 'MTN_AIR_25', label: 'MTN R25 Airtime', fixedPriceCents: 2500 },
  { networkCode: 'MTN', externalCode: 'MTN_AIR_35', label: 'MTN R35 Airtime', fixedPriceCents: 3500 },
  { networkCode: 'MTN', externalCode: 'MTN_AIR_50', label: 'MTN R50 Airtime', fixedPriceCents: 5000 },
  { networkCode: 'MTN', externalCode: 'MTN_AIR_100', label: 'MTN R100 Airtime', fixedPriceCents: 10000 },
  { networkCode: 'MTN', externalCode: 'MTN_AIR_200', label: 'MTN R200 Airtime', fixedPriceCents: 20000 },
  
  // Cell C Airtime
  { networkCode: 'CELLC', externalCode: 'CELLC_AIR_5', label: 'Cell C R5 Airtime', fixedPriceCents: 500 },
  { networkCode: 'CELLC', externalCode: 'CELLC_AIR_10', label: 'Cell C R10 Airtime', fixedPriceCents: 1000 },
  { networkCode: 'CELLC', externalCode: 'CELLC_AIR_25', label: 'Cell C R25 Airtime', fixedPriceCents: 2500 },
  { networkCode: 'CELLC', externalCode: 'CELLC_AIR_50', label: 'Cell C R50 Airtime', fixedPriceCents: 5000 },
  { networkCode: 'CELLC', externalCode: 'CELLC_AIR_100', label: 'Cell C R100 Airtime', fixedPriceCents: 10000 },
  
  // Telkom Airtime
  { networkCode: 'TELKOM', externalCode: 'TELK_AIR_5', label: 'Telkom R5 Airtime', fixedPriceCents: 500 },
  { networkCode: 'TELKOM', externalCode: 'TELK_AIR_10', label: 'Telkom R10 Airtime', fixedPriceCents: 1000 },
  { networkCode: 'TELKOM', externalCode: 'TELK_AIR_25', label: 'Telkom R25 Airtime', fixedPriceCents: 2500 },
  { networkCode: 'TELKOM', externalCode: 'TELK_AIR_50', label: 'Telkom R50 Airtime', fixedPriceCents: 5000 },
  { networkCode: 'TELKOM', externalCode: 'TELK_AIR_100', label: 'Telkom R100 Airtime', fixedPriceCents: 10000 },
];

// ==============================================================================
// DATA BUNDLES
// ==============================================================================
const DATA_BUNDLES = [
  // Vodacom Daily Bundles
  { networkCode: 'VODACOM', externalCode: 'VODA_DATA_50MB_1D', label: 'Vodacom 50MB Daily', fixedPriceCents: 500, dataMb: 50, periodType: 'DAILY', validityDays: 1 },
  { networkCode: 'VODACOM', externalCode: 'VODA_DATA_100MB_1D', label: 'Vodacom 100MB Daily', fixedPriceCents: 1000, dataMb: 100, periodType: 'DAILY', validityDays: 1 },
  { networkCode: 'VODACOM', externalCode: 'VODA_DATA_250MB_1D', label: 'Vodacom 250MB Daily', fixedPriceCents: 1500, dataMb: 250, periodType: 'DAILY', validityDays: 1 },
  
  // Vodacom Weekly Bundles
  { networkCode: 'VODACOM', externalCode: 'VODA_DATA_350MB_7D', label: 'Vodacom 350MB Weekly', fixedPriceCents: 2900, dataMb: 350, periodType: 'WEEKLY', validityDays: 7 },
  { networkCode: 'VODACOM', externalCode: 'VODA_DATA_500MB_7D', label: 'Vodacom 500MB Weekly', fixedPriceCents: 4900, dataMb: 500, periodType: 'WEEKLY', validityDays: 7 },
  { networkCode: 'VODACOM', externalCode: 'VODA_DATA_1GB_7D', label: 'Vodacom 1GB Weekly', fixedPriceCents: 7900, dataMb: 1024, periodType: 'WEEKLY', validityDays: 7 },
  { networkCode: 'VODACOM', externalCode: 'VODA_DATA_2GB_7D', label: 'Vodacom 2GB Weekly', fixedPriceCents: 9900, dataMb: 2048, periodType: 'WEEKLY', validityDays: 7 },
  
  // Vodacom Monthly Bundles
  { networkCode: 'VODACOM', externalCode: 'VODA_DATA_1GB_30D', label: 'Vodacom 1GB Monthly', fixedPriceCents: 14900, dataMb: 1024, periodType: 'MONTHLY', validityDays: 30 },
  { networkCode: 'VODACOM', externalCode: 'VODA_DATA_2GB_30D', label: 'Vodacom 2GB Monthly', fixedPriceCents: 24900, dataMb: 2048, periodType: 'MONTHLY', validityDays: 30 },
  { networkCode: 'VODACOM', externalCode: 'VODA_DATA_5GB_30D', label: 'Vodacom 5GB Monthly', fixedPriceCents: 39900, dataMb: 5120, periodType: 'MONTHLY', validityDays: 30 },
  { networkCode: 'VODACOM', externalCode: 'VODA_DATA_10GB_30D', label: 'Vodacom 10GB Monthly', fixedPriceCents: 69900, dataMb: 10240, periodType: 'MONTHLY', validityDays: 30 },
  
  // MTN Daily Bundles
  { networkCode: 'MTN', externalCode: 'MTN_DATA_30MB_1D', label: 'MTN 30MB Daily', fixedPriceCents: 400, dataMb: 30, periodType: 'DAILY', validityDays: 1 },
  { networkCode: 'MTN', externalCode: 'MTN_DATA_100MB_1D', label: 'MTN 100MB Daily', fixedPriceCents: 1000, dataMb: 100, periodType: 'DAILY', validityDays: 1 },
  { networkCode: 'MTN', externalCode: 'MTN_DATA_250MB_1D', label: 'MTN 250MB Daily', fixedPriceCents: 1500, dataMb: 250, periodType: 'DAILY', validityDays: 1 },
  
  // MTN Weekly Bundles
  { networkCode: 'MTN', externalCode: 'MTN_DATA_350MB_7D', label: 'MTN 350MB Weekly', fixedPriceCents: 2500, dataMb: 350, periodType: 'WEEKLY', validityDays: 7 },
  { networkCode: 'MTN', externalCode: 'MTN_DATA_750MB_7D', label: 'MTN 750MB Weekly', fixedPriceCents: 5000, dataMb: 750, periodType: 'WEEKLY', validityDays: 7 },
  { networkCode: 'MTN', externalCode: 'MTN_DATA_1GB_7D', label: 'MTN 1GB Weekly', fixedPriceCents: 7500, dataMb: 1024, periodType: 'WEEKLY', validityDays: 7 },
  { networkCode: 'MTN', externalCode: 'MTN_DATA_2GB_7D', label: 'MTN 2GB Weekly', fixedPriceCents: 9900, dataMb: 2048, periodType: 'WEEKLY', validityDays: 7 },
  
  // MTN Monthly Bundles
  { networkCode: 'MTN', externalCode: 'MTN_DATA_1GB_30D', label: 'MTN 1GB Monthly', fixedPriceCents: 14500, dataMb: 1024, periodType: 'MONTHLY', validityDays: 30 },
  { networkCode: 'MTN', externalCode: 'MTN_DATA_2GB_30D', label: 'MTN 2GB Monthly', fixedPriceCents: 24500, dataMb: 2048, periodType: 'MONTHLY', validityDays: 30 },
  { networkCode: 'MTN', externalCode: 'MTN_DATA_5GB_30D', label: 'MTN 5GB Monthly', fixedPriceCents: 39900, dataMb: 5120, periodType: 'MONTHLY', validityDays: 30 },
  { networkCode: 'MTN', externalCode: 'MTN_DATA_10GB_30D', label: 'MTN 10GB Monthly', fixedPriceCents: 69900, dataMb: 10240, periodType: 'MONTHLY', validityDays: 30 },
  
  // Cell C Bundles
  { networkCode: 'CELLC', externalCode: 'CELLC_DATA_100MB_1D', label: 'Cell C 100MB Daily', fixedPriceCents: 900, dataMb: 100, periodType: 'DAILY', validityDays: 1 },
  { networkCode: 'CELLC', externalCode: 'CELLC_DATA_500MB_7D', label: 'Cell C 500MB Weekly', fixedPriceCents: 4500, dataMb: 500, periodType: 'WEEKLY', validityDays: 7 },
  { networkCode: 'CELLC', externalCode: 'CELLC_DATA_1GB_7D', label: 'Cell C 1GB Weekly', fixedPriceCents: 7000, dataMb: 1024, periodType: 'WEEKLY', validityDays: 7 },
  { networkCode: 'CELLC', externalCode: 'CELLC_DATA_1GB_30D', label: 'Cell C 1GB Monthly', fixedPriceCents: 13900, dataMb: 1024, periodType: 'MONTHLY', validityDays: 30 },
  { networkCode: 'CELLC', externalCode: 'CELLC_DATA_5GB_30D', label: 'Cell C 5GB Monthly', fixedPriceCents: 37900, dataMb: 5120, periodType: 'MONTHLY', validityDays: 30 },
  
  // Telkom Bundles
  { networkCode: 'TELKOM', externalCode: 'TELK_DATA_100MB_1D', label: 'Telkom 100MB Daily', fixedPriceCents: 800, dataMb: 100, periodType: 'DAILY', validityDays: 1 },
  { networkCode: 'TELKOM', externalCode: 'TELK_DATA_500MB_7D', label: 'Telkom 500MB Weekly', fixedPriceCents: 4000, dataMb: 500, periodType: 'WEEKLY', validityDays: 7 },
  { networkCode: 'TELKOM', externalCode: 'TELK_DATA_1GB_7D', label: 'Telkom 1GB Weekly', fixedPriceCents: 6500, dataMb: 1024, periodType: 'WEEKLY', validityDays: 7 },
  { networkCode: 'TELKOM', externalCode: 'TELK_DATA_1GB_30D', label: 'Telkom 1GB Monthly', fixedPriceCents: 12900, dataMb: 1024, periodType: 'MONTHLY', validityDays: 30 },
  { networkCode: 'TELKOM', externalCode: 'TELK_DATA_5GB_30D', label: 'Telkom 5GB Monthly', fixedPriceCents: 34900, dataMb: 5120, periodType: 'MONTHLY', validityDays: 30 },
];

// ==============================================================================
// ELECTRICITY PRODUCTS
// ==============================================================================
const ELECTRICITY_PRODUCTS = [
  { operatorCode: 'ESKOMDIRECT', externalCode: 'ESKOM_ELEC', label: 'Eskom Prepaid Electricity', minCents: 1000, maxCents: 500000, stepCents: 100 },
  { operatorCode: 'CAPETOWN', externalCode: 'CPT_ELEC', label: 'Cape Town Electricity', minCents: 1000, maxCents: 500000, stepCents: 100 },
  { operatorCode: 'EKURHULENI', externalCode: 'EKU_ELEC', label: 'Ekurhuleni Electricity', minCents: 1000, maxCents: 500000, stepCents: 100 },
  { operatorCode: 'TSHWANE', externalCode: 'TSH_ELEC', label: 'Tshwane Electricity', minCents: 1000, maxCents: 500000, stepCents: 100 },
  { operatorCode: 'CITYPOWER', externalCode: 'CITYP_ELEC', label: 'City Power (Johannesburg)', minCents: 1000, maxCents: 500000, stepCents: 100 },
  { operatorCode: 'CITIQ', externalCode: 'CITIQ_ELEC', label: 'CiTiQ Prepaid', minCents: 1000, maxCents: 500000, stepCents: 100 },
  { operatorCode: 'PREPAIDWORLD', externalCode: 'PPW_ELEC', label: 'Prepaid World', minCents: 1000, maxCents: 500000, stepCents: 100 },
  { operatorCode: 'SYNTELL', externalCode: 'SYNTELL_ELEC', label: 'Syntell Private Utilities', minCents: 1000, maxCents: 500000, stepCents: 100 },
  { operatorCode: 'CENTLEC', externalCode: 'CENTLEC_ELEC', label: 'Centlec (Free State)', minCents: 1000, maxCents: 500000, stepCents: 100 },
  { operatorCode: 'LANDIS', externalCode: 'LANDIS_ELEC', label: 'Landis+Gyr Vending', minCents: 1000, maxCents: 500000, stepCents: 100 },
];

// ==============================================================================
// LIFESTYLE / OTT VOUCHERS
// ==============================================================================
const LIFESTYLE_PRODUCTS = [
  // Google Play
  { operatorCode: 'GOOGLEPLAY', externalCode: 'GPLAY_25', label: 'Google Play R25 Voucher', fixedPriceCents: 2500 },
  { operatorCode: 'GOOGLEPLAY', externalCode: 'GPLAY_50', label: 'Google Play R50 Voucher', fixedPriceCents: 5000 },
  { operatorCode: 'GOOGLEPLAY', externalCode: 'GPLAY_100', label: 'Google Play R100 Voucher', fixedPriceCents: 10000 },
  { operatorCode: 'GOOGLEPLAY', externalCode: 'GPLAY_200', label: 'Google Play R200 Voucher', fixedPriceCents: 20000 },
  
  // Netflix
  { operatorCode: 'NETFLIX', externalCode: 'NETFLIX_100', label: 'Netflix R100 Gift Card', fixedPriceCents: 10000 },
  { operatorCode: 'NETFLIX', externalCode: 'NETFLIX_200', label: 'Netflix R200 Gift Card', fixedPriceCents: 20000 },
  { operatorCode: 'NETFLIX', externalCode: 'NETFLIX_500', label: 'Netflix R500 Gift Card', fixedPriceCents: 50000 },
  
  // Uber
  { operatorCode: 'UBER', externalCode: 'UBER_50', label: 'Uber R50 Voucher', fixedPriceCents: 5000 },
  { operatorCode: 'UBER', externalCode: 'UBER_100', label: 'Uber R100 Voucher', fixedPriceCents: 10000 },
  { operatorCode: 'UBER', externalCode: 'UBER_200', label: 'Uber R200 Voucher', fixedPriceCents: 20000 },
  
  // PlayStation
  { operatorCode: 'PLAYSTATION', externalCode: 'PSN_100', label: 'PlayStation Store R100', fixedPriceCents: 10000 },
  { operatorCode: 'PLAYSTATION', externalCode: 'PSN_200', label: 'PlayStation Store R200', fixedPriceCents: 20000 },
  { operatorCode: 'PLAYSTATION', externalCode: 'PSN_500', label: 'PlayStation Store R500', fixedPriceCents: 50000 },
  
  // Steam
  { operatorCode: 'STEAM', externalCode: 'STEAM_50', label: 'Steam Wallet R50', fixedPriceCents: 5000 },
  { operatorCode: 'STEAM', externalCode: 'STEAM_100', label: 'Steam Wallet R100', fixedPriceCents: 10000 },
  { operatorCode: 'STEAM', externalCode: 'STEAM_200', label: 'Steam Wallet R200', fixedPriceCents: 20000 },
  
  // Showmax
  { operatorCode: 'SHOWMAX', externalCode: 'SHOWMAX_99', label: 'Showmax Monthly R99', fixedPriceCents: 9900 },
  { operatorCode: 'SHOWMAX', externalCode: 'SHOWMAX_225', label: 'Showmax Pro Monthly R225', fixedPriceCents: 22500 },
];

// ==============================================================================
// BILLPAY / PAYTV
// ==============================================================================
const BILLPAY_PRODUCTS = [
  // DStv
  { operatorCode: 'DSTV', externalCode: 'DSTV_PAYMENT', label: 'DStv Account Payment', minCents: 1000, maxCents: 500000, stepCents: 100 },
  { operatorCode: 'DSTV', externalCode: 'DSTV_ACCESS', label: 'DStv Access R115', fixedPriceCents: 11500 },
  { operatorCode: 'DSTV', externalCode: 'DSTV_FAMILY', label: 'DStv Family R295', fixedPriceCents: 29500 },
  { operatorCode: 'DSTV', externalCode: 'DSTV_COMPACT', label: 'DStv Compact R499', fixedPriceCents: 49900 },
  { operatorCode: 'DSTV', externalCode: 'DSTV_COMPACT_PLUS', label: 'DStv Compact Plus R699', fixedPriceCents: 69900 },
  { operatorCode: 'DSTV', externalCode: 'DSTV_PREMIUM', label: 'DStv Premium R879', fixedPriceCents: 87900 },
  
  // GOtv
  { operatorCode: 'GOTV', externalCode: 'GOTV_LITE', label: 'GOtv Lite R60', fixedPriceCents: 6000 },
  { operatorCode: 'GOTV', externalCode: 'GOTV_VALUE', label: 'GOtv Value R125', fixedPriceCents: 12500 },
  { operatorCode: 'GOTV', externalCode: 'GOTV_PLUS', label: 'GOtv Plus R245', fixedPriceCents: 24500 },
  
  // EasyPay
  { operatorCode: 'EASYPAY', externalCode: 'EASYPAY_BILL', label: 'EasyPay Bill Payment', minCents: 1000, maxCents: 1000000, stepCents: 100 },
];

// ==============================================================================
// REMITTANCE
// ==============================================================================
const REMITTANCE_PRODUCTS = [
  { operatorCode: 'MUKURU', externalCode: 'MUKURU_SEND', label: 'Mukuru Money Transfer', minCents: 10000, maxCents: 1000000, stepCents: 100 },
  { operatorCode: 'HELLOPAISA', externalCode: 'HELLOPAISA_SEND', label: 'Hello Paisa Transfer', minCents: 10000, maxCents: 1000000, stepCents: 100 },
  { operatorCode: 'MAMAMONEY', externalCode: 'MAMA_SEND', label: 'Mama Money Transfer', minCents: 10000, maxCents: 1000000, stepCents: 100 },
  { operatorCode: 'HOMEREMIT', externalCode: 'HOMEREMIT_SEND', label: 'Home Remit Transfer', minCents: 10000, maxCents: 1000000, stepCents: 100 },
  { operatorCode: 'SIKHONA', externalCode: 'SIKHONA_SEND', label: 'Sikhona Forex Transfer', minCents: 10000, maxCents: 1000000, stepCents: 100 },
];

// ==============================================================================
// GAMING / BETTING
// ==============================================================================
const GAMING_PRODUCTS = [
  // Hollywoodbets
  { operatorCode: 'HOLLYWOODBETS', externalCode: 'HWBETS_10', label: 'Hollywoodbets R10 Top-up', fixedPriceCents: 1000 },
  { operatorCode: 'HOLLYWOODBETS', externalCode: 'HWBETS_20', label: 'Hollywoodbets R20 Top-up', fixedPriceCents: 2000 },
  { operatorCode: 'HOLLYWOODBETS', externalCode: 'HWBETS_50', label: 'Hollywoodbets R50 Top-up', fixedPriceCents: 5000 },
  { operatorCode: 'HOLLYWOODBETS', externalCode: 'HWBETS_100', label: 'Hollywoodbets R100 Top-up', fixedPriceCents: 10000 },
  { operatorCode: 'HOLLYWOODBETS', externalCode: 'HWBETS_200', label: 'Hollywoodbets R200 Top-up', fixedPriceCents: 20000 },
  
  // Lottostar
  { operatorCode: 'LOTTOSTAR', externalCode: 'LOTTO_10', label: 'Lottostar R10 Top-up', fixedPriceCents: 1000 },
  { operatorCode: 'LOTTOSTAR', externalCode: 'LOTTO_20', label: 'Lottostar R20 Top-up', fixedPriceCents: 2000 },
  { operatorCode: 'LOTTOSTAR', externalCode: 'LOTTO_50', label: 'Lottostar R50 Top-up', fixedPriceCents: 5000 },
  { operatorCode: 'LOTTOSTAR', externalCode: 'LOTTO_100', label: 'Lottostar R100 Top-up', fixedPriceCents: 10000 },
  
  // Supersportbet
  { operatorCode: 'SUPERSPORTBET', externalCode: 'SSB_10', label: 'SuperSportBet R10 Top-up', fixedPriceCents: 1000 },
  { operatorCode: 'SUPERSPORTBET', externalCode: 'SSB_20', label: 'SuperSportBet R20 Top-up', fixedPriceCents: 2000 },
  { operatorCode: 'SUPERSPORTBET', externalCode: 'SSB_50', label: 'SuperSportBet R50 Top-up', fixedPriceCents: 5000 },
  { operatorCode: 'SUPERSPORTBET', externalCode: 'SSB_100', label: 'SuperSportBet R100 Top-up', fixedPriceCents: 10000 },
  
  // Betway
  { operatorCode: 'BETWAY', externalCode: 'BETWAY_10', label: 'Betway R10 Top-up', fixedPriceCents: 1000 },
  { operatorCode: 'BETWAY', externalCode: 'BETWAY_50', label: 'Betway R50 Top-up', fixedPriceCents: 5000 },
  { operatorCode: 'BETWAY', externalCode: 'BETWAY_100', label: 'Betway R100 Top-up', fixedPriceCents: 10000 },
];

// ==============================================================================
// TOP 10 POPULAR PRODUCTS (for "What VAS products can I buy?")
// ==============================================================================
const TOP_10_PRODUCTS = [
  'VODA_AIR_10',   // 1. Vodacom Airtime
  'VODA_DATA_1GB_7D', // 2. Vodacom Data
  'ESKOM_ELEC',   // 3. Eskom Electricity
  'DSTV_PAYMENT', // 4. DStv Payment
  'GPLAY_50',     // 5. Google Play
  'UBER_100',     // 6. Uber
  'HWBETS_50',    // 7. Hollywoodbets
  'MUKURU_SEND',  // 8. Mukuru Remittance
  'NETFLIX_100',  // 9. Netflix
  'LOTTO_50',     // 10. Lottostar
];

export async function seedVasProducts() {
  console.log('🌱 Seeding VAS products...');
  
  let count = 0;
  
  // Seed Airtime
  for (const product of AIRTIME_PRODUCTS) {
    await prisma.vasProduct.upsert({
      where: {
        provider_category_externalCode: {
          provider: 'BLU',
          category: 'AIRTIME',
          externalCode: product.externalCode,
        },
      },
      update: {
        label: product.label,
        fixedPriceCents: product.fixedPriceCents,
        priceCents: product.fixedPriceCents || 0,
        active: true,
      },
      create: {
        provider: 'BLU',
        category: 'AIRTIME',
        subcategory: 'PINNED',
        networkCode: product.networkCode,
        externalCode: product.externalCode,
        label: product.label,
        fixedPriceCents: product.fixedPriceCents,
        priceCents: product.fixedPriceCents || 0,
        purchaseType: 'INSTANT_VEND',
        targetType: 'MSISDN',
        priority: 10,
        popularity: TOP_10_PRODUCTS.includes(product.externalCode) ? 100 : 50,
        active: true,
      },
    });
    count++;
  }
  console.log(`  ✅ ${AIRTIME_PRODUCTS.length} airtime products`);
  
  // Seed Data Bundles
  for (const bundle of DATA_BUNDLES) {
    await prisma.vasProduct.upsert({
      where: {
        provider_category_externalCode: {
          provider: 'BLU',
          category: 'DATA',
          externalCode: bundle.externalCode,
        },
      },
      update: {
        label: bundle.label,
        fixedPriceCents: bundle.fixedPriceCents,
        priceCents: bundle.fixedPriceCents || 0,
        dataMb: bundle.dataMb,
        periodType: bundle.periodType,
        validityDays: bundle.validityDays,
        active: true,
      },
      create: {
        provider: 'BLU',
        category: 'DATA',
        subcategory: 'PINNED',
        networkCode: bundle.networkCode,
        externalCode: bundle.externalCode,
        label: bundle.label,
        fixedPriceCents: bundle.fixedPriceCents,
        priceCents: bundle.fixedPriceCents || 0,
        dataMb: bundle.dataMb,
        periodType: bundle.periodType,
        validityDays: bundle.validityDays,
        purchaseType: 'INSTANT_VEND',
        targetType: 'MSISDN',
        priority: 20,
        popularity: TOP_10_PRODUCTS.includes(bundle.externalCode) ? 100 : 50,
        active: true,
      },
    });
    count++;
  }
  console.log(`  ✅ ${DATA_BUNDLES.length} data bundles`);
  
  // Seed Electricity
  for (const product of ELECTRICITY_PRODUCTS) {
    await prisma.vasProduct.upsert({
      where: {
        provider_category_externalCode: {
          provider: 'BLU',
          category: 'ELECTRICITY',
          externalCode: product.externalCode,
        },
      },
      update: {
        label: product.label,
        minCents: product.minCents,
        maxCents: product.maxCents,
        stepCents: product.stepCents,
        active: true,
      },
      create: {
        provider: 'BLU',
        category: 'ELECTRICITY',
        subcategory: 'MUNICIPAL_ELEC',
        operatorCode: product.operatorCode,
        externalCode: product.externalCode,
        label: product.label,
        minCents: product.minCents,
        maxCents: product.maxCents,
        stepCents: product.stepCents,
        purchaseType: 'TOKEN_BASED',
        targetType: 'METER_NUMBER',
        priority: 30,
        popularity: TOP_10_PRODUCTS.includes(product.externalCode) ? 100 : 40,
        active: true,
      },
    });
    count++;
  }
  console.log(`  ✅ ${ELECTRICITY_PRODUCTS.length} electricity products`);
  
  // Seed Lifestyle
  for (const product of LIFESTYLE_PRODUCTS) {
    await prisma.vasProduct.upsert({
      where: {
        provider_category_externalCode: {
          provider: 'BLU',
          category: 'LIFESTYLE',
          externalCode: product.externalCode,
        },
      },
      update: {
        label: product.label,
        fixedPriceCents: product.fixedPriceCents,
        priceCents: product.fixedPriceCents || 0,
        active: true,
      },
      create: {
        provider: 'BLU',
        category: 'LIFESTYLE',
        subcategory: 'OTT',
        operatorCode: product.operatorCode,
        externalCode: product.externalCode,
        label: product.label,
        fixedPriceCents: product.fixedPriceCents,
        priceCents: product.fixedPriceCents || 0,
        purchaseType: 'PIN_BASED',
        targetType: 'ACCOUNT_ID',
        priority: 40,
        popularity: TOP_10_PRODUCTS.includes(product.externalCode) ? 100 : 30,
        active: true,
      },
    });
    count++;
  }
  console.log(`  ✅ ${LIFESTYLE_PRODUCTS.length} lifestyle products`);
  
  // Seed Billpay
  for (const product of BILLPAY_PRODUCTS) {
    await prisma.vasProduct.upsert({
      where: {
        provider_category_externalCode: {
          provider: 'BLU',
          category: 'BILLPAY',
          externalCode: product.externalCode,
        },
      },
      update: {
        label: product.label,
        fixedPriceCents: product.fixedPriceCents,
        priceCents: product.fixedPriceCents || 0,
        minCents: product.minCents,
        maxCents: product.maxCents,
        stepCents: product.stepCents,
        active: true,
      },
      create: {
        provider: 'BLU',
        category: 'BILLPAY',
        subcategory: 'PAYTV',
        operatorCode: product.operatorCode,
        externalCode: product.externalCode,
        label: product.label,
        fixedPriceCents: product.fixedPriceCents,
        priceCents: product.fixedPriceCents || 0,
        minCents: product.minCents,
        maxCents: product.maxCents,
        stepCents: product.stepCents,
        purchaseType: product.minCents ? 'REFERENCE_BASED' : 'INSTANT_VEND',
        targetType: 'SMARTCARD',
        priority: 35,
        popularity: TOP_10_PRODUCTS.includes(product.externalCode) ? 100 : 40,
        active: true,
      },
    });
    count++;
  }
  console.log(`  ✅ ${BILLPAY_PRODUCTS.length} billpay products`);
  
  // Seed Remittance
  for (const product of REMITTANCE_PRODUCTS) {
    await prisma.vasProduct.upsert({
      where: {
        provider_category_externalCode: {
          provider: 'BLU',
          category: 'REMITTANCE',
          externalCode: product.externalCode,
        },
      },
      update: {
        label: product.label,
        minCents: product.minCents,
        maxCents: product.maxCents,
        stepCents: product.stepCents,
        active: true,
      },
      create: {
        provider: 'BLU',
        category: 'REMITTANCE',
        operatorCode: product.operatorCode,
        externalCode: product.externalCode,
        label: product.label,
        minCents: product.minCents,
        maxCents: product.maxCents,
        stepCents: product.stepCents,
        purchaseType: 'REFERENCE_BASED',
        targetType: 'ACCOUNT_ID',
        priority: 50,
        popularity: TOP_10_PRODUCTS.includes(product.externalCode) ? 100 : 30,
        active: true,
      },
    });
    count++;
  }
  console.log(`  ✅ ${REMITTANCE_PRODUCTS.length} remittance products`);
  
  // Seed Gaming
  for (const product of GAMING_PRODUCTS) {
    await prisma.vasProduct.upsert({
      where: {
        provider_category_externalCode: {
          provider: 'BLU',
          category: 'GAMING',
          externalCode: product.externalCode,
        },
      },
      update: {
        label: product.label,
        fixedPriceCents: product.fixedPriceCents,
        priceCents: product.fixedPriceCents || 0,
        active: true,
      },
      create: {
        provider: 'BLU',
        category: 'GAMING',
        operatorCode: product.operatorCode,
        externalCode: product.externalCode,
        label: product.label,
        fixedPriceCents: product.fixedPriceCents,
        priceCents: product.fixedPriceCents || 0,
        purchaseType: 'INSTANT_VEND',
        targetType: 'ACCOUNT_ID',
        priority: 45,
        popularity: TOP_10_PRODUCTS.includes(product.externalCode) ? 100 : 35,
        active: true,
      },
    });
    count++;
  }
  console.log(`  ✅ ${GAMING_PRODUCTS.length} gaming products`);
  
  console.log(`\n🎉 Seeded ${count} VAS products total`);
}

// Run if called directly
if (require.main === module) {
  seedVasProducts()
    .then(() => {
      console.log('✅ VAS seed complete');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ VAS seed failed:', error);
      process.exit(1);
    });
}

