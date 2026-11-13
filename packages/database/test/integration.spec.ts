import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { parseDatabaseConfig, parseIntegrationAdminUrl } from "../src/config.js";

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
    staged = fs.mkdtempSync(path.join(os.tmpdir(), "nukh-database-foundation-"));
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
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("nukh-database-foundation-"))
        throw new Error("Unsafe database migration staging cleanup path");
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

test("local PostgreSQL migration creates read-only runtime permissions and enforces tenant ownership", { skip: !hasDatabaseConfig }, async () => {
  const config = parseDatabaseConfig(process.env);
  const migrationRole = decodeURIComponent(new URL(config.migrationUrl).username);
  await withAdminClient(async (client) => {
    const roles = await client.query(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit
       FROM pg_roles
       WHERE rolname::text = ANY($1::text[])`,
      [[migrationRole, config.runtimeRole, config.importRole]],
    );
    assert.equal(roles.rowCount, 3);
    assert.equal(new Set(roles.rows.map((role: { rolname: string }) => role.rolname)).size, 3);
    for (const role of roles.rows as Array<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolinherit: boolean }>) {
      assert.equal(role.rolsuper, false);
      assert.equal(role.rolcreatedb, false);
      assert.equal(role.rolcreaterole, false);
      assert.equal(role.rolinherit, false);
    }
  });

  const databaseName = `nukhabapay_db_${randomUUID().replaceAll("-", "")}`;
  await createDatabase(databaseName);

  try {
    const migratorUrl = databaseUrl(process.env["DB_MIGRATION_URL"]!, databaseName);
    const runtimeUrl = databaseUrl(process.env["DB_RUNTIME_URL"]!, databaseName);

    runMigrationUp(migratorUrl, "migrations");

    const migrator = new Client({ connectionString: migratorUrl });
    const runtime = new Client({ connectionString: runtimeUrl });
    await migrator.connect();
    await runtime.connect();

    try {
      const tenantA = randomUUID();
      const tenantB = randomUUID();
      const providerAccountId = randomUUID();

      await migrator.query("INSERT INTO nukhabapay.tenants (id, tenant_key) VALUES ($1, $2), ($3, $4)", [tenantA, "alpha", tenantB, "beta"]);
      await migrator.query(
        "INSERT INTO nukhabapay.provider_accounts (id, tenant_id, provider_code, external_account_key, status) VALUES ($1, $2, $3, $4, $5)",
        [providerAccountId, tenantA, "provider_a", "account-001", "ACTIVE"],
      );

      await assert.rejects(
        () => migrator.query(
          "INSERT INTO nukhabapay.provider_snapshots (id, tenant_id, provider_account_id, snapshot_key, source_version, observed_at, status, started_at) VALUES ($1, $2, $3, $4, $5, NOW(), $6, NOW())",
          [randomUUID(), tenantB, providerAccountId, "snapshot-cross-tenant", "v1", "FAILED"],
        ),
        /foreign key|violates|not valid/i,
      );

      const selectCount = await runtime.query("SELECT COUNT(*)::int AS total FROM nukhabapay.tenants");
      assert.equal(selectCount.rows[0].total, 2);

      await assert.rejects(
        () => runtime.query("INSERT INTO nukhabapay.tenants (id, tenant_key) VALUES ($1, $2)", [randomUUID(), "runtime-insert"]),
        /permission|read-only|denied|not allowed/i,
      );
      await assert.rejects(
        () => runtime.query(
          "INSERT INTO nukhabapay.provider_accounts (id, tenant_id, provider_code, external_account_key, status) VALUES ($1, $2, $3, $4, $5)",
          [randomUUID(), tenantA, "provider_b", "not-allowed", "ACTIVE"],
        ),
        /permission|read-only|denied|not allowed/i,
      );
    } finally {
      await migrator.end();
      await runtime.end();
    }
  } finally {
    await dropDatabase(databaseName);
  }
});

test("local PostgreSQL migration is repeatable and failed migrations roll back cleanly", { skip: !hasDatabaseConfig }, async () => {
  const databaseName = `nukhabapay_db_${randomUUID().replaceAll("-", "")}`;
  await createDatabase(databaseName);

  try {
    const migrationUrl = databaseUrl(process.env["DB_MIGRATION_URL"]!, databaseName);

    runMigrationUp(migrationUrl, "migrations");
    const repeatable = new Client({ connectionString: migrationUrl });
    await repeatable.connect();
    try {
      const before = Number((await repeatable.query("SELECT COUNT(*)::int AS total FROM nukhabapay.schema_migrations")).rows[0].total);
      runMigrationUp(migrationUrl, "migrations");
      const after = Number((await repeatable.query("SELECT COUNT(*)::int AS total FROM nukhabapay.schema_migrations")).rows[0].total);
      assert.equal(after, before);
    } finally {
      await repeatable.end();
    }

    const failDbName = `nukhabapay_fail_${randomUUID().replaceAll("-", "")}`;
    await createDatabase(failDbName);
    const failUrl = databaseUrl(process.env["DB_MIGRATION_URL"]!, failDbName);

    try {
      assert.throws(() => runMigrationUp(failUrl, path.join("test", "fixtures")), /division by zero/i);
      const admin = new Client({
        connectionString: databaseUrl(parseIntegrationAdminUrl(adminUrl).connectionString, failDbName),
      });
      await admin.connect();
      try {
        const target = await admin.query("SELECT current_database() AS database");
        assert.equal(target.rows[0].database, failDbName);
        const result = await admin.query(`SELECT to_regclass('nukhabapay.rollback_probe') AS table_exists`);
        assert.equal(result.rows[0].table_exists, null);
        const history = await admin.query(
          "SELECT COUNT(*)::int AS total FROM nukhabapay.schema_migrations WHERE name = '999_failure'",
        );
        assert.equal(history.rows[0].total, 0);
      } finally {
        await admin.end();
      }
    } finally {
      await dropDatabase(failDbName);
    }
  } finally {
    await dropDatabase(databaseName);
  }
});
