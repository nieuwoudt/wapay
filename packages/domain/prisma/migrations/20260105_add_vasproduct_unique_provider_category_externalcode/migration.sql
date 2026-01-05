-- Ensure composite unique used by vasProduct.upsert(provider, category, externalCode)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'VasProduct_provider_category_externalCode_key'
  ) THEN
    ALTER TABLE "VasProduct"
      ADD CONSTRAINT "VasProduct_provider_category_externalCode_key"
      UNIQUE ("provider", "category", "externalCode");
  END IF;
END
$$;

