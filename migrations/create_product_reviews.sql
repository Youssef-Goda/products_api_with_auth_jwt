-- ═══════════════════════════════════════════════════════════════════
-- Dealio — Product Reviews Table Migration
-- Run this in the Supabase SQL Editor for your project.
-- ═══════════════════════════════════════════════════════════════════
--
-- Prerequisites (already exist):
--   - public.users(id UUID)
--   - public.order_items(id UUID)
--   - public."Products"(id UUID, rating FLOAT)
--
-- Business rules enforced at DB level:
--   - One review per order_item (UNIQUE on user_id + order_item_id)
--   - Rating must be 1–5
--   - Comment max 500 characters
--   - Images is a JSON array (validated at application level)
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS product_reviews (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID         NOT NULL,
  user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_item_id UUID         NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  rating        SMALLINT     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT         CHECK (char_length(comment) <= 500),
  images        JSONB        NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE(user_id, order_item_id)
);

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_reviews_product_id  ON product_reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_reviews_user_id     ON product_reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_created_at  ON product_reviews(created_at DESC);

-- ── Verification ────────────────────────────────────────────────────
-- After running, confirm:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'product_reviews';
--
-- Should return: product_reviews
-- ═══════════════════════════════════════════════════════════════════
