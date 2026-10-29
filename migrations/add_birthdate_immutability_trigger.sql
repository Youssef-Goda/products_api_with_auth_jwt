-- ============================================================
-- add_birthdate_immutability_trigger.sql
-- Run ONCE in the Supabase SQL Editor.
-- Adds a BEFORE UPDATE trigger on public.users that raises an
-- exception when someone tries to change a non-NULL birthDate.
-- This is DB-level defence-in-depth on top of the API-level 409.
-- Column name: "birthDate" (camelCase, case-sensitive in Postgres).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.prevent_birthdate_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only enforce when the stored value is already set
  IF OLD."birthDate" IS NOT NULL THEN
    -- Reject any attempt to change it (including setting it to the same value again)
    IF NEW."birthDate" IS DISTINCT FROM OLD."birthDate" THEN
      RAISE EXCEPTION
        'Birth date cannot be changed once it has been set (current: %, attempted: %)',
        OLD."birthDate", NEW."birthDate"
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_birthdate_change ON public.users;

CREATE TRIGGER trg_prevent_birthdate_change
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_birthdate_change();

COMMIT;

-- Verify:
SELECT tgname, tgtype
FROM pg_trigger
WHERE tgrelid = 'public.users'::regclass
  AND tgname = 'trg_prevent_birthdate_change';

