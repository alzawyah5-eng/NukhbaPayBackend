import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import test from "node:test";
import { parseIdentityRuntimeConfiguration } from "../src/identity-runtime.config.js";

function connection(role: string, host = "127.0.0.1", port = "", database = "nukhabapay_synthetic"): string {
  const url = new URL(`postgresql://${host}`);
  url.username = role; url.password = randomUUID(); url.pathname = `/${database}`; url.port = port;
  return url.href;
}

function settings(overrides: Readonly<Record<string, string | undefined>> = {}) {
  return {
    DB_IDENTITY_READER_URL: connection("nukhabapay_identity_reader"),
    DB_IDENTITY_WRITER_URL: connection("nukhabapay_identity_writer"),
    ...overrides,
  };
}

test("IAM runtime configuration needs only its restricted connections and hides secrets in inspection", () => {
  const env = settings();
  const config = parseIdentityRuntimeConfiguration(new Proxy(env, {
    get(target, property, receiver) {
      if (["DB_MIGRATION_URL", "DB_RUNTIME_URL", "DB_IMPORT_URL", "DB_TEST_ADMIN_URL"].includes(String(property))) {
        throw new Error("Unrelated credential was accessed");
      }
      return Reflect.get(target, property, receiver);
    },
  }));
  assert.equal(config.readerRole, "nukhabapay_identity_reader");
  assert.equal(config.writerRole, "nukhabapay_identity_writer");
  assert.equal(config.port, 5432);
  assert.equal(config.poolMax, 3);
  assert.equal(config.statementTimeoutMs, 4000);
  assert.ok(config.readerUrl === env.DB_IDENTITY_READER_URL);
  assert.ok(config.writerUrl === env.DB_IDENTITY_WRITER_URL);
  assert.ok(Object.isFrozen(config));
  for (const output of [JSON.stringify(config), inspect(config)]) {
    assert.ok(!output.includes(env.DB_IDENTITY_READER_URL));
    assert.ok(!output.includes(new URL(env.DB_IDENTITY_WRITER_URL).password));
    assert.ok(!output.includes("postgresql://"));
  }
});

test("IAM parser compares effective port, host and database exactly", () => {
  const env = settings({ DB_IDENTITY_WRITER_URL: connection("nukhabapay_identity_writer", "127.0.0.1", "5432") });
  assert.equal(parseIdentityRuntimeConfiguration(env).port, 5432);
  assert.equal(parseIdentityRuntimeConfiguration(settings({
    DB_IDENTITY_READER_URL: connection("nukhabapay_identity_reader", "[::1]", "5433"),
    DB_IDENTITY_WRITER_URL: connection("nukhabapay_identity_writer", "[::1]", "5433"),
  })).port, 5433);
  for (const overrides of [
    { DB_IDENTITY_WRITER_URL: connection("nukhabapay_identity_writer", "127.0.0.1", "5433") },
    { DB_IDENTITY_WRITER_URL: connection("nukhabapay_identity_writer", "localhost") },
    { DB_IDENTITY_WRITER_URL: connection("nukhabapay_identity_writer", "127.0.0.1", "", "other") },
  ]) assert.throws(() => parseIdentityRuntimeConfiguration(settings(overrides)), TypeError);
});

test("IAM runtime rejects missing values, privileged/wrong roles, unsafe URLs and raw error details", () => {
  for (const role of ["postgres", "nukhabapay_migrator", "nukhabapay_runtime", "nukhabapay_importer", "nukhabapay_identity_writer"]) {
    assert.throws(() => parseIdentityRuntimeConfiguration(settings({ DB_IDENTITY_READER_URL: connection(role) })), TypeError);
  }
  const env = settings();
  for (const overrides of [
    { DB_IDENTITY_READER_URL: undefined }, { DB_IDENTITY_WRITER_URL: undefined },
    { DB_IDENTITY_READER_ROLE: "postgres" }, { DB_IDENTITY_WRITER_ROLE: "nukhabapay_identity_reader" },
    { DB_IDENTITY_READER_URL: "not-a-url" },
    { DB_IDENTITY_READER_URL: connection("nukhabapay_identity_reader", "remote.invalid") },
    { DB_IDENTITY_READER_URL: env.DB_IDENTITY_READER_URL.replace("postgresql:", "http:") },
    { DB_IDENTITY_READER_URL: env.DB_IDENTITY_READER_URL + "?options=unsafe" },
    { DB_IDENTITY_READER_URL: env.DB_IDENTITY_READER_URL + "#fragment" },
    { DB_IDENTITY_READER_URL: connection("nukhabapay_identity_reader", "127.0.0.1", "", "postgres") },
  ]) assert.throws(() => parseIdentityRuntimeConfiguration(settings(overrides)), (error: unknown) =>
    error instanceof TypeError && error.message.startsWith("Invalid IAM runtime configuration:") &&
    !error.message.includes("postgresql:") && error.cause === undefined);
  const missingPassword = new URL(env.DB_IDENTITY_READER_URL); missingPassword.password = "";
  assert.throws(() => parseIdentityRuntimeConfiguration(settings({ DB_IDENTITY_READER_URL: missingPassword.href })), TypeError);
});

test("IAM pool limits and timeout ordering fail closed", () => {
  for (const overrides of [
    { DB_IDENTITY_POOL_MAX: "0" }, { DB_IDENTITY_POOL_MAX: "11" },
    { DB_IDENTITY_CONNECTION_TIMEOUT_MS: "10001" }, { DB_IDENTITY_CONNECTION_TIMEOUT_MS: "099" },
    { DB_IDENTITY_QUERY_TIMEOUT_MS: "199" }, { DB_IDENTITY_QUERY_TIMEOUT_MS: "15001" },
    { DB_IDENTITY_STATEMENT_TIMEOUT_MS: "10001" }, { DB_IDENTITY_STATEMENT_TIMEOUT_MS: "-1" },
    { DB_IDENTITY_QUERY_TIMEOUT_MS: "4000", DB_IDENTITY_STATEMENT_TIMEOUT_MS: "4000" },
  ]) assert.throws(() => parseIdentityRuntimeConfiguration(settings(overrides)), TypeError);
});
