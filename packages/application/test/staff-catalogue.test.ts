import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {StaffCatalogueService,consumeStaffCatalogueRead,type StaffCatalogueSnapshot} from '../src/catalog/staff-catalogue.js';
import {attestVerifiedStaffIdentity} from '../src/identity/verified-staff-identity.js';
import {SYNTHETIC_PRODUCT,SYNTHETIC_NOW,createSyntheticProviders} from '../../provider-adapters/src/index.js';
async function fixture(){
 const tenant=randomUUID(),staff=randomUUID(),product=randomUUID(),other=randomUUID(),snapshot=randomUUID(),account=randomUUID();let fresh=true,pricing=true,audits=0;
 const now=Date.parse(SYNTHETIC_NOW),identity=attestVerifiedStaffIdentity({issuer:'https://staff.invalid/',subject:'test',security:{audience:'test',clientId:'test',profile:'rfc9068-staff-v1',principalKind:'human',issuedAt:now/1000,expiresAt:now/1000+300,assurance:'not-established'}});
 const provider=createSyntheticProviders()[0]!,offers=(await provider.fetchCatalog()).map(o=>({...o,snapshotId:snapshot}));
 const data:StaffCatalogueSnapshot={tenantId:tenant,revision:'1',availability:[{country:'AE',service:'DIGITAL_PIN',providerId:provider.providerId,enabled:true},{country:'SA',service:'DIGITAL_PIN',providerId:provider.providerId,enabled:false}],
 products:[{id:product,name:'Gift A',country:'AE',service:'DIGITAL_PIN'},{id:other,name:'Gift B',country:'AE',service:'DIGITAL_PIN'}],
 offers:[{id:randomUUID(),productId:product,providerId:provider.providerId,available:true,validUntil:'2026-11-09T11:00:00Z',providerCostMinor:9700n}],imports:[],drafts:[],
 proposals:[{tenantId:tenant,productId:product,product:SYNTHETIC_PRODUCT,offers,sourceSnapshots:[{snapshotId:snapshot,providerAccountId:account,snapshotKey:'s1',sourceVersion:'v1',observedAt:'2026-11-09T09:00:00Z',completedAt:'2026-11-09T09:05:00Z',status:'COMPLETE'}],pricingPolicy:{version:'v1',serviceFeeMinor:200n,maximumServiceFeeMinor:200n,taxAmountMinor:0n,paymentFeeBasisPoints:150,paymentFixedFeeMinor:20n,agentCommissionMinor:50n,minimumContributionMinor:100n,maximumOfferAgeMs:86400000},evaluatedAt:SYNTHETIC_NOW,expectedPreviousVersion:0,idempotencyKey:randomUUID()}]};
 const authority={require:async(_i:unknown,_t:string,p:string)=>{if(p==='pricing.read'&&!pricing)throw Object.assign(new Error('Denied'),{status:403});return {staffId:staff,tenantId:tenant,revalidate:async()=>fresh};}};
 const service=new StaffCatalogueService({authority,now:()=>new Date(now),read:async t=>{consumeStaffCatalogueRead(t);return data;},audit:async()=>{audits++;}});
 return {service,data,tenant,identity,provider:provider.providerId,audits:()=>audits,revoke:()=>{fresh=false;},denyPricing:()=>{pricing=false;}};
}
test('geography and explicit country/service/provider availability remain independent',async()=>{
 const f=await fixture();const countries=await f.service.read(f.identity,f.tenant,'countries',{group:'GCC'});assert.equal(countries.items.length,6);
 assert.equal(countries.items.find(c=>c.id==='AE')!['continent'],'Asia');assert.equal(countries.items.find(c=>c.id==='SA')!['configured'],false);
 assert.equal((await f.service.read(f.identity,f.tenant,'providers',{country:'SA',service:'DIGITAL_PIN'})).items.length,0);
 assert.equal((await f.service.read(f.identity,f.tenant,'providers',{country:'AE',service:'DIGITAL_PIN'})).items[0]!.id,f.provider);
 assert.equal((await f.service.read(f.identity,f.tenant,'products',{provider:'unconfigured'})).items.length,0);
});
test('economics reuse exact existing pricing and require separate authorization',async()=>{
 const f=await fixture();const page=await f.service.read(f.identity,f.tenant,'economics',{});assert.equal(page.items[0]!['total'],'102.00');assert.equal(page.items[0]!['margin'],'2.77');assert.equal(page.items[0]!['canPublish'],false);
 const products=await f.service.read(f.identity,f.tenant,'products',{});assert.equal(JSON.stringify(products).includes('providerCost'),false);
 f.denyPricing();await assert.rejects(()=>f.service.read(f.identity,f.tenant,'offers',{}),{status:403});
});
test('continuations bind filter, sort, tenant actor and revision and cannot replay',async()=>{
 const f=await fixture(),first=await f.service.read(f.identity,f.tenant,'products',{limit:'1',sort:'name'});assert.ok(first.next);
 await assert.rejects(()=>f.service.read(f.identity,f.tenant,'products',{limit:'1',sort:'id',cursor:first.next}),{status:409});
 const next=await f.service.read(f.identity,f.tenant,'products',{limit:'1',sort:'name',cursor:first.next});assert.notEqual(next.items[0]!.id,first.items[0]!.id);
 await assert.rejects(()=>f.service.read(f.identity,f.tenant,'products',{limit:'1',sort:'name',cursor:first.next}),{status:409});
 assert.equal(first.count,2);assert.equal(first.previous,null);assert.equal(next.next,null);assert.ok(next.previous);
 await assert.rejects(()=>f.service.read(f.identity,f.tenant,'products',{limit:'2',sort:'name',cursor:next.previous}),{status:409});
 const previous=await f.service.read(f.identity,f.tenant,'products',{limit:'1',sort:'name',cursor:next.previous});
 assert.deepEqual(previous.items,first.items);assert.ok(previous.next);assert.equal(previous.previous,null);
 await assert.rejects(()=>f.service.read(f.identity,f.tenant,'products',{limit:'1',sort:'name',cursor:next.previous}),{status:409});
});
test('foreign snapshots, malformed queries and revoked authority never disclose catalogue state',async()=>{
 const f=await fixture();for(const q of [{limit:'0'},{sort:'providerCost'},{tenantId:randomUUID()},{country:'ZZ'},{search:'a\nb'}])await assert.rejects(()=>f.service.read(f.identity,f.tenant,'products',q),{status:400});
 (f.data as {tenantId:string}).tenantId=randomUUID();await assert.rejects(()=>f.service.read(f.identity,f.tenant,'products',{}),{status:503});
 const other=await fixture();other.revoke();await assert.rejects(()=>other.service.read(other.identity,other.tenant,'products',{}),{status:403});assert.equal(other.audits(),0);
});

test('publication history is scoped, audited and paged by exact ledger revision',async()=>{
 const f=await fixture(),product=f.data.products[0]!.id;
 const first=randomUUID(),second=randomUUID(),foreign=randomUUID();
 const data:StaffCatalogueSnapshot={...f.data,publications:[
   {id:first,productId:product,revision:'9007199254740992',action:'ACTIVATE',occurredAt:SYNTHETIC_NOW},
   {id:second,productId:product,revision:'9007199254740993',action:'ROLLBACK',occurredAt:SYNTHETIC_NOW},
 ]};
 let audits=0,pricing=true;
 const authority={require:async(_identity:unknown,tenantId:string,permission:string)=>{
   if(tenantId!==f.tenant||permission==='pricing.read'&&!pricing) throw Object.assign(new Error('Denied'),{status:403});
   return {staffId:product,tenantId,revalidate:async()=>true};
 }};
 const service=new StaffCatalogueService({authority,now:()=>new Date(SYNTHETIC_NOW),
   read:async ticket=>{consumeStaffCatalogueRead(ticket);return data;},audit:async()=>{audits++;}});
 const page=await service.read(f.identity,f.tenant,'publications',{product,limit:'1'});
 assert.deepEqual(page.items,[{id:second,productId:product,revision:'9007199254740993',action:'ROLLBACK',occurredAt:SYNTHETIC_NOW}]);
 const next=await service.read(f.identity,f.tenant,'publications',{product,limit:'1',cursor:page.next});
 assert.equal(next.items[0]!.id,first);
 assert.equal(audits,2);
 await assert.rejects(()=>service.read(f.identity,foreign,'publications',{product}),{status:403});
 pricing=false;
 await assert.rejects(()=>service.read(f.identity,f.tenant,'publications',{product}),{status:403});
 assert.equal(audits,2);
});

test('discoveries disclose exact reported denominations without creating priced or publishable offers', async()=>{
 const f=await fixture(),id=randomUUID();
 const discovery={id,providerId:'FINXPLOR',sourceId:'pilot-item',name:'Sandbox card',brand:'Sandbox',
   sourceCountry:'GTM',currency:'USD',category:'Gift Card',delivery:'email',observedAt:SYNTHETIC_NOW,
   minAmount:'0.00',maxAmount:'9007199254740993.07',denominations:['9007199254740993.07'],
   reviewReason:'OUTSIDE_PRICED_CATALOGUE_SCOPE' as const,privateToken:'discard'};
 Object.assign(f.data,{discoveries:[discovery]});
 f.denyPricing();
 const page=await f.service.read(f.identity,f.tenant,'discoveries',{provider:'FINXPLOR',search:'Finxplore'});
 assert.equal(page.items.length,1);
 assert.equal(page.count,1);
 assert.deepEqual(page.sourceCountries,['GTM']);
 assert.equal(page.items[0]!['maxAmount'],'9007199254740993.07');
 assert.equal(page.items[0]!['reviewReason'],'OUTSIDE_PRICED_CATALOGUE_SCOPE');
 assert.equal(page.items[0]!['status'],'DISCOVERY_ONLY');
 assert.equal(page.items[0]!['sourceCountryCode'],'GT');
 assert.deepEqual(page.items[0]!['mappingBlockers'],['SERVICE_COUNTRY','CURRENCY']);
 assert.equal(page.items[0]!['pricing'],'UNVERIFIED');
 assert.deepEqual(page.items[0]!['pricingReview'],{matching:'OUTSIDE_SCOPE',state:'AWAITING_VERIFIED_TERMS',salePrice:null});
 assert.equal(page.items[0]!['privateToken'],undefined);
 assert.equal(page.items[0]!['available'],undefined);
 assert.equal(page.items[0]!['total'],undefined);
 assert.equal(f.audits(),1);
 const filtered=await f.service.read(f.identity,f.tenant,'discoveries',{sourceCountry:'ARE'});
 assert.equal(filtered.count,0);assert.deepEqual(filtered.sourceCountries,['GTM']);
 await assert.rejects(()=>f.service.read(f.identity,f.tenant,'discoveries',{sourceCountry:'AE'}),{status:400});
 await assert.rejects(()=>f.service.read(f.identity,randomUUID(),'discoveries',{}),{status:503});
 f.revoke();
 await assert.rejects(()=>f.service.read(f.identity,f.tenant,'discoveries',{}),{status:403});
 assert.equal(f.audits(),2);
});

test('discovery providers merge the configured directory with tenant imports and filter by source market and product type',async()=>{
 const f=await fixture();
 const base={id:randomUUID(),providerId:'FINXPLOR',sourceId:'gift',name:'Card',brand:'Fixture',sourceCountry:'GTM',
   currency:'USD',category:'Gift Card',delivery:'email',observedAt:SYNTHETIC_NOW,minAmount:'1.00',maxAmount:'1.00',
   denominations:['1.00'],reviewReason:'CANONICAL_MAPPING_REQUIRED' as const};
 const data={...f.data,discoveryProviderIds:['FINXPLOR'],discoveries:[base,
   {...base,id:randomUUID(),sourceId:'mobile',name:'Data',sourceCountry:'NGA',category:'Mobile & Telecom'},
   {...base,id:randomUUID(),sourceId:'other',providerId:'IRONGATE',sourceCountry:'IDN'}]};
 const service=new StaffCatalogueService({now:()=>new Date(SYNTHETIC_NOW),
   authority:{require:async()=>({staffId:randomUUID(),tenantId:f.tenant,revalidate:async()=>true})},
   read:async ticket=>{consumeStaffCatalogueRead(ticket);return data;},audit:async()=>{},configuredDiscoveryProviders:['FINXPLOR','IPAY','UNKNOWN']});
 const directory=(await service.read(f.identity,f.tenant,'discovery-providers',{})).items;
 assert.deepEqual(directory.map(({id,name,hasDiscoveries})=>({id,name,hasDiscoveries})),[
   {id:'FINXPLOR',name:'Finxplor',hasDiscoveries:true},{id:'IPAY',name:'iPay / Qore3',hasDiscoveries:false},
 ]);
 assert.deepEqual(directory[0]?.['functions'],[
   {name:'List products',method:'GET',path:'/api/v1/products',verification:'Sandbox imported'},
   {name:'Get product details',method:'GET',path:'/api/v1/products/:productId',verification:'Mock verified'},
 ]);
 const mobile=await service.read(f.identity,f.tenant,'discoveries',{provider:'FINXPLOR',sourceRegion:'Africa',sourceCountry:'NGA',productType:'Mobile recharge'});
 assert.deepEqual(mobile.items.map(row=>row.name),['Data']);
 assert.deepEqual(mobile.sourceMarkets,[{id:'GTM',name:'Guatemala',region:'Americas'},{id:'NGA',name:'Nigeria',region:'Africa'}]);
 assert.deepEqual(mobile.productTypes,['Gift cards','Mobile recharge']);
 assert.equal((await service.read(f.identity,f.tenant,'discoveries',{provider:'FINXPLOR',productType:'Gift cards'})).count,1);
 assert.equal((await service.read(f.identity,f.tenant,'discoveries',{provider:'IPAY'})).count,0);
 await assert.rejects(()=>service.read(f.identity,f.tenant,'discoveries',{sourceRegion:'unknown'}),{status:400});
});
