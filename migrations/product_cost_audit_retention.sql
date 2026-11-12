-- Preserve cost audit history after a product is deleted. The original ID is
-- retained in productIdSnapshot while the live FK becomes NULL.
BEGIN;
ALTER TABLE public."ProductCostAuditLogs"
  ADD COLUMN IF NOT EXISTS "productIdSnapshot" uuid;
UPDATE public."ProductCostAuditLogs"
SET "productIdSnapshot" = "productId"
WHERE "productIdSnapshot" IS NULL;

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public."ProductCostAuditLogs"'::regclass
      AND contype = 'f'
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                          WHERE attrelid = 'public."ProductCostAuditLogs"'::regclass
                            AND attname = 'productId')]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE public."ProductCostAuditLogs" DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public."ProductCostAuditLogs" ALTER COLUMN "productId" DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public."ProductCostAuditLogs"'::regclass
                   AND conname='ProductCostAuditLogs_productId_retention_fk') THEN
    ALTER TABLE public."ProductCostAuditLogs"
      ADD CONSTRAINT "ProductCostAuditLogs_productId_retention_fk"
      FOREIGN KEY ("productId") REFERENCES public."Products"(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.preserve_product_cost_audit_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public."ProductCostAuditLogs"
  SET "productIdSnapshot" = COALESCE("productIdSnapshot", OLD.id)
  WHERE "productId" = OLD.id;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS preserve_product_cost_audit_identity ON public."Products";
CREATE TRIGGER preserve_product_cost_audit_identity
BEFORE DELETE ON public."Products"
FOR EACH ROW EXECUTE FUNCTION public.preserve_product_cost_audit_identity();
COMMIT;
