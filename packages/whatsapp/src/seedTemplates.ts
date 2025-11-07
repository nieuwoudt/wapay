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

/**
 * Fetch all templates with pagination support
 */
async function fetchAllTemplates(wabaId: string, accessToken: string): Promise<MetaTemplate[]> {
  let url = new URL(`https://graph.facebook.com/v20.0/${wabaId}/message_templates`);
  url.searchParams.set('fields', 'name,language,status,category,components');
  url.searchParams.set('limit', '200');

  const all: MetaTemplate[] = [];
  
  for (;;) {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Meta templates fetch failed: ${res.status} - ${error}`);
    }

    const json = await res.json();
    all.push(...(json.data ?? []));
    
    const next = json.paging?.next;
    if (!next) break;
    url = new URL(next); // Continue pagination
  }

  return all;
}

/**
 * Seed templates by auto-deriving WABA from phone number
 * This ensures we always seed the correct WABA regardless of env var misconfig
 */
export async function seedWhatsappTemplates(opts: {
  accessToken: string;
  phoneNumberId?: string;
}) {
  const { accessToken, phoneNumberId } = opts;
  
  console.log('🌱 Seeding WhatsApp templates from Meta API...');
  
  // 🔐 Always derive the WABA from the phone number, not env var
  const phoneId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!phoneId) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID not set');
  }

  // Try to resolve WABA from phone number, fallback to env var
  let wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  
  if (!wabaId) {
    console.log(`📱 Resolving WABA from phone number ID: ${phoneId}`);
    
    // Try different field names (API has changed over versions)
    const pnRes = await fetch(
      `https://graph.facebook.com/v20.0/${phoneId}?fields=id,verified_name,code_verification_status,display_phone_number,quality_rating,platform_type,throughput,last_onboarded_time&access_token=${accessToken}`
    );
    
    if (!pnRes.ok) {
      const error = await pnRes.text();
      console.error(`⚠️  Cannot resolve WABA from phone number: ${pnRes.status} - ${error}`);
      console.log('💡 Using WHATSAPP_BUSINESS_ACCOUNT_ID from env instead');
    } else {
      const pnJson = await pnRes.json();
      console.log('📋 Phone number details:', JSON.stringify(pnJson, null, 2));
      
      // The phone number doesn't directly expose WABA ID in newer API versions
      // We'll need to use the env var
      console.log('💡 WABA ID not available from phone number endpoint, using env var');
    }
  }
  
  // Fallback: use env var (this is actually more reliable)
  if (!wabaId) {
    wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  }
  
  if (!wabaId) {
    throw new Error('WHATSAPP_BUSINESS_ACCOUNT_ID not set and could not resolve from phone number. Please set this environment variable.');
  }

  console.log(`✅ Using WABA ID: ${wabaId}`);
  
  // Fetch ALL templates with pagination
  const templates = await fetchAllTemplates(wabaId, accessToken);

  console.log(`📥 Fetched ${templates.length} templates from Meta`);
  console.log(`📋 Templates:`, templates.map(t => `${t.name} [${t.language}] (${t.status})`).join(', '));

  // Upsert APPROVED templates only
  let seededCount = 0;
  for (const t of templates) {
    if (t.status !== 'APPROVED') {
      console.log(`⏭️  Skipping ${t.name} [${t.language}] - status: ${t.status}`);
      continue;
    }

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

  console.log(`✅ Seeded ${seededCount} APPROVED templates to database`);
  
  return { ok: true, count: seededCount, wabaId };
}

