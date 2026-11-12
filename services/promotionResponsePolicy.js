'use strict';
const RESTRICTED_ADMIN_FIELDS=new Set(['margin_snapshot','profit_snapshot','expected_loss','loss_making','financial','financial_snapshot','financialFingerprint','approvals']);
function promotionDto(value,actorRole){
  if(String(actorRole||'').toLowerCase()!=='admin'||!value||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map((entry)=>promotionDto(entry,actorRole));
  const safe={};
  for(const [key,entry] of Object.entries(value)){
    if(RESTRICTED_ADMIN_FIELDS.has(key))continue;
    safe[key]=entry&&typeof entry==='object'?promotionDto(entry,actorRole):entry;
  }
  return safe;
}
module.exports={promotionDto};
