import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { DatabaseConfig, IdentityDatabaseConfig } from "./config.js";
import type { IdentityPoolSettings } from "./identity-runtime.config.js";

export function createRuntimePool(config: DatabaseConfig): Pool {
  const pool = new Pool({
    connectionString: config.runtimeUrl,
    application_name: "nukhbapay-api",
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    query_timeout: config.queryTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    idleTimeoutMillis: 10_000,
    options: "-c default_transaction_read_only=on -c idle_in_transaction_session_timeout=15000",
  });

  pool.on("error", (error: unknown) => {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "unknown";
    console.error("Idle PostgreSQL connection failed", { code });
  });
  return pool;
}

export function createImportPool(config: DatabaseConfig): Pool {
  const pool = new Pool({
    connectionString: config.importUrl,
    application_name: "nukhbapay-import",
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    query_timeout: config.queryTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    idleTimeoutMillis: 10_000,
    options: "-c default_transaction_read_only=off -c idle_in_transaction_session_timeout=15000",
  });

  pool.on("error", (error: unknown) => {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "unknown";
    console.error("Idle PostgreSQL import connection failed", { code });
  });
  return pool;
}

export function createIdentityReaderPool(
  config: IdentityPoolSettings,
  identityConfig: Pick<IdentityDatabaseConfig, "readerUrl">,
  onConnect?: PoolConfig['onConnect'],
): Pool {
  const pool = new Pool({
    ...(onConnect && {onConnect}),
    connectionString: identityConfig.readerUrl,
    application_name: "nukhbapay-identity-reader",
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    query_timeout: config.queryTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    idleTimeoutMillis: 10_000,
    options: "-c default_transaction_read_only=on -c idle_in_transaction_session_timeout=15000",
  });

  pool.on("error", () => {
    console.error("Idle PostgreSQL identity-reader connection unavailable");
  });
  return pool;
}

export function createIdentityWriterPool(
  config: IdentityPoolSettings,
  identityConfig: Pick<IdentityDatabaseConfig, "writerUrl">,
  onConnect?: PoolConfig['onConnect'],
): Pool {
  const pool = new Pool({
    ...(onConnect && {onConnect}),
    connectionString: identityConfig.writerUrl,
    application_name: "nukhbapay-identity-audit-writer",
    max: Math.min(config.poolMax, 2),
    connectionTimeoutMillis: config.connectionTimeoutMs,
    query_timeout: config.queryTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    idleTimeoutMillis: 10_000,
    options: "-c default_transaction_read_only=off -c idle_in_transaction_session_timeout=15000",
  });

  pool.on("error", () => {
    console.error("Idle PostgreSQL identity-writer connection unavailable");
  });
  return pool;
}

export async function inTransaction<Result>(
  client: PoolClient,
  work: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  await client.query("BEGIN");
  try {
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      const releaseError = rollbackError instanceof Error
        ? rollbackError
        : new Error("Transaction rollback failed");
      client.release(releaseError);
      throw new AggregateError([error, rollbackError], "Transaction failed and rollback could not complete");
    }
    throw error;
  }
}
