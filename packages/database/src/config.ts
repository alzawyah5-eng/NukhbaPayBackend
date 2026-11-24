export interface DatabaseConfig {
  readonly migrationUrl: string;
  readonly runtimeUrl: string;
  readonly importUrl: string;
  readonly runtimeRole: string;
  readonly importRole: string;
  readonly poolMax: number;
  readonly connectionTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export interface IntegrationAdminConfig {
  readonly connectionString: string;
  readonly username: string;
}

export interface IdentityDatabaseConfig {
  readonly readerUrl: string;
  readonly writerUrl: string;
  readonly readerRole: string;
  readonly writerRole: string;
}

interface LocalPostgresUrl {
  readonly original: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new TypeError("Database URL contains invalid percent encoding");
  }
}

function parseLocalUrl(value: string | undefined, name: string): LocalPostgresUrl {
  if (!value) throw new TypeError(`${name} is required`);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} must be a valid PostgreSQL URL`);
  }

  const host = url.hostname.toLowerCase();
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new TypeError(`${name} must use the postgres or postgresql protocol`);
  }
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
    throw new TypeError(`${name} must connect to a loopback host for this local foundation`);
  }
  if (url.search || url.hash || !url.password) {
    throw new TypeError(`${name} must include a password and must not include query parameters or a fragment`);
  }

  const username = decode(url.username);
  const database = decode(url.pathname.slice(1));
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(username)) {
    throw new TypeError(`${name} must use a simple PostgreSQL role name`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(database)) {
    throw new TypeError(`${name} must name a database`);
  }

  return { original: value, host, port: Number(url.port || 5432), database, username };
}

function parseBoundedInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${name} must be a canonical positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function parseIntegrationAdminUrl(value: string | undefined): IntegrationAdminConfig {
  const target = parseLocalUrl(value, "DB_TEST_ADMIN_URL");
  if (target.database !== "postgres") {
    throw new TypeError("DB_TEST_ADMIN_URL must connect to the local postgres maintenance database");
  }
  return Object.freeze({ connectionString: target.original, username: target.username });
}

export function parseDatabaseConfig(
  env: Readonly<Record<string, string | undefined>>,
): DatabaseConfig {
  const migration = parseLocalUrl(env["DB_MIGRATION_URL"], "DB_MIGRATION_URL");
  const runtime = parseLocalUrl(env["DB_RUNTIME_URL"], "DB_RUNTIME_URL");
  const importUrl = parseLocalUrl(env["DB_IMPORT_URL"] ?? env["DB_RUNTIME_URL"], "DB_IMPORT_URL");
  if (
    migration.host !== runtime.host ||
    migration.port !== runtime.port ||
    migration.database !== runtime.database ||
    migration.username === runtime.username
  ) {
    throw new TypeError("Migration and runtime URLs must target the same local database with distinct roles");
  }

  if (env["DB_IMPORT_URL"]) {
    if (
      migration.host !== importUrl.host ||
      migration.port !== importUrl.port ||
      migration.database !== importUrl.database ||
      runtime.username === importUrl.username ||
      migration.username === importUrl.username
    ) {
      throw new TypeError("Migration, runtime, and import URLs must target the same local database with distinct roles");
    }
  }

  const runtimeRole = env["DB_RUNTIME_ROLE"] ?? "nukhabapay_runtime";
  const importRole = env["DB_IMPORT_ROLE"] ?? (env["DB_IMPORT_URL"] ? "nukhabapay_importer" : runtimeRole);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(runtimeRole) || runtimeRole !== runtime.username) {
    throw new TypeError("DB_RUNTIME_ROLE must match the runtime URL role");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(importRole) || importRole !== importUrl.username) {
    throw new TypeError("DB_IMPORT_ROLE must match the import URL role");
  }

  const config = {
    migrationUrl: migration.original,
    runtimeUrl: runtime.original,
    importUrl: importUrl.original,
    runtimeRole,
    importRole,
    poolMax: parseBoundedInteger(env, "DB_POOL_MAX", 5, 1, 20),
    connectionTimeoutMs: parseBoundedInteger(env, "DB_CONNECTION_TIMEOUT_MS", 3_000, 100, 30_000),
    queryTimeoutMs: parseBoundedInteger(env, "DB_QUERY_TIMEOUT_MS", 10_000, 100, 30_000),
    statementTimeoutMs: parseBoundedInteger(env, "DB_STATEMENT_TIMEOUT_MS", 5_000, 100, 30_000),
  } satisfies DatabaseConfig;

  if (config.statementTimeoutMs >= config.queryTimeoutMs) {
    throw new RangeError("DB_STATEMENT_TIMEOUT_MS must be less than DB_QUERY_TIMEOUT_MS");
  }
  return Object.freeze(config);
}

export function parseIdentityDatabaseConfig(
  env: Readonly<Record<string, string | undefined>>,
): IdentityDatabaseConfig {
  const catalog = parseDatabaseConfig(env);
  const migration = parseLocalUrl(env["DB_MIGRATION_URL"], "DB_MIGRATION_URL");
  const reader = parseLocalUrl(env["DB_IDENTITY_READER_URL"], "DB_IDENTITY_READER_URL");
  const writer = parseLocalUrl(env["DB_IDENTITY_WRITER_URL"], "DB_IDENTITY_WRITER_URL");
  const readerRole = env["DB_IDENTITY_READER_ROLE"] ?? "nukhabapay_identity_reader";
  const writerRole = env["DB_IDENTITY_WRITER_ROLE"] ?? "nukhabapay_identity_writer";
  const roles = [
    migration.username,
    catalog.runtimeRole,
    catalog.importRole,
    readerRole,
    writerRole,
  ];

  if (
    reader.host !== migration.host ||
    reader.port !== migration.port ||
    reader.database !== migration.database ||
    writer.host !== migration.host ||
    writer.port !== migration.port ||
    writer.database !== migration.database
  ) {
    throw new TypeError("Identity roles must target the same local database as the catalog roles");
  }
  if (
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(readerRole) ||
    readerRole !== reader.username ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(writerRole) ||
    writerRole !== writer.username
  ) {
    throw new TypeError("Identity database role settings must match their connection URL roles");
  }
  if (new Set(roles).size !== roles.length) {
    throw new TypeError("Migration, runtime, import, identity reader, and identity writer roles must be distinct");
  }

  return Object.freeze({
    readerUrl: reader.original,
    writerUrl: writer.original,
    readerRole,
    writerRole,
  });
}
