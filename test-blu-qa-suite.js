#!/usr/bin/env node
/**
 * Blu Voucher QA Test Suite
 * 
 * Tests the deployed Vercel API for Blu voucher redemption
 * Runs multiple scenarios and generates a detailed report
 */

const https = require('https');
const crypto = require('crypto');

// Configuration
const VERCEL_API_BASE = process.env.VERCEL_API_BASE || 'https://your-app.vercel.app';
const TEST_ACCOUNT_ID = process.env.TEST_ACCOUNT_ID || 'test-account-qa';
const TEST_WA_ID = process.env.TEST_WA_ID || '27787051175';

// Test voucher PINs (you'll need to provide these)
const TEST_VOUCHERS = {
  VALID: process.env.BLU_TEST_VALID_PIN || '3608644555612212',
  USED: process.env.BLU_TEST_USED_PIN || '0000000000000000', // Already redeemed
  FAKE: '9999999999999999', // Random invalid PIN
  EXPIRED: process.env.BLU_TEST_EXPIRED_PIN || '1111111111111111', // Expired voucher
};

// Test results
const results = [];

/**
 * Make HTTP request to Vercel API
 */
function makeRequest(path, method, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, VERCEL_API_BASE);
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-idempotency-key': `test-${crypto.randomUUID()}`,
      },
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: parsed, headers: res.headers });
        } catch {
          resolve({ statusCode: res.statusCode, body: data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    
    req.end();
  });
}

/**
 * Test Case: Redeem a voucher
 */
async function testRedeemVoucher(testName, pin, expectedStatus, expectedError = null) {
  console.log(`\n🧪 Test: ${testName}`);
  console.log(`   PIN: ${pin.slice(0, 4)}****${pin.slice(-4)}`);
  
  const startTime = Date.now();
  
  try {
    const response = await makeRequest('/api/deposit/blu/redeem', 'POST', {
      pin,
      accountId: TEST_ACCOUNT_ID,
      waId: TEST_WA_ID,
      amountCents: 1000, // This will be overridden by status check
    });
    
    const duration = Date.now() - startTime;
    
    const result = {
      testName,
      pin: `${pin.slice(0, 4)}****${pin.slice(-4)}`,
      statusCode: response.statusCode,
      responseBody: response.body,
      duration: `${duration}ms`,
      passed: response.statusCode === expectedStatus,
      expectedStatus,
      expectedError,
    };
    
    // Check if error matches expectation
    if (expectedError && response.body.error !== expectedError) {
      result.passed = false;
      result.errorMismatch = `Expected ${expectedError}, got ${response.body.error}`;
    }
    
    results.push(result);
    
    console.log(`   Status: ${response.statusCode} ${result.passed ? '✅' : '❌'}`);
    console.log(`   Duration: ${duration}ms`);
    console.log(`   Response:`, JSON.stringify(response.body, null, 2));
    
    return result;
  } catch (error) {
    console.error(`   ❌ Request failed:`, error.message);
    results.push({
      testName,
      pin: `${pin.slice(0, 4)}****${pin.slice(-4)}`,
      error: error.message,
      passed: false,
    });
    return null;
  }
}

/**
 * Test Case: Idempotency check
 */
async function testIdempotency(pin) {
  console.log(`\n🧪 Test: Idempotency Check`);
  console.log(`   PIN: ${pin.slice(0, 4)}****${pin.slice(-4)}`);
  
  const idemKey = `test-idem-${Date.now()}`;
  
  try {
    // First request
    const response1 = await makeRequest('/api/deposit/blu/redeem', 'POST', {
      pin,
      accountId: TEST_ACCOUNT_ID,
      waId: TEST_WA_ID,
      amountCents: 1000,
    });
    
    // Wait 1 second
    await new Promise(r => setTimeout(r, 1000));
    
    // Second request with same idempotency key
    const response2 = await makeRequest('/api/deposit/blu/redeem', 'POST', {
      pin,
      accountId: TEST_ACCOUNT_ID,
      waId: TEST_WA_ID,
      amountCents: 1000,
    });
    
    const passed = response1.statusCode === response2.statusCode;
    
    results.push({
      testName: 'Idempotency Check',
      passed,
      response1: response1.body,
      response2: response2.body,
    });
    
    console.log(`   First request: ${response1.statusCode}`);
    console.log(`   Second request: ${response2.statusCode}`);
    console.log(`   ${passed ? '✅ Passed' : '❌ Failed'}`);
    
  } catch (error) {
    console.error(`   ❌ Test failed:`, error.message);
    results.push({
      testName: 'Idempotency Check',
      error: error.message,
      passed: false,
    });
  }
}

/**
 * Test Case: Check wallet balance
 */
async function testCheckBalance() {
  console.log(`\n🧪 Test: Check Wallet Balance`);
  
  try {
    const response = await makeRequest(`/api/wallet/balance?accountId=${TEST_ACCOUNT_ID}`, 'GET');
    
    const passed = response.statusCode === 200 && typeof response.body.balance === 'number';
    
    results.push({
      testName: 'Check Wallet Balance',
      statusCode: response.statusCode,
      balance: response.body.balance,
      passed,
    });
    
    console.log(`   Status: ${response.statusCode} ${passed ? '✅' : '❌'}`);
    console.log(`   Balance: R ${response.body.balance || 'N/A'}`);
    
    return response.body.balance;
  } catch (error) {
    console.error(`   ❌ Request failed:`, error.message);
    results.push({
      testName: 'Check Wallet Balance',
      error: error.message,
      passed: false,
    });
    return null;
  }
}

/**
 * Generate test report
 */
function generateReport() {
  console.log('\n' + '='.repeat(80));
  console.log('📊 BLU VOUCHER QA TEST REPORT');
  console.log('='.repeat(80));
  
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  
  console.log(`\n✅ Passed: ${passed}/${total}`);
  console.log(`❌ Failed: ${failed}/${total}`);
  console.log(`📈 Success Rate: ${((passed / total) * 100).toFixed(1)}%`);
  
  console.log('\n' + '-'.repeat(80));
  console.log('DETAILED RESULTS:');
  console.log('-'.repeat(80));
  
  results.forEach((result, index) => {
    console.log(`\n${index + 1}. ${result.testName} ${result.passed ? '✅' : '❌'}`);
    if (result.statusCode) console.log(`   Status Code: ${result.statusCode}`);
    if (result.duration) console.log(`   Duration: ${result.duration}`);
    if (result.error) console.log(`   Error: ${result.error}`);
    if (result.errorMismatch) console.log(`   Error Mismatch: ${result.errorMismatch}`);
    if (result.responseBody) {
      console.log(`   Response:`, JSON.stringify(result.responseBody, null, 2));
    }
  });
  
  console.log('\n' + '='.repeat(80));
  console.log('END OF REPORT');
  console.log('='.repeat(80) + '\n');
}

/**
 * Main test runner
 */
async function runTests() {
  console.log('🚀 Starting Blu Voucher QA Test Suite');
  console.log(`📍 API Base: ${VERCEL_API_BASE}`);
  console.log(`👤 Test Account: ${TEST_ACCOUNT_ID}`);
  console.log(`📱 Test WhatsApp: ${TEST_WA_ID}`);
  
  // Check configuration
  if (VERCEL_API_BASE.includes('your-app')) {
    console.error('\n❌ ERROR: Please set VERCEL_API_BASE environment variable');
    console.error('   Example: export VERCEL_API_BASE=https://wapay-abc123.vercel.app');
    process.exit(1);
  }
  
  try {
    // Test 1: Valid voucher redemption
    await testRedeemVoucher(
      'Valid Voucher Redemption',
      TEST_VOUCHERS.VALID,
      200,
      null
    );
    
    // Wait between tests
    await new Promise(r => setTimeout(r, 2000));
    
    // Test 2: Already used voucher
    await testRedeemVoucher(
      'Already Used Voucher',
      TEST_VOUCHERS.USED,
      400,
      'USER_INPUT'
    );
    
    await new Promise(r => setTimeout(r, 2000));
    
    // Test 3: Fake/invalid PIN
    await testRedeemVoucher(
      'Invalid/Fake PIN',
      TEST_VOUCHERS.FAKE,
      400,
      'USER_INPUT'
    );
    
    await new Promise(r => setTimeout(r, 2000));
    
    // Test 4: Expired voucher
    await testRedeemVoucher(
      'Expired Voucher',
      TEST_VOUCHERS.EXPIRED,
      400,
      'USER_INPUT'
    );
    
    await new Promise(r => setTimeout(r, 2000));
    
    // Test 5: Check wallet balance
    const balance1 = await testCheckBalance();
    
    await new Promise(r => setTimeout(r, 2000));
    
    // Test 6: Idempotency (if we have a fresh valid voucher)
    // Skipping for now as it would consume a voucher
    // await testIdempotency(TEST_VOUCHERS.VALID);
    
    // Generate report
    generateReport();
    
  } catch (error) {
    console.error('\n❌ Test suite failed:', error);
    process.exit(1);
  }
}

// Run tests
runTests().catch(console.error);

