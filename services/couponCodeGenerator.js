'use strict';
const { randomInt } = require('node:crypto');
const ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function normalizeCouponPrefix(value=''){
  const prefix=String(value||'').trim().toUpperCase();
  if(prefix.length>12||!/^[A-Z0-9_-]*$/.test(prefix))throw new Error('Coupon prefix must be at most 12 letters, digits, underscores, or hyphens.');
  return prefix;
}

function generateCouponCode({prefix='',randomLength=10}={}){
  const normalized=normalizeCouponPrefix(prefix);
  if(!Number.isSafeInteger(randomLength)||randomLength<3||randomLength>28||normalized.length+randomLength>40)throw new Error('Generated coupon code length is invalid.');
  let suffix='';
  for(let i=0;i<randomLength;i++)suffix+=ALPHABET[randomInt(ALPHABET.length)];
  return `${normalized}${suffix}`;
}

module.exports={generateCouponCode,normalizeCouponPrefix,ALPHABET};
