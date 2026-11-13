import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { TrustedStaffActorBoundary, type TrustedStaffActor } from "../src/identity/trusted-staff-actor.js";
import { StaffSessionLifecycle, consumeStaffSessionTicket, type StaffSessionStore, type StaffSessionTicket, type SessionStoreOutcome } from "../src/identity/staff-session.js";
import { attestVerifiedStaffIdentity } from "../src/identity/verified-staff-identity.js";
import type { StaffAuthorizationRepository, ResolvedStaffPrincipal, StaffMembershipStatus } from "../src/identity/staff-access.js";

const staff="00000000-0000-4000-8000-000000000001",tenant="00000000-0000-4000-8000-000000000002";
function fixture(options:{issuer?:string;sessionIssuers?:readonly string[]}={}) {
  let now=Date.UTC(2026,10,12),version=1n,status:ResolvedStaffPrincipal['staffStatus']='ACTIVE',membership:StaffMembershipStatus='ACTIVE',auditFailure=false;
  const repository:StaffAuthorizationRepository={findByTrustedIdentity:async identity=>identity.subject==='unit-staff'?{staffId:staff,staffStatus:status,identityStatus:'ACTIVE',tokensValidAfter: null, authzVersion:version}:null,
    findPlatformRoleGrants:async()=>[],findTenantMembership:async(_staff,id)=>id===tenant?{membershipId:tenant,tenantId:tenant,status:membership,version:1n,roleGrants:[]}:null};
  const actors=new TrustedStaffActorBoundary({repository,now:()=>new Date(now),...(options.sessionIssuers===undefined?{}:{sessionIssuers:options.sessionIssuers}),auditWriter:{appendSecurityAuditEvents:async()=>{if(auditFailure)throw new Error('Private audit fault');}}});
  const identity=()=>attestVerifiedStaffIdentity({issuer:options.issuer??'https://sessions.synthetic.invalid/',subject:'unit-staff',security:{audience:'urn:nukhbapay:synthetic:staff-api',clientId:'unit',profile:'rfc9068-staff-v1',principalKind:'human',issuedAt:now/1000,expiresAt:now/1000+300,assurance:'not-established'}});
  const rows=new Map<string,{binding:string;expires:number;last:number;revoked:boolean}>();let events=0,unavailable=false;
  const store:StaffSessionStore={execute:async(t:StaffSessionTicket):Promise<SessionStoreOutcome>=>{
    if(!consumeStaffSessionTicket(t))return 'DENIED';if(unavailable)return 'UNRESOLVED';
    if(!await t.revalidate())return 'DENIED';
    if(t.operation==='CREATE'||t.operation==='ROTATE'){
      if(t.previousHash){const old=rows.get(t.previousHash);if(!old||old.revoked)return 'DENIED';old.revoked=true;events++;}
      rows.set(t.tokenHash,{binding:JSON.stringify(t.binding),expires:t.expiresAtMs,last:t.nowMs,revoked:false});events++;return 'COMMITTED';
    }
    const row=rows.get(t.tokenHash);if(!row||row.binding!==JSON.stringify(t.binding))return 'DENIED';
    if(t.operation==='REVOKE'){if(!row.revoked){row.revoked=true;events++;}return 'REVOKED';}
    if(t.operation==='CHECK_REVOKED')return row.revoked?'REVOKED':'ACTIVE';
    if(row.revoked||t.nowMs>=row.expires||t.nowMs>=row.last+t.idleMs)return 'DENIED';row.last=t.nowMs;events++;return 'ACTIVE';
  }};
  const make=(enabled=true)=>new StaffSessionLifecycle({actors,store,now:()=>new Date(now),enabled,idleMs:1000,absoluteMs:10000});
  return {actors,store,make,rows,events:()=>events,identity,now:()=>new Date(now),advance:(ms:number)=>{now+=ms;},version:()=>{version++;},restoreVersion:()=>{version=1n;},suspend:()=>{status='SUSPENDED';},restoreStatus:()=>{status='ACTIVE';},revokeMembership:()=>{membership='REVOKED';},
    failAudit:(value=true)=>{auditFailure=value;},failStore:(value=true)=>{unavailable=value;},actor:async(scope?:string)=>{
      const established=await actors.establish(identity(),scope);assert.equal(established.allowed,true);if(!established.allowed)throw new Error('Fixture actor denied');return established.actor;
    }};
}
async function token(service:StaffSessionLifecycle,actor:TrustedStaffActor) {
  const result=await service.create(actor);assert.equal(result.ok,true);if(!result.ok)throw new Error('Fixture session denied');return result;
}
test('sessions default disabled and forged, cloned and wrong-boundary actors never create records',async()=>{
  const f=fixture(),actor=await f.actor(),disabled=new StaffSessionLifecycle({actors:f.actors,store:f.store,now:f.now});
  assert.equal((await disabled.create(actor)).ok,false);
  for(const forged of [{},JSON.parse(JSON.stringify(actor)),{staffId:staff},Object.create(actor)])assert.equal((await f.make().create(forged as TrustedStaffActor)).ok,false);
  assert.equal((await f.make().create(await fixture().actor())).ok,false);assert.equal(f.rows.size,0);
  const evidence=await f.actors.inspectSessionActor(actor);
  const deceptive=new StaffSessionLifecycle({actors:{inspectSessionActor:async()=>evidence},store:f.store,now:f.now,enabled:true});
  assert.equal((await deceptive.create({} as TrustedStaffActor)).ok,false);
});
test('session credentials have 256-bit entropy format, hash-only storage, safe serialization and no execution authority',async()=>{
  const f=fixture(),service=f.make(),actor=await f.actor(),a=await token(service,actor),b=await token(service,actor);
  assert.equal(JSON.stringify(service).includes('dependencies'),false);assert.equal(inspect(service).includes('dependencies'),false);
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(a.credential.cookieValue()),true);
  assert.equal(a.credential.cookieValue()!==b.credential.cookieValue(),true);
  for(const text of [JSON.stringify(a),inspect(a),String(a.credential),JSON.stringify([...f.rows])])assert.equal(text.includes(a.credential.cookieValue()),false);
  assert.deepEqual(await service.validate(a.credential.cookieValue()),{ok:true,execution:'NOT_AUTHORIZED',assurance:'not-established'});
});

test('reviewed session issuers are exact trusted composition inputs; defaults remain synthetic-only',async()=>{
  const issuer='https://development.auth0.example/';
  for(const options of [{issuer},{issuer,sessionIssuers:['https://other.auth0.example/']},{sessionIssuers:[]}]) {
    const f=fixture(options);assert.equal((await f.make().create(await f.actor())).ok,false);assert.equal(f.rows.size,0);
  }
  const f=fixture({issuer,sessionIssuers:[issuer]});assert.equal((await f.make().create(await f.actor())).ok,true);
});
test('idle and absolute boundaries are exclusive and activity cannot extend absolute expiry',async()=>{
  const f=fixture(),service=f.make(),created=await token(service,await f.actor()),raw=created.credential.cookieValue();
  f.advance(999);assert.equal((await service.validate(raw)).ok,true);f.advance(1000);assert.equal((await service.validate(raw)).ok,false);
  const f2=fixture(),s2=f2.make(),r2=(await token(s2,await f2.actor())).credential.cookieValue();
  for(let n=0;n<11;n++){f2.advance(900);assert.equal((await s2.validate(r2)).ok,true);}f2.advance(100);assert.equal((await s2.validate(r2)).ok,false);
});
test('staff suspension, membership revocation and authority versions invalidate sessions without positive caching',async()=>{
  for(const change of ['version','suspend','revokeMembership'] as const){const f=fixture(),s=f.make(),raw=(await token(s,await f.actor(tenant))).credential.cookieValue();
    assert.equal((await s.validate(raw)).ok,true);f[change]();assert.equal((await s.validate(raw)).ok,false);}
  const f=fixture(),s=f.make(),actor=await f.actor(),first=(await token(s,actor)).credential.cookieValue(),second=(await token(s,actor)).credential.cookieValue();
  f.suspend();assert.equal((await s.validate(first)).ok,false);f.restoreStatus();assert.equal((await s.validate(second)).ok,false);
  assert.equal((await s.verifyRevocation(second)).ok,true);
});
test('rotation revokes the fixed old credential, preserves scope and accepts only a freshly verified changed authority',async()=>{
  const f=fixture(),s=f.make(),old=(await token(s,await f.actor())).credential.cookieValue();f.version();
  const rotated=await s.rotate(await f.actor(),old);assert.equal(rotated.ok,true);if(!rotated.ok)throw new Error('Rotation denied');
  assert.equal(rotated.credential.cookieValue()!==old,true);assert.equal((await s.validate(old)).ok,false);
  assert.equal((await s.validate(rotated.credential.cookieValue())).ok,true);
  assert.equal((await s.rotate(await f.actor(),old)).ok,false);
  assert.equal((await s.rotate(await f.actor(tenant),rotated.credential.cookieValue())).ok,false);
});
test('replaying a rotated or logged-out credential cannot poison a fresh sibling using the same verified actor',async()=>{
  const f=fixture(),s=f.make(),actor=await f.actor(),old=(await token(s,actor)).credential.cookieValue();
  const rotated=await s.rotate(actor,old);assert.equal(rotated.ok,true);if(!rotated.ok)throw new Error('Rotation denied');
  const current=rotated.credential.cookieValue();
  assert.equal((await s.validate(old)).ok,false);assert.equal((await s.validate(current)).ok,true);
  const other=(await token(s,actor)).credential.cookieValue();await s.revoke(other);
  assert.equal((await s.validate(other)).ok,false);assert.equal((await s.validate(current)).ok,true);
  f.suspend();assert.equal((await s.validate(current)).ok,false);f.restoreStatus();
  assert.equal((await s.create(actor)).ok,false);
});
test('revocation is audited, idempotent and verifiable after authority expiry; a cold instance cannot rehydrate actor authority',async()=>{
  const f=fixture(),s=f.make(),raw=(await token(s,await f.actor())).credential.cookieValue();
  const before=f.events();f.advance(301000);assert.equal((await s.revoke(raw)).ok,true);assert.equal((await s.revoke(raw)).ok,true);
  assert.equal(f.events(),before+1);assert.equal((await s.verifyRevocation(raw)).ok,true);assert.equal((await s.validate(raw)).ok,false);
  assert.equal((await f.make().validate(raw)).ok,false);
});
test('audit or persistence outage and uncertain acknowledgement never return successful session results',async()=>{
  const f=fixture(),s=f.make(),actor=await f.actor();f.failAudit();assert.equal((await s.create(actor)).ok,false);assert.equal(f.rows.size,0);
  f.failAudit(false);f.failStore();assert.equal((await s.create(actor)).ok,false);f.failStore(false);
  const raw=(await token(s,actor)).credential.cookieValue();f.failStore();assert.equal((await s.validate(raw)).ok,false);assert.equal((await s.revoke(raw)).ok,false);
  f.failStore(false);assert.equal((await s.validate(raw)).ok,true);assert.equal((await s.revoke(raw)).ok,true);
});
test('session store tickets are immutable, one-use capabilities rather than executable JSON',async()=>{
  assert.equal(consumeStaffSessionTicket({operation:'CREATE',staffId:staff}),false);
  const f=fixture();let captured:StaffSessionTicket|undefined;
  const s=new StaffSessionLifecycle({actors:f.actors,now:f.now,enabled:true,store:{execute:async ticket=>{captured=ticket;assert.equal(Object.isFrozen(ticket)&&Object.isFrozen(ticket.binding),true);return f.store.execute(ticket);}}});
  await token(s,await f.actor());assert.ok(captured);assert.equal(await f.store.execute(captured),'DENIED');
  assert.equal(await f.store.execute(JSON.parse(JSON.stringify(captured)) as StaffSessionTicket),'DENIED');
});
test('authority changes during commit acknowledgement revoke issued or unissued generations and cannot be restored',async()=>{
  for(const phase of ['CREATE','VALIDATE']){
    const f=fixture();let injected=false;
    const s=new StaffSessionLifecycle({actors:f.actors,now:f.now,enabled:true,store:{execute:async ticket=>{
      const outcome=await f.store.execute(ticket);
      if(ticket.operation===phase&&!injected){injected=true;f.version();}
      return outcome;
    }}});
    const actor=await f.actor(),result=await s.create(actor);
    if(phase==='CREATE'){assert.equal(result.ok,false);assert.equal([...f.rows.values()].every(row=>row.revoked),true);}
    else {
      assert.equal(result.ok,true);if(!result.ok)throw new Error('Fixture session denied');const raw=result.credential.cookieValue();
      assert.equal((await s.validate(raw)).ok,false);f.restoreVersion();assert.equal((await s.validate(raw)).ok,false);
      assert.equal((await s.verifyRevocation(raw)).ok,true);assert.equal((await s.create(actor)).ok,false);
    }
  }
});
