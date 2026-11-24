import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PublishedCatalogueService,attestCatalogueClient,consumeCatalogueReadTicket,CATALOGUE_AUDIENCES,CATALOGUE_SCOPES } from "../src/catalog/published-catalogue.js";

function fixture() {
  const now=Date.parse('2026-11-19T10:00:00Z'),tenantId=randomUUID();let audits=0;
  const identity=attestCatalogueClient({issuer:'https://catalogue.synthetic.invalid/',subject:'backend',clientId:'backend',kind:'payment',audience:CATALOGUE_AUDIENCES.payment,scope:CATALOGUE_SCOPES.payment,issuedAt:now/1000,expiresAt:now/1000+300});
  const rows=['Nukhba Gift 100','Nukhba Gift 200','Other Gift'].map(name=>({productId:randomUUID(),name,publicationId:randomUUID(),totalMinor:'10200',validUntil:'2026-11-19T11:00:00Z'}));
  const service=new PublishedCatalogueService({capability:'SYNTHETIC_PUBLISHED_CATALOGUE_ONLY',now:()=>new Date(now),requestsPerMinute:200,
    bindings:{find:async()=>({...identity,tenantId,kioskId:null,enabled:true,version:'1'})},
    reader:{read:async ticket=>{consumeCatalogueReadTicket(ticket);assert.equal(ticket.tenantId,tenantId);return rows;}},audit:{append:async()=>{audits++;}}});
  return {audits:()=>audits,read:(query:Record<string,unknown>)=>service.read(identity,{kind:'payment',query})};
}

test('master catalogue searches normalized names within country, region and service availability',async()=>{
  const f=fixture();
  const page=await f.read({search:'  NUKHBA  ',country:'AE',region:'AE',service:'DIGITAL_PIN'});
  assert.equal(page.items.length,2);assert.ok(page.items.every(p=>p.name.startsWith('Nukhba')));
  assert.equal((await f.read({search:'Ｎｕｋｈｂａ'})).items.length,2);
  for(const query of [{country:'SA'},{region:'EU'},{service:'AIRTIME'},{search:'missing'}])assert.equal((await f.read(query)).items.length,0);
  assert.equal(f.audits(),6);
});

test('pagination cannot broaden or substitute its bound search or availability filters',async()=>{
  const f=fixture(),page=await f.read({limit:'1',search:'nukhba',country:'AE'});assert.ok(page.next_cursor);
  for(const query of [{limit:'1',cursor:page.next_cursor},{limit:'1',search:'other',country:'AE',cursor:page.next_cursor},
    {limit:'1',search:'nukhba',country:'SA',cursor:page.next_cursor}])await assert.rejects(()=>f.read(query),{status:409});
  const next=await f.read({limit:'1',search:'NUKHBA',country:'AE',cursor:page.next_cursor});
  assert.equal(next.items.length,1);assert.notEqual(next.items[0]!.product_id,page.items[0]!.product_id);
  await assert.rejects(()=>f.read({limit:'1',search:'nukhba',country:'AE',cursor:page.next_cursor}),{status:409});
});

test('invalid filters reject before reading or committing a read audit',async()=>{
  const f=fixture();
  for(const query of [{search:''},{search:' '},{search:'x'.repeat(129)},{search:'a\nb'},{search:['a']},{country:'ae'},
    {country:'AE\n'},{region:'ae'},{service:'DIGITAL_PIN\n'},{tenantId:randomUUID()}])await assert.rejects(()=>f.read(query),{status:400});
  assert.equal(f.audits(),0);
});

test('machine-token expiry during the final binding lookup prevents disclosure after committed audit',async()=>{
  let now=Date.parse('2026-11-19T10:00:00Z'),lookups=0,audits=0;const tenantId=randomUUID();
  const identity=attestCatalogueClient({issuer:'https://catalogue.synthetic.invalid/',subject:'backend',clientId:'backend',kind:'payment',
    audience:CATALOGUE_AUDIENCES.payment,scope:CATALOGUE_SCOPES.payment,issuedAt:now/1000,expiresAt:now/1000+300});
  const service=new PublishedCatalogueService({capability:'SYNTHETIC_PUBLISHED_CATALOGUE_ONLY',now:()=>new Date(now),
    bindings:{find:async()=>{if(++lookups===3)now+=300000;return {...identity,tenantId,kioskId:null,enabled:true,version:'1'};}},
    reader:{read:async ticket=>{consumeCatalogueReadTicket(ticket);return [{productId:randomUUID(),name:'SYNTHETIC',publicationId:randomUUID(),totalMinor:'10200',validUntil:'2026-11-19T11:00:00Z'}];}},
    audit:{append:async()=>{audits++;}}});
  await assert.rejects(()=>service.read(identity,{kind:'payment',query:{}}),{status:403});
  assert.equal(audits,1);
});


test('GCC and Asia select the same AE catalogue without creating country duplicates or wider availability', async () => {
  const f = fixture();
  const gcc = await f.read({ country: 'AE', region: 'GCC' });
  const asia = await f.read({ country: 'AE', region: 'ASIA' });
  assert.equal(gcc.items.length, 3);
  assert.deepEqual(gcc.items, asia.items);
  assert.equal(new Set(gcc.items.map(item => item.product_id)).size, gcc.items.length);
  assert.equal((await f.read({ country: 'SA', region: 'GCC' })).items.length, 0);
});
