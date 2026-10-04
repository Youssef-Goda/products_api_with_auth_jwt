/**
 * reviewRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Complete review system for Dealio.
 *
 * Business rules (enforced server-side):
 *   1. User must be authenticated (JWT).
 *   2. User must have a DELIVERED order containing the product.
 *   3. One review per order_item (UNIQUE DB constraint).
 *   4. Rating 1–5 required.
 *   5. Comment max 500 chars.
 *   6. Images: max 5, must be valid URLs from existing upload endpoint.
 *
 * Mount in server.js:
 *   app.use('/api/reviews', reviewRoutes);
 *
 * Supabase tables required:
 *   product_reviews (see migration SQL below)
 *   orders, order_items, Products, users (existing)
 *
 * ─── SQL to run in Supabase SQL Editor ───────────────────────────────────────
 * CREATE TABLE IF NOT EXISTS product_reviews (
 *   id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   product_id    UUID NOT NULL,
 *   user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 *   order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
 *   rating        SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
 *   comment       TEXT CHECK (char_length(comment) <= 500),
 *   images        JSONB NOT NULL DEFAULT '[]',
 *   created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
 *   updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
 *   UNIQUE(user_id, order_item_id)
 * );
 * CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON product_reviews(product_id);
 * CREATE INDEX IF NOT EXISTS idx_reviews_user_id ON product_reviews(user_id);
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/authMiddleware');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase admin client (bypass RLS) ────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_COMMENT_LENGTH = 500;
const MAX_IMAGES = 5;
const REVIEW_ELIGIBLE_STATUS = 'delivered';

// ── Helper: resolve authenticated user's UUID from the JWT ────────────────────
async function resolveUserId(req, res) {
  const jwtId = req.user?.id;
  if (!jwtId) {
    res.status(401).json({ success: false, message: 'Not authenticated.' });
    return null;
  }
  const { data: userRow, error } = await supabase
    .from('users')
    .select('id')
    .eq('id', jwtId)
    .maybeSingle();
  if (error) {
    console.error('❌ [Reviews] resolveUserId DB error:', error.message);
    res.status(500).json({ success: false, message: 'Database error verifying user.' });
    return null;
  }
  if (!userRow) {
    res.status(403).json({ success: false, message: 'User not found.' });
    return null;
  }
  return userRow.id;
}

// ── Helper: recalculate + persist the product's average rating ────────────────
async function recalculateProductRating(productId) {
  try {
    const { data: reviews, error } = await supabase
      .from('product_reviews')
      .select('rating')
      .eq('product_id', productId);

    if (error) {
      console.error('❌ [Reviews] recalculate rating error:', error.message);
      return;
    }

    const count = reviews?.length ?? 0;
    const avg = count === 0
      ? 0.0
      : parseFloat((reviews.reduce((sum, r) => sum + r.rating, 0) / count).toFixed(1));

    // Update the Products table (Sequelize model table name = "Products")
    const { error: updateErr } = await supabase
      .from('Products')
      .update({ rating: avg })
      .eq('id', productId);

    if (updateErr) {
      console.error('❌ [Reviews] update product rating error:', updateErr.message);
    } else {
      console.log(`✅ [Reviews] Product ${productId} rating updated → ${avg} (${count} reviews)`);
    }
  } catch (e) {
    console.error('❌ [Reviews] recalculateProductRating exception:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/reviews/product/:productId
// Public — returns review summary + paginated review list
// Query params: page (default 1), limit (default 10), sort (newest|highest|lowest|images)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/product/:productId', async (req, res) => {
  const { productId } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  const sort = req.query.sort || 'newest';
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  try {
    // Fetch summary (total count + average rating + distribution)
    const { data: allReviews, error: summaryErr } = await supabase
      .from('product_reviews')
      .select('rating')
      .eq('product_id', productId);

    if (summaryErr) throw summaryErr;

    const totalCount = allReviews?.length ?? 0;
    const avgRating = totalCount === 0
      ? 0.0
      : parseFloat((allReviews.reduce((s, r) => s + r.rating, 0) / totalCount).toFixed(1));

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    (allReviews || []).forEach(r => {
      if (r.rating >= 1 && r.rating <= 5) distribution[r.rating]++;
    });

    // Build paginated query
    let query = supabase
      .from('product_reviews')
      .select('*, users(id, firstName, lastName, profilePicture)', { count: 'exact' })
      .eq('product_id', productId)
      .range(from, to);

    // Apply sort
    switch (sort) {
      case 'highest':
        query = query.order('rating', { ascending: false }).order('created_at', { ascending: false });
        break;
      case 'lowest':
        query = query.order('rating', { ascending: true }).order('created_at', { ascending: false });
        break;
      case 'images':
        // Reviews with images first — handled in JS after fetch since JSONB array length needs special SQL
        query = query.order('created_at', { ascending: false });
        break;
      default: // newest
        query = query.order('created_at', { ascending: false });
    }

    const { data: reviews, count, error: listErr } = await query;
    if (listErr) throw listErr;

    let reviewList = reviews || [];

    // For 'images' sort: sort in JS by image count descending
    if (sort === 'images') {
      reviewList = reviewList.sort((a, b) => {
        const aLen = Array.isArray(a.images) ? a.images.length : 0;
        const bLen = Array.isArray(b.images) ? b.images.length : 0;
        return bLen - aLen;
      });
    }

    // Shape the response — never expose sensitive user data
    const shapedReviews = reviewList.map(r => ({
      id: r.id,
      productId: r.product_id,
      rating: r.rating,
      comment: r.comment,
      images: Array.isArray(r.images) ? r.images : [],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      user: r.users ? {
        id: r.users.id,
        firstName: r.users.firstName,
        lastName: r.users.lastName,
        profilePicture: r.users.profilePicture || null,
      } : null,
    }));

    return res.json({
      success: true,
      data: {
        summary: {
          totalCount,
          avgRating,
          distribution,
        },
        reviews: shapedReviews,
        pagination: {
          page,
          limit,
          total: count ?? totalCount,
          hasMore: from + reviewList.length < (count ?? totalCount),
        },
      },
    });
  } catch (err) {
    console.error('❌ [Reviews] GET /product/:productId Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/reviews/eligibility/:productId
// Authenticated — checks if the current user is eligible to review this product
// Returns: { canReview, reason, orderItemId, existingReview? }
// ══════════════════════════════════════════════════════════════════════════════
router.get('/eligibility/:productId', authenticateToken, async (req, res) => {
  const userId = await resolveUserId(req, res);
  if (!userId) return;

  const { productId } = req.params;

  try {
    // 1. Find delivered orders containing this product for this user
    const { data: deliveredItems, error: itemsErr } = await supabase
      .from('order_items')
      .select('id, order_id, orders!inner(user_id, status)')
      .eq('product_id', productId)
      .eq('orders.user_id', userId)
      .eq('orders.status', REVIEW_ELIGIBLE_STATUS);

    if (itemsErr) throw itemsErr;

    if (!deliveredItems || deliveredItems.length === 0) {
      return res.json({
        success: true,
        data: {
          canReview: false,
          reason: 'not_purchased',
          message: 'You must purchase and receive this product to leave a review.',
        },
      });
    }

    // 2. Check if user already reviewed any of these order items
    const orderItemIds = deliveredItems.map(i => i.id);
    const { data: existingReviews, error: reviewErr } = await supabase
      .from('product_reviews')
      .select('id, rating, comment, images, created_at, order_item_id')
      .eq('user_id', userId)
      .eq('product_id', productId)
      .in('order_item_id', orderItemIds);

    if (reviewErr) throw reviewErr;

    if (existingReviews && existingReviews.length > 0) {
      // User already reviewed — return their existing review
      const existing = existingReviews[0];
      return res.json({
        success: true,
        data: {
          canReview: false,
          reason: 'already_reviewed',
          message: 'You have already reviewed this product.',
          existingReview: {
            id: existing.id,
            rating: existing.rating,
            comment: existing.comment,
            images: Array.isArray(existing.images) ? existing.images : [],
            createdAt: existing.created_at,
            orderItemId: existing.order_item_id,
          },
        },
      });
    }

    // 3. User is eligible — return the first eligible order item id
    return res.json({
      success: true,
      data: {
        canReview: true,
        reason: 'eligible',
        message: 'You are eligible to review this product.',
        orderItemId: deliveredItems[0].id,
      },
    });
  } catch (err) {
    console.error('❌ [Reviews] GET /eligibility/:productId Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/reviews
// Authenticated — create a new review
// Body: { productId, orderItemId, rating, comment?, images? }
// ══════════════════════════════════════════════════════════════════════════════
router.post('/', authenticateToken, async (req, res) => {
  const userId = await resolveUserId(req, res);
  if (!userId) return;

  const { productId, orderItemId, rating, comment, images } = req.body;

  // ── Input validation ──────────────────────────────────────────────────────
  if (!productId) {
    return res.status(400).json({ success: false, message: 'productId is required.' });
  }
  if (!orderItemId) {
    return res.status(400).json({ success: false, message: 'orderItemId is required.' });
  }
  const ratingNum = parseInt(rating);
  if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ success: false, message: 'Rating must be an integer between 1 and 5.' });
  }
  if (comment !== undefined && comment !== null) {
    if (typeof comment !== 'string') {
      return res.status(400).json({ success: false, message: 'Comment must be a string.' });
    }
    if (comment.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Comment must not exceed ${MAX_COMMENT_LENGTH} characters.`,
      });
    }
  }
  if (images !== undefined && images !== null) {
    if (!Array.isArray(images)) {
      return res.status(400).json({ success: false, message: 'images must be an array.' });
    }
    if (images.length > MAX_IMAGES) {
      return res.status(400).json({ success: false, message: `Maximum ${MAX_IMAGES} images allowed.` });
    }
    for (const img of images) {
      if (typeof img !== 'string' || !img.startsWith('http')) {
        return res.status(400).json({ success: false, message: 'Each image must be a valid URL string.' });
      }
    }
  }

  try {
    // ── Security: Verify orderItemId belongs to a DELIVERED order owned by this user ──
    const { data: orderItem, error: itemErr } = await supabase
      .from('order_items')
      .select('id, product_id, order_id, orders!inner(user_id, status)')
      .eq('id', orderItemId)
      .maybeSingle();

    if (itemErr) throw itemErr;
    if (!orderItem) {
      return res.status(404).json({ success: false, message: 'Order item not found.' });
    }
    // Must belong to the authenticated user
    if (orderItem.orders.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'This order item does not belong to you.' });
    }
    // Order must be delivered
    if (orderItem.orders.status !== REVIEW_ELIGIBLE_STATUS) {
      return res.status(400).json({
        success: false,
        message: `Order must be delivered before leaving a review. Current status: ${orderItem.orders.status}.`,
      });
    }
    // Product must match
    if (orderItem.product_id !== productId) {
      return res.status(400).json({ success: false, message: 'Product ID does not match the order item.' });
    }

    // ── Insert the review ─────────────────────────────────────────────────────
    const { data: review, error: insertErr } = await supabase
      .from('product_reviews')
      .insert({
        product_id: productId,
        user_id: userId,
        order_item_id: orderItemId,
        rating: ratingNum,
        comment: (comment && comment.trim()) || null,
        images: Array.isArray(images) ? images : [],
      })
      .select('*, users(id, firstName, lastName, profilePicture)')
      .single();

    if (insertErr) {
      // Unique constraint violation — already reviewed
      if (insertErr.code === '23505') {
        return res.status(409).json({
          success: false,
          message: 'You have already reviewed this product for this purchase.',
        });
      }
      throw insertErr;
    }

    // ── Recalculate product rating ─────────────────────────────────────────────
    await recalculateProductRating(productId);

    const shaped = {
      id: review.id,
      productId: review.product_id,
      rating: review.rating,
      comment: review.comment,
      images: Array.isArray(review.images) ? review.images : [],
      createdAt: review.created_at,
      updatedAt: review.updated_at,
      user: review.users ? {
        id: review.users.id,
        firstName: review.users.firstName,
        lastName: review.users.lastName,
        profilePicture: review.users.profilePicture || null,
      } : null,
    };

    console.log(`✅ [Reviews] Review created: product=${productId}, user=${userId}, rating=${ratingNum}`);
    return res.status(201).json({ success: true, data: shaped });
  } catch (err) {
    console.error('❌ [Reviews] POST / Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/reviews/:id
// Authenticated — update own review
// Body: { rating?, comment?, images? }
// ══════════════════════════════════════════════════════════════════════════════
router.put('/:id', authenticateToken, async (req, res) => {
  const userId = await resolveUserId(req, res);
  if (!userId) return;

  const { id } = req.params;
  const { rating, comment, images } = req.body;

  // ── Validate inputs ────────────────────────────────────────────────────────
  if (rating !== undefined) {
    const ratingNum = parseInt(rating);
    if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5.' });
    }
  }
  if (comment !== undefined && comment !== null) {
    if (typeof comment !== 'string') {
      return res.status(400).json({ success: false, message: 'Comment must be a string.' });
    }
    if (comment.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Comment must not exceed ${MAX_COMMENT_LENGTH} characters.`,
      });
    }
  }
  if (images !== undefined && images !== null) {
    if (!Array.isArray(images) || images.length > MAX_IMAGES) {
      return res.status(400).json({ success: false, message: `Maximum ${MAX_IMAGES} images allowed.` });
    }
    for (const img of images) {
      if (typeof img !== 'string' || !img.startsWith('http')) {
        return res.status(400).json({ success: false, message: 'Each image must be a valid URL string.' });
      }
    }
  }

  try {
    // Fetch review and verify ownership
    const { data: existing, error: fetchErr } = await supabase
      .from('product_reviews')
      .select('id, user_id, product_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ success: false, message: 'Review not found.' });
    if (existing.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'You can only edit your own reviews.' });
    }

    // Build update payload with only provided fields
    const updatePayload = { updated_at: new Date().toISOString() };
    if (rating !== undefined) updatePayload.rating = parseInt(rating);
    if (comment !== undefined) updatePayload.comment = (comment && comment.trim()) || null;
    if (images !== undefined) updatePayload.images = Array.isArray(images) ? images : [];

    const { data: updated, error: updateErr } = await supabase
      .from('product_reviews')
      .update(updatePayload)
      .eq('id', id)
      .select('*, users(id, firstName, lastName, profilePicture)')
      .single();

    if (updateErr) throw updateErr;

    await recalculateProductRating(existing.product_id);

    const shaped = {
      id: updated.id,
      productId: updated.product_id,
      rating: updated.rating,
      comment: updated.comment,
      images: Array.isArray(updated.images) ? updated.images : [],
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
      user: updated.users ? {
        id: updated.users.id,
        firstName: updated.users.firstName,
        lastName: updated.users.lastName,
        profilePicture: updated.users.profilePicture || null,
      } : null,
    };

    console.log(`✅ [Reviews] Review updated: id=${id}, user=${userId}`);
    return res.json({ success: true, data: shaped });
  } catch (err) {
    console.error('❌ [Reviews] PUT /:id Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DELETE /api/reviews/:id
// Authenticated — delete own review
// ══════════════════════════════════════════════════════════════════════════════
router.delete('/:id', authenticateToken, async (req, res) => {
  const userId = await resolveUserId(req, res);
  if (!userId) return;

  const { id } = req.params;

  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('product_reviews')
      .select('id, user_id, product_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ success: false, message: 'Review not found.' });
    if (existing.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'You can only delete your own reviews.' });
    }

    const productId = existing.product_id;

    const { error: deleteErr } = await supabase
      .from('product_reviews')
      .delete()
      .eq('id', id);

    if (deleteErr) throw deleteErr;

    await recalculateProductRating(productId);

    console.log(`✅ [Reviews] Review deleted: id=${id}, user=${userId}`);
    return res.json({ success: true, message: 'Review deleted.' });
  } catch (err) {
    console.error('❌ [Reviews] DELETE /:id Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
