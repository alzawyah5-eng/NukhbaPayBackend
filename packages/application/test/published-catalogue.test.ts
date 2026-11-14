import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {isVerifiedStaffIdentity} from "../src/identity/verified-staff-identity.js";
import {PublishedCatalogueService,attestCatalogueClient,consumeCatalogueReadTicket,CATALOGUE_AUDIENCES,CATALOGUE_SCOPES,CatalogueAccessError} from "../src/catalog/published-catalogue.js";

test("catalogue authorization, safe projection, bounded cursors and audit fail closed",async()=>{
 let time=Date.parse("2026-11-09T10:00:00Z"),auditDown=false,storageDown=false,enabled=true,audits=0;
 const tenantId=randomUUID(),identity=attestCatalogueClient({issuer:"https://catalogue.invalid/",subject:"backend",clientId:"backend",kind:"payment",audience:CATALOGUE_AUDIENCES.payment,scope:CATALOGUE_SCOPES.payment,issuedAt:time/1000-60,expiresAt:time/1000+300});
 assert.equal(isVerifiedStaffIdentity(identity),false);
 const ids=[randomUUID(),randomUUID()].sort();
 const rows=ids.map(productId=>({productId,name:"SYNTHETIC",publicationId:randomUUID(),totalMinor:"10200",validUntil:"2026-11-09T11:00:00Z",provider_cost_minor:"PRIVATE-MARKER"}));
 const service=new PublishedCatalogueService({capability:"SYNTHETIC_PUBLISHED_CATALOGUE_ONLY",now:()=>new Date(time),requestsPerMinute:200,
  bindings:{find:async()=>({issuer:identity.issuer,subject:identity.subject,clientId:identity.clientId,kind:"payment",scope:CATALOGUE_SCOPES.payment,tenantId,kioskId:null,enabled,version:"1"})},
  reader:{read:async ticket=>{consumeCatalogueReadTicket(ticket);if(storageDown)throw new Error("private connection details");return rows;}},
  audit:{append:async()=>{if(auditDown)throw new Error("private audit details");audits++;}}});
 const read=(query:Record<string,unknown>={})=>service.read(identity,{kind:"payment",query});
 await assert.rejects(()=>service.read({...identity},{kind:"payment",query:{}}),{status:401});
 const page=await read({limit:"1"});assert.ok(page.next_cursor);assert.equal(page.items[0]!.product_id,ids[0]);assert.equal(page.items[0]!.display_total,"102.00");assert.equal(JSON.stringify(page).includes("PRIVATE-MARKER"),false);assert.equal(audits,1);
 const second=await read({limit:"1",cursor:page.next_cursor});assert.equal(second.items[0]!.product_id,ids[1]);assert.equal(second.catalogue_version,page.catalogue_version);
 await assert.rejects(()=>read({limit:"1",cursor:page.next_cursor}),{status:409});
 const stale=await read({limit:"1"});rows[0]!.publicationId=randomUUID();await assert.rejects(()=>read({limit:"1",cursor:stale.next_cursor}),{status:409});
 const expires=await read({limit:"1"});time+=60001;await assert.rejects(()=>read({limit:"1",cursor:expires.next_cursor}),{status:409});
 for(const query of [{limit:"51"},{limit:["1"]},{limit:"0"},{tenantId:randomUUID()},{cursor:"forged"}])await assert.rejects(()=>read(query),{status:400});
 enabled=false;await assert.rejects(()=>read(),{status:403});enabled=true;
 auditDown=true;await assert.rejects(()=>read(),{status:503});auditDown=false;
 storageDown=true;await assert.rejects(()=>read(),{status:503});storageDown=false;
 await assert.rejects(()=>service.read(identity,{kind:"payment",productId:randomUUID(),query:{}}),{status:404});
 assert.throws(()=>consumeCatalogueReadTicket({tenantId,nowMs:time,revalidate:async()=>true}),/Untrusted/);
 assert.ok(new CatalogueAccessError(503).message.indexOf("private")===-1);
});
