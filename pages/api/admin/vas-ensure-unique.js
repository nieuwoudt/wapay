/**
 * Admin endpoint to ensure VasProduct unique constraint exists in prod.
 * Protect with x-admin-key (same as other admin endpoints).
 *
 * Actions:
 * - Add UNIQUE(provider, category, externalCode) if missing.
 * - Return current indexes/constraints for VasProduct.
 */

import prisma from '../../../lib/prisma.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  try {
    const addConstraintSql = `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'VasProduct_provider_category_externalCode_key'
        ) THEN
          ALTER TABLE "VasProduct"
          ADD CONSTRAINT "VasProduct_provider_category_externalCode_key"
          UNIQUE ("provider", "category", "externalCode");
        END IF;
      END
      $$;
    `;
    await prisma.$executeRawUnsafe(addConstraintSql);

    const indexes = await prisma.$queryRawUnsafe(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'VasProduct';
    `);

    const constraints = await prisma.$queryRawUnsafe(`
      SELECT conname, pg_get_constraintdef(c.oid) as definition
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      WHERE t.relname = 'VasProduct';
    `);

    return res.status(200).json({
      ok: true,
      indexes,
      constraints,
    });
  } catch (error) {
    console.error('vas-ensure-unique error', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}

