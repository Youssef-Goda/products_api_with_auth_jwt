'use strict';

function parsePurchaseCost(value) {
  if (value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(text)) {
    throw new Error('Purchase cost must be a valid non-negative amount with up to 2 decimal places.');
  }
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 9999999999.99) {
    throw new Error('Purchase cost is outside the supported range.');
  }
  return number;
}

module.exports = { parsePurchaseCost };
