#!/usr/bin/env node
/**
 * Clean up duplicate WhatsApp templates from database
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function cleanDuplicates() {
  console.log('🧹 Cleaning duplicate WhatsApp templates...\n');
  
  try {
    // Get all templates
    const allTemplates = await prisma.whatsappTemplate.findMany({
      orderBy: { createdAt: 'asc' }
    });
    
    console.log(`📊 Found ${allTemplates.length} total templates`);
    
    // Group by unique key (wabaId + name + language)
    const uniqueMap = new Map();
    const duplicates = [];
    
    for (const template of allTemplates) {
      const key = `${template.wabaId}_${template.name}_${template.language}`;
      
      if (uniqueMap.has(key)) {
        // This is a duplicate - mark for deletion
        duplicates.push(template.id);
        console.log(`🔍 Duplicate found: ${template.name} [${template.language}] (ID: ${template.id})`);
      } else {
        // First occurrence - keep it
        uniqueMap.set(key, template);
      }
    }
    
    if (duplicates.length === 0) {
      console.log('\n✅ No duplicates found! Database is clean.');
      return;
    }
    
    console.log(`\n🗑️  Found ${duplicates.length} duplicates to remove`);
    console.log(`✅ Keeping ${uniqueMap.size} unique templates\n`);
    
    // Delete duplicates
    const result = await prisma.whatsappTemplate.deleteMany({
      where: {
        id: { in: duplicates }
      }
    });
    
    console.log(`✅ Deleted ${result.count} duplicate templates`);
    
    // Verify cleanup
    const remaining = await prisma.whatsappTemplate.count();
    console.log(`📊 Templates remaining: ${remaining}`);
    
    // Show unique templates
    const unique = await prisma.whatsappTemplate.findMany({
      select: { name: true, language: true, status: true },
      orderBy: { name: 'asc' }
    });
    
    console.log('\n📋 Unique templates in database:');
    unique.forEach(t => {
      console.log(`   • ${t.name} [${t.language}] - ${t.status}`);
    });
    
  } catch (error) {
    console.error('❌ Error cleaning duplicates:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

cleanDuplicates()
  .then(() => {
    console.log('\n✅ Cleanup complete!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Cleanup failed:', error);
    process.exit(1);
  });

