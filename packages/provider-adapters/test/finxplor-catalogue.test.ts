import assert from 'node:assert/strict';
import test from 'node:test';
import { FinxplorCatalogue } from '../src/finxplor-catalogue.ts';

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
