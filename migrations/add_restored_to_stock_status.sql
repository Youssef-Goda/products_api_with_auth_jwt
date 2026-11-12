-- Replace only single-column CHECK constraints on stock_status. Multi-column
-- and unrelated checks are preserved. Rerunnable: the expected check is
-- detected by definition before adding it again. Existing invalid values make
-- VALIDATE fail instead of being silently rewritten.
BEGIN;
DO $$
DECLARE
  stock_att smallint;
  c record;
  expected_exists boolean := false;
BEGIN
  SELECT attnum INTO stock_att FROM pg_attribute
  WHERE attrelid='public.orders'::regclass AND attname='stock_status' AND NOT attisdropped;
  IF stock_att IS NULL THEN RAISE EXCEPTION 'public.orders.stock_status does not exist'; END IF;

  FOR c IN
    SELECT conname, conkey, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid='public.orders'::regclass AND contype='c'
  LOOP
    IF c.conkey = ARRAY[stock_att]::smallint[] THEN
      IF lower(c.definition) LIKE '%restored%' AND lower(c.definition) LIKE '%processing%' THEN
        expected_exists := true;
      ELSE
        EXECUTE format('ALTER TABLE public.orders DROP CONSTRAINT %I', c.conname);
      END IF;
    END IF;
  END LOOP;

  IF NOT expected_exists THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_stock_status_check
      CHECK (stock_status IS NULL OR stock_status IN ('pending','processing','done','failed','restored')) NOT VALID;
    ALTER TABLE public.orders VALIDATE CONSTRAINT orders_stock_status_check;
  END IF;
END $$;
COMMIT;
