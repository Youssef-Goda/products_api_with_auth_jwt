-- Apply once to the existing Supabase/PostgreSQL database before deploying the API.
-- Existing costs remain NULL (unknown); no historical values are fabricated.
ALTER TABLE "Products" ADD COLUMN IF NOT EXISTS "costPrice" NUMERIC(12,2);

CREATE TABLE IF NOT EXISTS "ProductCostAuditLogs" (
  id BIGSERIAL PRIMARY KEY,
  "productId" UUID NOT NULL REFERENCES "Products"(id) ON DELETE CASCADE,
  "previousCost" NUMERIC(12,2),
  "newCost" NUMERIC(12,2),
  "changedBy" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "ProductCostAuditLogs_product_created_idx"
  ON "ProductCostAuditLogs" ("productId", "createdAt" DESC);

ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS unit_cost_snapshot NUMERIC(12,2);
