'use strict';

const { calculateProductProfitability } = require('./productProfitability');

const canManageProductCost = (role) => String(role || '').toLowerCase() === 'owner';

function serializePublicProduct(product) {
  const value = typeof product.toJSON === 'function' ? product.toJSON() : { ...product };
  delete value.costPrice;
  delete value.grossProfit;
  delete value.grossMargin;
  delete value.isBelowCost;
  return value;
}

function serializeInternalProduct(product) {
  const value = typeof product.toJSON === 'function' ? product.toJSON() : { ...product };
  const figures = calculateProductProfitability({ costPrice: value.costPrice, sellingPrice: Number(value.price) });
  return {
    ...value,
    costPrice: figures.costPrice,
    grossProfit: figures.grossProfit,
    grossMargin: figures.grossMargin,
    isBelowCost: figures.isBelowCost,
  };
}

module.exports = { canManageProductCost, serializePublicProduct, serializeInternalProduct };
