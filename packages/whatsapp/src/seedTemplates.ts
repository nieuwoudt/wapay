/**
 * WhatsApp Template Seeding
 * 
 * Fetches approved templates from Meta API and stores them in database
 */

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

type MetaTemplate = {
  name: string;
  status: string;
  category: string;
  language: string;
  components?: any[];
};

export async function seedWhatsappTemplates(opts: {
  wabaId: string;
  accessToken: string;
}) {
  const { wabaId, accessToken } = opts;
  
  console.log('🌱 Seeding WhatsApp templates from Meta API...');
  console.log(`📋 Using WABA ID: ${wabaId}`);
  
  const url = new URL(`https://graph.facebook.com/v21.0/${wabaId}/message_templates`);
  url.searchParams.set('limit', '200');
  // Don't filter by status - fetch ALL templates to see what we have

  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Meta templates fetch failed: ${res.status} - ${error}`);
    }

    const json = await res.json();
    const templates: MetaTemplate[] = json.data ?? [];

    console.log(`📥 Fetched ${templates.length} templates from Meta`);
    console.log(`📋 Template details:`, templates.map(t => `${t.name} (${t.status}, ${t.language})`).join(', '));

    let seededCount = 0;
    for (const t of templates) {
      const componentsHash = t.components
        ? crypto.createHash('sha256').update(JSON.stringify(t.components)).digest('hex')
        : null;

      await prisma.whatsappTemplate.upsert({
        where: { 
          wabaId_name_language: { 
            wabaId, 
            name: t.name, 
            language: t.language 
          } 
        },
        update: {
          status: t.status,
          category: t.category,
          componentsHash,
          updatedAt: new Date(),
        },
        create: {
          wabaId,
          name: t.name,
          language: t.language,
          status: t.status,
          category: t.category,
          componentsHash,
        },
      });

      seededCount++;
    }

    console.log(`✅ Seeded ${seededCount} templates to database`);
    
    return { ok: true, count: seededCount };

  } catch (error) {
    console.error('❌ Template seeding failed:', error);
    throw error;
  }
}

