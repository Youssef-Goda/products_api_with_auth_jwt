-- ============================================================
-- add_lat_lng_to_shipping_addresses.sql
-- Run ONCE in the Supabase SQL Editor
-- ============================================================
-- Adds optional latitude / longitude columns to shipping_addresses
-- so GPS-detected coordinates can be stored alongside the text address.
-- ============================================================

-- STEP 1: Add the columns (idempotent — skips if already present)
ALTER TABLE public.shipping_addresses
  ADD COLUMN IF NOT EXISTS latitude  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

-- STEP 2: Confirm
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'shipping_addresses'
  AND column_name  IN ('latitude', 'longitude');
