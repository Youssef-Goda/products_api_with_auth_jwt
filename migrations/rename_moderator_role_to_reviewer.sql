-- Canonicalize the existing Moderator role to Reviewer without changing any
-- user's access level. Unknown role values are left untouched.
-- Rerunnable. Review active sessions separately: old signed tokens are
-- temporarily mapped by authMiddleware until they expire.
BEGIN;
DO $$
DECLARE
  role_att smallint;
  role_type oid;
  role_kind "char";
  type_schema text;
  type_name text;
  has_old boolean;
  has_new boolean;
  c record;
  rewritten text;
BEGIN
  SELECT a.attnum, a.atttypid, t.typtype, ns.nspname, t.typname
    INTO role_att, role_type, role_kind, type_schema, type_name
  FROM pg_attribute a
  JOIN pg_type t ON t.oid=a.atttypid
  JOIN pg_namespace ns ON ns.oid=t.typnamespace
  WHERE a.attrelid='public.users'::regclass AND a.attname='role' AND NOT a.attisdropped;
  IF role_att IS NULL THEN RAISE EXCEPTION 'public.users.role does not exist'; END IF;

  IF role_kind='e' THEN
    SELECT EXISTS(SELECT 1 FROM pg_enum WHERE enumtypid=role_type AND enumlabel='moderator'),
           EXISTS(SELECT 1 FROM pg_enum WHERE enumtypid=role_type AND enumlabel='reviewer')
      INTO has_old, has_new;
    IF has_old AND NOT has_new THEN
      EXECUTE format('ALTER TYPE %I.%I RENAME VALUE %L TO %L',type_schema,type_name,'moderator','reviewer');
    ELSIF has_old AND has_new THEN
      -- If both enum values already exist, update role CHECKs before rows.
      FOR c IN SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid='public.users'::regclass AND contype='c'
          AND role_att=ANY(conkey) AND pg_get_constraintdef(oid) ILIKE '%moderator%'
      LOOP
        rewritten := regexp_replace(c.definition, '''moderator''', '''reviewer''', 'gi');
        EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I',c.conname);
        EXECUTE format('ALTER TABLE public.users ADD CONSTRAINT %I %s',c.conname,rewritten);
      END LOOP;
      UPDATE public.users SET role='reviewer' WHERE lower(role::text)='moderator';
    ELSIF NOT has_new THEN
      RAISE EXCEPTION 'Role enum has neither moderator nor reviewer value';
    END IF;
  ELSE
    -- Keep role CHECK expressions intact while replacing only the legacy value.
    FOR c IN SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='public.users'::regclass AND contype='c'
        AND role_att=ANY(conkey) AND pg_get_constraintdef(oid) ILIKE '%moderator%'
    LOOP
      rewritten := regexp_replace(c.definition, '''moderator''', '''reviewer''', 'gi');
      EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I',c.conname);
      EXECUTE format('ALTER TABLE public.users ADD CONSTRAINT %I %s',c.conname,rewritten);
    END LOOP;
    UPDATE public.users SET role='reviewer' WHERE lower(role::text)='moderator';
  END IF;
END $$;
COMMIT;
