'use strict';

const PRIVILEGED_ROLES = new Set(['owner','manager','admin']);
const SUPPORTED_ROLES = new Set(['user','customer','vendor','moderator','admin','manager','owner']);

function roleChangeAllowed(actorRole, targetRole, nextRole) {
  const actor=String(actorRole||'').toLowerCase();
  const target=String(targetRole||'').toLowerCase();
  const next=String(nextRole||'').toLowerCase();
  if (!SUPPORTED_ROLES.has(next)) return false;
  if (PRIVILEGED_ROLES.has(next) && actor!=='owner') return false;
  if (actor==='admin' && ['admin','owner','manager'].includes(target)) return false;
  if (target==='owner' && actor!=='owner') return false;
  if (target==='manager' && actor!=='owner') return false;
  return actor==='owner'||actor==='admin';
}

function accountStatusChangeAllowed(actorId, actorRole, targetId, targetRole, active) {
  if (typeof active!=='boolean') return false;
  if (String(actorId)===String(targetId)&&active===false) return false;
  if (String(targetRole||'').toLowerCase()==='owner'&&String(actorRole||'').toLowerCase()!=='owner') return false;
  return ['owner','admin','super_admin'].includes(String(actorRole||'').toLowerCase());
}

module.exports={SUPPORTED_ROLES,roleChangeAllowed,accountStatusChangeAllowed};
