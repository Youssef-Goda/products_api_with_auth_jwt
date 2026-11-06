'use strict';

/** Internal gross profitability figures. A null cost is unknown, never zero. */
function calculateProductProfitability({ costPrice, sellingPrice, effectivePrice = sellingPrice }) {
  const price = Number(effectivePrice);
  if (!Number.isFinite(price) || price < 0) throw new TypeError('Effective price must be a non-negative finite amount.');
  const cost = costPrice == null ? null : Number(costPrice);
  if (cost !== null && (!Number.isFinite(cost) || cost < 0)) throw new TypeError('Cost must be a non-negative finite amount.');
  const grossProfit = cost === null ? null : price - cost;
  return {
    costPrice: cost,
    sellingPrice: Number(sellingPrice),
    effectivePrice: price,
    grossProfit,
    grossMargin: cost === null || price === 0 ? null : (grossProfit / price) * 100,
    isBelowCost: cost !== null && price < cost,
  };
}

module.exports = { calculateProductProfitability };
