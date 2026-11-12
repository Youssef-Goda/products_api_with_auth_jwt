'use strict';

const { calculateCartProfitability, percentageDiscountCents, toCents } = require('./cartProfitability');

function discountForPromotion(promotion, subtotal) {
  let discount = promotion.discount_type === 'percentage'
    ? percentageDiscountCents(subtotal, promotion.discount_value)
    : toCents(promotion.discount_value,'Promotion discount');
  if (promotion.max_discount != null) discount = Math.min(discount, toCents(promotion.max_discount,'Maximum discount'));
  return Math.min(Math.max(0, discount), subtotal);
}

async function calculatePromotionFinancials({ promotion, products, threshold = 20, costLookup }) {
  const eligible = products.filter((p) => {
    const productId = String(p.id);
    return (!promotion.eligible_product_ids?.length || promotion.eligible_product_ids.includes(productId)) &&
      !promotion.excluded_product_ids?.includes(productId) &&
      (!promotion.eligible_category_ids?.length || promotion.eligible_category_ids.includes(String(p.categoryId ?? p.category_id))) &&
      !promotion.excluded_category_ids?.includes(String(p.categoryId ?? p.category_id));
  });
  if (!eligible.length) throw new Error('Promotion has no eligible products.');
  const items = eligible.map((p) => ({ productId: String(p.id), quantity: 1, unitPrice: p.price, productDiscount: 0 }));
  const subtotalCents = items.reduce((sum, item) => sum + Math.round(Number(item.unitPrice) * 100), 0);
  const discountCents = discountForPromotion(promotion, subtotalCents);
  // `products` are fetched by the authorized backend caller for this calculation;
  // use those same trusted rows instead of issuing an implicit second DB query.
  const trustedCostLookup=costLookup||(async(ids)=>ids.map((id)=>products.find((product)=>String(product.id).toLowerCase()===String(id).toLowerCase())).filter(Boolean).map((product)=>({id:product.id,costPrice:product.costPrice})));
  const result = await calculateCartProfitability({ items, cartDiscount: discountCents / 100, costLookup:trustedCostLookup });
  const known = result.items.every((line) => line.unitCost != null && line.grossProfit != null);
  const effectiveRevenue = result.items.reduce((sum, line) => sum + line.effectiveSubtotal, 0);
  const grossProfit = known ? result.items.reduce((sum, line) => sum + line.grossProfit, 0) : null;
  const grossMargin = !known || effectiveRevenue <= 0 ? null : grossProfit / effectiveRevenue * 100;
  const expectedLoss = known ? result.items.reduce((sum, line) => sum + Math.max(0, -line.grossProfit), 0) : null;
  return {
    eligibleProductCount: eligible.length,
    effectiveRevenue: Number(effectiveRevenue.toFixed(2)),
    grossProfit: grossProfit == null ? null : Number(grossProfit.toFixed(2)),
    grossMargin: grossMargin == null ? null : Number(grossMargin.toFixed(4)),
    costKnown: known,
    expectedLoss: expectedLoss == null ? null : Number(expectedLoss.toFixed(2)),
    lossMaking: known && result.items.some((line) => line.grossProfit < 0),
    itemLosses: known ? result.items.filter((line) => line.grossProfit < 0).map((line) => ({ productId: line.productId, grossLoss: Number(Math.abs(line.grossProfit).toFixed(2)) })) : null,
    minimumGrossMargin: Number(threshold),
  };
}

module.exports = { calculatePromotionFinancials, discountForPromotion };
