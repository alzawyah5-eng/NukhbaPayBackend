import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { parseStaffSessionRuntimeConfiguration } from "../src/staff-session-runtime.config.js";

const connection = (database = "nukhabapay_dev", role = "nukhabapay_session_backend") => {
  const url = new URL("postgresql://127.0.0.1:5432");
  url.username = role;
  url.password = "synthetic-password-not-a-secret";
  url.pathname = "/" + database;
  return url.href;
};
const valid = (): Record<string, string> => ({
  NUKHBAPAY_STAFF_SESSION_MODE: "persistent-development",
  NUKHBAPAY_ENVIRONMENT: "development",
  NUKHBAPAY_ENV: "local",
  NODE_ENV: "development",
  DB_STAFF_SESSION_URL: connection(),
  DB_STAFF_SESSION_ROLE: "nukhabapay_session_backend",
  DB_STAFF_SESSION_EXPECTED_DATABASE_OID: "24576",
  DB_STAFF_SESSION_EXPECTED_SYSTEM_IDENTIFIER: "7000000000000000001",
  DB_STAFF_SESSION_POOL_MAX: "2",
  DB_STAFF_SESSION_CONNECTION_TIMEOUT_MS: "3000",
  DB_STAFF_SESSION_QUERY_TIMEOUT_MS: "6000",
  DB_STAFF_SESSION_STATEMENT_TIMEOUT_MS: "4000",
});

test("staff session runtime is disabled by default and rejects stray persistence settings", () => {
  assert.deepEqual(parseStaffSessionRuntimeConfiguration({}), { mode: "disabled" });
  assert.deepEqual(parseStaffSessionRuntimeConfiguration({ NUKHBAPAY_STAFF_SESSION_MODE: "disabled" }), { mode: "disabled" });
  assert.throws(() => parseStaffSessionRuntimeConfiguration({ DB_STAFF_SESSION_ROLE: "nukhabapay_session_backend" }), TypeError);
  assert.throws(() => parseStaffSessionRuntimeConfiguration({ NUKHBAPAY_STAFF_SESSION_MODE: "local-synthetic" }), TypeError);
});

test("persistent development session settings are exact, bounded and redacted", () => {
  const env = valid();
  const config = parseStaffSessionRuntimeConfiguration(env);
  assert.equal(config.mode, "persistent-development");
  if (config.mode !== "persistent-development") throw new Error("Persistent configuration missing");
  assert.equal(config.database, "nukhabapay_dev");
  assert.equal(config.role, "nukhabapay_session_backend");
  assert.equal(Object.keys(config).includes("connectionString"), false);
  assert.equal(JSON.stringify(config).includes(env["DB_STAFF_SESSION_URL"]!), false);
  assert.equal(inspect(config).includes("synthetic-password"), false);
});

test("persistent development session settings reject unsafe identity, target and credentials", () => {
  const cases: Record<string, string | undefined>[] = [
    { NUKHBAPAY_STAFF_SESSION_MODE: undefined },
    { NUKHBAPAY_ENVIRONMENT: "production" },
    { NODE_ENV: "production" },
    { DB_STAFF_SESSION_URL: undefined },
    { DB_STAFF_SESSION_URL: connection("other") },
    { DB_STAFF_SESSION_URL: connection("nukhabapay_b3b3_00000000000000000000000000000000") },
    { DB_STAFF_SESSION_URL: connection("nukhabapay_dev", "nukhabapay_migrator") },
    { DB_STAFF_SESSION_URL: "postgresql://nukhabapay_session_backend@127.0.0.1:5432/nukhabapay_dev" },
    { DB_STAFF_SESSION_URL: connection() + "?sslmode=disable" },
    { DB_STAFF_SESSION_ROLE: "nukh_session_00000000000000000000" },
    { DB_STAFF_SESSION_EXPECTED_DATABASE_OID: "0" },
    { DB_STAFF_SESSION_EXPECTED_SYSTEM_IDENTIFIER: "123" },
    { DB_STAFF_SESSION_POOL_MAX: "4" },
    { DB_STAFF_SESSION_CONNECTION_TIMEOUT_MS: "99" },
    { DB_STAFF_SESSION_QUERY_TIMEOUT_MS: "15001" },
    { DB_STAFF_SESSION_STATEMENT_TIMEOUT_MS: "6000" },
  ];
  for (const change of cases) assert.throws(() => parseStaffSessionRuntimeConfiguration({ ...valid(), ...change }), TypeError);
});
