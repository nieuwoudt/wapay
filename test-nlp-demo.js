#!/usr/bin/env node
/**
 * 🎭 WaPay NLP Interactive Demo
 * 
 * This script simulates the complete customer UX:
 * 1. User sends a message
 * 2. NLP processes it
 * 3. Routes to API
 * 4. Simulates response
 * 5. Shows WhatsApp message
 * 
 * Run: node test-nlp-demo.js
 */

import { createInterface } from 'readline';

// Simulate NLP (simplified versions of our actual code)

function extractAmount(text) {
  const match = text.match(/R\s*(\d+(?:[.,]\d{1,2})?)/i);
  if (match) {
    const value = parseFloat(match[1].replace(',', '.'));
    return { cents: Math.round(value * 100), raw: match[0] };
  }
  return null;
}

function extractNetwork(text) {
  const lower = text.toLowerCase();
  if (lower.includes('vodacom')) return { code: 'VODACOM', raw: 'Vodacom' };
  if (lower.includes('mtn')) return { code: 'MTN', raw: 'MTN' };
  if (lower.includes('cell c')) return { code: 'CELL_C', raw: 'Cell C' };
  if (lower.includes('telkom')) return { code: 'TELKOM', raw: 'Telkom' };
  return null;
}

function extractMsisdn(text) {
  const match = text.match(/0\s*(\d{2})\s*(\d{3})\s*(\d{4})/);
  if (match) {
    const normalized = `+27${match[1]}${match[2]}${match[3]}`;
    return { normalized, raw: match[0] };
  }
  return null;
}

function extractMerchant(text) {
  const lower = text.toLowerCase();
  if (lower.includes('checkers')) return { name: 'Checkers', code: 'CHECKERS' };
  if (lower.includes('pick n pay')) return { name: 'Pick n Pay', code: 'PNP' };
  if (lower.includes('woolworths')) return { name: 'Woolworths', code: 'WOOLWORTHS' };
  if (lower.includes('spar')) return { name: 'Spar', code: 'SPAR' };
  return null;
}

function classifyIntent(text) {
  const lower = text.toLowerCase();
  
  // Balance check
  if (lower.includes('balance') || lower.includes("what's my money")) {
    return { 
      type: 'CHECK_BALANCE', 
      confidence: 0.9,
      entities: {}
    };
  }
  
  // Airtime
  if (lower.includes('airtime') || lower.includes('recharge')) {
    const amount = extractAmount(text);
    const network = extractNetwork(text);
    const msisdn = extractMsisdn(text);
    
    return {
      type: 'BUY_AIRTIME',
      confidence: 0.9,
      entities: { amount, network, msisdn }
    };
  }
  
  // Data
  if (lower.includes('data') || lower.includes('bundle')) {
    const amount = extractAmount(text);
    const network = extractNetwork(text);
    const msisdn = extractMsisdn(text);
    
    return {
      type: 'BUY_DATA',
      confidence: 0.8,
      entities: { amount, network, msisdn }
    };
  }
  
  // Pay at store
  if (lower.includes('pay at') || lower.includes('can i pay') || lower.includes('use wapay at')) {
    const amount = extractAmount(text);
    const merchant = extractMerchant(text);
    
    return {
      type: 'PAY_AT_STORE',
      confidence: 0.9,
      entities: { amount, merchant }
    };
  }
  
  // Voucher redemption
  if (lower.includes('voucher') || /\d{16}/.test(text)) {
    const pinMatch = text.match(/\d{16}/);
    const pin = pinMatch ? { value: pinMatch[0], raw: pinMatch[0] } : null;
    
    return {
      type: 'REDEEM_VOUCHER',
      confidence: 0.9,
      entities: { pin }
    };
  }
  
  return { type: 'UNKNOWN', confidence: 0, entities: {} };
}

function getMissingEntities(intent) {
  const missing = [];
  
  if (intent.type === 'BUY_AIRTIME') {
    if (!intent.entities.amount) missing.push('amount');
    if (!intent.entities.msisdn) missing.push('phone number');
  }
  
  if (intent.type === 'BUY_DATA') {
    if (!intent.entities.amount) missing.push('bundle selection');
    if (!intent.entities.msisdn) missing.push('phone number');
  }
  
  if (intent.type === 'PAY_AT_STORE') {
    if (!intent.entities.amount) missing.push('amount');
    if (!intent.entities.merchant) missing.push('store name');
  }
  
  if (intent.type === 'REDEEM_VOUCHER') {
    if (!intent.entities.pin) missing.push('voucher PIN');
  }
  
  return missing;
}

function simulateApiCall(intent) {
  const totalBalance = 20000; // R200.00 (single WaPay balance)

  switch (intent.type) {
    case 'CHECK_BALANCE':
      return {
        success: true,
        data: {
          totalCents: totalBalance,
          displayAmount: `R${(totalBalance / 100).toFixed(2)}`
        }
      };
      
    case 'BUY_AIRTIME':
      return {
        success: true,
        data: {
          network: intent.entities.network?.code || 'VODACOM',
          amount: intent.entities.amount?.cents || 5000,
          recipient: intent.entities.msisdn?.normalized || '+27821234567',
          fee: 0,
          total: intent.entities.amount?.cents || 5000,
          reference: `AIR${Date.now()}`
        }
      };
      
    case 'BUY_DATA':
      return {
        success: true,
        data: {
          network: intent.entities.network?.code || 'VODACOM',
          bundle: '1GB Weekly',
          recipient: intent.entities.msisdn?.normalized || '+27821234567',
          price: 3500,
          reference: `DATA${Date.now()}`
        }
      };
      
    case 'PAY_AT_STORE':
      return {
        success: true,
        data: {
          wiCode: Math.floor(100000 + Math.random() * 900000).toString(),
          amount: intent.entities.amount?.cents || 10000,
          merchant: intent.entities.merchant?.name || 'Retailer',
          expiresIn: '10 minutes'
        }
      };
      
    case 'REDEEM_VOUCHER':
      return {
        success: true,
        data: {
          amount: 10000, // R100.00
          reference: `BLU${Date.now()}`,
          newBalance: accountBalance + 10000
        }
      };
      
    default:
      return { success: false, error: 'Unknown intent' };
  }
}

function formatWhatsAppMessage(intent, apiResponse) {
  switch (intent.type) {
    case 'CHECK_BALANCE':
      return `💰 Your Balance\n\n` +
             `Your WaPay balance is ${apiResponse.data.displayAmount}.\n\n` +
             `What would you like to do?`;
      
    case 'BUY_AIRTIME':
      return `📱 Airtime Purchase Preview\n\n` +
             `Network: ${apiResponse.data.network}\n` +
             `Amount: R${(apiResponse.data.amount / 100).toFixed(2)}\n` +
             `Recipient: ${apiResponse.data.recipient}\n` +
             `Fee: R${(apiResponse.data.fee / 100).toFixed(2)}\n` +
             `Total: R${(apiResponse.data.total / 100).toFixed(2)}\n\n` +
             `Reply YES to confirm`;
      
    case 'BUY_DATA':
      return `📊 Data Bundle Preview\n\n` +
             `Bundle: ${apiResponse.data.bundle}\n` +
             `Network: ${apiResponse.data.network}\n` +
             `Recipient: ${apiResponse.data.recipient}\n` +
             `Price: R${(apiResponse.data.price / 100).toFixed(2)}\n\n` +
             `Reply YES to confirm`;
      
    case 'PAY_AT_STORE':
      return `💳 Payment Code Ready!\n\n` +
             `Show this code at checkout:\n\n` +
             `🔢 ${apiResponse.data.wiCode}\n\n` +
             `Amount: R${(apiResponse.data.amount / 100).toFixed(2)}\n` +
             `Store: ${apiResponse.data.merchant}\n` +
             `Expires: ${apiResponse.data.expiresIn}\n\n` +
             `Present this to the cashier.`;
      
    case 'REDEEM_VOUCHER':
      return `✅ Deposit Successful!\n\n` +
             `Amount: R${(apiResponse.data.amount / 100).toFixed(2)}\n` +
             `Reference: ${apiResponse.data.reference}\n` +
             `New Balance: R${(apiResponse.data.newBalance / 100).toFixed(2)}\n\n` +
             `Thank you for using WaPay! 🎉`;
      
    default:
      return `I'm sorry, I didn't understand that. Try:\n` +
             `• "What's my balance?"\n` +
             `• "Buy R50 Vodacom airtime for 0821234567"\n` +
             `• "Can I pay R79.88 at Checkers?"\n` +
             `• "Redeem voucher 1234567890123456"`;
  }
}

function processMessage(text) {
  console.log('\n' + '='.repeat(60));
  console.log('📱 CUSTOMER MESSAGE:');
  console.log('='.repeat(60));
  console.log(text);
  console.log('');
  
  // Step 1: NLP Processing
  console.log('🧠 NLP PROCESSING...');
  const intent = classifyIntent(text);
  console.log('Intent:', intent.type);
  console.log('Confidence:', intent.confidence);
  console.log('Entities:', JSON.stringify(intent.entities, null, 2));
  console.log('');
  
  // Step 2: Check for missing entities
  const missing = getMissingEntities(intent);
  if (missing.length > 0) {
    console.log('⚠️  MISSING ENTITIES:', missing.join(', '));
    console.log('');
    console.log('📤 WHATSAPP RESPONSE (Disambiguation):');
    console.log('='.repeat(60));
    
    if (missing.includes('amount')) {
      console.log('How much would you like to spend?\n\n[R10] [R20] [R50] [R100]');
    } else if (missing.includes('phone number')) {
      console.log('Which phone number should receive this?\n\nEnter number (e.g., 082 123 4567)');
    } else if (missing.includes('store name')) {
      console.log('Which store would you like to pay at?\n\n[Checkers] [Pick n Pay] [Woolworths] [Spar]');
    }
    
    console.log('='.repeat(60));
    return;
  }
  
  // Step 3: Route to API
  console.log('🔀 ROUTING TO API...');
  const route = intent.type === 'CHECK_BALANCE' 
    ? 'GET /api/wallet/balance'
    : intent.type === 'BUY_AIRTIME'
    ? 'POST /api/vas/airtime/preview'
    : intent.type === 'BUY_DATA'
    ? 'POST /api/vas/data/preview'
    : intent.type === 'PAY_AT_STORE'
    ? 'POST /api/yoyo/token/issue'
    : intent.type === 'REDEEM_VOUCHER'
    ? 'POST /api/deposit/blu/redeem'
    : 'UNKNOWN';
  
  console.log('Route:', route);
  console.log('');
  
  // Step 4: Simulate API call
  console.log('⚙️  SIMULATING API CALL...');
  const apiResponse = simulateApiCall(intent);
  console.log('API Response:', JSON.stringify(apiResponse.data, null, 2));
  console.log('');
  
  // Step 5: Format WhatsApp message
  console.log('📤 WHATSAPP RESPONSE:');
  console.log('='.repeat(60));
  const message = formatWhatsAppMessage(intent, apiResponse);
  console.log(message);
  console.log('='.repeat(60));
  console.log('');
}

// Interactive mode
console.log('');
console.log('🎭 WaPay NLP Interactive Demo');
console.log('================================');
console.log('');
console.log('This demo simulates the COMPLETE customer experience!');
console.log('');
console.log('Try these commands:');
console.log('  • "what\'s my balance?"');
console.log('  • "buy me R50 Vodacom airtime for 0821234567"');
console.log('  • "can I pay R79.88 at Checkers?"');
console.log('  • "redeem voucher 5608644555612212"');
console.log('  • "I need airtime" (to see disambiguation)');
console.log('');
console.log('Type "exit" to quit.');
console.log('');

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '👤 Customer: '
});

rl.prompt();

rl.on('line', (line) => {
  const input = line.trim();
  
  if (!input) {
    rl.prompt();
    return;
  }
  
  if (input.toLowerCase() === 'exit') {
    console.log('\n👋 Thanks for trying WaPay!\n');
    rl.close();
    return;
  }
  
  processMessage(input);
  rl.prompt();
});

rl.on('close', () => {
  process.exit(0);
});

