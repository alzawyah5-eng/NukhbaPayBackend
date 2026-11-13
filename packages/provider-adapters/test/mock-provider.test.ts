import assert from "node:assert/strict";
import test from "node:test";
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
