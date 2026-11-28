import assert from 'node:assert/strict';
import test from 'node:test';
import { FinxplorCatalogue, normalizeFinxplorProduct, type FinxplorProduct } from '../src/finxplor-catalogue.ts';

const account = { tenantId: '10000000-0000-4000-8000-000000000001', providerAccountId: '10000000-0000-4000-8000-000000000002' };
const otherTenant = { ...account, tenantId: '10000000-0000-4000-8000-000000000003' };
const credentialReference = 'finxplor/sandbox/registration-1';
const sample = '{"success":true,"data":[{"productId":"source-1","productName":"Fixture voucher","brand":"Fixture","countryCode":"GTM","currency":"USD","category":"Gift Card","deliveryMethod":"email","denominations":[9007199254740993.07,"8.00"],"minAmount":8.00,"maxAmount":9007199254740993.07,"imageUrl":"https://image.invalid","apiKey":"discard-me"}],"pagination":{"page":1,"limit":1,"total":2,"totalPages":2,"hasNextPage":true}}';
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

test('Finxplor reads the exact sandbox page and retains source decimals without executable fields', async () => {
  let calls = 0;
  const adapter = new FinxplorCatalogue({
    account, credentialReference,
    getApiKey: async (scope, reference) => {
      assert.deepEqual(scope, account);
      assert.equal(reference, credentialReference);
      return 'fixture-key-123';
    },
    transport: async (url, init) => {
      calls++;
      assert.equal(url, 'https://sandbox.finxplorconnect.com/api/v1/products?page=1&limit=1');
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('x-api-key'), 'fixture-key-123');
      return json(sample);
    },
  });
  assert.deepEqual(await adapter.page(account, 1, 1), {
    products: [{ sourceId: 'source-1', name: 'Fixture voucher', brand: 'Fixture', country: 'GTM', currency: 'USD',
      category: 'Gift Card', delivery: 'email', denominations: ['9007199254740993.07', '8.00'],
      minAmount: '8.00', maxAmount: '9007199254740993.07' }],
    total: 2, totalPages: 2, hasNextPage: true,
  });
  assert.equal(calls, 1);
});

test('Finxplor admits only unsigned artwork on its catalogue media route', async () => {
  const logo = 'https://finxplorconnect.com/api/v1/media/YXJ0d29yaw';
  let image = logo;
  const adapter = new FinxplorCatalogue({
    account, credentialReference, getApiKey: async () => 'fixture-key-123',
    transport: async () => json(sample.replace('https://image.invalid',image)),
  });
  assert.equal((await adapter.page(account,1,1)).products[0]?.imageUrl,logo);
  for (const unsafe of [logo+'?token=fixture',logo.replace('finxplorconnect.com','other.example'),
    logo.replace('/api/v1/media/','/api/v1/products/'),logo.replace('https:','http:')]) {
    image=unsafe;
    assert.equal((await adapter.page(account,1,1)).products[0]?.imageUrl,undefined);
  }
});

test('Finxplor denies cross-tenant and invalid pagination before loading credentials', async () => {
  let resolutions = 0;
  const adapter = new FinxplorCatalogue({ account, credentialReference, getApiKey: async () => {
    resolutions++;
    return 'fixture-key-123';
  }, transport: async () => json(sample) });
  await assert.rejects(adapter.page(otherTenant, 1, 1));
  await assert.rejects(adapter.page({ ...account, providerAccountId: otherTenant.tenantId }, 1, 1));
  await assert.rejects(adapter.page(account, 0, 1));
  await assert.rejects(adapter.page(account, 1, 101));
  assert.equal(resolutions, 0);
});

test('Finxplor detail binds the encoded identifier to the response and projects safe exact amounts',async()=>{
 const body=sample.slice(sample.indexOf('[{')+1,sample.indexOf('}],')+1).replaceAll('source-1','product:123');
 let calls=0, mismatch=false;
 const adapter=new FinxplorCatalogue({account,credentialReference,getApiKey:async()=> 'fixture-key-123',
   transport:async(url,init)=>{
     calls++;
     assert.equal(url,'https://sandbox.finxplorconnect.com/api/v1/products/product%3A123');
     assert.equal(init?.method,'GET');
     return json(`{"success":true,"data":{"product":${mismatch?body.replace('product:123','wrong'):body}}}`);
   }});
 await assert.rejects(adapter.detail(otherTenant,'product:123'));
 await assert.rejects(adapter.detail(account,'../purchase'));
 assert.equal(calls,0);
 const detail=await adapter.detail(account,'product:123');
 assert.equal(detail.maxAmount,'9007199254740993.07');
 assert.equal(Object.hasOwn(detail,'apiKey'),false);
 mismatch=true;await assert.rejects(adapter.detail(account,'product:123'));
});

test('Finxplor full traversal requires the reported count and unique IDs across pages', async () => {
  const base = JSON.parse(sample).data[0];
  const requests: number[] = [];
  let repeatId = false;
  const adapter = new FinxplorCatalogue({ account, credentialReference, getApiKey: async () => 'fixture-key-123',
    transport: async url => {
      const page = Number(new URL(String(url)).searchParams.get('page'));
      requests.push(page);
      const data = page === 1 ? Array.from({length:100}, (_, i) => ({ ...base, productId:'p-'+i }))
        : [{ ...base, productId:repeatId?'p-0':'p-100' }];
      return json(JSON.stringify({success:true,data,pagination:{page,limit:100,total:101,totalPages:2,hasNextPage:page===1}}));
    } });
  assert.equal((await adapter.fullCatalogue(account)).length,101);
  assert.deepEqual(requests,[1,2]);
  repeatId=true;
  await assert.rejects(adapter.fullCatalogue(account),/Finxplor catalogue read unavailable/);
  assert.deepEqual(requests,[1,2,1,2]);
});

test('Finxplor fails closed on failed and malformed pages without a second request', async () => {
  for (const response of [json(sample, 429), json(sample.replace('"page":1', '"page":2')),
    json(sample.replace('"currency":"USD"', '"currency":"US"')), json(sample.replace('"8.00"', 'null'))]) {
    let calls = 0;
    const adapter = new FinxplorCatalogue({ account, credentialReference, getApiKey: async () => 'fixture-key-123',
      transport: async () => { calls++; return response; } });
    await assert.rejects(adapter.page(account, 1, 1), /Finxplor catalogue read unavailable/);
    assert.equal(calls, 1);
  }
});


test('global traversal reads beyond misleading totals and confirms every country', async () => {
 const row=JSON.parse(sample).data[0];
 let calls=0, changed=false;
 const adapter=new FinxplorCatalogue({account,credentialReference,getApiKey:async()=> 'fixture-key-123',
  transport:async url=>{
   calls++;
   const query=new URL(String(url)).searchParams;
   assert.equal(query.has('country'),false);assert.equal(query.has('category'),false);
   const page=Number(query.get('page'));
   const data=page===1?Array.from({length:100},(_,i)=>({...row,productId:'g-'+i})):
    page===2?[{...row,productId:'global-extra',countryCode:'ARE',brand:changed&&calls>3?'Changed':'Fixture'}]:[];
   return json(JSON.stringify({success:true,data,pagination:{page,limit:100,total:data.length,totalPages:Number(data.length>0),hasNextPage:false}}));
  }});
 const result=await adapter.globalCatalogue(account);
 assert.equal(result.scope,'ALL_COUNTRIES');assert.equal(result.rows.length,101);
 assert.equal(result.pages,3);assert.equal(calls,6);
 calls=0;changed=true;
 await assert.rejects(adapter.globalCatalogue(account));
});

test('catalogue denominations and any displayed price do not establish acquisition cost', async () => {
  const { finxplorCatalogueCostEvidence, normalizeFinxplorProduct } = await import('../src/finxplor-catalogue.ts');
  const product = normalizeFinxplorProduct({
    productId:'quote-required-fixture', countryCode:'ARE', category:'Gift Card', currency:'AED',
    denominations:['50'], productName:'Fixture', brand:'Fixture', deliveryMethod:'PIN', minAmount:'50', maxAmount:'50',
    senderCost:'12.00', retailPrice:'53.00',
  });
  assert.deepEqual(finxplorCatalogueCostEvidence(product),{basis:'QUOTE_REQUIRED',sourceReference:'quote-required-fixture'});
});


test('global sync resumes at the failed page and requires a second terminal read', async () => {
  const pages: Array<readonly FinxplorProduct[]> = [];
  const calls:number[] = [];
  const confirmations: Array<readonly string[]> = [];
  let limitReached = true;
  const adapter = new FinxplorCatalogue({account,credentialReference,getApiKey:async()=> 'fixture-key-123',
    transport:async url => {
      const page=Number(new URL(url).searchParams.get('page'));
      calls.push(page);
      if (page===2 && limitReached) return new Response('{}',{status:500,headers:{'retry-after':'16'}});
      const items = page===1 ? JSON.parse(sample).data : [];
      return json(JSON.stringify({success:true,data:items,pagination:{page,limit:100}}));
    },
  });
  const checkpoint=()=>({observedAt:'2026-01-01T00:00:00Z',pages,confirmations,
    savePage:async(_page:number,products:readonly FinxplorProduct[])=>{pages.push(products);},
    saveConfirmation:async(_page:number,ids:readonly string[])=>{confirmations.push(ids);}});
  const partial=await adapter.globalCatalogue(account,undefined,undefined,checkpoint());
  assert.equal(partial.scope,'PARTIAL_ALL_COUNTRIES');
  assert.equal(partial.rows.length,1);
  assert.equal(partial.nextPage,2);
  assert.deepEqual(calls,[1,2]);
  limitReached=false;
  const readyToVerify=await adapter.globalCatalogue(account,undefined,undefined,checkpoint());
  assert.equal(readyToVerify.scope,'PARTIAL_ALL_COUNTRIES');
  assert.equal(readyToVerify.verificationPending,true);
  const complete=await adapter.globalCatalogue(account,undefined,undefined,checkpoint());
  assert.equal(complete.scope,'ALL_COUNTRIES');
  assert.deepEqual(calls,[1,2,2,1,2]);
  assert.equal(confirmations.length,2);
});

test('provider formatting whitespace in product names is normalized for display', () => {
  const row=JSON.parse(sample).data[0];
  const product={...row,denominations:['50'],minAmount:'50',maxAmount:'50',
    productName:'Night Data Bundles\t 350MB\r\n'};
  assert.equal(normalizeFinxplorProduct(product).name,'Night Data Bundles  350MB');
  assert.throws(()=>normalizeFinxplorProduct({...product,productName:'Name\u0000'}));
});

test('known provider alpha-2 country codes are stored in the catalogue alpha-3 format', () => {
  const row=JSON.parse(sample).data[0];
  const product=normalizeFinxplorProduct({...row,denominations:[],minAmount:'15',maxAmount:'15',countryCode:'US'},'ARE_GIFT_CARD');
  assert.equal(product.country,'USA');
  assert.equal(product.sourceCountryLabel,'US');
  const historical=normalizeFinxplorProduct({...row,denominations:[],minAmount:'15',maxAmount:'15',countryCode:'AN'},'ARE_GIFT_CARD');
  assert.equal(historical.country,'ANT');
  assert.equal(historical.sourceCountryLabel,'AN');
  const unspecified=normalizeFinxplorProduct({...row,denominations:[],minAmount:'15',maxAmount:'15',countryCode:'ZZ'},'ARE_GIFT_CARD');
  assert.equal(unspecified.country,'ZZZ');
  assert.equal(unspecified.sourceCountryLabel,'ZZ');
  assert.equal(normalizeFinxplorProduct({...row,denominations:[],minAmount:'15',maxAmount:'15',countryCode:'LO'}).country,'LAO');
  const unmapped=normalizeFinxplorProduct({...row,denominations:[],minAmount:'15',maxAmount:'15',countryCode:'XY'},'ARE_GIFT_CARD');
  assert.equal(unmapped.country,'XXY');
  assert.equal(unmapped.sourceCountryLabel,'XY');
});


test('global verification tolerates repeated identical rows and different page order', async () => {
  const template=JSON.parse(sample).data[0];
  const a={...template,productId:'product-a'};
  const b={...template,productId:'product-b'};
  const sequences=[[a],[a,b],[],[b,a],[]];
  let requests=0;
  const adapter=new FinxplorCatalogue({account,credentialReference,getApiKey:async()=> 'fixture-key-123',
    transport:async url=>{
      const page=Number(new URL(url).searchParams.get('page'));
      return json(JSON.stringify({success:true,data:sequences[requests++],pagination:{page,limit:100}}));
    },
  });
  const result=await adapter.globalCatalogue(account);
  assert.equal(result.scope,'ALL_COUNTRIES');
  assert.deepEqual(result.rows.map(row=>row.sourceId),['product-a','product-b']);
  assert.equal(requests,5);
});


test('global verification retains additional products when Finxplor returns a different set', async () => {
  const wireRow=JSON.parse(sample).data[0];
  const first = normalizeFinxplorProduct({...wireRow,productId:'initial-product',denominations:['1'],
    minAmount:'1',maxAmount:'1'},'ARE_GIFT_CARD');
  const adapter=new FinxplorCatalogue({account,credentialReference,getApiKey:async()=> 'fixture-key-123',
    transport:async url=>{
      const page=Number(new URL(url).searchParams.get('page'));
      const data=page===1?[{...wireRow,productId:'additional-product'}]:[];
      return json(JSON.stringify({success:true,data,pagination:{page,limit:100}}));
    },
  });
  const confirmed: Array<readonly string[]>=[];
  const updates: FinxplorProduct[]=[];
  const result=await adapter.globalCatalogue(account,undefined,undefined,{
    observedAt:'2026-01-01T00:00:00Z',pages:[[first],[]],confirmations:confirmed,
    savePage:async()=>assert.fail('Restarted the initial scan'),
    saveConfirmation:async(_page,ids,differences=[])=>{confirmed.push(ids);updates.push(...differences);},
  });
  assert.equal(result.scope,'PARTIAL_ALL_COUNTRIES');
  assert.equal(result.verificationMismatch,true);
  assert.deepEqual(result.rows.map(product=>product.sourceId),['initial-product','additional-product']);
  assert.deepEqual(updates.map(product=>product.sourceId),['additional-product']);
});
