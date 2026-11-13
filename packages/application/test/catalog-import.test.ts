import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogProvider, ProviderOffer } from "../../provider-contracts/src/index.js";
import {
  importSyntheticCatalogProvider,
  readSyntheticProviderSnapshot,
  type CatalogImportRepository,
  type CatalogImportResult,
} from "../src/catalog/synthetic-provider-import.js";

const offer: ProviderOffer = {
  providerId: "synthetic-provider-a",
  offerId: "synthetic-provider-a-gift-100",
  snapshotId: "synthetic-provider-a-synthetic-snapshot-v1",
  identity: {
    canonicalProductId: "synthetic_brand_x_ae_aed_100",
    brand: "SYNTHETIC_BRAND_X",
    redemptionCountry: "AE",
    currency: "AED",
    faceValueMinor: 10_000n,
    fulfillmentMethod: "DIGITAL_PIN",
    termsVersion: "synthetic-terms-v1",
  },
  mappingStatus: "APPROVED",
  providerDebitMinor: 9_700n,
  upfrontDiscountMinor: 300n,
  additionalProviderFeeMinor: 0n,
  available: true,
  eligible: true,
  observedAt: "2026-11-09T09:00:00Z",
  validUntil: "2026-11-09T11:00:00Z",
};

test("the synthetic provider use case forwards a complete snapshot and explicit internal context", async () => {
  let receivedContext: Parameters<CatalogImportRepository["importSyntheticSnapshot"]>[0] | undefined;
  let receivedOffers: readonly ProviderOffer[] | undefined;
  const result: CatalogImportResult = {
    tenantId: "tenant-internal",
    providerAccountId: "provider-account-internal",
    snapshotId: "snapshot-persisted",
    snapshotKey: offer.snapshotId,
    sourceVersion: "v1",
    status: "COMPLETE",
    created: true,
    counts: { products: 1, mappings: 1, offers: 1 },
    acceptedAt: "2026-11-09T09:01:00Z",
  };
  const repository: CatalogImportRepository = {
    importSyntheticSnapshot: async (context, offers) => {
      receivedContext = context;
      receivedOffers = offers;
      return result;
    },
    readSnapshot: async () => null,
  };
  const provider: CatalogProvider = {
    providerId: offer.providerId,
    fetchCatalog: async () => [offer],
  };

  const imported = await importSyntheticCatalogProvider(
    repository,
    "tenant-internal",
    "provider-account-internal",
    provider,
    offer.snapshotId,
    "v1",
    offer.observedAt,
  );
  assert.equal(imported, result);
  assert.deepEqual(receivedContext, {
    tenantId: "tenant-internal",
    providerAccountId: "provider-account-internal",
    snapshotKey: offer.snapshotId,
    sourceVersion: "v1",
    observedAt: offer.observedAt,
    effectiveAt: null,
  });
  assert.deepEqual(receivedOffers, [offer]);

  assert.equal(
    await readSyntheticProviderSnapshot(repository, "tenant-internal", "provider-account-internal", offer.snapshotId),
    null,
  );
});
