-- ============================================================
-- reconcile_cod_stock.sql  (READ-ONLY — no updates)
-- ============================================================
-- Lists COD orders placed BEFORE the stock-reduction feature
-- was deployed (stock_status IS NULL, payment_method = 'cod',
-- and order not already cancelled/refunded).
--
-- For each such order, shows the expected stock deductions that
-- NEVER happened.  Review this output and decide manually whether
-- to adjust product countInStock values accordingly.
--
-- This query is SAFE to run at any time — it performs no writes.
-- ============================================================

SELECT
  o.id                    AS order_id,
  o."createdAt"           AS placed_at,
  o.status                AS order_status,
  o.payment_method,
  o.stock_status,
  oi.product_id,
  oi.product_name,
  oi.quantity             AS qty_never_deducted
FROM public.orders o
JOIN public.order_items oi ON oi.order_id = o.id
WHERE o.payment_method = 'cod'
  AND o.stock_status IS NULL
  AND o.status NOT IN ('cancelled', 'refunded')
ORDER BY o."createdAt" DESC, o.id, oi.product_id;

