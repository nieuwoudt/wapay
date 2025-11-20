#!/usr/bin/env node
/**
 * Diagnostic script to check WhatsApp environment variables
 */

console.log('🔍 Checking WhatsApp Environment Variables...\n');

const requiredVars = [
  { name: 'META_WHATSAPP_TOKEN', alias: 'WHATSAPP_ACCESS_TOKEN' },
  { name: 'META_WHATSAPP_PHONE_NUMBER_ID', alias: 'WHATSAPP_PHONE_NUMBER_ID' },
  { name: 'META_WEBHOOK_VERIFY_TOKEN', alias: 'WHATSAPP_VERIFY_TOKEN' },
];

let allGood = true;

for (const { name, alias } of requiredVars) {
  const value = process.env[name] || process.env[alias];
  
  if (value) {
    const masked = value.substring(0, 15) + '***';
    console.log(`✅ ${name}: ${masked}`);
  } else {
    console.log(`❌ ${name}: NOT SET (also checked ${alias})`);
    allGood = false;
  }
}

console.log('\n' + '='.repeat(60));

if (allGood) {
  console.log('✅ All environment variables are set!');
  console.log('\nYour WaPay should now respond to WhatsApp messages.');
  console.log('\n📱 Next steps:');
  console.log('1. If deployed to Vercel, redeploy: vercel --prod');
  console.log('2. If running locally, restart: pnpm dev');
  console.log('3. Send a test message to your WhatsApp number');
} else {
  console.log('❌ Missing environment variables!');
  console.log('\n📝 To fix this:');
  console.log('1. Create .env.local with the missing variables');
  console.log('2. Or if on Vercel, set them with: vercel env add <VAR_NAME>');
  console.log('\nSee env.template for reference values.');
}

console.log('='.repeat(60));


