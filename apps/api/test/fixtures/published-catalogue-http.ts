import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import type {AddressInfo} from "node:net";
import {PublishedCatalogueService,CATALOGUE_AUDIENCES,CATALOGUE_SCOPES} from "@nukhbapay/application";
import type {CatalogueReader,CatalogueAuditWriter,CatalogueClientBinding,CatalogueClientKind} from "@nukhbapay/application";
import {createApiApplication} from "../../src/http-application.js";
import {SyntheticCatalogueTokenVerifier} from "../../src/modules/catalog/published-catalogue-http.js";
import {signingKey} from "./oidc-test-issuer.js";

export async function exercisePublishedCatalogueHttp(f:{reader:CatalogueReader;audit:CatalogueAuditWriter;tenantId:string;otherTenantId:string;productId:string;unpublishedId:string;secondProductId:string;oldVersion:string;
 activateSecond():Promise<unknown>;republish():Promise<{operationId:string}>;denyReader():Promise<void>;restoreReader():Promise<void>;denyAudit():Promise<void>;restoreAudit():Promise<void>}){
 let nowMs=Date.parse("2026-11-09T10:00:00Z");const now=()=>new Date(nowMs),seconds=now().getTime()/1000,issuer="https://catalogue.synthetic.invalid/",kioskId=randomUUID(),otherKiosk=randomUUID();
 const appId="synthetic-payment-backend",kioskClient="synthetic-kiosk-client",otherId="synthetic-other-backend";
 const bindings=new Map<string,CatalogueClientBinding>();
 for(const [clientId,kind,tenant,kiosk] of [[appId,"payment",f.tenantId,null],[kioskClient,"kiosk",f.tenantId,kioskId],[otherId,"payment",f.otherTenantId,null]] as const){bindings.set(clientId,Object.freeze({issuer,subject:clientId,clientId,kind,tenantId:tenant,kioskId:kiosk,scope:CATALOGUE_SCOPES[kind],enabled:true,version:"1"}));}
 const key=await signingKey("catalogue-key"),verifier=new SyntheticCatalogueTokenVerifier({issuer,keys:[key.publicJwk],now});
 assert.throws(()=>new SyntheticCatalogueTokenVerifier({issuer:"https://production.example/",keys:[key.publicJwk],now}));
 const mint=(kind:CatalogueClientKind,clientId:string,overrides:Record<string,unknown>={})=>key.sign({iss:issuer,sub:clientId,aud:CATALOGUE_AUDIENCES[kind],iat:seconds,exp:seconds+300,jti:randomUUID(),client_id:clientId,client_kind:kind,client_profile:"synthetic-catalogue-client-v1",principal_kind:"machine",scope:CATALOGUE_SCOPES[kind],...overrides});
 const payment=await mint("payment",appId),kiosk=await mint("kiosk",kioskClient),other=await mint("payment",otherId);
 const repository={find:async(i:{clientId:string})=>bindings.get(i.clientId)??null};
 let revokeAfterAudit=false;
 const audit={append:async(e:Parameters<CatalogueAuditWriter["append"]>[0])=>{await f.audit.append(e);if(revokeAfterAudit)bindings.set(appId,{...bindings.get(appId)!,enabled:false});}};
 const service=new PublishedCatalogueService({capability:"SYNTHETIC_PUBLISHED_CATALOGUE_ONLY",bindings:repository,reader:f.reader,audit,now,requestsPerMinute:200});
 const app=await createApiApplication({logger:false,catalogue:{verifier,service,now}});await app.listen(0,"127.0.0.1");
 const base=`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
 const send=async(path:string,token:string|undefined=payment,headers:Record<string,string>={})=>{
  const response=await fetch(base+path,{headers:{...(token?{Authorization:"Bearer "+token}:{}),...headers}}),body=await response.json();
  assert.equal(response.headers.get("cache-control"),"no-store");
  if(response.status>=400){assert.deepEqual(body,{statusCode:response.status,message:response.status===503?"Service unavailable":"Request could not be completed"});}
  return {status:response.status,body};
 };
 try{
  assert.equal((await send("/v1/payment/catalogue","")).status,401);
  assert.equal((await fetch(base+"/v1/payment/catalogue",{method:"HEAD",headers:{Authorization:"Bearer "+payment}})).status,403);
  assert.equal((await fetch(base+"/v1/payment/catalogue",{method:"POST",headers:{Authorization:"Bearer "+payment}})).status,404);
  assert.equal((await fetch(base+"/v1/pricing/approve",{method:"POST",headers:{Authorization:"Bearer "+kiosk}})).status,404);
  assert.equal((await send("/v1/payment/catalogue","invalid.invalid.invalid")).status,401);
  assert.equal((await send("/v1/payment/catalogue",payment.slice(0,payment.lastIndexOf(".")+1)+"A".repeat(342))).status,401);
  for(const overrides of [{aud:"urn:staff"},{principal_kind:"human"},{roles:["PRICING_APPROVER"]},{tenant_id:f.tenantId},{exp:seconds-1}])assert.equal((await send("/v1/payment/catalogue",await mint("payment",appId,overrides))).status,401);
  assert.equal((await send("/v1/payment/catalogue",await mint("payment",appId,{scope:CATALOGUE_SCOPES.kiosk}))).status,403);
  assert.equal((await send("/v1/payment/catalogue",await mint("payment",appId,{scope:"pricing.approve"}))).status,403);
  assert.equal((await send("/v1/payment/catalogue",await mint("payment","unregistered-client"))).status,403);
  assert.equal((await send("/v1/payment/catalogue",kiosk)).status,401);
  assert.equal((await send(`/v1/kiosks/${kioskId}/catalogue`,payment)).status,401);
  assert.equal((await send(`/v1/kiosks/${otherKiosk}/catalogue`,kiosk,{"X-Kiosk-Id":kioskId,"X-Tenant-Id":f.tenantId})).status,403);
  assert.equal((await send(`/v1/kiosks/${kioskId}/catalogue`,kiosk)).status,200);
  const one=await send("/v1/payment/catalogue",payment,{"X-Tenant-Id":f.otherTenantId,"X-Client-Id":otherId,"X-Roles":"pricing.approve"});
  assert.equal(one.status,200);assert.equal(one.body.items.length,1);assert.equal(one.body.items[0].product_id,f.productId);
  assert.deepEqual(Object.keys(one.body.items[0]).sort(),["product_id","name","category","price_status","catalog_version","display_total","currency"].sort());
  assert.equal(one.body.items[0].catalog_version,f.oldVersion);assert.equal(one.body.items[0].display_total,"102.00");
  assert.equal((await send(`/v1/payment/catalogue/${f.productId}`,other)).status,404);
  assert.deepEqual((await send("/v1/payment/catalogue",other)).body.items,[]);
  assert.equal((await send(`/v1/payment/catalogue/${f.unpublishedId}`)).status,404);
  assert.equal((await send(`/v1/payment/catalogue/${f.secondProductId}`)).status,404);
  for(const query of ["limit=0","limit=51","limit=1.5","limit=01","limit=1&limit=2","cursor=forged","tenantId="+f.otherTenantId,"__proto__=forged"])assert.equal((await send("/v1/payment/catalogue?"+query)).status,400);
  const extra=await fetch(base+"/v1/payment/catalogue",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({payload:"x".repeat(17000)})});assert.equal(extra.status,413);
  await f.activateSecond();
  const first=await send("/v1/payment/catalogue?limit=1");assert.equal(first.body.items.length,1);assert.ok(first.body.next_cursor);
  const page2=await send("/v1/payment/catalogue?limit=1&cursor="+first.body.next_cursor);assert.equal(page2.status,200);assert.equal(page2.body.catalogue_version,first.body.catalogue_version);assert.equal(page2.body.next_cursor,null);
  assert.ok(first.body.items[0].product_id<page2.body.items[0].product_id);
  assert.equal((await send("/v1/payment/catalogue?limit=1&cursor="+first.body.next_cursor)).status,409);
  const bound=await send("/v1/payment/catalogue?limit=1");assert.equal((await send(`/v1/kiosks/${kioskId}/catalogue?limit=1&cursor=`+bound.body.next_cursor,kiosk)).status,409);assert.equal((await send("/v1/payment/catalogue?limit=1&cursor="+bound.body.next_cursor)).status,200);
  const stale=await send("/v1/payment/catalogue?limit=1");
  const concurrent=await Promise.all([f.republish(),...Array.from({length:6},()=>send("/v1/payment/catalogue"))]);const publication=concurrent[0] as {operationId:string};
  for(const result of concurrent.slice(1) as Awaited<ReturnType<typeof send>>[]){assert.equal(result.status,200);const p=result.body.items.find((r:{product_id:string})=>r.product_id===f.productId);assert.ok((p.catalog_version===f.oldVersion&&p.display_total==="102.00")||(p.catalog_version===publication.operationId&&p.display_total==="103.00"));}
  assert.equal((await send("/v1/payment/catalogue?limit=1&cursor="+stale.body.next_cursor)).status,409);
  await f.denyReader();try{assert.equal((await send("/v1/payment/catalogue")).status,503);}finally{await f.restoreReader();}
  await f.denyAudit();try{assert.equal((await send("/v1/payment/catalogue")).status,503);}finally{await f.restoreAudit();}
  revokeAfterAudit=true;assert.equal((await send("/v1/payment/catalogue")).status,403);revokeAfterAudit=false;bindings.set(appId,{...bindings.get(appId)!,enabled:true,version:"2"});
  assert.equal((await send("/v1/payment/catalogue")).status,200);
  const limited=new PublishedCatalogueService({capability:"SYNTHETIC_PUBLISHED_CATALOGUE_ONLY",bindings:repository,reader:f.reader,audit:f.audit,now,requestsPerMinute:2});
  const rateApp=await createApiApplication({logger:false,catalogue:{verifier,service:limited,now}});await rateApp.listen(0,"127.0.0.1");
  try{for(const expected of [200,200,429])assert.equal((await fetch(`http://127.0.0.1:${(rateApp.getHttpServer().address() as AddressInfo).port}/v1/payment/catalogue`,{headers:{Authorization:"Bearer "+payment}})).status,expected);}finally{await rateApp.close();}
  const disabled=await createApiApplication({logger:false});await disabled.listen(0,"127.0.0.1");try{assert.equal((await fetch(`http://127.0.0.1:${(disabled.getHttpServer().address() as AddressInfo).port}/v1/payment/catalogue`,{headers:{Authorization:"Bearer "+payment}})).status,503);}finally{await disabled.close();}
  nowMs+=3600000;const refreshed=await mint("payment",appId,{iat:nowMs/1000,exp:nowMs/1000+300});
  const expired=await send("/v1/payment/catalogue",refreshed);assert.equal(expired.status,200);assert.deepEqual(expired.body.items,[]);
  assert.equal((await send(`/v1/payment/catalogue/${f.productId}`,refreshed)).status,404);
 }finally{await app.close();}
}
