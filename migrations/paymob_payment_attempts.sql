-- Durable Paymob attempt guard. Apply after promotion_redemption_checkout.sql.
-- Rollback: drop this table. This removes payment-attempt and reconciliation
-- history, so export/retain it before rollback if operational records are needed.
CREATE TABLE IF NOT EXISTS public.paymob_payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  request_key text NOT NULL,
  status text NOT NULL DEFAULT 'initializing'
    CHECK (status IN ('initializing','initiated','failed','expired','consumed','reconciliation_required')),
  payment_method text NOT NULL CHECK (payment_method IN ('card','wallet','cash','fawry')),
  provider_intention_id text,
  client_secret text,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  expires_at timestamptz,
  provider_transaction_id text,
  provider_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id, request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS paymob_one_active_attempt_per_order
  ON public.paymob_payment_attempts(order_id)
  WHERE status IN ('initializing','initiated','reconciliation_required');
CREATE UNIQUE INDEX IF NOT EXISTS paymob_provider_transaction_unique
  ON public.paymob_payment_attempts(provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS paymob_attempt_status_expiry_idx
  ON public.paymob_payment_attempts(status, expires_at);
ALTER TABLE public.paymob_payment_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paymob_payment_attempts FROM anon, authenticated;
