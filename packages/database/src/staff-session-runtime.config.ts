import { inspect } from "node:util";

type Environment = Readonly<Record<string, string | undefined>>;

export type StaffSessionRuntimeConfiguration =
  | Readonly<{ mode: "disabled" }>
  | Readonly<{
      mode: "persistent-development";
      host: "127.0.0.1";
      port: 5432;
      database: "nukhabapay_dev";
      role: "nukhabapay_session_backend";
      expectedDatabaseOid: string;
      expectedSystemIdentifier: string;
      poolMax: number;
      connectionTimeoutMs: number;
      queryTimeoutMs: number;
      statementTimeoutMs: number;
      connectionString: string;
    }>;

const persistentKeys = [
  "DB_STAFF_SESSION_URL",
  "DB_STAFF_SESSION_ROLE",
  "DB_STAFF_SESSION_EXPECTED_DATABASE_OID",
  "DB_STAFF_SESSION_EXPECTED_SYSTEM_IDENTIFIER",
  "DB_STAFF_SESSION_POOL_MAX",
  "DB_STAFF_SESSION_CONNECTION_TIMEOUT_MS",
  "DB_STAFF_SESSION_QUERY_TIMEOUT_MS",
  "DB_STAFF_SESSION_STATEMENT_TIMEOUT_MS",
] as const;

function invalid(field: string): never {
  throw new TypeError(`Invalid staff session runtime configuration: ${field}`);
}

function requiredInteger(env: Environment, field: string, minimum: number, maximum: number): number {
  const text = env[field];
  if (typeof text !== "string" || !/^(0|[1-9]\d*)$/.test(text)) return invalid(field);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid(field);
  return value;
}

export function parseStaffSessionRuntimeConfiguration(env: Environment): StaffSessionRuntimeConfiguration {
  const mode = env["NUKHBAPAY_STAFF_SESSION_MODE"];
  if (mode === undefined || mode === "disabled") {
    if (persistentKeys.some((key) => env[key] !== undefined)) return invalid("DISABLED_WITH_DATABASE_SETTINGS");
    return Object.freeze({ mode: "disabled" as const });
  }
  if (mode !== "persistent-development") return invalid("NUKHBAPAY_STAFF_SESSION_MODE");
  if (env["NUKHBAPAY_ENVIRONMENT"] !== "development" || env["NUKHBAPAY_ENV"] !== "local" ||
      env["NODE_ENV"] !== "development") {
    return invalid("NUKHBAPAY_ENVIRONMENT");
  }
  const role = env["DB_STAFF_SESSION_ROLE"];
  if (role !== "nukhabapay_session_backend") return invalid("DB_STAFF_SESSION_ROLE");
  const text = env["DB_STAFF_SESSION_URL"];
  if (typeof text !== "string" || text.length === 0 || text.length > 4096 || /\s/.test(text)) {
    return invalid("DB_STAFF_SESSION_URL");
  }
  let url: URL;
  let username: string;
  let password: string;
  let database: string;
  try {
    url = new URL(text);
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return invalid("DB_STAFF_SESSION_URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1" ||
      (url.port || "5432") !== "5432" || url.search || url.hash || username !== role ||
      database !== "nukhabapay_dev" || password.length < 16 || password.length > 1024) {
    return invalid("DB_STAFF_SESSION_URL");
  }
  const expectedDatabaseOid = env["DB_STAFF_SESSION_EXPECTED_DATABASE_OID"];
  const expectedSystemIdentifier = env["DB_STAFF_SESSION_EXPECTED_SYSTEM_IDENTIFIER"];
  if (typeof expectedDatabaseOid !== "string" || !/^[1-9]\d{0,9}$/.test(expectedDatabaseOid)) {
    return invalid("DB_STAFF_SESSION_EXPECTED_DATABASE_OID");
  }
  if (typeof expectedSystemIdentifier !== "string" || !/^[1-9]\d{15,19}$/.test(expectedSystemIdentifier)) {
    return invalid("DB_STAFF_SESSION_EXPECTED_SYSTEM_IDENTIFIER");
  }
  const settings = {
    mode: "persistent-development" as const,
    host: "127.0.0.1" as const,
    port: 5432 as const,
    database: "nukhabapay_dev" as const,
    role,
    expectedDatabaseOid,
    expectedSystemIdentifier,
    poolMax: requiredInteger(env, "DB_STAFF_SESSION_POOL_MAX", 1, 3),
    connectionTimeoutMs: requiredInteger(env, "DB_STAFF_SESSION_CONNECTION_TIMEOUT_MS", 100, 10_000),
    queryTimeoutMs: requiredInteger(env, "DB_STAFF_SESSION_QUERY_TIMEOUT_MS", 200, 15_000),
    statementTimeoutMs: requiredInteger(env, "DB_STAFF_SESSION_STATEMENT_TIMEOUT_MS", 100, 10_000),
  };
  if (settings.statementTimeoutMs >= settings.queryTimeoutMs) return invalid("DB_STAFF_SESSION_STATEMENT_TIMEOUT_MS");
  Object.defineProperties(settings, {
    connectionString: { value: text },
    [inspect.custom]: { value: () => ({ ...settings, connection: "[REDACTED]" }) },
  });
  return Object.freeze(settings) as StaffSessionRuntimeConfiguration;
}
