'use strict';

function hideInternalOrderCosts(value) {
  if (Array.isArray(value)) return value.map(hideInternalOrderCosts);
  if (!value || typeof value !== 'object') return value;
  const clean = { ...value };
  delete clean.unit_cost_snapshot;
  return Object.fromEntries(Object.entries(clean).map(([key, child]) => [key, hideInternalOrderCosts(child)]));
}

module.exports = { hideInternalOrderCosts };
