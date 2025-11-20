#!/usr/bin/env node
/**
 * WaPay Complete Diagnostic Tool
 * Tests all systems and identifies exact failures
 */

const https = require('https');
const { PrismaClient } = require('@prisma/client');

console.log('🔍 WaPay Complete Diagnostics\n');
console.log('='.repeat(60));

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || process.env.META_WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_WHATSAPP_PHONE_NUMBER_ID;
const TEST_NUMBER = '27787051175'; // Your WhatsApp number

let allPassed = true;

// Helper function to make API calls
function apiCall(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'graph.facebook.com',
      path: `/v21.0${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

// Test 1: Environment Variables
async function testEnvironment() {
  console.log('\n1️⃣  Testing Environment Variables...');
  console.log('─'.repeat(60));
  
  const checks = [
    { name: 'WHATSAPP_ACCESS_TOKEN', value: TOKEN },
    { name: 'WHATSAPP_PHONE_NUMBER_ID', value: PHONE_ID },
    { name: 'DATABASE_URL', value: process.env.DATABASE_URL },
  ];
  
  for (const check of checks) {
    if (check.value) {
      console.log(`✅ ${check.name}: ${check.value.substring(0, 20)}...`);
    } else {
      console.log(`❌ ${check.name}: NOT SET`);
      allPassed = false;
    }
  }
}

// Test 2: Database Connection
async function testDatabase() {
  console.log('\n2️⃣  Testing Database Connection...');
  console.log('─'.repeat(60));
  
  try {
    const prisma = new PrismaClient();
    await prisma.$connect();
    
    const accounts = await prisma.account.count();
    console.log(`✅ Database connected`);
    console.log(`   Found ${accounts} accounts`);
    
    await prisma.$disconnect();
  } catch (error) {
    console.error(`❌ Database connection failed: ${error.message}`);
    allPassed = false;
  }
}

// Test 3: WhatsApp Token Permissions
async function testToken() {
  console.log('\n3️⃣  Testing WhatsApp Token Permissions...');
  console.log('─'.repeat(60));
  
  try {
    const result = await apiCall('GET', `/me?fields=id,name`);
    
    if (result.status === 200) {
      console.log(`✅ Token is valid`);
      console.log(`   App ID: ${result.data.id}`);
      console.log(`   App Name: ${result.data.name || 'Unknown'}`);
    } else {
      console.error(`❌ Token validation failed: ${result.data.error?.message}`);
      allPassed = false;
    }
  } catch (error) {
    console.error(`❌ Token test failed: ${error.message}`);
    allPassed = false;
  }
}

// Test 4: Send Text Message
async function testTextMessage() {
  console.log('\n4️⃣  Testing Text Message Send...');
  console.log('─'.repeat(60));
  
  try {
    const result = await apiCall('POST', `/${PHONE_ID}/messages`, {
      messaging_product: 'whatsapp',
      to: TEST_NUMBER,
      type: 'text',
      text: {
        body: '🔍 WaPay Diagnostic Test - Text Message'
      }
    });
    
    if (result.status === 200 && result.data.messages) {
      console.log(`✅ Text message sent successfully`);
      console.log(`   Message ID: ${result.data.messages[0].id}`);
    } else {
      console.error(`❌ Text message failed`);
      console.error(`   Status: ${result.status}`);
      console.error(`   Error: ${JSON.stringify(result.data.error, null, 2)}`);
      allPassed = false;
    }
  } catch (error) {
    console.error(`❌ Text message test failed: ${error.message}`);
    allPassed = false;
  }
}

// Test 5: Send Template Message
async function testTemplate() {
  console.log('\n5️⃣  Testing Template Message Send...');
  console.log('─'.repeat(60));
  
  try {
    const result = await apiCall('POST', `/${PHONE_ID}/messages`, {
      messaging_product: 'whatsapp',
      to: TEST_NUMBER,
      type: 'template',
      template: {
        name: 'onboarding_step_1',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Nieuwoudt' }
            ]
          }
        ]
      }
    });
    
    if (result.status === 200 && result.data.messages) {
      console.log(`✅ Template sent successfully`);
      console.log(`   Message ID: ${result.data.messages[0].id}`);
      console.log(`   Template: onboarding_step_1`);
    } else {
      console.error(`❌ Template send failed`);
      console.error(`   Status: ${result.status}`);
      console.error(`   Error: ${JSON.stringify(result.data.error, null, 2)}`);
      allPassed = false;
    }
  } catch (error) {
    console.error(`❌ Template test failed: ${error.message}`);
    allPassed = false;
  }
}

// Test 6: OTP Template
async function testOtpTemplate() {
  console.log('\n6️⃣  Testing OTP Template Send...');
  console.log('─'.repeat(60));
  
  try {
    const result = await apiCall('POST', `/${PHONE_ID}/messages`, {
      messaging_product: 'whatsapp',
      to: TEST_NUMBER,
      type: 'template',
      template: {
        name: 'otp_register_step_2',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: '123456' }
            ]
          }
        ]
      }
    });
    
    if (result.status === 200 && result.data.messages) {
      console.log(`✅ OTP template sent successfully`);
      console.log(`   Message ID: ${result.data.messages[0].id}`);
    } else {
      console.error(`❌ OTP template failed`);
      console.error(`   Status: ${result.status}`);
      console.error(`   Error: ${JSON.stringify(result.data.error, null, 2)}`);
      allPassed = false;
    }
  } catch (error) {
    console.error(`❌ OTP template test failed: ${error.message}`);
    allPassed = false;
  }
}

// Test 7: Check Templates in Database
async function testTemplateDatabase() {
  console.log('\n7️⃣  Testing Template Database...');
  console.log('─'.repeat(60));
  
  try {
    const prisma = new PrismaClient();
    await prisma.$connect();
    
    const templates = await prisma.whatsappTemplate.findMany({
      where: { status: 'APPROVED' },
      select: { name: true, language: true }
    });
    
    console.log(`✅ Found ${templates.length} approved templates in database:`);
    templates.forEach(t => {
      console.log(`   - ${t.name} [${t.language}]`);
    });
    
    // Check specific templates
    const required = ['onboarding_step_1', 'otp_register_step_2'];
    for (const name of required) {
      const exists = templates.find(t => t.name === name);
      if (exists) {
        console.log(`   ✅ ${name} exists`);
      } else {
        console.log(`   ❌ ${name} MISSING`);
        allPassed = false;
      }
    }
    
    await prisma.$disconnect();
  } catch (error) {
    console.error(`❌ Template database check failed: ${error.message}`);
    allPassed = false;
  }
}

// Run all tests
async function runDiagnostics() {
  await testEnvironment();
  await testDatabase();
  await testToken();
  await testTextMessage();
  await testTemplate();
  await testOtpTemplate();
  await testTemplateDatabase();
  
  console.log('\n' + '='.repeat(60));
  console.log('\n📊 DIAGNOSTIC SUMMARY\n');
  
  if (allPassed) {
    console.log('✅ ALL TESTS PASSED!');
    console.log('\nYour WaPay setup is working correctly.');
    console.log('If you\'re still having issues, check Vercel logs for runtime errors.');
  } else {
    console.log('❌ SOME TESTS FAILED!');
    console.log('\nPlease fix the failed tests above.');
    console.log('Common fixes:');
    console.log('  • Regenerate WhatsApp token with proper permissions');
    console.log('  • Update DATABASE_URL in Vercel');
    console.log('  • Verify templates are approved in Meta');
    console.log('  • Redeploy after fixing environment variables');
  }
  
  console.log('\n' + '='.repeat(60));
}

// Run diagnostics
runDiagnostics().catch(error => {
  console.error('\n❌ Diagnostic script failed:', error);
  process.exit(1);
});

