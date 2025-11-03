/**
 * WhatsApp Template Catalog
 * 
 * In-memory cache for fast template lookups
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Catalog = Map<string, Set<string>>; // name -> approved languages

let catalog: Catalog = new Map();

export async function buildCatalog(wabaId: string) {
  console.log('🏗️  Building template catalog...');
  
  const rows = await prisma.whatsappTemplate.findMany({
    where: { wabaId, status: 'APPROVED' },
    select: { name: true, language: true },
  });

  const map: Catalog = new Map();
  for (const r of rows) {
    if (!map.has(r.name)) map.set(r.name, new Set());
    map.get(r.name)!.add(r.language);
  }
  
  catalog = map;
  
  console.log(`✅ Built catalog with ${map.size} templates`);
  
  // Log available templates for debugging
  for (const [name, langs] of map.entries()) {
    console.log(`   - ${name}: [${Array.from(langs).join(', ')}]`);
  }
  
  return map;
}

export function resolveLanguage(name: string, preferred?: string): string | null {
  const langs = catalog.get(name);
  if (!langs || langs.size === 0) {
    console.warn(`⚠️  Template '${name}' not found in catalog`);
    return null;
  }
  
  // Try preferred language first
  if (preferred && langs.has(preferred)) {
    console.log(`✓ Using preferred language '${preferred}' for template '${name}'`);
    return preferred;
  }
  
  // Fallback: first approved language (deterministic)
  const fallback = [...langs].sort()[0] ?? null;
  console.log(`ℹ️  Using fallback language '${fallback}' for template '${name}'`);
  return fallback;
}

export function isApproved(name: string, lang: string): boolean {
  return catalog.get(name)?.has(lang) ?? false;
}

export function getAvailableTemplates(): string[] {
  return Array.from(catalog.keys());
}

export function getAvailableLanguages(name: string): string[] {
  const langs = catalog.get(name);
  return langs ? Array.from(langs) : [];
}

