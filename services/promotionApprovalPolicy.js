'use strict';

const crypto = require('node:crypto');

function classifyPromotionFinancials(financial, threshold = 20) {
  if (!financial?.costKnown || financial.grossMargin == null) return 'unverifiable';
  if (financial.lossMaking === true || Number(financial.grossProfit) < 0 || Number(financial.expectedLoss || 0) > 0) return 'owner_loss';
  if (Number(financial.grossMargin) < Number(threshold)) return 'manager_and_owner';
  return 'normal';
}

function affectedProducts(promotion, products) {
  const ids = (values) => (values || []).map(String);
  const eligibleIds = ids(promotion.eligible_product_ids);
  const categoryIds = ids(promotion.eligible_category_ids);
  const excludedIds = ids(promotion.excluded_product_ids);
  const excludedCategories = ids(promotion.excluded_category_ids);
  return products.filter((product) => {
    const id = String(product.id);
    const category = String(product.categoryId ?? product.category_id ?? '');
    return (!eligibleIds.length || eligibleIds.includes(id)) &&
      (!categoryIds.length || categoryIds.includes(category)) &&
      !excludedIds.includes(id) && !excludedCategories.includes(category);
  }).sort((a,b) => String(a.id).localeCompare(String(b.id)));
}

function promotionFinancialFingerprint(promotion, products, threshold) {
  const fields = {
    discountType: promotion.discount_type ?? promotion.discountType,
    discountValue: Number(promotion.discount_value ?? promotion.discountValue),
    maxDiscount: promotion.max_discount ?? promotion.maxDiscount ?? null,
    minOrderAmount: promotion.min_order_amount ?? promotion.minOrderAmount ?? 0,
    allowStacking: promotion.allow_stacking ?? promotion.allowStacking ?? false,
    campaignId: promotion.campaign_id ?? promotion.campaignId ?? null,
    eligibleProductIds: (promotion.eligible_product_ids ?? promotion.eligibleProductIds ?? []).map(String).sort(),
    eligibleCategoryIds: (promotion.eligible_category_ids ?? promotion.eligibleCategoryIds ?? []).map(String).sort(),
    excludedProductIds: (promotion.excluded_product_ids ?? promotion.excludedProductIds ?? []).map(String).sort(),
    excludedCategoryIds: (promotion.excluded_category_ids ?? promotion.excludedCategoryIds ?? []).map(String).sort(),
    eligibleCustomerIds: (promotion.eligible_customer_ids ?? promotion.eligibleCustomerIds ?? []).map(String).sort(),
    threshold: Number(threshold),
    products: affectedProducts(promotion, products).map((product) => ({
      id: String(product.id),
      priceCents: Math.round(Number(product.price) * 100),
      costCents: product.costPrice == null ? null : Math.round(Number(product.costPrice) * 100),
      categoryId: product.categoryId == null && product.category_id == null ? null : String(product.categoryId ?? product.category_id),
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

module.exports = { classifyPromotionFinancials, affectedProducts, promotionFinancialFingerprint };
