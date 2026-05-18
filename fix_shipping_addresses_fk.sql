-- ============================================================
-- fix_shipping_addresses_fk.sql
-- Run this ONCE in the Supabase SQL Editor
-- ============================================================
--
-- ROOT CAUSE:
--   The foreign key shipping_addresses_user_id_fkey was originally
--   pointing to auth.users(id) — the Supabase OAuth auth table.
--   However, the Node.js backend mints JWTs using the UUID from
--   public.users(id) — a separate custom user table managed by
--   Sequelize.  These UUIDs are different for the same person,
--   so every INSERT from the backend produces:
--
--     "insert or update on table shipping_addresses violates
--      foreign key constraint shipping_addresses_user_id_fkey"
--
-- FIX:
--   Re-point the FK to public.users(id) so the JWT user_id
--   matches the referenced table.
-- ============================================================

-- STEP 1: Drop the old FK (safe even if it didn't exist)
ALTER TABLE public.shipping_addresses
  DROP CONSTRAINT IF EXISTS shipping_addresses_user_id_fkey;

-- STEP 2: Re-create the FK pointing to public.users
ALTER TABLE public.shipping_addresses
  ADD CONSTRAINT shipping_addresses_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES public.users(id)
  ON DELETE CASCADE;

-- STEP 3: Confirm the constraint exists
SELECT
  tc.constraint_name,
  tc.table_name,
  kcu.column_name,
  ccu.table_schema AS foreign_table_schema,
  ccu.table_name   AS foreign_table_name,
  ccu.column_name  AS foreign_column_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage  AS kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema    = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
 AND ccu.table_schema    = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name      = 'shipping_addresses';

-- ── Optional: fix any orphaned rows that have a user_id
-- ── not present in public.users (clean up before adding FK)
-- DELETE FROM public.shipping_addresses
--   WHERE user_id NOT IN (SELECT id FROM public.users);
