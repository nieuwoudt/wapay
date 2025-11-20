#!/usr/bin/env node
/**
 * Test Database Connection
 * This will help diagnose the DATABASE_URL issue
 */

console.log('🔍 Testing Database Connection...\n');

// Check if DATABASE_URL is set
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error('❌ DATABASE_URL is not set in environment');
  console.log('\n📝 Please set it first:');
  console.log('   export DATABASE_URL="postgresql://..."');
  process.exit(1);
}

// Parse and validate the URL
try {
  const url = new URL(dbUrl);
  
  console.log('📊 Connection Details:');
  console.log('─────────────────────────────────');
  console.log('Protocol:', url.protocol);
  console.log('Username:', url.username);
  console.log('Password:', url.password ? '***' + url.password.slice(-4) : 'NOT SET');
  console.log('Host:', url.hostname);
  console.log('Port:', url.port);
  console.log('Database:', url.pathname.slice(1));
  console.log('Params:', url.search);
  console.log('─────────────────────────────────\n');

  // Check for common issues
  let hasIssues = false;

  if (!url.username.includes('.')) {
    console.error('❌ USERNAME FORMAT ISSUE:');
    console.error('   Current:', url.username);
    console.error('   Expected: postgres.[PROJECT-REF]');
    console.error('   Example: postgres.abcdefghijklmnop\n');
    hasIssues = true;
  }

  if (!url.hostname.includes('pooler.supabase.com')) {
    console.error('⚠️  HOSTNAME ISSUE:');
    console.error('   Current:', url.hostname);
    console.error('   Expected: aws-0-[region].pooler.supabase.com');
    console.error('   You should use the POOLER connection for Vercel\n');
    hasIssues = true;
  }

  if (url.port !== '6543') {
    console.error('⚠️  PORT ISSUE:');
    console.error('   Current:', url.port);
    console.error('   Expected: 6543 (pooler)');
    console.error('   Note: Port 5432 is for direct connections, not serverless\n');
    hasIssues = true;
  }

  if (hasIssues) {
    console.log('\n🔧 HOW TO FIX:\n');
    console.log('1. Go to: https://supabase.com/dashboard/projects');
    console.log('2. Click your WaPay project');
    console.log('3. Settings → Database');
    console.log('4. Scroll to "Connection string"');
    console.log('5. Select "Connection pooling" (NOT "Direct connection")');
    console.log('6. Click "URI" tab');
    console.log('7. Copy the ENTIRE connection string');
    console.log('8. Replace [YOUR-PASSWORD] with your actual password');
    console.log('9. Update in Vercel and redeploy\n');
    process.exit(1);
  }

  console.log('✅ Connection string format looks correct!\n');
  console.log('Now testing actual connection...\n');

  // Try to connect with Prisma
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: dbUrl,
      },
    },
  });

  prisma.$connect()
    .then(async () => {
      console.log('✅ DATABASE CONNECTION SUCCESSFUL!\n');
      
      // Try a simple query
      const result = await prisma.$queryRaw`SELECT NOW() as current_time`;
      console.log('📅 Database time:', result[0].current_time);
      
      // Check if tables exist
      const tables = await prisma.$queryRaw`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
        ORDER BY table_name
      `;
      
      console.log(`\n📊 Found ${tables.length} tables in database:`);
      tables.forEach(t => console.log('   -', t.table_name));
      
      await prisma.$disconnect();
      console.log('\n✅ Your DATABASE_URL is correct!');
      console.log('   You can use this in Vercel.');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ DATABASE CONNECTION FAILED!\n');
      console.error('Error:', error.message);
      console.error('\nThis means:');
      
      if (error.message.includes('Tenant or user not found')) {
        console.error('   • Username format is wrong (should be postgres.[PROJECT-REF])');
        console.error('   • OR password is incorrect');
        console.error('   • OR Supabase project doesn\'t exist\n');
      } else if (error.message.includes('password authentication failed')) {
        console.error('   • Password is incorrect\n');
      } else if (error.message.includes('timeout')) {
        console.error('   • Network/firewall issue\n');
      } else {
        console.error('   • Unknown database error\n');
      }

      console.log('🔧 Next steps:');
      console.log('1. Verify your Supabase project exists');
      console.log('2. Get fresh connection string from Supabase dashboard');
      console.log('3. Make sure you\'re using CONNECTION POOLING (port 6543)');
      console.log('4. Verify your database password is correct\n');
      
      process.exit(1);
    });

} catch (error) {
  console.error('❌ Invalid DATABASE_URL format:', error.message);
  console.log('\n✅ Expected format:');
  console.log('postgresql://postgres.[ref]:[password]@aws-0-region.pooler.supabase.com:6543/postgres');
  process.exit(1);
}


