import assert from "node:assert/strict";
import test from "node:test";
import { checkStaffBrowserTransport, STAFF_COOKIE_OPTIONS, staffSessionLifetimeUsable } from "../src/modules/identity/staff-browser-security.js";
const origin="https://staff.synthetic.invalid",csrf="synthetic_csrf_01234567890123456789";
const headers=["Origin",origin,"Content-Type","application/json","Sec-Fetch-Site","same-origin","X-CSRF-Token",csrf];
test("local browser transport validates origin/CSRF without granting authorization",()=>{
  assert.deepEqual(checkStaffBrowserTransport({expectedOrigin:origin,method:"POST",rawHeaders:headers,expectedCsrf:csrf}),{transportValid:true,execution:"NOT_AUTHORIZED"});
  for(const method of ["GET","HEAD"]) assert.equal(checkStaffBrowserTransport({expectedOrigin:origin,method,rawHeaders:[],expectedCsrf:csrf}).transportValid,true);
});
test("cross-origin, duplicate, absent, wrong CSRF and simple-form requests deny",()=>{
  for(const rawHeaders of [[],[...headers,"Origin",origin],headers.map(v=>v===origin?"https://other.synthetic.invalid":v),headers.map(v=>v===csrf?"wrong":v),headers.map(v=>v==="application/json"?"text/plain":v),[...headers,"Sec-Fetch-Site","cross-site"]]) {
    assert.deepEqual(checkStaffBrowserTransport({expectedOrigin:origin,method:"POST",rawHeaders,expectedCsrf:csrf}),{transportValid:false,execution:"NOT_AUTHORIZED"});
  }
  assert.equal(checkStaffBrowserTransport({expectedOrigin:"https://real.example.com",method:"POST",rawHeaders:headers,expectedCsrf:csrf}).transportValid,false);
});
test("cookie policy is host-only secure and session idle/absolute/revocation boundaries deny",()=>{
  assert.deepEqual(STAFF_COOKIE_OPTIONS,{name:"__Host-nukhbapay_staff",secure:true,httpOnly:true,sameSite:"strict",path:"/"});
  assert.ok(Object.isFrozen(STAFF_COOKIE_OPTIONS));
  const record={createdAtMs:0,lastSeenAtMs:1000,revoked:false};
  assert.equal(staffSessionLifetimeUsable(record,2000),true);
  assert.equal(staffSessionLifetimeUsable(record,1000+15*60*1000),false);
  assert.equal(staffSessionLifetimeUsable({...record,lastSeenAtMs:8*60*60*1000},8*60*60*1000),false);
  assert.equal(staffSessionLifetimeUsable({...record,revoked:true},2000),false);
  assert.equal(staffSessionLifetimeUsable(record,Number.NaN),false);
});
