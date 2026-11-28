import { inspect } from "node:util";

export interface IdentityPoolSettings {
  readonly poolMax: number;
  readonly connectionTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export interface IdentityRuntimeConfiguration extends IdentityPoolSettings {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly readerRole: "nukhabapay_identity_reader";
  readonly writerRole: "nukhabapay_identity_writer";
  readonly readerUrl: string;
  readonly writerUrl: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

function invalid(field: string): never {
  throw new TypeError(`Invalid IAM runtime configuration: ${field}`);
}

function target(env: Environment, field: string, role: string, stagingHost?:string): { url: string; host: string; port: number; database: string } {
  const text = env[field];
  if (typeof text !== "string" || text.length === 0 || text.length > 4096 || /\s/.test(text)) return invalid(field);
  let url: URL;
  try { url = new URL(text); } catch { return invalid(field); }
  let username: string;
  let password: string;
  let database: string;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch { return invalid(field); }
  const host = url.hostname.toLowerCase();
  const port = url.port === "" ? 5432 : Number(url.port);
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !(stagingHost ? host===stagingHost && port===5432 && database==='nukhbapay_staff' :
        ["127.0.0.1", "localhost", "[::1]"].includes(host)) ||
      url.search || url.hash || username !== role || !password ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(database) ||
      ["postgres", "template0", "template1"].includes(database) ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    return invalid(field);
  }
  return { url: text, host, port, database };
}

function bounded(env: Environment, field: string, fallback: number, minimum: number, maximum: number): number {
  const text = env[field];
  if (text === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(text)) return invalid(field);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid(field);
  return value;
}

/** IAM-only local configuration. It never reads migration/import/runtime URLs. */
export function parseIdentityRuntimeConfiguration(env: Environment, stagingHost?:string): IdentityRuntimeConfiguration {
  const readerRole = "nukhabapay_identity_reader";
  const writerRole = "nukhabapay_identity_writer";
  if (env["DB_IDENTITY_READER_ROLE"] !== undefined && env["DB_IDENTITY_READER_ROLE"] !== readerRole) return invalid("DB_IDENTITY_READER_ROLE");
  if (env["DB_IDENTITY_WRITER_ROLE"] !== undefined && env["DB_IDENTITY_WRITER_ROLE"] !== writerRole) return invalid("DB_IDENTITY_WRITER_ROLE");
  const reader = target(env, "DB_IDENTITY_READER_URL", readerRole, stagingHost);
  const writer = target(env, "DB_IDENTITY_WRITER_URL", writerRole, stagingHost);
  if (reader.host !== writer.host || reader.port !== writer.port || reader.database !== writer.database) {
    return invalid("IAM_TARGET_MISMATCH");
  }
  const settings = {
    host: reader.host, port: reader.port, database: reader.database, readerRole, writerRole,
    poolMax: bounded(env, "DB_IDENTITY_POOL_MAX", 3, 1, 10),
    connectionTimeoutMs: bounded(env, "DB_IDENTITY_CONNECTION_TIMEOUT_MS", 3000, 100, 10_000),
    queryTimeoutMs: bounded(env, "DB_IDENTITY_QUERY_TIMEOUT_MS", 6000, 200, 15_000),
    statementTimeoutMs: bounded(env, "DB_IDENTITY_STATEMENT_TIMEOUT_MS", 4000, 100, 10_000),
  };
  if (settings.statementTimeoutMs >= settings.queryTimeoutMs) return invalid("DB_IDENTITY_STATEMENT_TIMEOUT_MS");
  // Do not expose connection strings through JSON serialization or ordinary inspection.
  Object.defineProperties(settings, {
    readerUrl: { value: reader.url }, writerUrl: { value: writer.url },
    [inspect.custom]: { value: () => ({ ...settings, connections: "[REDACTED]" }) },
  });
  return Object.freeze(settings) as IdentityRuntimeConfiguration;
}
