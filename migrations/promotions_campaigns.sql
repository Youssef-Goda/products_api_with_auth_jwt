-- Dealio promotions foundation. Review and apply through the normal migration process.
CREATE TABLE IF NOT EXISTS public.promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  kind text NOT NULL CHECK (kind IN ('coupon','automatic')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','partially_approved','pending_owner_approval','rejected','scheduled','active','paused','expired','cancelled')),
  discount_type text NOT NULL CHECK (discount_type IN ('percentage','fixed')),
  discount_value numeric(12,2) NOT NULL CHECK (discount_value >= 0),
  coupon_code text,
  starts_at timestamptz,
  ends_at timestamptz,
  min_order_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (min_order_amount >= 0),
  max_discount numeric(12,2) CHECK (max_discount IS NULL OR max_discount > 0),
  max_uses integer CHECK (max_uses IS NULL OR max_uses > 0),
  max_uses_per_customer integer CHECK (max_uses_per_customer IS NULL OR max_uses_per_customer > 0),
  eligible_product_ids uuid[] NOT NULL DEFAULT '{}',
  eligible_category_ids uuid[] NOT NULL DEFAULT '{}',
  excluded_product_ids uuid[] NOT NULL DEFAULT '{}',
  excluded_category_ids uuid[] NOT NULL DEFAULT '{}',
  eligible_customer_ids uuid[] NOT NULL DEFAULT '{}',
  campaign_id uuid,
  priority integer NOT NULL DEFAULT 0,
  allow_stacking boolean NOT NULL DEFAULT false,
  settings_version integer NOT NULL DEFAULT 1,
  margin_snapshot numeric(8,4),
  profit_snapshot numeric(12,2),
  expected_loss numeric(12,2) NOT NULL DEFAULT 0 CHECK (expected_loss >= 0),
  loss_making boolean NOT NULL DEFAULT false,
  creator_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS promotions_coupon_code_unique ON public.promotions (upper(btrim(coupon_code))) WHERE coupon_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS promotions_status_dates_idx ON public.promotions(status, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS public.promotion_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES public.promotions(id) ON DELETE CASCADE,
  settings_version integer NOT NULL,
  reviewer_id uuid NOT NULL,
  reviewer_role text NOT NULL CHECK (reviewer_role IN ('manager','owner')),
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  reason text,
  acknowledged_loss boolean NOT NULL DEFAULT false,
  financial_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(promotion_id, settings_version, reviewer_id)
);
CREATE TABLE IF NOT EXISTS public.promotion_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid REFERENCES public.promotions(id) ON DELETE SET NULL,
  actor_id uuid NOT NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.promotion_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES public.promotions(id),
  customer_id uuid NOT NULL,
  order_id uuid,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','redeemed','released')),
  discount_amount numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promotion_redemptions_usage_idx ON public.promotion_redemptions(promotion_id, customer_id, status);

CREATE TABLE IF NOT EXISTS public.promotion_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  starts_at timestamptz,
  ends_at timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','expired','cancelled')),
  target_customer_ids uuid[] NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='promotions_campaign_fk') THEN
    ALTER TABLE public.promotions ADD CONSTRAINT promotions_campaign_fk FOREIGN KEY (campaign_id) REFERENCES public.promotion_campaigns(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.promotion_policy (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  minimum_gross_margin numeric(8,4) NOT NULL DEFAULT 20 CHECK (minimum_gross_margin >= 0 AND minimum_gross_margin <= 100),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.promotion_policy(id, minimum_gross_margin) VALUES (true,20) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.promotion_policy_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  previous_threshold numeric(8,4) NOT NULL,
  proposed_threshold numeric(8,4) NOT NULL CHECK (proposed_threshold >= 0 AND proposed_threshold <= 100),
  reason text NOT NULL,
  proposed_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by uuid,
  decision_reason text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- All reads and writes go through the authenticated backend; do not expose
-- internal approval and profitability records through public Supabase APIs.
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotion_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotion_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotion_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotion_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotion_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotion_policy_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.promotions, public.promotion_approvals, public.promotion_audit_logs,
  public.promotion_redemptions, public.promotion_campaigns, public.promotion_policy,
  public.promotion_policy_proposals FROM anon, authenticated;
