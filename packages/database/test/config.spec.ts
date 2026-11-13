import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDatabaseConfig,
  parseIdentityDatabaseConfig,
  parseIntegrationAdminUrl,
} from "../src/config.js";

const urls = {
  DB_MIGRATION_URL: "postgresql://nukhabapay_migrator:migrator_password@127.0.0.1:5432/nukhabapay_dev",
  DB_RUNTIME_URL: "postgresql://nukhabapay_runtime:runtime_password@127.0.0.1:5432/nukhabapay_dev",
  DB_IMPORT_URL: "postgresql://nukhabapay_importer:importer_password@127.0.0.1:5432/nukhabapay_dev",
  DB_RUNTIME_ROLE: "nukhabapay_runtime",
  DB_IMPORT_ROLE: "nukhabapay_importer",
};

test("database settings keep local roles distinct and resource limits bounded", () => {
  assert.deepEqual(parseDatabaseConfig(urls), {
    migrationUrl: urls.DB_MIGRATION_URL,
    runtimeUrl: urls.DB_RUNTIME_URL,
    importUrl: urls.DB_IMPORT_URL,
    runtimeRole: "nukhabapay_runtime",
    importRole: "nukhabapay_importer",
    poolMax: 5,
    connectionTimeoutMs: 3_000,
    queryTimeoutMs: 10_000,
    statementTimeoutMs: 5_000,
  });

  const config = parseDatabaseConfig({
    ...urls,
    DB_MIGRATION_URL: urls.DB_MIGRATION_URL.replace("127.0.0.1", "[::1]"),
    DB_RUNTIME_URL: urls.DB_RUNTIME_URL.replace("127.0.0.1", "[::1]"),
    DB_IMPORT_URL: urls.DB_IMPORT_URL.replace("127.0.0.1", "[::1]"),
    DB_POOL_MAX: "12",
    DB_CONNECTION_TIMEOUT_MS: "500",
    DB_QUERY_TIMEOUT_MS: "2000",
    DB_STATEMENT_TIMEOUT_MS: "1000",
  });
  assert.equal(config.poolMax, 12);
  assert.equal(config.statementTimeoutMs, 1_000);
});

test("invalid hosts, credentials, roles, and timeouts fail closed", () => {
  for (const migrationUrl of [
    urls.DB_MIGRATION_URL.replace("127.0.0.1", "db.example.com"),
    urls.DB_MIGRATION_URL.replace("postgresql:", "http:"),
    urls.DB_MIGRATION_URL.replace("nukhabapay_migrator", ""),
    `${urls.DB_MIGRATION_URL}?sslmode=disable`,
    urls.DB_MIGRATION_URL.replace("nukhabapay_dev", "other_db"),
  ]) {
    assert.throws(() => parseDatabaseConfig({ ...urls, DB_MIGRATION_URL: migrationUrl }), TypeError);
  }

  assert.throws(() => parseDatabaseConfig({
    ...urls,
    DB_IMPORT_URL: urls.DB_RUNTIME_URL,
  }), /distinct roles/);
  assert.throws(() => parseDatabaseConfig({
    ...urls,
    DB_RUNTIME_URL: urls.DB_RUNTIME_URL.replace("nukhabapay_runtime", "nukhabapay_migrator"),
  }), /distinct roles/);
  assert.throws(() => parseDatabaseConfig({ ...urls, DB_RUNTIME_ROLE: "other_role" }), /must match/);
  assert.throws(() => parseDatabaseConfig({ ...urls, DB_POOL_MAX: "21" }), /between 1 and 20/);
  assert.throws(() => parseDatabaseConfig({ ...urls, DB_QUERY_TIMEOUT_MS: "5s" }), /canonical positive integer/);
  assert.throws(() => parseDatabaseConfig({
    ...urls,
    DB_QUERY_TIMEOUT_MS: "1000",
    DB_STATEMENT_TIMEOUT_MS: "1000",
  }), /must be less than/);
});

test("integration admin configuration is constrained to the local maintenance database", () => {
  const config = parseIntegrationAdminUrl(
    "postgresql://nukhabapay_dev:local%3Asecret@localhost:5432/postgres",
  );
  assert.equal(config.username, "nukhabapay_dev");

  for (const value of [
    undefined,
    "postgresql://admin:secret@remote.example/postgres",
    "postgresql://admin:secret@127.0.0.1/nukhabapay_dev",
    "postgresql://admin:secret@127.0.0.1/postgres?sslmode=disable",
  ]) {
    assert.throws(() => parseIntegrationAdminUrl(value), TypeError);
  }
});

test("identity database roles target the catalog database and remain distinct", () => {
  const readerUrl = new URL(urls.DB_RUNTIME_URL);
  readerUrl.username = "nukhabapay_identity_reader";
  const writerUrl = new URL(urls.DB_RUNTIME_URL);
  writerUrl.username = "nukhabapay_identity_writer";
  const identityEnv = {
    ...urls,
    DB_IDENTITY_READER_URL: readerUrl.toString(),
    DB_IDENTITY_WRITER_URL: writerUrl.toString(),
  };

  assert.deepEqual(parseIdentityDatabaseConfig(identityEnv), {
    readerUrl: readerUrl.toString(),
    writerUrl: writerUrl.toString(),
    readerRole: "nukhabapay_identity_reader",
    writerRole: "nukhabapay_identity_writer",
  });

  assert.throws(() => parseIdentityDatabaseConfig({
    ...identityEnv,
    DB_IDENTITY_WRITER_URL: readerUrl.toString(),
    DB_IDENTITY_WRITER_ROLE: "nukhabapay_identity_reader",
  }), /distinct/);
  assert.throws(() => parseIdentityDatabaseConfig({
    ...identityEnv,
    DB_IDENTITY_READER_URL: readerUrl.toString().replace("nukhabapay_dev", "other_db"),
  }), /same local database/);
  assert.throws(() => parseIdentityDatabaseConfig({
    ...identityEnv,
    DB_IDENTITY_WRITER_ROLE: "other_role",
  }), /match their connection URL roles/);
});
