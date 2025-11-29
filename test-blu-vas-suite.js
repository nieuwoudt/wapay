#!/usr/bin/env node
/**
 * Blu VAS Integration Test Suite
 * 
 * Tests against Blu QA environment with real API calls.
 * 
 * Prerequisites:
 *   - BLU_BASE_URL set to QA URL
 *   - BLU_BASIC_USER, BLU_BASIC_PASS, BLU_API_KEY set
 *   - Test mobile numbers (approved by networks)
 * 
 * Usage:
 *   BLU_TEST_MSISDN=0821234567 node test-blu-vas-suite.js
 * 
 * Options:
 *   BLU_TEST_MSISDN       - Test phone number (required)
 *   BLU_TEST_AMOUNT       - Airtime amount in cents (default: 500 = R5)
 *   BLU_TEST_SKIP_AIRTIME - Skip airtime tests (set to 'true')
 *   BLU_TEST_SKIP_DATA    - Skip data tests (set to 'true')
 */

import { request } from 'undici';

// Configuration
// Note: BLU_TRADE_API_KEY is the shared API key for both Voucher + VAS endpoints
const config = {
  baseUrl: process.env.BLU_BASE_URL || 'https://qa-api.bluvoucher.co.za',
  username: process.env.BLU_BASIC_USER,
  password: process.env.BLU_BASIC_PASS,
  apiKey: process.env.BLU_TRADE_API_KEY || process.env.BLU_API_KEY, // Shared Trade API key
  testMsisdn: process.env.BLU_TEST_MSISDN,
  testAmount: parseInt(process.env.BLU_TEST_AMOUNT || '500', 10), // R5 default
  skipAirtime: process.env.BLU_TEST_SKIP_AIRTIME === 'true',
  skipData: process.env.BLU_TEST_SKIP_DATA === 'true',
};

// Validate configuration
function validateConfig() {
  const missing = [];
  if (!config.username) missing.push('BLU_BASIC_USER');
  if (!config.password) missing.push('BLU_BASIC_PASS');
  if (!config.apiKey) missing.push('BLU_TRADE_API_KEY (or BLU_API_KEY)');
  if (!config.testMsisdn) missing.push('BLU_TEST_MSISDN');
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(v => console.error(`   - ${v}`));
    console.error('\nUsage:');
    console.error('  BLU_TRADE_API_KEY=xxx BLU_TEST_MSISDN=0821234567 node test-blu-vas-suite.js');
    process.exit(1);
  }
}

// Build auth headers
function getHeaders() {
  const basic = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${basic}`,
    'apikey': config.apiKey,
  };
}

// Generate unique request ID
function generateRequestId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

// Format phone number to Blu format
function toBluFormat(msisdn) {
  if (msisdn.startsWith('+27')) return '0' + msisdn.substring(3);
  if (msisdn.startsWith('27')) return '0' + msisdn.substring(2);
  return msisdn;
}

// Test results tracking
const results = {
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: [],
};

function recordResult(name, passed, details = {}) {
  results.tests.push({ name, passed, details });
  if (passed === null) {
    results.skipped++;
    console.log(`⏭️  SKIP: ${name}`);
  } else if (passed) {
    results.passed++;
    console.log(`✅ PASS: ${name}`);
  } else {
    results.failed++;
    console.log(`❌ FAIL: ${name}`);
    if (details.error) console.log(`   Error: ${details.error}`);
  }
}

// ===========================================================================
// Test Cases
// ===========================================================================

async function testNetworkDetection() {
  const name = 'Network Detection';
  const msisdn = toBluFormat(config.testMsisdn);
  
  try {
    const url = `${config.baseUrl}/mobile/airtime/mobile-number/check?mobileNumber=${encodeURIComponent(msisdn)}`;
    const { statusCode, body } = await request(url, {
      method: 'GET',
      headers: getHeaders(),
      bodyTimeout: 30000,
    });
    
    const data = await body.json();
    
    if (statusCode === 200 && data.vendorName) {
      recordResult(name, true, { vendor: data.vendorName });
      return data.vendorName;
    } else {
      recordResult(name, false, { statusCode, data });
      return null;
    }
  } catch (error) {
    recordResult(name, false, { error: error.message });
    return null;
  }
}

async function testAirtimePurchase(vendorId) {
  const name = 'Airtime Purchase';
  
  if (config.skipAirtime) {
    recordResult(name, null, { reason: 'Skipped via BLU_TEST_SKIP_AIRTIME' });
    return;
  }
  
  if (!vendorId) {
    recordResult(name, null, { reason: 'No vendorId from network detection' });
    return;
  }
  
  const requestId = generateRequestId('test-air');
  const msisdn = toBluFormat(config.testMsisdn);
  
  try {
    const url = `${config.baseUrl}/mobile/airtime/sales`;
    const payload = {
      requestId,
      vendorId: vendorId.toLowerCase(),
      mobileNumber: msisdn,
      amount: config.testAmount,
      vendMetaData: {
        transactionRequestDateTime: new Date().toISOString(),
        transactionReference: `WAPAY-TEST-${requestId}`,
        vendorId: 'WAPAY-TEST',
        deviceId: 'TEST-SUITE',
        consumerAccountNumber: 'test-account',
        cellphoneNumber: msisdn,
      },
    };
    
    console.log(`   Purchasing R${(config.testAmount / 100).toFixed(2)} airtime to ${msisdn}...`);
    
    const { statusCode, body } = await request(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
      bodyTimeout: 60000,
    });
    
    const data = await body.json();
    
    if (statusCode === 200 || statusCode === 201) {
      recordResult(name, true, { 
        reference: data.reference,
        amount: data.amount,
        vendor: data.vendorName,
      });
    } else {
      recordResult(name, false, { statusCode, data });
    }
  } catch (error) {
    recordResult(name, false, { error: error.message });
  }
}

async function testAirtimeKnownFailure() {
  const name = 'Airtime Known Failure (Invalid Number)';
  
  if (config.skipAirtime) {
    recordResult(name, null, { reason: 'Skipped via BLU_TEST_SKIP_AIRTIME' });
    return;
  }
  
  const requestId = generateRequestId('test-air-fail');
  
  try {
    const url = `${config.baseUrl}/mobile/airtime/sales`;
    const payload = {
      requestId,
      vendorId: 'vodacom',
      mobileNumber: '0000000000', // Invalid number
      amount: 500,
      vendMetaData: {
        transactionRequestDateTime: new Date().toISOString(),
        transactionReference: `WAPAY-TEST-${requestId}`,
        vendorId: 'WAPAY-TEST',
        deviceId: 'TEST-SUITE',
        consumerAccountNumber: 'test-account',
        cellphoneNumber: '0000000000',
      },
    };
    
    const { statusCode, body } = await request(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
      bodyTimeout: 60000,
    });
    
    const data = await body.json();
    
    // We EXPECT this to fail with 400
    if (statusCode === 400 || statusCode === 404) {
      recordResult(name, true, { expectedFailure: true, statusCode });
    } else if (statusCode === 200 || statusCode === 201) {
      recordResult(name, false, { error: 'Expected failure but got success' });
    } else {
      recordResult(name, false, { statusCode, data });
    }
  } catch (error) {
    recordResult(name, false, { error: error.message });
  }
}

async function testDataProductsCatalogue(vendorId) {
  const name = 'Data Products Catalogue';
  
  if (config.skipData) {
    recordResult(name, null, { reason: 'Skipped via BLU_TEST_SKIP_DATA' });
    return null;
  }
  
  if (!vendorId) {
    recordResult(name, null, { reason: 'No vendorId from network detection' });
    return null;
  }
  
  try {
    const vendor = vendorId.toLowerCase();
    const url = `${config.baseUrl}/mobile/data/products?vendorId=${encodeURIComponent(vendor)}`;
    
    const { statusCode, body } = await request(url, {
      method: 'GET',
      headers: getHeaders(),
      bodyTimeout: 30000,
    });
    
    const data = await body.json();
    
    if (statusCode === 200 && Array.isArray(data) && data.length > 0) {
      recordResult(name, true, { productCount: data.length });
      return data[0]; // Return first product for purchase test
    } else if (statusCode === 200 && Array.isArray(data)) {
      recordResult(name, false, { error: 'No products returned' });
      return null;
    } else {
      recordResult(name, false, { statusCode, data });
      return null;
    }
  } catch (error) {
    recordResult(name, false, { error: error.message });
    return null;
  }
}

async function testDataBundlePurchase(vendorId, product) {
  const name = 'Data Bundle Purchase';
  
  if (config.skipData) {
    recordResult(name, null, { reason: 'Skipped via BLU_TEST_SKIP_DATA' });
    return;
  }
  
  if (!vendorId || !product) {
    recordResult(name, null, { reason: 'Missing vendorId or product' });
    return;
  }
  
  const requestId = generateRequestId('test-data');
  const msisdn = toBluFormat(config.testMsisdn);
  
  try {
    const url = `${config.baseUrl}/mobile/data/sales`;
    const payload = {
      requestId,
      vendorId: vendorId.toLowerCase(),
      productId: product.id,
      mobileNumber: msisdn,
      vendMetaData: {
        transactionRequestDateTime: new Date().toISOString(),
        transactionReference: `WAPAY-TEST-${requestId}`,
        vendorId: 'WAPAY-TEST',
        deviceId: 'TEST-SUITE',
        consumerAccountNumber: 'test-account',
        cellphoneNumber: msisdn,
      },
    };
    
    console.log(`   Purchasing "${product.name}" (R${(product.amount / 100).toFixed(2)}) to ${msisdn}...`);
    
    const { statusCode, body } = await request(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
      bodyTimeout: 60000,
    });
    
    const data = await body.json();
    
    if (statusCode === 200 || statusCode === 201) {
      recordResult(name, true, { 
        reference: data.reference,
        product: data.productName,
        vendor: data.vendorName,
      });
    } else {
      recordResult(name, false, { statusCode, data });
    }
  } catch (error) {
    recordResult(name, false, { error: error.message });
  }
}

async function testIdempotency() {
  const name = 'Idempotency (Duplicate Request)';
  
  if (config.skipAirtime) {
    recordResult(name, null, { reason: 'Skipped via BLU_TEST_SKIP_AIRTIME' });
    return;
  }
  
  const requestId = generateRequestId('test-idem');
  const msisdn = toBluFormat(config.testMsisdn);
  
  try {
    const url = `${config.baseUrl}/mobile/airtime/sales`;
    const payload = {
      requestId, // Same requestId for both calls
      vendorId: 'vodacom',
      mobileNumber: msisdn,
      amount: config.testAmount,
      vendMetaData: {
        transactionRequestDateTime: new Date().toISOString(),
        transactionReference: `WAPAY-TEST-${requestId}`,
        vendorId: 'WAPAY-TEST',
        deviceId: 'TEST-SUITE',
        consumerAccountNumber: 'test-account',
        cellphoneNumber: msisdn,
      },
    };
    
    // First request
    const res1 = await request(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
      bodyTimeout: 60000,
    });
    const data1 = await res1.body.json();
    
    if (res1.statusCode !== 200 && res1.statusCode !== 201) {
      recordResult(name, false, { error: 'First request failed', statusCode: res1.statusCode });
      return;
    }
    
    // Second request with same requestId
    const res2 = await request(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
      bodyTimeout: 60000,
    });
    const data2 = await res2.body.json();
    
    // Second request should return 409 Conflict or same result
    if (res2.statusCode === 409) {
      recordResult(name, true, { behavior: 'conflict_returned' });
    } else if (res2.statusCode === 200 || res2.statusCode === 201) {
      // Check if same reference returned (idempotent)
      if (data1.reference === data2.reference) {
        recordResult(name, true, { behavior: 'same_result_returned' });
      } else {
        recordResult(name, false, { 
          error: 'Different references returned - not idempotent!',
          ref1: data1.reference,
          ref2: data2.reference,
        });
      }
    } else {
      recordResult(name, false, { statusCode: res2.statusCode, data: data2 });
    }
  } catch (error) {
    recordResult(name, false, { error: error.message });
  }
}

// ===========================================================================
// Main Test Runner
// ===========================================================================

async function runTests() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('           Blu VAS Integration Test Suite');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`Test MSISDN: ${config.testMsisdn}`);
  console.log(`Test Amount: R${(config.testAmount / 100).toFixed(2)}`);
  console.log('═══════════════════════════════════════════════════════════\n');
  
  // Run tests in sequence
  console.log('📱 Testing Network Detection...');
  const vendorName = await testNetworkDetection();
  const vendorId = vendorName ? vendorName.toLowerCase().replace(/\s+/g, '') : null;
  console.log('');
  
  console.log('💰 Testing Airtime Purchase...');
  await testAirtimePurchase(vendorId);
  console.log('');
  
  console.log('💰 Testing Airtime Known Failure...');
  await testAirtimeKnownFailure();
  console.log('');
  
  console.log('📦 Testing Data Products Catalogue...');
  const product = await testDataProductsCatalogue(vendorId);
  console.log('');
  
  console.log('📦 Testing Data Bundle Purchase...');
  await testDataBundlePurchase(vendorId, product);
  console.log('');
  
  console.log('🔄 Testing Idempotency...');
  await testIdempotency();
  console.log('');
  
  // Summary
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                      Test Summary');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`✅ Passed:  ${results.passed}`);
  console.log(`❌ Failed:  ${results.failed}`);
  console.log(`⏭️  Skipped: ${results.skipped}`);
  console.log(`📊 Total:   ${results.tests.length}`);
  console.log('═══════════════════════════════════════════════════════════');
  
  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
}

// Run
validateConfig();
runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

