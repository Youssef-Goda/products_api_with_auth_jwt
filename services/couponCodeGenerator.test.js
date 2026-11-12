'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateCouponCode, normalizeCouponPrefix, ALPHABET } = require('./couponCodeGenerator');

test('generated coupon codes are normalized, bounded, and use the safe alphabet', () => {
  const code = generateCouponCode({ prefix: ' deal- ', randomLength: 12 });
  assert.match(code, /^DEAL-[A-HJ-NP-Z2-9]{12}$/);
  assert.equal(code.length, 17);
  assert.equal([...code.slice(5)].every((character) => ALPHABET.includes(character)), true);
});

test('prefix validation rejects unsafe and overlong values', () => {
  assert.equal(normalizeCouponPrefix(' save_'), 'SAVE_');
  assert.throws(() => normalizeCouponPrefix('bad prefix'));
  assert.throws(() => normalizeCouponPrefix('x'.repeat(13)));
});

test('generated code length and prefix combination stay within backend limit', () => {
  assert.throws(() => generateCouponCode({ randomLength: 2 }));
  assert.throws(() => generateCouponCode({ prefix: 'x'.repeat(12), randomLength: 29 }));
  assert.equal(generateCouponCode({ prefix: 'x'.repeat(12), randomLength: 28 }).length, 40);
});
