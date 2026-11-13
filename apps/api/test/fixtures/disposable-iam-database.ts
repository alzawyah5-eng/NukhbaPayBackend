import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { parseDatabaseConfig, parseIdentityDatabaseConfig, parseIntegrationAdminUrl } from "@nukhbapay/database";

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) throw new Error("Unsafe disposable fixture identifier");
  return `"${value}"`;
}

export function forDatabase(base: string, database: string): string {
  const url = new URL(base); url.pathname = `/${database}`; return url.href;
}

export async function withDisposableIamDatabase(work: (fixture: {
  readonly databaseName: string;
  readonly fixtureClient: Client;
  readonly runtimeEnv: Readonly<Record<string, string>>;
  readonly runtimeUrl: string;
  readonly importUrl: string;
}) => Promise<void>, brick: "b3b2" | "b3b3" = "b3b2", migrationVersion: 0 | 4 | 5 = 4, unapprovedTarget = false): Promise<void> {
  if (brick !== "b3b2" && brick !== "b3b3") throw new Error("Unapproved disposable fixture prefix");
  if (![0,4,5].includes(migrationVersion) || typeof unapprovedTarget !== "boolean") throw new Error("Unapproved fixture migration boundary");
  const catalog = parseDatabaseConfig(process.env);
  const identity = parseIdentityDatabaseConfig(process.env);
  const adminConfig = parseIntegrationAdminUrl(process.env["DB_TEST_ADMIN_URL"]);
  const migrationRole = decodeURIComponent(new URL(catalog.migrationUrl).username);
  assert.equal(migrationRole, "nukhabapay_migrator");
  const roles = [migrationRole, catalog.runtimeRole, catalog.importRole, identity.readerRole, identity.writerRole];
  const databaseName = `nukhabapay_${unapprovedTarget ? "guard" : brick}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: adminConfig.connectionString, connectionTimeoutMillis: 3000 });
  const fixtureClient = new Client({ connectionString: forDatabase(adminConfig.connectionString, databaseName), connectionTimeoutMillis: 3000 });
  let created = false;
  await admin.connect();
  try {
    const target = (await admin.query("SELECT current_database() AS database, host(inet_server_addr()) AS host, inet_server_port() AS port, current_user AS role")).rows[0];
    assert.equal(target.database, "postgres");
    assert.ok(["127.0.0.1", "::1"].includes(target.host));
    assert.equal(target.port, Number(new URL(adminConfig.connectionString).port || 5432));
    assert.equal(target.role, adminConfig.username);
    const boundaries = await admin.query(
      `SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls,
              EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS membership
       FROM pg_roles r WHERE rolname=ANY($1::text[])`, [roles],
    );
    assert.equal(boundaries.rowCount, 5);
    for (const role of boundaries.rows) {
      assert.equal(role.rolcanlogin, true);
      for (const flag of ["rolsuper", "rolcreatedb", "rolcreaterole", "rolinherit", "rolbypassrls", "membership"]) assert.equal(role[flag], false);
    }
    await admin.query(`CREATE DATABASE ${identifier(databaseName)}`); created = true;
    console.info("Disposable IAM acceptance target:", databaseName);
    await admin.query(`ALTER DATABASE ${identifier(databaseName)} OWNER TO ${identifier(migrationRole)}`);
    await admin.query(`REVOKE ALL ON DATABASE ${identifier(databaseName)} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${identifier(databaseName)} TO ${roles.map(identifier).join(", ")}`);
    await fixtureClient.connect();
    assert.equal((await fixtureClient.query("SELECT current_database() AS database")).rows[0].database, databaseName);
    if(migrationVersion!==0) {
    await fixtureClient.query(`CREATE SCHEMA nukhabapay AUTHORIZATION ${identifier(migrationRole)}`);
    await fixtureClient.query(`GRANT USAGE ON SCHEMA nukhabapay TO ${roles.slice(1).map(identifier).join(", ")}`);
    const workspace = fileURLToPath(new URL("../../../../../", import.meta.url));
    const packageRoot = path.join(workspace, "packages", "database");
    // The deliberate wrong-name fixture exercises frozen 005's own refusal.
    // It receives historical 004 only, no activation safeguards/runtime ports.
    if(!unapprovedTarget) {
      const preflight = new Client({connectionString: forDatabase(catalog.migrationUrl,databaseName)});
      try { await preflight.connect(); await preflight.query(readFileSync(path.join(packageRoot,'pending-migrations/004_identity_default_acl_preflight.sql'),'utf8')); }
      finally { await preflight.end(); }
    }
    try {
      execFileSync(process.execPath, [
        "--experimental-strip-types", path.join(packageRoot, "node_modules/node-pg-migrate/bin/node-pg-migrate.js"),
        "up", String(migrationVersion), "--timestamp", "--database-url-var", "DB_MIGRATION_URL", "--migrations-dir", "migrations",
        "--schema", "nukhabapay", "--migrations-schema", "nukhabapay", "--migrations-table", "schema_migrations",
        "--single-transaction", "--check-order", "--migration-file-language", "ts", "--ignore-pattern", "README.md|.*\\.md",
      ], { cwd: packageRoot, env: { ...process.env, DB_MIGRATION_URL: forDatabase(catalog.migrationUrl, databaseName) }, stdio: "pipe" });
    } catch { throw new Error("Disposable IAM fixture migration failed"); }
    assert.equal((await fixtureClient.query("SELECT count(*)::int AS total FROM nukhabapay.schema_migrations")).rows[0].total, migrationVersion);
    if(migrationVersion===5) assert.equal((await fixtureClient.query("SELECT name FROM nukhabapay.schema_migrations ORDER BY id DESC LIMIT 1")).rows[0].name,"005_staff_workflow_persistence");
    if(!unapprovedTarget) {
      const validity = new Client({connectionString: forDatabase(catalog.migrationUrl,databaseName)});
      try { await validity.connect(); await validity.query(readFileSync(path.join(packageRoot,'roles/grant_identity_validity_reader.sql'),'utf8')); }
      finally { await validity.end(); }
    }
    }
    await work({
      databaseName, fixtureClient,
      runtimeEnv: Object.freeze({
        DB_IDENTITY_READER_URL: forDatabase(identity.readerUrl, databaseName),
        DB_IDENTITY_WRITER_URL: forDatabase(identity.writerUrl, databaseName),
        DB_IDENTITY_POOL_MAX: "1",
      }),
      runtimeUrl: forDatabase(catalog.runtimeUrl, databaseName), importUrl: forDatabase(catalog.importUrl, databaseName),
    });
  } finally {
    await fixtureClient.end();
    try {
      if (created) {
        assert.match(databaseName, /^nukhabapay_(b3b[23]|guard)_[0-9a-f]{32}$/);
        const owner = await admin.query("SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1", [databaseName]);
        assert.equal(owner.rows[0]?.owner, migrationRole);
        let sessions = await admin.query("SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname=$1", [databaseName]);
        // Client.end()/pg_restore exit may precede server-side Terminate handling.
        // Never kill a session or weaken the zero-connection requirement.
        const deadline=Date.now()+2000;
        while(sessions.rows[0].total!==0 && Date.now()<deadline) {
          await new Promise(resolve=>setTimeout(resolve,25));
          await admin.query('SELECT pg_stat_clear_snapshot()');
          sessions=await admin.query("SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname=$1",[databaseName]);
        }
        assert.equal(sessions.rows[0].total, 0);
        await admin.query(`DROP DATABASE ${identifier(databaseName)}`);
      }
    } finally { await admin.end(); }
  }
}
