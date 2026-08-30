-- ============================================================
-- add_stock_status_to_orders.sql
-- Run ONCE in the Supabase SQL Editor.
-- ============================================================
-- All statements use IF NOT EXISTS / DROP IF EXISTS so this
-- script is safe to re-run, but it is intended to execute once.
-- ============================================================
--
-- PURPOSE
-- -------
-- Adds two columns to the public.orders table to support
-- retryable, idempotent stock reduction after a successful
-- Paymob payment webhook.
--
-- COLUMN: stock_status TEXT DEFAULT NULL
-- ──────────────────────────────────────
--   State machine (transitions enforced by the webhook handler):
--
--     NULL          - Payment not yet confirmed, or a pre-feature
--                     order. The webhook NEVER processes stock for
--                     NULL orders.  This covers all pre-existing rows.
--
--     'pending'     - Payment confirmed; stock reduction not yet
--                     attempted. Set atomically alongside
--                     payment_status = 'paid' in Phase A.
--
--     'processing'  - Stock reduction is in progress. The
--                     stock_processing_started_at timestamp below
--                     guards against this state becoming permanently
--                     stuck (e.g. Vercel function crash / OOM kill).
--
--     'done'        - Stock was successfully reduced. TERMINAL.
--                     No subsequent webhook will touch stock again.
--
--     'failed'      - Stock reduction failed (Sequelize rolled back).
--                     Retryable: a duplicate Paymob webhook will
--                     reclaim and retry from this state.
--
-- COLUMN: stock_processing_started_at TIMESTAMPTZ DEFAULT NULL
-- ─────────────────────────────────────────────────────────────
--   Set to now() when stock_status transitions to 'processing'.
--   Cleared to NULL when transitioning to 'done' or 'failed'.
--
--   STALE LEASE RECOVERY:
--     Any row with stock_status = 'processing' where
--     stock_processing_started_at < now() - 5 minutes is
--     treated as abandoned (server crash/timeout). A subsequent
--     webhook reclaims the processing slot via a second conditional
--     UPDATE that matches the stale timestamp.
--
-- EXISTING ORDERS
-- ───────────────
-- Pre-existing rows keep stock_status = NULL after this migration.
-- The webhook only processes stock for stock_status IN
-- ('pending', 'failed'), so NULL rows are permanently excluded.
-- This is intentional: stock for orders placed before this feature
-- was deployed is not retroactively tracked.
-- ============================================================

-- STEP 1: Add stock_status column (idempotent)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS stock_status TEXT DEFAULT NULL;

-- STEP 2: Add lease timestamp for stale-processing recovery (idempotent)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS stock_processing_started_at TIMESTAMPTZ DEFAULT NULL;

-- STEP 3: Enforce valid state values via CHECK constraint (idempotent)
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_stock_status_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_stock_status_check
  CHECK (
    stock_status IS NULL
    OR stock_status IN ('pending', 'processing', 'done', 'failed')
  );

-- STEP 4: Partial index for fast webhook lookups (idempotent)
-- Only indexes rows that still need work, keeping the index small.
CREATE INDEX IF NOT EXISTS idx_orders_stock_status_active
  ON public.orders (id, stock_processing_started_at)
  WHERE stock_status IN ('pending', 'processing', 'failed');

-- STEP 5: Confirm the columns and constraint exist
SELECT
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'orders'
  AND column_name  IN ('stock_status', 'stock_processing_started_at')
ORDER BY column_name;
