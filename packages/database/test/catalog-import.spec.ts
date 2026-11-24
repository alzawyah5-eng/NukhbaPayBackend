import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { createCatalogueRefreshStore } from "../src/catalogue-refresh-store.js";
import { parseDatabaseConfig, parseIntegrationAdminUrl } from "../src/config.js";
import {
  CatalogImportConflictError,
  CatalogPostgresRepository,
} from "../src/repositories/catalog-repository.js";

const packageRoot = fileURLToPath(new URL("../../..", import.meta.url));
const adminUrl = process.env["DB_TEST_ADMIN_URL"];
const hasDatabaseConfig = Boolean(
  process.env["DB_MIGRATION_URL"] &&
  process.env["DB_RUNTIME_URL"] &&
  process.env["DB_IMPORT_URL"] &&
  process.env["DB_RUNTIME_ROLE"] &&
  process.env["DB_IMPORT_ROLE"] &&
  adminUrl,
);

function getNodePgMigrateCli(): string {
  const candidates = [
    path.join(packageRoot, "node_modules", "node-pg-migrate", "bin", "node-pg-migrate.js"),
    path.join(packageRoot, "..", "..", "node_modules", "node-pg-migrate", "bin", "node-pg-migrate.js"),
  ];
  const hit = candidates.find((candidate) => fs.existsSync(candidate));
  if (!hit) {
    throw new Error(`node-pg-migrate CLI not found at ${candidates.join(" or ")}`);
  }
  return hit;
}

function runMigrationUp(databaseUrl: string, migrationDir: string): void {
  const cli = getNodePgMigrateCli();
  let staged: string | undefined;
  if (migrationDir === "migrations") {
    staged = fs.mkdtempSync(path.join(os.tmpdir(), "nukh-catalog-foundation-"));
    for (const name of ["001_catalog.ts", "002_import_role_privileges.ts", "003_import_role_read_access.ts"])
      fs.copyFileSync(path.join(packageRoot, "migrations", name), path.join(staged, name));
    migrationDir = staged;
  }
  const env = {
    ...process.env,
    DB_MIGRATION_URL: databaseUrl,
  };
  try {
    execFileSync(process.execPath, [
      "--experimental-strip-types",
      cli,
      "up",
      "--database-url-var",
      "DB_MIGRATION_URL",
      "--migrations-dir",
      migrationDir,
      "--schema",
      "nukhabapay",
      "--migrations-schema",
      "nukhabapay",
      "--migrations-table",
      "schema_migrations",
      "--single-transaction",
      "--check-order",
      "--migration-file-language",
      "ts",
      "--ignore-pattern",
      "README.md|.*\\.md",
    ], { cwd: packageRoot, env, stdio: "pipe" });
  } finally {
    if (staged) {
      const resolved = path.resolve(staged);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("nukh-catalog-foundation-"))
        throw new Error("Unsafe catalogue migration staging cleanup path");
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

async function withAdminClient<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: parseIntegrationAdminUrl(adminUrl).connectionString });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) {
    throw new Error("Unsafe database identifier in test configuration");
  }
  return `"${value}"`;
}

function databaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function createDatabase(dbName: string): Promise<void> {
  const config = parseDatabaseConfig(process.env);
  const migrationRole = quoteIdentifier(decodeURIComponent(new URL(config.migrationUrl).username));
  const runtimeRole = quoteIdentifier(config.runtimeRole);
  const importRole = quoteIdentifier(config.importRole);
  const database = quoteIdentifier(dbName);
  await withAdminClient(async (client) => {
    await client.query(`CREATE DATABASE ${database}`);
    await client.query(`ALTER DATABASE ${database} OWNER TO ${migrationRole}`);
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${migrationRole}, ${runtimeRole}, ${importRole}`);
  });

  const newClient = new Client({ connectionString: databaseUrl(parseIntegrationAdminUrl(adminUrl).connectionString, dbName) });
  await newClient.connect();
  try {
    await newClient.query(`CREATE SCHEMA nukhabapay AUTHORIZATION ${migrationRole}`);
    await newClient.query(`GRANT USAGE ON SCHEMA nukhabapay TO ${runtimeRole}, ${importRole}`);
  } finally {
    await newClient.end();
  }
}

async function dropDatabase(dbName: string): Promise<void> {
  await withAdminClient(async (client) => {
    await client.query(`DROP DATABASE ${quoteIdentifier(dbName)}`);
  });
}

async function seedApprovedMapping(
  client: Client,
  tenantId: string,
  providerAccountId: string,
  offer: ReturnType<typeof createOffer>,
  mappingStatus: "APPROVED" | "PROPOSED" | "REJECTED" = "APPROVED",
): Promise<void> {
  const existingProduct = await client.query<{ id: string }>(
    "SELECT id FROM nukhabapay.products WHERE canonical_product_key = $1",
    [offer.identity.canonicalProductId],
  );
  const productId = existingProduct.rows[0]?.id ?? randomUUID();
  const sourceSnapshotId = randomUUID();
  if (existingProduct.rowCount === 0) {
    await client.query(
      `INSERT INTO nukhabapay.products
        (id, canonical_product_key, brand, redemption_country, currency, face_value_minor, fulfillment_method, terms_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        productId,
        offer.identity.canonicalProductId,
        offer.identity.brand,
        offer.identity.redemptionCountry,
        offer.identity.currency,
        offer.identity.faceValueMinor,
        offer.identity.fulfillmentMethod,
        offer.identity.termsVersion,
      ],
    );
  }
  await client.query(
    `INSERT INTO nukhabapay.provider_snapshots
      (id, tenant_id, provider_account_id, snapshot_key, source_version, observed_at, status, row_count, started_at, completed_at)
     VALUES ($1, $2, $3, $4, 'mapping-seed-v1', $5, 'COMPLETE', 0, $5, $5)`,
    [sourceSnapshotId, tenantId, providerAccountId, `mapping-seed-${offer.offerId}`, offer.observedAt],
  );
  await client.query(
    `INSERT INTO nukhabapay.product_mappings
      (id, tenant_id, provider_account_id, provider_sku, product_id, mapping_version, status, provenance_kind, provenance, source_snapshot_id)
     VALUES ($1, $2, $3, $4, $5, 1, $6, 'MANUAL', $7, $8)`,
    [
      randomUUID(),
      tenantId,
      providerAccountId,
      offer.offerId,
      productId,
      mappingStatus,
      JSON.stringify({ source: "acceptance-test", approvedBy: "migration-fixture" }),
      sourceSnapshotId,
    ],
  );
}

function createOffer(providerId: string, offerId: string, snapshotId: string, debit: bigint): {
  providerId: string;
  offerId: string;
  snapshotId: string;
  identity: {
    canonicalProductId: string;
    brand: string;
    redemptionCountry: "AE";
    currency: "AED";
    faceValueMinor: bigint;
    fulfillmentMethod: "DIGITAL_PIN";
    termsVersion: string;
  };
  mappingStatus: "APPROVED";
  providerDebitMinor: bigint;
  upfrontDiscountMinor: bigint;
  additionalProviderFeeMinor: bigint;
  available: boolean;
  eligible: boolean;
  observedAt: string;
  validUntil: string;
} {
  return {
    providerId,
    offerId,
    snapshotId,
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
    providerDebitMinor: debit,
    upfrontDiscountMinor: 10_000n - debit,
    additionalProviderFeeMinor: 0n,
    available: true,
    eligible: true,
    observedAt: "2026-11-09T09:00:00Z",
    validUntil: "2026-11-09T11:00:00Z",
  };
}

test("snapshot references are validated before persistence", async () => {
  const repository = new CatalogPostgresRepository(new Pool());
  try {
    await assert.rejects(
      () => repository.importSyntheticSnapshot(
        {
          tenantId: randomUUID(),
          providerAccountId: randomUUID(),
          snapshotKey: "snapshot-expected-v1",
          sourceVersion: "v1",
          observedAt: "2026-11-09T09:00:00Z",
        },
        [createOffer("synthetic-provider-a", "gift-mismatch", "snapshot-other-v1", 9_700n)],
      ),
      /Offer snapshot mismatch/,
    );
    const reviewOffer = {
      ...createOffer("synthetic-provider-a", "gift-review-only", "snapshot-review-v1", 9_700n),
      mappingStatus: "REVIEW_REQUIRED" as const,
    };
    await assert.rejects(
      () => repository.importSyntheticSnapshot(
        {
          tenantId: randomUUID(),
          providerAccountId: randomUUID(),
          snapshotKey: "snapshot-review-v1",
          sourceVersion: "v1",
          observedAt: "2026-11-09T09:00:00Z",
        },
        [reviewOffer],
      ),
      /not approved for import/,
    );
  } finally {
    await repository["pool"].end();
  }
});

test("synthetic snapshot imports replay safely, reject conflicts, serialize concurrency, and enforce mapping ownership", { skip: !hasDatabaseConfig }, async () => {
  const databaseName = `nukhabapay_i_${randomUUID().replaceAll("-", "")}`;
  await createDatabase(databaseName);

  try {
    const runtimeUrl = databaseUrl(process.env["DB_RUNTIME_URL"]!, databaseName);
    const importUrl = databaseUrl(process.env["DB_IMPORT_URL"]!, databaseName);
    const migrationUrl = databaseUrl(process.env["DB_MIGRATION_URL"]!, databaseName);
    runMigrationUp(migrationUrl, "migrations");

    const migrator = new Client({ connectionString: migrationUrl });
    const runtime = new Client({ connectionString: runtimeUrl });
    await migrator.connect();
    await runtime.connect();

    try {
      const tenantA = randomUUID();
      const tenantB = randomUUID();
      const providerAccountId = randomUUID();
      const offer = createOffer("synthetic-provider-a", "gift-100", "synthetic-provider-a-snapshot-v1", 9_700n);

      await migrator.query("INSERT INTO nukhabapay.tenants (id, tenant_key) VALUES ($1, $2), ($3, $4)", [tenantA, "alpha", tenantB, "beta"]);
      await migrator.query(
        "INSERT INTO nukhabapay.provider_accounts (id, tenant_id, provider_code, external_account_key, status) VALUES ($1, $2, $3, $4, $5)",
        [providerAccountId, tenantA, "synthetic-provider-a", "account-001", "ACTIVE"],
      );

      await seedApprovedMapping(migrator, tenantA, providerAccountId, offer);

      const importPool = new Pool({ connectionString: importUrl, max: 5 });
      const importer = new Client({ connectionString: importUrl });
      await importer.connect();
      const repository = new CatalogPostgresRepository(importPool);
      try {
        await assert.rejects(
          () => importer.query(
            "DELETE FROM nukhabapay.provider_offers WHERE false",
          ),
          /permission denied/i,
        );
        await assert.rejects(
          () => importer.query(
            "UPDATE nukhabapay.provider_snapshots SET snapshot_key = snapshot_key WHERE false",
          ),
          /permission denied/i,
        );
        await assert.rejects(
          () => importer.query("UPDATE nukhabapay.products SET brand = brand WHERE false"),
          /permission denied/i,
        );
        await assert.rejects(
          () => importer.query("CREATE TABLE nukhabapay.importer_ddl_probe (id integer)"),
          /permission denied/i,
        );

        const firstImport = await repository.importSyntheticSnapshot(
          {
            tenantId: tenantA,
            providerAccountId,
            snapshotKey: "synthetic-provider-a-snapshot-v1",
            sourceVersion: "v1",
            observedAt: "2026-11-09T09:00:00Z",
          },
          [offer],
        );
        assert.equal(firstImport.created, true);
        assert.equal(firstImport.counts.offers, 1);
        assert.equal(firstImport.counts.products, 1);
        assert.equal(firstImport.counts.mappings, 1);
        await assert.rejects(
          () => repository.importSyntheticSnapshot(
            {
              tenantId: tenantA,
              providerAccountId,
              snapshotKey: "synthetic-invalid-v1",
              sourceVersion: "v1",
              observedAt: "2026-11-09T09:00:00Z",
            },
            [{ ...offer, offerId: "gift-invalid", snapshotId: "synthetic-invalid-v1", providerDebitMinor: 0n }],
          ),
          /invalid financial or availability data/,
        );

        const secondImport = await repository.importSyntheticSnapshot(
          {
            tenantId: tenantA,
            providerAccountId,
            snapshotKey: "synthetic-provider-a-snapshot-v1",
            sourceVersion: "v1",
            observedAt: "2026-11-09T09:00:00Z",
          },
          [offer],
        );
        assert.equal(secondImport.created, false);
        assert.equal(secondImport.snapshotId, firstImport.snapshotId);

        // Inspect the reused connection from a separate login of the same restricted
        // role: a query on the pooled connection itself would hide its idle state.
        for (let replay = 0; replay < 3; replay += 1) {
          const repeated = await repository.importSyntheticSnapshot(
            {
              tenantId: tenantA,
              providerAccountId,
              snapshotKey: offer.snapshotId,
              sourceVersion: "v1",
              observedAt: offer.observedAt,
            },
            [offer],
          );
          assert.equal(repeated.created, false);
          assert.equal(repeated.snapshotId, firstImport.snapshotId);
          const reused = await importPool.connect();
          try {
            const backend = await reused.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            const state = await importer.query(
              "SELECT state, xact_start FROM pg_stat_activity WHERE pid = $1",
              [backend.rows[0]!.pid],
            );
            assert.equal(state.rows[0]?.state, "idle");
            assert.equal(state.rows[0]?.xact_start, null);
            const locks = await importer.query(
              "SELECT COUNT(*)::int AS total FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'",
              [backend.rows[0]!.pid],
            );
            assert.equal(locks.rows[0]?.total, 0);
          } finally {
            reused.release();
          }
          const independent = await importer.query(
            "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
            [`${tenantA}:${providerAccountId}:${offer.snapshotId}`],
          );
          assert.equal(independent.rows[0]?.acquired, true);
        }

        const persisted = await repository.readSnapshot(tenantA, providerAccountId, "synthetic-provider-a-snapshot-v1");
        assert.ok(persisted);
        assert.equal(persisted?.snapshot.status, "COMPLETE");
        assert.equal(persisted?.snapshot.sourceVersion, "v1");
        assert.equal(persisted?.offers[0]?.providerOfferKey, "gift-100");
        assert.equal(persisted?.offers[0]?.providerDebitMinor, 9_700n);
        assert.equal(persisted?.offers[0]?.faceValueMinor, 10_000n);

        const countResult = await runtime.query(
          "SELECT COUNT(*)::int AS total FROM nukhabapay.provider_offers WHERE tenant_id = $1 AND provider_account_id = $2",
          [tenantA, providerAccountId],
        );
        assert.equal(Number(countResult.rows[0].total), 1);

        await assert.rejects(
          () => repository.importSyntheticSnapshot(
            {
              tenantId: tenantB,
              providerAccountId,
              snapshotKey: "synthetic-provider-a-snapshot-v2",
              sourceVersion: "v2",
              observedAt: "2026-11-09T09:05:00Z",
            },
            [{ ...offer, offerId: "gift-200", snapshotId: "synthetic-provider-a-snapshot-v2", providerDebitMinor: 9_800n }],
          ),
          /not owned by the supplied tenant|Provider account is not owned by the supplied tenant/i,
        );

        await assert.rejects(
          () => repository.importSyntheticSnapshot(
            {
              tenantId: tenantA,
              providerAccountId,
              snapshotKey: "synthetic-provider-a-snapshot-v1",
              sourceVersion: "v2",
              observedAt: "2026-11-09T09:05:00Z",
            },
            [offer],
          ),
          CatalogImportConflictError,
        );
        await assert.rejects(
          () => repository.importSyntheticSnapshot(
            {
              tenantId: tenantA,
              providerAccountId,
              snapshotKey: "synthetic-provider-a-snapshot-v1",
              sourceVersion: "v1",
              observedAt: "2026-11-09T09:00:00Z",
            },
            [{ ...offer, providerDebitMinor: 9_800n, upfrontDiscountMinor: 200n }],
          ),
          CatalogImportConflictError,
        );
        const preserved = await repository.readSnapshot(tenantA, providerAccountId, "synthetic-provider-a-snapshot-v1");
        assert.equal(preserved?.offers.length, 1);
        assert.equal(preserved?.offers[0]?.providerDebitMinor, 9_700n);

        const nextOffer = createOffer("synthetic-provider-a", "gift-200", "synthetic-provider-a-snapshot-v2", 9_800n);
        await seedApprovedMapping(migrator, tenantA, providerAccountId, nextOffer);
        await repository.importSyntheticSnapshot(
          {
            tenantId: tenantA,
            providerAccountId,
            snapshotKey: "synthetic-provider-a-snapshot-v2",
            sourceVersion: "v2",
            observedAt: "2026-11-09T09:05:00Z",
          },
          [nextOffer],
        );
        const updated = await repository.readSnapshot(tenantA, providerAccountId, "synthetic-provider-a-snapshot-v2");
        assert.ok(updated);
        assert.equal(updated?.offers.length, 1);

        const concurrentOffer = createOffer("synthetic-provider-a", "gift-300", "synthetic-provider-a-snapshot-v3", 9_600n);
        await seedApprovedMapping(migrator, tenantA, providerAccountId, concurrentOffer);
        const concurrentContext = {
          tenantId: tenantA,
          providerAccountId,
          snapshotKey: "synthetic-provider-a-snapshot-v3",
          sourceVersion: "v3",
          observedAt: "2026-11-09T09:10:00Z",
        };
        const concurrentResults = await Promise.all(
          Array.from({ length: 6 }, () => repository.importSyntheticSnapshot(concurrentContext, [concurrentOffer])),
        );
        assert.equal(concurrentResults.filter((result) => result.created).length, 1);
        assert.equal(new Set(concurrentResults.map((result) => result.snapshotId)).size, 1);

        const unapprovedOffer = createOffer("synthetic-provider-a", "gift-review", "synthetic-review-v1", 9_500n);
        await seedApprovedMapping(migrator, tenantA, providerAccountId, unapprovedOffer, "PROPOSED");
        await assert.rejects(
          () => repository.importSyntheticSnapshot(
            {
              tenantId: tenantA,
              providerAccountId,
              snapshotKey: "synthetic-review-v1",
              sourceVersion: "v1",
              observedAt: "2026-11-09T09:15:00Z",
            },
            [unapprovedOffer],
          ),
          /non-approved mapping/,
        );
        const conflictMapping = createOffer("synthetic-provider-a", "gift-conflict", "mapping-seed-gift-conflict", 9_500n);
        const alternativeProduct = {
          ...createOffer("synthetic-provider-a", "gift-alternative", "mapping-seed-gift-alternative", 9_500n),
          identity: {
            ...offer.identity,
            canonicalProductId: "synthetic_brand_y_ae_aed_100",
            brand: "SYNTHETIC_BRAND_Y",
          },
        };
        await seedApprovedMapping(migrator, tenantA, providerAccountId, conflictMapping);
        await seedApprovedMapping(migrator, tenantA, providerAccountId, alternativeProduct);
        await assert.rejects(
          () => repository.importSyntheticSnapshot(
            {
              tenantId: tenantA,
              providerAccountId,
              snapshotKey: "synthetic-mapping-conflict-v1",
              sourceVersion: "v1",
              observedAt: "2026-11-09T09:18:00Z",
            },
            [{
              ...alternativeProduct,
              offerId: "gift-conflict",
              snapshotId: "synthetic-mapping-conflict-v1",
            }],
          ),
          /resolves to a conflicting product mapping/,
        );
        assert.equal(
          (await runtime.query(
            "SELECT COUNT(*)::int AS total FROM nukhabapay.provider_snapshots WHERE tenant_id = $1 AND provider_account_id = $2 AND snapshot_key = $3",
            [tenantA, providerAccountId, "synthetic-review-v1"],
          )).rows[0]?.total,
          0,
        );

        const unmappedOffer = createOffer("synthetic-provider-a", "gift-unmapped", "synthetic-unmapped-v1", 9_400n);
        await assert.rejects(
          () => repository.importSyntheticSnapshot(
            {
              tenantId: tenantA,
              providerAccountId,
              snapshotKey: "synthetic-unmapped-v1",
              sourceVersion: "v1",
              observedAt: "2026-11-09T09:16:00Z",
            },
            [unmappedOffer],
          ),
          /no approved product mapping/,
        );

        const wrongProviderOffer = createOffer("synthetic-provider-b", "gift-wrong-provider", "synthetic-wrong-provider-v1", 9_400n);
        await assert.rejects(
          () => repository.importSyntheticSnapshot(
            {
              tenantId: tenantA,
              providerAccountId,
              snapshotKey: "synthetic-wrong-provider-v1",
              sourceVersion: "v1",
              observedAt: "2026-11-09T09:17:00Z",
            },
            [wrongProviderOffer],
          ),
          /does not match provider account/,
        );
      } finally {
        await importer.end();
        await importPool.end();
      }
    } finally {
      await migrator.end();
      await runtime.end();
    }
  } finally {
    await dropDatabase(databaseName);
  }
});

test("the documented local command imports the synthetic provider through the application use case", { skip: !hasDatabaseConfig }, async () => {
  const databaseName = `nukhabapay_cli_${randomUUID().replaceAll("-", "")}`;
  await createDatabase(databaseName);

  try {
    const migrationUrl = databaseUrl(process.env["DB_MIGRATION_URL"]!, databaseName);
    const runtimeUrl = databaseUrl(process.env["DB_RUNTIME_URL"]!, databaseName);
    const importUrl = databaseUrl(process.env["DB_IMPORT_URL"]!, databaseName);
    runMigrationUp(migrationUrl, "migrations");

    const tenantId = randomUUID();
    const providerAccountId = randomUUID();
    const offer = createOffer(
      "synthetic-provider-a",
      "synthetic-provider-a-gift-100",
      "synthetic-provider-a-synthetic-snapshot-v1",
      9_700n,
    );
    const migrator = new Client({ connectionString: migrationUrl });
    await migrator.connect();
    try {
      await migrator.query("INSERT INTO nukhabapay.tenants (id, tenant_key) VALUES ($1, $2)", [tenantId, "cli-tenant"]);
      await migrator.query(
        "INSERT INTO nukhabapay.provider_accounts (id, tenant_id, provider_code, external_account_key, status) VALUES ($1, $2, $3, $4, $5)",
        [providerAccountId, tenantId, "synthetic-provider-a", "cli-account", "ACTIVE"],
      );
      await seedApprovedMapping(migrator, tenantId, providerAccountId, offer);
    } finally {
      await migrator.end();
    }

    const workspaceRoot = path.resolve(packageRoot, "..", "..");
    const output = execFileSync(
      process.execPath,
      ["--experimental-strip-types", path.join(workspaceRoot, "scripts", "import-synthetic-catalog.ts")],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          DB_MIGRATION_URL: migrationUrl,
          DB_RUNTIME_URL: runtimeUrl,
          DB_IMPORT_URL: importUrl,
          NUKHBAPAY_TENANT_ID: tenantId,
          NUKHBAPAY_PROVIDER_ACCOUNT_ID: providerAccountId,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const result = JSON.parse(output.trim()) as {
      readonly status: "COMPLETE";
      readonly created: boolean;
      readonly counts: { readonly offers: number };
      readonly snapshotKey: string;
    };
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.created, true);
    assert.equal(result.counts.offers, 1);
    assert.equal(result.snapshotKey, offer.snapshotId);

    const reader = new Client({ connectionString: runtimeUrl });
    await reader.connect();
    try {
      const persisted = await reader.query(
        `SELECT s.status, COUNT(o.id)::int AS offers
         FROM nukhabapay.provider_snapshots s
         LEFT JOIN nukhabapay.provider_offers o
           ON o.tenant_id = s.tenant_id
          AND o.provider_account_id = s.provider_account_id
          AND o.provider_snapshot_id = s.id
         WHERE s.tenant_id = $1 AND s.provider_account_id = $2 AND s.snapshot_key = $3
         GROUP BY s.id`,
        [tenantId, providerAccountId, offer.snapshotId],
      );
      assert.equal(persisted.rows[0]?.status, "COMPLETE");
      assert.equal(Number(persisted.rows[0]?.offers), 1);
    } finally {
      await reader.end();
    }
  } finally {
    await dropDatabase(databaseName);
  }
});

test("a failure after writes rolls back only the failed import", { skip: !hasDatabaseConfig }, async () => {
  const databaseName = `nukhabapay_r_${randomUUID().replaceAll("-", "")}`;
  await createDatabase(databaseName);

  try {
    const migrationUrl = databaseUrl(process.env["DB_MIGRATION_URL"]!, databaseName);
    const importUrl = databaseUrl(process.env["DB_IMPORT_URL"]!, databaseName);
    const runtimeUrl = databaseUrl(process.env["DB_RUNTIME_URL"]!, databaseName);
    runMigrationUp(migrationUrl, "migrations");

    const client = new Client({ connectionString: migrationUrl });
    await client.connect();
    try {
      const tenantId = randomUUID();
      const providerAccountId = randomUUID();
      await client.query("INSERT INTO nukhabapay.tenants (id, tenant_key) VALUES ($1, $2)", [tenantId, "gamma"]);
      await client.query(
        "INSERT INTO nukhabapay.provider_accounts (id, tenant_id, provider_code, external_account_key, status) VALUES ($1, $2, $3, $4, $5)",
        [providerAccountId, tenantId, "synthetic-provider-b", "account-002", "ACTIVE"],
      );

      const baselineOffer = createOffer("synthetic-provider-b", "gift-300", "synthetic-accepted-v1", 9_600n);
      const firstFailedOffer = createOffer("synthetic-provider-b", "gift-rollback-first", "synthetic-failed-v1", 9_500n);
      const failingOffer = createOffer("synthetic-provider-b", "gift-rollback-fail", "synthetic-failed-v1", 9_400n);
      await seedApprovedMapping(client, tenantId, providerAccountId, baselineOffer);
      await seedApprovedMapping(client, tenantId, providerAccountId, firstFailedOffer);
      await seedApprovedMapping(client, tenantId, providerAccountId, failingOffer);
      await client.query(`
        CREATE FUNCTION nukhabapay.fail_test_offer_insert() RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          IF NEW.provider_offer_key = 'gift-rollback-fail' THEN
            RAISE EXCEPTION 'controlled integration failure' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END;
        $function$;
        CREATE TRIGGER fail_test_offer_insert
          BEFORE INSERT ON nukhabapay.provider_offers
          FOR EACH ROW EXECUTE FUNCTION nukhabapay.fail_test_offer_insert();
      `);

      const importPool = new Pool({ connectionString: importUrl, max: 5 });
      const reader = new Client({ connectionString: runtimeUrl });
      await reader.connect();
      const repository = new CatalogPostgresRepository(importPool);
      try {
        await repository.importSyntheticSnapshot(
          {
            tenantId,
            providerAccountId,
            snapshotKey: "synthetic-accepted-v1",
            sourceVersion: "v1",
            observedAt: "2026-11-09T09:00:00Z",
          },
          [baselineOffer],
        );

        const baselineBefore = await reader.query(
          `SELECT s.id, s.status, s.row_count, o.provider_debit_minor, o.provider_offer_key
           FROM nukhabapay.provider_snapshots s
           JOIN nukhabapay.provider_offers o
             ON o.tenant_id = s.tenant_id
            AND o.provider_account_id = s.provider_account_id
            AND o.provider_snapshot_id = s.id
           WHERE s.tenant_id = $1 AND s.provider_account_id = $2 AND s.snapshot_key = $3`,
          [tenantId, providerAccountId, "synthetic-accepted-v1"],
        );
        assert.equal(baselineBefore.rowCount, 1);
        assert.equal(baselineBefore.rows[0]?.provider_debit_minor, "9600");

        await assert.rejects(
          () => repository.importSyntheticSnapshot(
            {
              tenantId,
              providerAccountId,
              snapshotKey: "synthetic-failed-v1",
              sourceVersion: "v1",
              observedAt: "2026-11-09T09:00:00Z",
            },
            [firstFailedOffer, failingOffer],
          ),
          /controlled integration failure/,
        );

        const failedSnapshot = await reader.query(
          "SELECT COUNT(*)::int AS total FROM nukhabapay.provider_snapshots WHERE tenant_id = $1 AND provider_account_id = $2 AND snapshot_key = $3",
          [tenantId, providerAccountId, "synthetic-failed-v1"],
        );
        assert.equal(Number(failedSnapshot.rows[0]?.total), 0);
        const failedOffers = await reader.query(
          `SELECT COUNT(*)::int AS total
           FROM nukhabapay.provider_offers o
           JOIN nukhabapay.provider_snapshots s
             ON s.tenant_id = o.tenant_id
            AND s.provider_account_id = o.provider_account_id
            AND s.id = o.provider_snapshot_id
           WHERE s.tenant_id = $1 AND s.provider_account_id = $2 AND s.snapshot_key = $3`,
          [tenantId, providerAccountId, "synthetic-failed-v1"],
        );
        assert.equal(Number(failedOffers.rows[0]?.total), 0);
        const baselineAfter = await reader.query(
          `SELECT s.id, s.status, s.row_count, o.provider_debit_minor, o.provider_offer_key
           FROM nukhabapay.provider_snapshots s
           JOIN nukhabapay.provider_offers o
             ON o.tenant_id = s.tenant_id
            AND o.provider_account_id = s.provider_account_id
            AND o.provider_snapshot_id = s.id
           WHERE s.tenant_id = $1 AND s.provider_account_id = $2 AND s.snapshot_key = $3`,
          [tenantId, providerAccountId, "synthetic-accepted-v1"],
        );
        assert.deepEqual(baselineAfter.rows, baselineBefore.rows);
      } finally {
        await reader.end();
        await importPool.end();
      }
    } finally {
      await client.query("DROP TRIGGER IF EXISTS fail_test_offer_insert ON nukhabapay.provider_offers");
      await client.query("DROP FUNCTION IF EXISTS nukhabapay.fail_test_offer_insert()");
      await client.end();
    }
  } finally {
    await dropDatabase(databaseName);
  }
});

test("scheduled PostgreSQL import commits only under a current lease", { skip: !hasDatabaseConfig || !process.env["NUKHBA_DISPOSABLE_PG_DIRECTORY"] }, async () => {
  await withAdminClient(async client => {
    const { rows: [target] } = await client.query<{ path: string; port: number }>(
      "SELECT current_setting('data_directory') AS path, inet_server_port() AS port",
    );
    const normalizedPath = (value: string) => path.resolve(value).toLowerCase();
    assert.equal(normalizedPath(target!.path), normalizedPath(process.env["NUKHBA_DISPOSABLE_PG_DIRECTORY"]!));
    assert.ok(![5432, 55437].includes(target!.port));
  });
  const config = parseDatabaseConfig(process.env);
  const database = `nukhabapay_r_${randomUUID().replaceAll("-", "")}`;
  const tenant = randomUUID(), account = randomUUID(), schedule = randomUUID();
  await createDatabase(database);
  try {
    const ownerUrl = databaseUrl(config.migrationUrl, database);
    runMigrationUp(ownerUrl, "migrations");
    const owner = new Client({ connectionString: ownerUrl });
    const observer = new Client({ connectionString: databaseUrl(parseIntegrationAdminUrl(adminUrl).connectionString, database) });
    const pool = new Pool({ connectionString: databaseUrl(config.importUrl, database), max: 2 });
    try {
      await owner.connect();
      await observer.connect();
      for (const file of ["012_catalogue_refresh_R2_PROPOSAL.sql", "012_catalogue_refresh_write_fence_PROPOSAL.sql"]) {
        await owner.query(fs.readFileSync(path.join(packageRoot, "pending-migrations", file), "utf8"));
      }
      const role = quoteIdentifier(config.importRole);
      await owner.query(`GRANT SELECT ON nukhabapay.catalogue_refresh_schedules TO ${role};
        GRANT SELECT, INSERT, UPDATE ON nukhabapay.catalogue_refresh_jobs TO ${role};
        GRANT INSERT ON nukhabapay.catalogue_refresh_audit,nukhabapay.catalogue_refresh_write_evidence TO ${role};
        GRANT USAGE ON SEQUENCE nukhabapay.catalogue_refresh_audit_id_seq TO ${role};
        CREATE FUNCTION nukhabapay.fixture_delay_import() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.snapshot_key = 'scheduled-expired' THEN PERFORM pg_sleep(1.35); END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER fixture_delay_import BEFORE INSERT ON nukhabapay.provider_snapshots
        FOR EACH ROW EXECUTE FUNCTION nukhabapay.fixture_delay_import();`);
      await owner.query("INSERT INTO nukhabapay.tenants(id,tenant_key) VALUES($1,'scheduled-fixture')",[tenant]);
      await owner.query("INSERT INTO nukhabapay.provider_accounts(id,tenant_id,provider_code,external_account_key,status) VALUES($1,$2,'synthetic-fenced','fixture','ACTIVE')",[account,tenant]);
      await observer.query(`INSERT INTO nukhabapay.catalogue_refresh_schedules VALUES
        ($1,$2,$3,'v1','v1',true,floor(extract(epoch FROM clock_timestamp())*1000)::bigint-200,86400000)`,[schedule,tenant,account]);
      const offer = createOffer("synthetic-fenced","fenced-offer","scheduled-first",9_600n);
      await seedApprovedMapping(owner, tenant, account, offer);
      const store = createCatalogueRefreshStore(pool, [tenant]);
      const catalogue = new CatalogPostgresRepository(pool);
      const firstClaim = await store.claim(0, 12_000);
      assert.ok(firstClaim);
      const context = { tenantId:tenant, providerAccountId:account, snapshotKey:offer.snapshotId, sourceVersion:"v1", observedAt:offer.observedAt };
      assert.equal((await catalogue.importFencedSnapshot(context, [offer], firstClaim)).created, true);
      assert.equal((await catalogue.importFencedSnapshot(context, [offer], firstClaim)).created, false);
      await store.settle(firstClaim, { state:"SUCCEEDED", reason:"NONE", nextAttemptAtMs:null }, 0);

      await observer.query("UPDATE nukhabapay.catalogue_refresh_schedules SET version='v2' WHERE id=$1",[schedule]);
      const nextClaim = await store.claim(0, 1_200);
      assert.ok(nextClaim);
      const expired = { ...context, snapshotKey:"scheduled-expired" };
      await assert.rejects(catalogue.importFencedSnapshot(expired, [{ ...offer, snapshotId:expired.snapshotKey }], nextClaim), { code:"42501" });
      assert.equal(await catalogue.readSnapshot(tenant, account, expired.snapshotKey), null);
      assert.equal((await catalogue.readSnapshot(tenant, account, offer.snapshotId))?.offers.length, 1);
      assert.equal((await observer.query("SELECT count(*)::int AS count FROM nukhabapay.catalogue_refresh_write_evidence WHERE version='v2'")).rows[0].count, 0);
      await store.expire(0);
      assert.equal(await store.claim(0, 12_000), null);
    } finally { await Promise.all([owner.end(), observer.end(), pool.end()]); }
  } finally { await dropDatabase(database); }
});
