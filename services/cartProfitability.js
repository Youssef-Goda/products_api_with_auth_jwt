'use strict';

const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

function toCents(value, label) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) {
      throw new TypeError(`${label} must be a non-negative amount with at most 2 decimal places.`);
    }
    const cents = Math.round(value * 100);
    if (!Number.isSafeInteger(cents)) throw new RangeError(`${label} exceeds the supported range.`);
    return cents;
  }

  const text = String(value ?? '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new TypeError(`${label} must be a non-negative amount with at most 2 decimal places.`);
  }
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (cents > MAX_CENTS) throw new RangeError(`${label} exceeds the supported range.`);
  return Number(cents);
}

const fromCents = (cents) => cents / 100;

function percentageDiscountCents(subtotalCents, percentage) {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0) throw new TypeError('Subtotal cents must be a non-negative integer.');
  const percentageCents=toCents(percentage,'Percentage discount');
  if(percentageCents>10000)throw new RangeError('Percentage discount cannot exceed 100%.');
  return Number((BigInt(subtotalCents)*BigInt(percentageCents)+5000n)/10000n);
}

function allocateDiscountCents(weights, discountCents) {
  if (!Array.isArray(weights) || !Number.isSafeInteger(discountCents) || discountCents < 0 || weights.some((weight) => !Number.isSafeInteger(weight) || weight < 0)) {
    throw new TypeError('Discount allocation requires non-negative integer cents and weights.');
  }
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (discountCents > totalWeight) throw new RangeError('Discount exceeds eligible item totals.');
  if (discountCents === 0) return weights.map(() => 0);
  const shares = weights.map((weight, index) => {
    if (weight === 0) return { index, cents: 0, remainder: 0n };
    const product = BigInt(discountCents) * BigInt(weight);
    return { index, cents: Number(product / BigInt(totalWeight)), remainder: product % BigInt(totalWeight) };
  });
  let remaining = discountCents - shares.reduce((sum, share) => sum + share.cents, 0);
  const order = shares.filter((share) => weights[share.index] > 0)
    .sort((a,b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (let cursor=0; remaining>0; cursor++,remaining--) shares[order[cursor].index].cents++;
  return shares.map((share) => share.cents);
}

/**
 * Calculate line-level profitability after existing item discounts and one
 * cart discount. Cart discount is shared by largest-remainder proportional
 * allocation over eligible post-product-discount subtotals, so cents reconcile
 * exactly and product discounts are never counted twice.
 *
 * Each item: { productId/product_id, unitPrice/unit_price (before item discounts),
 *              quantity, productDiscount, eligibleForCartDiscount }. unitCost must come from trusted
 * stored product/order data; this calculator fetches the current stored cost
 * itself. Inject costLookup only for a trusted repository or deterministic tests.
 */
async function calculateCartProfitability({ items, cartDiscount = 0, costBasis = 'current', costLookup = lookupCurrentProductCosts }) {
  if (!Array.isArray(items) || items.length === 0) throw new TypeError('At least one cart item is required.');
  if (!['current', 'orderSnapshot'].includes(costBasis)) throw new TypeError('costBasis must be current or orderSnapshot.');
  const cartDiscountCents = toCents(cartDiscount, 'Cart discount');

  const productIds = [...new Set(items.map((item) => item?.productId ?? item?.product_id).filter(Boolean).map(String))];
  if (productIds.length === 0 || items.some((item) => !(item?.productId ?? item?.product_id))) {
    throw new TypeError('Every item must reference a product.');
  }
  let costById = null;
  if (costBasis === 'current') {
    const storedCosts = await costLookup(productIds);
    costById = storedCosts instanceof Map
      ? storedCosts
      : new Map(storedCosts.map((product) => [String(product.id).toLowerCase(), product.costPrice]));
    if (productIds.some((id) => !costById.has(id.toLowerCase()))) {
      throw new Error('One or more products were not found while calculating profitability.');
    }
  }

  const lines = items.map((item, index) => {
    const unitPriceCents = toCents(item.unitPrice ?? item.unit_price, `Item ${index + 1} unit price`);
    const quantity = item.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new TypeError(`Item ${index + 1} quantity must be a positive integer.`);
    const subtotalCents = unitPriceCents * quantity;
    if (!Number.isSafeInteger(subtotalCents)) throw new RangeError(`Item ${index + 1} subtotal exceeds the supported range.`);
    const productDiscountCents = toCents(item.productDiscount ?? item.product_discount ?? 0, `Item ${index + 1} product discount`);
    if (productDiscountCents > subtotalCents) throw new RangeError(`Item ${index + 1} product discount exceeds its subtotal.`);
    const productId = String(item.productId ?? item.product_id);
    // Snapshot mode is for order-item rows already loaded from the database;
    // API handlers must never pass client-provided item snapshots here.
    const storedCost = costBasis === 'orderSnapshot'
      ? item.unit_cost_snapshot
      : costById.get(productId.toLowerCase());
    const unitCostCents = storedCost == null ? null : toCents(storedCost, `Item ${index + 1} unit cost`);
    const eligible = item.eligibleForCartDiscount !== false && item.eligible_for_cart_discount !== false;
    return {
      productId,
      quantity,
      unitPriceCents,
      subtotalCents,
      productDiscountCents,
      cartDiscountEligible: eligible,
      allocationWeight: eligible ? subtotalCents - productDiscountCents : 0,
      unitCostCents,
      cartDiscountCents: 0,
    };
  });

  const eligibleSubtotalCents = lines.reduce((sum, line) => sum + line.allocationWeight, 0);
  if (!Number.isSafeInteger(eligibleSubtotalCents)) throw new RangeError('Eligible cart subtotal exceeds the supported range.');
  if (cartDiscountCents > eligibleSubtotalCents) throw new RangeError('Cart discount exceeds eligible item totals.');

  const shares = allocateDiscountCents(lines.map((line) => line.allocationWeight), cartDiscountCents);
  for (const [index, share] of shares.entries()) lines[index].cartDiscountCents = share;

  const results = lines.map((line) => {
    const totalDiscountCents = line.productDiscountCents + line.cartDiscountCents;
    const effectiveSubtotalCents = line.subtotalCents - totalDiscountCents;
    const costTotalCents = line.unitCostCents == null ? null : line.unitCostCents * line.quantity;
    if (costTotalCents != null && !Number.isSafeInteger(costTotalCents)) {
      throw new RangeError(`Item ${line.productId ?? ''} cost total exceeds the supported range.`);
    }
    const grossProfitCents = line.unitCostCents == null
      ? null
      : effectiveSubtotalCents - costTotalCents;
    return {
      productId: line.productId,
      quantity: line.quantity,
      unitCost: line.unitCostCents == null ? null : fromCents(line.unitCostCents),
      unitCostCents: line.unitCostCents,
      subtotal: fromCents(line.subtotalCents),
      subtotalCents: line.subtotalCents,
      productDiscount: fromCents(line.productDiscountCents),
      productDiscountCents: line.productDiscountCents,
      cartDiscount: fromCents(line.cartDiscountCents),
      cartDiscountCents: line.cartDiscountCents,
      totalDiscount: fromCents(totalDiscountCents),
      totalDiscountCents,
      effectiveSubtotal: fromCents(effectiveSubtotalCents),
      effectiveSubtotalCents,
      // Average effective unit price; it can contain fractional cents when an
      // indivisible line discount is spread across multiple units.
      effectiveUnitPrice: effectiveSubtotalCents / 100 / line.quantity,
      grossProfit: grossProfitCents == null ? null : fromCents(grossProfitCents),
      grossProfitCents,
      grossMargin: grossProfitCents == null || effectiveSubtotalCents === 0
        ? null
        : (grossProfitCents / effectiveSubtotalCents) * 100,
      isBelowCost: grossProfitCents == null ? null : grossProfitCents < 0,
    };
  });

  const allocatedCartDiscountCents = lines.reduce((sum, line) => sum + line.cartDiscountCents, 0);
  if (allocatedCartDiscountCents !== cartDiscountCents) throw new Error('Cart discount allocation failed to reconcile.');

  const totalProductDiscountBigInt = lines.reduce((sum, line) => sum + BigInt(line.productDiscountCents), 0n);
  if (totalProductDiscountBigInt + BigInt(cartDiscountCents) > MAX_CENTS) {
    throw new RangeError('Total discounts exceed the supported range.');
  }

  return {
    items: results,
    cartDiscount: fromCents(cartDiscountCents),
    cartDiscountCents,
    allocatedCartDiscount: fromCents(allocatedCartDiscountCents),
    allocatedCartDiscountCents,
    totalProductDiscount: fromCents(Number(totalProductDiscountBigInt)),
    totalDiscount: fromCents(Number(BigInt(cartDiscountCents) + totalProductDiscountBigInt)),
  };
}

async function lookupCurrentProductCosts(productIds) {
  const Product = require('../models/Product');
  const products = await Product.findAll({
    where: { id: productIds },
    attributes: ['id', 'costPrice'],
  });
  return products.map((product) => ({ id: product.id, costPrice: product.costPrice }));
}

module.exports = { calculateCartProfitability, lookupCurrentProductCosts, allocateDiscountCents, percentageDiscountCents, toCents, fromCents };
