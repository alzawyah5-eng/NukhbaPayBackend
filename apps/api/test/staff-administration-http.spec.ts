import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {AdministrationError,StaffManagementService,StaffCatalogueService,TrustedStaffActorBoundary,createAdministrationAuthority,consumeAdministrationRead,consumeStaffCatalogueRead} from '@nukhbapay/application';
import {createApiApplication} from '../src/http-application.js';
import {OidcAccessTokenVerifier} from '../src/modules/identity/oidc-access-token.verifier.js';
import {claims,environment,keySource,NOW,signingKey} from './fixtures/oidc-test-issuer.js';
test('administration HTTP retains signed human identity, closed tenant scope and default-deny operational permissions',async()=>{
 const tenant=randomUUID(),staff=randomUUID(),member=randomUUID(),key=await signingKey('admin-unit'),source=keySource([key.publicJwk]);
 const verifier=new OidcAccessTokenVerifier(environment(),{fetchKeys:source.fetchKeys,now:()=>new Date(NOW)}),token=await key.sign(claims());
 const repository={findByTrustedIdentity:async()=>({staffId:staff,staffStatus:'ACTIVE' as const,identityStatus:'ACTIVE' as const,authzVersion:1n,tokensValidAfter:null}),findPlatformRoleGrants:async()=>[],findTenantMembership:async()=>({membershipId:member,tenantId:tenant,status:'ACTIVE' as const,version:1n,roleGrants:[]})};
 const actors=new TrustedStaffActorBoundary({repository,now:()=>new Date(NOW),auditWriter:{appendSecurityAuditEvents:async()=>undefined}});
 // Isolated future-policy double only. Normal composition below uses the actual inactive permission evaluator.
 const authority={require:async(_identity:unknown,id:string)=>{if(id!==tenant)throw new AdministrationError(403);return {staffId:staff,tenantId:tenant,revalidate:async()=>true};}};
 const reader={staff:async(t:Parameters<typeof consumeAdministrationRead>[0])=>{consumeAdministrationRead(t);return [{id:staff,tenantId:tenant,status:'ACTIVE',membershipStatus:'ACTIVE',version:'1',roles:['SUPPORT_AGENT'],secret:'PRIVATE'}];},audit:async(t:Parameters<typeof consumeAdministrationRead>[0])=>{consumeAdministrationRead(t);return [];}};
 const service=new StaffManagementService({authority,reader,actors,auditRead:async()=>undefined});
 const catalogue=new StaffCatalogueService({authority,now:()=>new Date(NOW),read:async t=>{consumeStaffCatalogueRead(t);return {tenantId:tenant,revision:'1',availability:[],products:[],offers:[],proposals:[],imports:[],drafts:[]};},audit:async()=>undefined});
 const app=await createApiApplication({logger:false,identity:{verifier},staffAdministration:service,staffCatalogue:catalogue});await app.listen(0,'127.0.0.1');
 const base=await app.getUrl(),path='/v1/admin/tenants/'+tenant;
 const send=(p:string,options:RequestInit={})=>fetch(base+p,{...options,headers:{Authorization:'Bearer '+token,...options.headers}});
 try{
  const response=await send(path+'/staff');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(JSON.stringify(await response.json()).includes('PRIVATE'),false);
  assert.equal((await send('/v1/admin/tenants/'+randomUUID()+'/staff')).status,403);
  assert.equal((await send(path+'/catalogue/countries?group=GCC')).status,200);
  for(const url of [path+'/staff?limit=1&limit=2',path+'/catalogue/products?country=ZZ',path+'/staff/'+randomUUID()])assert.ok([400,404].includes((await send(url)).status));
  assert.equal((await send(path+'/staff',{method:'HEAD'})).status,403);
  assert.equal((await send(path+'/catalogue/products?__proto__=forged')).status,400);
  assert.equal((await send(path+'/catalogue/imports?country=AE')).status,400);
  assert.equal((await send(path+'/staff',{headers:{Cookie:'__Host-staff=forged'}})).status,403);
  assert.equal((await send(path+'/staff',{headers:{Origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await fetch(base+path+'/staff')).status,401);
  assert.equal((await send(path+'/staff/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mfa:true,role:'TENANT_ADMIN'})})).status,400);
  assert.equal((await send(path+'/staff/'+staff+'/activate',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
 }finally{await app.close();}
 const strict=new StaffManagementService({authority:createAdministrationAuthority(repository,()=>new Date(NOW)),reader,actors,auditRead:async()=>undefined});
 const closed=await createApiApplication({logger:false,identity:{verifier},staffAdministration:strict});await closed.listen(0,'127.0.0.1');
 try{assert.equal((await fetch((await closed.getUrl())+path+'/staff',{headers:{Authorization:'Bearer '+token}})).status,403);}finally{await closed.close();}
 const unconfigured=await createApiApplication({logger:false,identity:{verifier}});await unconfigured.listen(0,'127.0.0.1');
 try{assert.equal((await fetch((await unconfigured.getUrl())+path+'/staff',{headers:{Authorization:'Bearer '+token}})).status,503);}finally{await unconfigured.close();}
});
