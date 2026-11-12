-- Inventory idempotency ledger. Apply to the Sequelize-managed PostgreSQL DB
-- that owns public."Products" (do not apply to Supabase unless DATABASE_URL
-- points to that same database). No existing stock values are changed.
BEGIN;
CREATE TABLE IF NOT EXISTS public.inventory_stock_movements (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('deduct','restore')),
  quantity integer NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id, product_id, action)
);
CREATE INDEX IF NOT EXISTS inventory_stock_movements_order_idx
  ON public.inventory_stock_movements(order_id, created_at);

-- Existing done orders represent stock that the previous service already
-- deducted. Seed idempotency claims without changing stock, so their later
-- cancellation can be restored by the new ledger-backed path.
INSERT INTO public.inventory_stock_movements(order_id,product_id,action,quantity)
SELECT o.id, oi.product_id, 'deduct', SUM(oi.quantity)::integer
FROM public.orders o
JOIN public.order_items oi ON oi.order_id=o.id
JOIN public."Products" p ON p.id=oi.product_id
WHERE o.stock_status='done'
GROUP BY o.id,oi.product_id
ON CONFLICT(order_id,product_id,action) DO NOTHING;

ALTER TABLE public.inventory_stock_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_stock_movements FROM anon, authenticated, PUBLIC;
COMMIT;
