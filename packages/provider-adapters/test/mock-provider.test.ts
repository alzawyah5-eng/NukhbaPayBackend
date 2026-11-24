import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createSyntheticProviders, SYNTHETIC_PRODUCT } from "../src/index.ts";

test("synthetic connectors return immutable normalized catalogs without execution capabilities", async () => {
  const providers = createSyntheticProviders();
  assert.equal(providers.length, 3);
  const catalogs = await Promise.all(providers.map((provider) => provider.fetchCatalog()));
  for (const catalog of catalogs) {
    assert.ok(Object.isFrozen(catalog));
    assert.ok(Object.isFrozen(catalog[0]));
    assert.deepEqual(catalog[0]!.identity, SYNTHETIC_PRODUCT);
  }
  for (const provider of providers) {
    assert.equal("submitOrder" in provider, false);
    assert.equal("chargePayment" in provider, false);
  }
});

test("synthetic catalogue reads respect an already cancelled request", async () => {
  const [provider] = createSyntheticProviders();
  assert.ok(provider);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.fetchCatalog(controller.signal), { name:"AbortError" });
  assert.equal((await provider.fetchCatalog()).length, 1);
});

test("versioned synthetic mock server preserves normalized availability and exact minor units", async () => {
  const providers = createSyntheticProviders();
  const server = createServer((request,response)=>{
    if (request.url!=="/fixtures/catalogue/v1") { response.writeHead(404).end();return; }
    if (request.method!=="GET") { response.writeHead(405,{allow:"GET"}).end();return; }
    void Promise.all(providers.map(provider=>provider.fetchCatalog())).then(catalogues=>{
      const body=JSON.stringify({version:1,offers:catalogues.flat()},(_,value:unknown)=>typeof value==="bigint" ? value.toString() : value);
      response.writeHead(200,{"content-type":"application/json","cache-control":"no-store"}).end(body);
    },()=>response.writeHead(503).end());
  });
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  const address=server.address();
  assert.ok(address && typeof address==="object");
  const base=`http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(base+"/fixtures/catalogue/v2")).status,404);
    assert.equal((await fetch(base+"/fixtures/catalogue/v1",{method:"POST"})).status,405);
    const response=await fetch(base+"/fixtures/catalogue/v1");
    assert.equal(response.status,200);
    const {version,offers}=await response.json();
    assert.equal(version,1);
    assert.equal(offers.length,3);
    for (const {identity,providerDebitMinor,additionalProviderFeeMinor,observedAt,validUntil} of offers) {
      assert.equal(identity.redemptionCountry,"AE");
      assert.equal(identity.currency,"AED");
      assert.equal(identity.faceValueMinor,"10000");
      assert.match(providerDebitMinor,/^\d+$/);
      assert.match(additionalProviderFeeMinor,/^\d+$/);
      assert.ok(Date.parse(validUntil)>Date.parse(observedAt));
    }
    assert.deepEqual(offers.map(o=>o.available),[true,true,false]);
    assert.equal(BigInt(offers[1].providerDebitMinor)+BigInt(offers[1].additionalProviderFeeMinor),9730n);
  } finally {await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeIdleConnections();});}
});
