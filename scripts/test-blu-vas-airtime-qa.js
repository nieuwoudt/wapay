#!/usr/bin/env node
/**
 * Blu VAS Airtime QA Integration Test
 * 
 * Tests airtime purchases against the real Blu QA environment using their test MSISDNs.
 * 
 * Blu QA Test Numbers:
 * - 0840012300 (Cell C)
 * - 0720012345 (Vodacom)
 * - 0830012300 (MTN)
 * - 0850012345 (Telkom)
 * 
 * Usage:
 *   BLU_VAS_STUB_MODE=false \
 *   BLU_BASE_URL=https://api.qa.bltelecoms.net/v2/trade \
 *   BLU_TRADE_API_KEY=5135ae7a-3d92-44ff-86bb-89c401722221 \
 *   node scripts/test-blu-vas-airtime-qa.js
 * 
 * Or with env vars already set:
 *   node scripts/test-blu-vas-airtime-qa.js
 */

const { request } = require('undici');

function skipIfMissingEnv(required) {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.log(`SKIP: missing env vars: ${missing.join(', ')}`);
    process.exit(0);
  }
}

skipIfMissingEnv([
  'BLU_BASIC_USER',
  'BLU_BASIC_PASS',
  (process.env.BLU_TRADE_API_KEY || process.env.BLU_API_KEY) ? null : 'BLU_TRADE_API_KEY|BLU_API_KEY',
].filter(Boolean));

// =============================================================================
// Configuration
// =============================================================================

const config = {
  baseUrl: process.env.BLU_BASE_URL || 'https://api.qa.bltelecoms.net/v2/trade',
  apiKey: process.env.BLU_TRADE_API_KEY || process.env.BLU_API_KEY,
};

// Blu QA Test MSISDNs
const TEST_MSISDNS = {
  CELLC: { msisdn: '0840012300', vendorId: 'cellc', vendorName: 'Cell C' },
  VODACOM: { msisdn: '0720012345', vendorId: 'vodacom', vendorName: 'Vodacom' },
  MTN: { msisdn: '0830012300', vendorId: 'mtn', vendorName: 'MTN' },
  TELKOM: { msisdn: '0850012345', vendorId: 'telkom', vendorName: 'Telkom' },
};

// =============================================================================
// Helpers
// =============================================================================

function getHeaders() {
  return {
    'accept': 'application/json',
    'Content-Type': 'application/json',
    'apikey': config.apiKey,
  };
}

function generateRequestId(vendorId) {
  return `wapay-qa-${vendorId}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
}

function logResult(network, success, data) {
  const icon = success ? '✅' : '❌';
  console.log(`\n${icon} ${network}`);
  console.log('─'.repeat(40));
  if (success) {
    console.log(`   vendorName:      ${data.vendorName}`);
    console.log(`   vendorReference: ${data.vendorReference || 'N/A'}`);
    console.log(`   reference:       ${data.reference}`);
    console.log(`   mobileNumber:    ${data.mobileNumber}`);
    console.log(`   amount:          R${(data.amount / 100).toFixed(2)} (${data.amount} cents)`);
    console.log(`   dateTime:        ${data.dateTime}`);
  } else {
    console.log(`   Error: ${data.error || data.message || JSON.stringify(data)}`);
  }
}

// =============================================================================
// Test Functions
// =============================================================================

async function testAirtimePurchase(network, testData) {
  const { msisdn, vendorId, vendorName } = testData;
  const requestId = generateRequestId(vendorId);
  const amountCents = 2000; // R20 test amount
  
  const url = `${config.baseUrl}/mobile/airtime/sales`;
  
  const payload = {
    requestId,
    vendorId,
    mobileNumber: msisdn,
    amount: amountCents,
    vendMetaData: {
      transactionRequestDateTime: new Date().toISOString(),
      transactionReference: `QA-TEST-${Date.now()}`,
      vendorId: 'WAPAY-QA',
      deviceId: 'QA-TEST-SCRIPT',
      consumerAccountNumber: 'qa-test-account',
      clientId: 'WaPayQA',
      emailAddress: 'qa@wapay.dev',
      cellphoneNumber: msisdn,
    },
  };

  console.log(`\n📱 Testing ${vendorName} (${msisdn})...`);
  console.log(`   URL: ${url}`);
  console.log(`   RequestId: ${requestId}`);

  try {
    const response = await request(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
      bodyTimeout: 60000,
      headersTimeout: 60000,
    });

    const responseText = await response.body.text();
    
    if (response.statusCode === 200 || response.statusCode === 201) {
      const data = JSON.parse(responseText);
      logResult(vendorName, true, data);
      return { success: true, data };
    } else {
      let errorData;
      try {
        errorData = JSON.parse(responseText);
      } catch {
        errorData = { message: responseText };
      }
      logResult(vendorName, false, errorData);
      return { success: false, error: errorData };
    }
  } catch (error) {
    logResult(vendorName, false, { error: error.message });
    return { success: false, error: error.message };
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log('═'.repeat(60));
  console.log('🧪 BLU VAS AIRTIME QA INTEGRATION TEST');
  console.log('═'.repeat(60));
  
  // Validate config
  if (!config.apiKey) {
    console.error('\n❌ ERROR: BLU_TRADE_API_KEY or BLU_API_KEY must be set');
    console.error('\nUsage:');
    console.error('  BLU_TRADE_API_KEY=your-api-key node scripts/test-blu-vas-airtime-qa.js');
    process.exit(1);
  }

  // Check stub mode
  if (process.env.BLU_VAS_STUB_MODE === 'true') {
    console.warn('\n⚠️  WARNING: BLU_VAS_STUB_MODE=true - tests will use stub responses!');
    console.warn('   Set BLU_VAS_STUB_MODE=false to test against real Blu QA.\n');
  }

  console.log('\n📋 Configuration:');
  console.log(`   Base URL:  ${config.baseUrl}`);
  console.log(`   API Key:   ${config.apiKey.substring(0, 8)}...${config.apiKey.substring(config.apiKey.length - 4)}`);
  console.log(`   Stub Mode: ${process.env.BLU_VAS_STUB_MODE || 'false'}`);

  console.log('\n📞 Test MSISDNs:');
  for (const [network, data] of Object.entries(TEST_MSISDNS)) {
    console.log(`   ${network}: ${data.msisdn} (vendorId: ${data.vendorId})`);
  }

  // Run tests
  const results = {};
  
  // Test Telkom first (known to work from user's curl example)
  console.log('\n' + '═'.repeat(60));
  console.log('🚀 Starting Tests (Telkom first as it\'s confirmed working)');
  console.log('═'.repeat(60));
  
  results.TELKOM = await testAirtimePurchase('TELKOM', TEST_MSISDNS.TELKOM);
  
  // Test other networks
  for (const [network, testData] of Object.entries(TEST_MSISDNS)) {
    if (network !== 'TELKOM') {
      results[network] = await testAirtimePurchase(network, testData);
    }
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('📊 SUMMARY');
  console.log('═'.repeat(60));
  
  let passed = 0;
  let failed = 0;
  
  for (const [network, result] of Object.entries(results)) {
    const icon = result.success ? '✅' : '❌';
    console.log(`${icon} ${network}: ${result.success ? 'PASSED' : 'FAILED'}`);
    if (result.success) {
      passed++;
    } else {
      failed++;
    }
  }
  
  console.log(`\nTotal: ${passed} passed, ${failed} failed`);
  
  if (failed === 0) {
    console.log('\n🎉 All tests passed! Blu QA integration is working.');
  } else if (passed > 0) {
    console.log('\n⚠️  Some tests failed. Check individual results above.');
  } else {
    console.log('\n❌ All tests failed. Check configuration and credentials.');
  }
  
  process.exit(failed > 0 ? 1 : 0);
}

// Run
main().catch(error => {
  console.error('\n❌ Unexpected error:', error);
  process.exit(1);
});

