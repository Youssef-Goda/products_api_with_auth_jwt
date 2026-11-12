-- Checkout and payment lifecycle additions for the Promotions foundation.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS original_subtotal numeric(12,2);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS coupon_code text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS applied_promotion_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS promotion_names text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS checkout_idempotency_key text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_expires_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS orders_user_checkout_key_unique
  ON public.orders(user_id, checkout_idempotency_key) WHERE checkout_idempotency_key IS NOT NULL;

ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS original_subtotal numeric(12,2);
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS discount_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0);
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS effective_unit_price numeric(14,4);
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS applied_promotion_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS promotion_names text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.promotion_redemptions ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.promotion_redemptions DROP CONSTRAINT IF EXISTS promotion_redemptions_status_check;
UPDATE public.promotion_redemptions SET status='consumed' WHERE status='redeemed';
ALTER TABLE public.promotion_redemptions ADD CONSTRAINT promotion_redemptions_status_check
  CHECK (status IN ('reserved','consumed','released','expired'));
CREATE UNIQUE INDEX IF NOT EXISTS promotion_redemption_once_per_order
  ON public.promotion_redemptions(promotion_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS promotion_redemption_expiry_idx
  ON public.promotion_redemptions(status, expires_at) WHERE status='reserved';
