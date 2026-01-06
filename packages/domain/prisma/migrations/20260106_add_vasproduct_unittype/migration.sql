-- Add unitType column with default 'DATA' if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'VasProduct' AND column_name = 'unitType'
  ) THEN
    ALTER TABLE "VasProduct" ADD COLUMN "unitType" text NOT NULL DEFAULT 'DATA';
  END IF;
END
$$;

