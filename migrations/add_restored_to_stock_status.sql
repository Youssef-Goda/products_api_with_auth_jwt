-- ============================================================
-- add_restored_to_stock_status.sql
-- Run ONCE in the Supabase SQL Editor.
-- Extends the stock_status CHECK constraint on public.orders
-- to allow the 'restored' terminal value.
--
-- Uses DROP CONSTRAINT IF EXISTS with the auto-generated name
-- that Supabase assigns (orders_stock_status_check).
-- If your DB used a different name, verify first with:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'public.orders'::regclass AND contype = 'c';
-- ============================================================

BEGIN;

-- Drop the constraint by its expected auto-generated name (safe no-op if missing)
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_stock_status_check;

-- Re-create with 'restored' added
ALTER TABLE public.orders
  ADD CONSTRAINT orders_stock_status_check
  CHECK (
    stock_status IS NULL
    OR stock_status IN ('pending', 'processing', 'done', 'failed', 'restored')
  );

COMMIT;

-- Verify: should show 'restored' in the constraint definition
SELECT
  c.conname        AS constraint_name,
  pg_get_constraintdef(c.oid) AS constraint_def
FROM pg_constraint c
WHERE c.conrelid = 'public.orders'::regclass
  AND c.contype  = 'c'
  AND c.conname  = 'orders_stock_status_check';
