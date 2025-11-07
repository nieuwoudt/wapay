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

  console.log(`📱 Resolving WABA from phone number ID: ${phoneId}`);
  
  const pnRes = await fetch(
    `https://graph.facebook.com/v20.0/${phoneId}?fields=whatsapp_business_account&access_token=${accessToken}`
  );
  
  if (!pnRes.ok) {
    const error = await pnRes.text();
    throw new Error(`Cannot resolve WABA from phone number: ${pnRes.status} - ${error}`);
  }

  const pnJson = await pnRes.json();
  const wabaId = pnJson?.whatsapp_business_account?.id;
  
  if (!wabaId) {
    throw new Error('Cannot resolve WABA from PHONE_NUMBER_ID. Check token/permissions.');
  }

  console.log(`✅ Resolved WABA ID: ${wabaId}`);
  
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

