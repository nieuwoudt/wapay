-- Add skuCode column as nullable for backward compatibility (if missing)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'VasProduct' AND column_name = 'skuCode'
  ) THEN
    ALTER TABLE "VasProduct" ADD COLUMN "skuCode" text;
  END IF;
END
$$;

