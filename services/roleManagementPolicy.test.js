'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {roleChangeAllowed,accountStatusChangeAllowed}=require('./roleManagementPolicy');

test('only Owner grants or revokes Owner, Manager, and Admin roles',()=>{
  for(const role of ['owner','manager','admin']){
    assert.equal(roleChangeAllowed('admin','customer',role),false);
    assert.equal(roleChangeAllowed('manager','customer',role),false);
    assert.equal(roleChangeAllowed('owner','customer',role),true);
  }
  assert.equal(roleChangeAllowed('owner','admin','customer'),true);
  assert.equal(roleChangeAllowed('admin','customer','moderator'),true);
  assert.equal(roleChangeAllowed('owner','customer','root'),false);
});
test('Admin cannot change Owner status and users cannot deactivate themselves',()=>{
  assert.equal(accountStatusChangeAllowed('a','admin','o','owner',false),false);
  assert.equal(accountStatusChangeAllowed('a','admin','a','admin',false),false);
  assert.equal(accountStatusChangeAllowed('o','owner','o','owner',false),false);
  assert.equal(accountStatusChangeAllowed('o','owner','a','admin',false),true);
  assert.equal(accountStatusChangeAllowed('a','admin','b','customer',false),true);
});
