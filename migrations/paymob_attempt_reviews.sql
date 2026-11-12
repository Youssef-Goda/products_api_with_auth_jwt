-- Append-only internal review notes for unresolved Paymob attempts. Reviews do
-- not mutate payment or attempt state; verified provider webhooks remain the
-- sole authority for paid/failed transitions.
BEGIN;
CREATE TABLE IF NOT EXISTS public.paymob_attempt_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES public.paymob_payment_attempts(id) ON DELETE RESTRICT,
  reviewer_id uuid NOT NULL,
  evidence_reference text NOT NULL CHECK (length(evidence_reference) BETWEEN 1 AND 500),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  previous_status text NOT NULL,
  resulting_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_status = resulting_status AND resulting_status = 'reconciliation_required')
);
CREATE INDEX IF NOT EXISTS paymob_attempt_reviews_attempt_created_idx
  ON public.paymob_attempt_reviews(attempt_id, created_at DESC);
ALTER TABLE public.paymob_attempt_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paymob_attempt_reviews FROM anon, authenticated, PUBLIC;
COMMIT;
