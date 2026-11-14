import { createImportPool } from "../packages/database/dist/database/src/pool.js";
import { parseDatabaseConfig } from "../packages/database/dist/database/src/config.js";
import { CatalogPostgresRepository } from "../packages/database/dist/database/src/repositories/catalog-repository.js";
import { createSyntheticProviders } from "../packages/provider-adapters/src/mock-provider.ts";
import { importSyntheticCatalogProvider } from "../packages/application/src/catalog/synthetic-provider-import.ts";

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new TypeError(`${name} is required for the internal synthetic import command`);
  }
  return value;
}

async function main(): Promise<void> {
  const tenantId = requiredEnvironmentValue("NUKHBAPAY_TENANT_ID");
  const providerAccountId = requiredEnvironmentValue("NUKHBAPAY_PROVIDER_ACCOUNT_ID");
  const config = parseDatabaseConfig(process.env);
  const provider = createSyntheticProviders().find(
    (candidate) => candidate.providerId === "synthetic-provider-a",
  );
  if (!provider) {
    throw new Error("Synthetic provider A is not configured");
  }

  const offers = await provider.fetchCatalog();
  if (offers.length === 0 || offers.some((offer) =>
    offer.providerId !== provider.providerId || offer.snapshotId !== offers[0]?.snapshotId
  )) {
    throw new Error("Synthetic provider returned an empty or inconsistent complete snapshot");
  }
  const snapshot = offers[0];
  if (!snapshot) {
    throw new Error("Synthetic provider returned an empty snapshot");
  }

  const pool = createImportPool(config);
  try {
    const repository = new CatalogPostgresRepository(pool);
    const result = await importSyntheticCatalogProvider(
      repository,
      tenantId,
      providerAccountId,
      provider,
      snapshot.snapshotId,
      "v1",
      snapshot.observedAt,
    );
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

await main();
