import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import {
  authorizeStaffAccess,
  resolveStaffTenantContext,
} from "../../application/src/identity/staff-access.js";
import type { SecurityAuditEvent } from "../../application/src/identity/security-audit.js";
import {
  SecurityAuditPostgresRepository,
  StaffIdentityPostgresRepository,
} from "../src/repositories/staff-identity-repository.js";
import {
  parseDatabaseConfig,
  parseIdentityDatabaseConfig,
  parseIntegrationAdminUrl,
} from "../src/config.js";

const packageRoot = fileURLToPath(new URL("../../..", import.meta.url));
const hasIdentityDatabaseConfig = Boolean(
  process.env["DB_MIGRATION_URL"] &&
  process.env["DB_RUNTIME_URL"] &&
  process.env["DB_IMPORT_URL"] &&
  process.env["DB_RUNTIME_ROLE"] &&
  process.env["DB_IMPORT_ROLE"] &&
  process.env["DB_IDENTITY_READER_URL"] &&
  process.env["DB_IDENTITY_WRITER_URL"] &&
  process.env["DB_TEST_ADMIN_URL"],
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

function runMigrationUp(databaseUrl: string): void {
  execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      getNodePgMigrateCli(),
      "up",
      "4",
      "--timestamp",
      "--database-url-var",
      "DB_MIGRATION_URL",
      "--migrations-dir",
      "migrations",
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
    ],
    {
      cwd: packageRoot,
      env: { ...process.env, DB_MIGRATION_URL: databaseUrl },
      stdio: "pipe",
    },
  );
}

async function withAdminClient<Result>(
  work: (client: Client) => Promise<Result>,
): Promise<Result> {
  const adminUrl = parseIntegrationAdminUrl(process.env["DB_TEST_ADMIN_URL"]).connectionString;
  const client = new Client({ connectionString: adminUrl });
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

async function createDatabase(databaseName: string): Promise<void> {
  const catalog = parseDatabaseConfig(process.env);
  const identity = parseIdentityDatabaseConfig(process.env);
  const migrationRole = quoteIdentifier(decodeURIComponent(new URL(catalog.migrationUrl).username));
  const roles = [
    migrationRole,
    quoteIdentifier(catalog.runtimeRole),
    quoteIdentifier(catalog.importRole),
    quoteIdentifier(identity.readerRole),
    quoteIdentifier(identity.writerRole),
  ];

  await withAdminClient(async (client) => {
    await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await client.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} OWNER TO ${migrationRole}`);
    await client.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(databaseName)} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${roles.join(", ")}`);
  });

  const adminUrl = parseIntegrationAdminUrl(process.env["DB_TEST_ADMIN_URL"]).connectionString;
  const client = new Client({ connectionString: databaseUrl(adminUrl, databaseName) });
  let failure: unknown;
  try {
    await client.connect();
    await client.query(`CREATE SCHEMA nukhabapay AUTHORIZATION ${migrationRole}`);
    await client.query(
      `GRANT USAGE ON SCHEMA nukhabapay TO ${roles.slice(1).join(", ")}`,
    );
  } catch (error) {
    failure = error;
  } finally {
    await client.end();
  }
  if (failure !== undefined) {
    await dropDatabase(databaseName);
    throw failure;
  }
}

async function dropDatabase(databaseName: string): Promise<void> {
  await withAdminClient(async (client) => {
    await client.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
  });
}

function buildAuditEvent(
  actorStaffId: string,
  tenantId: string,
  requestId: string,
): SecurityAuditEvent {
  return {
    occurredAt: "2026-01-02T03:04:05.000Z",
    actorStaffId,
    tenantId,
    action: "AUTHORIZATION_DECISION",
    outcome: "SUCCESS",
    targetType: "AUTHORIZATION",
    targetId: null,
    requestId,
    reasonCode: "NONE",
  };
}

test(
  "identity schema, scoped resolution, database roles, and audit rollback work on disposable PostgreSQL",
  { skip: !hasIdentityDatabaseConfig },
  async () => {
    const catalog = parseDatabaseConfig(process.env);
    const identity = parseIdentityDatabaseConfig(process.env);
    const expectedRoles = [
      decodeURIComponent(new URL(catalog.migrationUrl).username),
      catalog.runtimeRole,
      catalog.importRole,
      identity.readerRole,
      identity.writerRole,
    ];
    await withAdminClient(async (client) => {
      const roleRows = await client.query(
        `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                rolinherit, rolbypassrls
         FROM pg_catalog.pg_roles
         WHERE rolname = ANY($1::text[])`,
        [expectedRoles],
      );
      assert.equal(roleRows.rowCount, expectedRoles.length);
      assert.equal(new Set(roleRows.rows.map((row: { rolname: string }) => row.rolname)).size, expectedRoles.length);
      for (const role of roleRows.rows as Array<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolbypassrls: boolean;
      }>) {
        assert.equal(role.rolcanlogin, true);
        assert.equal(role.rolsuper, false);
        assert.equal(role.rolcreatedb, false);
        assert.equal(role.rolcreaterole, false);
        assert.equal(role.rolinherit, false);
        assert.equal(role.rolbypassrls, false);
      }
      const memberships = await client.query(
        `SELECT COUNT(*)::int AS total
         FROM pg_catalog.pg_auth_members AS membership
         JOIN pg_catalog.pg_roles AS role
           ON role.oid = membership.roleid OR role.oid = membership.member
         WHERE role.rolname = ANY($1::text[])`,
        [expectedRoles],
      );
      assert.equal(memberships.rows[0]?.total, 0);
    });
    const databaseName = `nukhabapay_iam_${randomUUID().replaceAll("-", "")}`;
    await createDatabase(databaseName);

    const migrationUrl = databaseUrl(catalog.migrationUrl, databaseName);
    const readerUrl = databaseUrl(identity.readerUrl, databaseName);
    const writerUrl = databaseUrl(identity.writerUrl, databaseName);
    const readerPool = new Pool({ connectionString: readerUrl, max: 1 });
    const writerPool = new Pool({ connectionString: writerUrl, max: 1 });
    const repository = new StaffIdentityPostgresRepository(readerPool);
    const auditRepository = new SecurityAuditPostgresRepository(writerPool);
    const adminUrl = parseIntegrationAdminUrl(process.env["DB_TEST_ADMIN_URL"]).connectionString;
    const fixtureDatabase = new Client({
      connectionString: databaseUrl(adminUrl, databaseName),
    });
    let fixtureConnected = false;

    try {
      await fixtureDatabase.connect();
      fixtureConnected = true;
      const preflight = new Client({connectionString:migrationUrl});
      try { await preflight.connect(); await preflight.query(fs.readFileSync(path.join(packageRoot,'pending-migrations/004_identity_default_acl_preflight.sql'),'utf8')); }
      finally { await preflight.end(); }
      runMigrationUp(migrationUrl);
      runMigrationUp(migrationUrl);
      const validity = new Client({connectionString:migrationUrl});
      try { await validity.connect(); await validity.query(fs.readFileSync(path.join(packageRoot,'roles/grant_identity_validity_reader.sql'),'utf8')); }
      finally { await validity.end(); }

      const iamTables = [
        "staff_users", "staff_identities", "staff_memberships", "iam_roles",
        "iam_permissions", "iam_role_permissions", "platform_role_grants",
        "tenant_role_grants", "security_audit_events",
      ];
      const rls = await fixtureDatabase.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE oid = ANY($1::regclass[]) ORDER BY relname`,
        [["nukhabapay.staff_memberships", "nukhabapay.tenant_role_grants", "nukhabapay.security_audit_events"]],
      );
      assert.equal(rls.rowCount, 3);
      for (const table of rls.rows) {
        assert.equal(table.relrowsecurity, true);
        assert.equal(table.relforcerowsecurity, true);
      }

      const readerColumns: Readonly<Record<string, readonly string[]>> = {
        staff_users: ["id", "status", "authz_version", "tokens_valid_after"],
        staff_identities: ["staff_id", "issuer", "subject", "status"],
        staff_memberships: ["id", "staff_id", "tenant_id", "status", "version"],
        platform_role_grants: ["staff_id", "role_code", "scope", "granted_at", "expires_at", "revoked_at"],
        tenant_role_grants: ["membership_id", "tenant_id", "role_code", "scope", "granted_at", "expires_at", "revoked_at"],
        security_audit_events: ["tenant_id", "request_id"],
      };
      for (const table of iamTables) {
        const columns = await fixtureDatabase.query(
          `SELECT attname,
                  has_column_privilege($1, attrelid, attname, 'SELECT') AS reader_select,
                  has_column_privilege($1, attrelid, attname, 'INSERT,UPDATE,REFERENCES') AS reader_write,
                  has_column_privilege($2, attrelid, attname, 'SELECT') AS writer_select,
                  has_column_privilege($2, attrelid, attname, 'INSERT') AS writer_insert,
                  has_column_privilege($2, attrelid, attname, 'UPDATE,REFERENCES') AS writer_change
           FROM pg_attribute WHERE attrelid = $3::regclass AND attnum > 0 AND NOT attisdropped`,
          [identity.readerRole, identity.writerRole, `nukhabapay.${table}`],
        );
        for (const column of columns.rows) {
          assert.equal(column.reader_select, readerColumns[table]?.includes(column.attname) ?? false);
          assert.equal(column.reader_write, false);
          assert.equal(column.writer_select, false);
          assert.equal(column.writer_insert, table === "security_audit_events");
          assert.equal(column.writer_change, false);
        }
        for (const role of [identity.readerRole, identity.writerRole]) {
          const privileges = await fixtureDatabase.query(
            "SELECT has_table_privilege($1, $2, 'DELETE,TRUNCATE,TRIGGER') AS extra",
            [role, `nukhabapay.${table}`],
          );
          assert.equal(privileges.rows[0]?.extra, false);
        }
      }
      for (const roleUrl of [catalog.runtimeUrl, catalog.importUrl]) {
        const catalogClient = new Client({ connectionString: databaseUrl(roleUrl, databaseName) });
        await catalogClient.connect();
        try {
          for (const table of iamTables) {
            // Empty reads still check privileges; no staff data enters test output.
            await assert.rejects(
              () => catalogClient.query(`SELECT * FROM nukhabapay.${table} WHERE false`),
              { code: "42501" },
            );
            const privileges = await catalogClient.query(
              "SELECT has_any_column_privilege(current_user, $1, 'SELECT') AS readable",
              [`nukhabapay.${table}`],
            );
            assert.equal(privileges.rows[0]?.readable, false, `${table} must have no catalog column reads`);
          }
          const catalogRead = await catalogClient.query("SELECT COUNT(*)::int AS total FROM nukhabapay.tenants");
          assert.equal(catalogRead.rows[0]?.total, 0);
        } finally {
          await catalogClient.end();
        }
      }

      // Creating as the actual migrator proves its defaults cannot leak future
      // IAM tables. Existing catalog grants are not default privileges.
      const migrationClient = new Client({ connectionString: migrationUrl });
      await migrationClient.connect();
      try {
        await migrationClient.query("CREATE TABLE nukhabapay.iam_default_grant_probe (id integer)");
        try {
          for (const role of [catalog.runtimeRole, catalog.importRole, identity.readerRole, identity.writerRole]) {
            const privileges = await migrationClient.query(
              `SELECT has_any_column_privilege($1, 'nukhabapay.iam_default_grant_probe', 'SELECT') AS readable,
                      has_table_privilege($1, 'nukhabapay.iam_default_grant_probe', 'INSERT,UPDATE,DELETE') AS writable`,
              [role],
            );
            assert.equal(privileges.rows[0]?.readable, false);
            assert.equal(privileges.rows[0]?.writable, false);
          }
        } finally {
          await migrationClient.query("DROP TABLE nukhabapay.iam_default_grant_probe");
        }
      } finally {
        await migrationClient.end();
      }

      const tenantA = randomUUID();
      const tenantB = randomUUID();
      const activeStaff = randomUUID();
      const platformOnlyStaff = randomUUID();
      const suspendedStaff = randomUUID();
      const disabledIdentityStaff = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();
      const platformMembershipA = randomUUID();
      const platformSuspendedMembership = randomUUID();
      const suspendedMembership = randomUUID();
      const baselineRequest = randomUUID();
      const otherTenantBaselineRequest = randomUUID();
      const failedRequest = randomUUID();
      const issuer = "https://synthetic.invalid/issuer";
      const now = new Date().toISOString();
      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      const oldGrantAt = "2024-01-01T00:00:00.000Z";

      await fixtureDatabase.query(
        "INSERT INTO nukhabapay.tenants (id, tenant_key) VALUES ($1, $2), ($3, $4)",
        [tenantA, `iam-a-${tenantA}`, tenantB, `iam-b-${tenantB}`],
      );
      await fixtureDatabase.query(
        `INSERT INTO nukhabapay.staff_users (id, display_name, contact_email, status)
         VALUES
           ($1, 'Active Staff', 'active@example.invalid', 'ACTIVE'),
           ($2, 'Platform Only', 'platform@example.invalid', 'ACTIVE'),
           ($3, 'Suspended Staff', 'suspended@example.invalid', 'SUSPENDED'),
           ($4, 'Disabled Identity', 'disabled@example.invalid', 'ACTIVE')`,
        [activeStaff, platformOnlyStaff, suspendedStaff, disabledIdentityStaff],
      );
      await fixtureDatabase.query(
        `INSERT INTO nukhabapay.staff_identities (id, staff_id, issuer, subject, status)
         VALUES
           ($1, $2, $3, $4, 'ACTIVE'),
           ($5, $6, $3, $7, 'ACTIVE'),
           ($8, $9, $3, $10, 'ACTIVE'),
           ($11, $12, $3, $13, 'DISABLED')`,
        [
          randomUUID(), activeStaff, issuer, "CaseSensitive-Subject",
          randomUUID(), platformOnlyStaff, "platform-subject",
          randomUUID(), suspendedStaff, "suspended-subject",
          randomUUID(), disabledIdentityStaff, "disabled-subject",
        ],
      );
      await fixtureDatabase.query(
        `INSERT INTO nukhabapay.staff_memberships (id, staff_id, tenant_id, status)
         VALUES
           ($1, $2, $3, 'ACTIVE'),
           ($4, $2, $5, 'ACTIVE'),
           ($6, $7, $3, 'ACTIVE'),
           ($8, $7, $5, 'SUSPENDED'),
           ($9, $10, $3, 'SUSPENDED')`,
        [
          membershipA, activeStaff, tenantA,
          membershipB, tenantB,
          platformMembershipA, platformOnlyStaff,
          platformSuspendedMembership, suspendedMembership, suspendedStaff,
        ],
      );
      await fixtureDatabase.query(
        `INSERT INTO nukhabapay.platform_role_grants
           (id, staff_id, role_code, granted_at, grant_source, evidence_reference)
         VALUES
           ($1, $2, 'SECURITY_ADMIN', $3, 'TEST', 'brick3a.platform'),
           ($4, $5, 'GOVERNANCE_OWNER', $3, 'TEST', 'brick3a.governance')`,
        [randomUUID(), activeStaff, oldGrantAt, randomUUID(), platformOnlyStaff],
      );
      await fixtureDatabase.query(
        `INSERT INTO nukhabapay.tenant_role_grants
           (id, membership_id, tenant_id, role_code, granted_at, expires_at,
            revoked_at, grant_source, evidence_reference)
         VALUES
           ($1, $2, $3, 'CATALOG_OPERATOR', $4, NULL, NULL, 'TEST', 'brick3a.operator'),
           ($5, $2, $3, 'SUPPORT_AGENT', $6, $7, NULL, 'TEST', 'brick3a.expired'),
           ($8, $2, $3, 'TENANT_AUDITOR', $6, NULL, $7, 'TEST', 'brick3a.revoked'),
           ($9, $10, $11, 'CATALOG_OPERATOR', $4, NULL, NULL, 'TEST', 'brick3a.conflict.op'),
           ($12, $10, $11, 'CATALOG_REVIEWER', $4, NULL, NULL, 'TEST', 'brick3a.conflict.review')`,
        [
          randomUUID(), membershipA, tenantA, oldGrantAt,
          randomUUID(), oldGrantAt, expiredAt,
          randomUUID(), randomUUID(), membershipB, tenantB,
          randomUUID(),
        ],
      );

      const roles = await fixtureDatabase.query(
        `SELECT
           (SELECT COUNT(*)::int FROM nukhabapay.iam_roles) AS roles,
           (SELECT COUNT(*)::int FROM nukhabapay.iam_permissions) AS permissions,
           (SELECT COUNT(*)::int FROM nukhabapay.iam_role_permissions) AS role_permissions,
           (SELECT COUNT(*)::int FROM nukhabapay.schema_migrations) AS migrations`,
      );
      assert.deepEqual(roles.rows[0], {
        roles: 12,
        permissions: 23,
        role_permissions: 32,
        migrations: 4,
      });

      const activePrincipal = await repository.findByTrustedIdentity({
        issuer,
        subject: "CaseSensitive-Subject",
      });
      assert.equal(activePrincipal?.staffId, activeStaff);
      assert.equal(
        await repository.findByTrustedIdentity({ issuer, subject: "casesensitive-subject" }),
        null,
      );
      assert.equal(
        await repository.findByTrustedIdentity({ issuer, subject: "not-enrolled" }),
        null,
      );
      assert.equal(
        (await repository.findByTrustedIdentity({ issuer, subject: "disabled-subject" }))
          ?.identityStatus,
        "DISABLED",
      );
      const disabledIdentityPrincipal = await repository.findByTrustedIdentity({
        issuer,
        subject: "disabled-subject",
      });
      assert.deepEqual(
        authorizeStaffAccess(
          {
            principal: disabledIdentityPrincipal,
            membership: null,
            platformRoleGrants: [],
          },
          {
            permissionCode: "staff.self.read",
            scope: "SELF",
            targetStaffId: disabledIdentityStaff,
            now,
          },
        ),
        { allowed: false, reason: "STAFF_NOT_ACTIVE" },
      );

      const activeContext = await resolveStaffTenantContext(
        repository,
        { issuer, subject: "CaseSensitive-Subject" },
        tenantA,
      );
      assert.equal(activeContext.membership?.membershipId, membershipA);
      assert.equal(activeContext.membership?.tenantId, tenantA);
      assert.equal(activeContext.membership?.roleGrants.length, 3);
      const mappedGrant = activeContext.membership?.roleGrants.find(
        (grant) => grant.roleCode === "CATALOG_OPERATOR",
      );
      assert.equal(mappedGrant?.grantedAt, new Date(oldGrantAt).toISOString());
      assert.equal(mappedGrant?.expiresAt, null);
      assert.equal(mappedGrant?.revokedAt, null);
      assert.equal(activeContext.platformRoleGrants[0]?.scope, "PLATFORM");

      const selfAccess = authorizeStaffAccess(
        {
          principal: activeContext.principal,
          membership: activeContext.membership,
          platformRoleGrants: activeContext.platformRoleGrants,
        },
        {
          permissionCode: "staff.self.read",
          scope: "SELF",
          targetStaffId: activeStaff,
          now,
        },
      );
      assert.deepEqual(selfAccess, { allowed: true, reason: "ALLOW" });

      const tenantMismatch = authorizeStaffAccess(
        {
          principal: activeContext.principal,
          membership: activeContext.membership,
          platformRoleGrants: activeContext.platformRoleGrants,
        },
        {
          permissionCode: "catalog.read",
          scope: "TENANT",
          tenantId: tenantA,
          objectTenantId: tenantB,
          now,
        },
      );
      assert.deepEqual(tenantMismatch, { allowed: false, reason: "TENANT_MISMATCH" });

      const platformOnlyContext = await resolveStaffTenantContext(
        repository,
        { issuer, subject: "platform-subject" },
        tenantA,
      );
      const platformCannotGrantTenantAccess = authorizeStaffAccess(
        {
          principal: platformOnlyContext.principal,
          membership: platformOnlyContext.membership,
          platformRoleGrants: platformOnlyContext.platformRoleGrants,
        },
        {
          permissionCode: "catalog.read",
          scope: "TENANT",
          tenantId: tenantA,
          objectTenantId: tenantA,
          now,
        },
      );
      assert.deepEqual(
        platformCannotGrantTenantAccess,
        { allowed: false, reason: "GRANT_INACTIVE" },
      );

      const expiredAccess = authorizeStaffAccess(
        {
          principal: activeContext.principal,
          membership: activeContext.membership,
          platformRoleGrants: activeContext.platformRoleGrants,
        },
        {
          permissionCode: "support.read_masked",
          scope: "TENANT",
          tenantId: tenantA,
          objectTenantId: tenantA,
          now,
        },
      );
      assert.deepEqual(expiredAccess, { allowed: false, reason: "GRANT_INACTIVE" });
      const revokedAccess = authorizeStaffAccess(
        {
          principal: activeContext.principal,
          membership: activeContext.membership,
          platformRoleGrants: activeContext.platformRoleGrants,
        },
        {
          permissionCode: "tenant.audit.read",
          scope: "TENANT",
          tenantId: tenantA,
          objectTenantId: tenantA,
          now,
        },
      );
      assert.deepEqual(revokedAccess, { allowed: false, reason: "GRANT_INACTIVE" });

      const conflictingContext = await resolveStaffTenantContext(
        repository,
        { issuer, subject: "CaseSensitive-Subject" },
        tenantB,
      );
      const conflictingAccess = authorizeStaffAccess(
        {
          principal: conflictingContext.principal,
          membership: conflictingContext.membership,
          platformRoleGrants: conflictingContext.platformRoleGrants,
        },
        {
          permissionCode: "catalog.read",
          scope: "TENANT",
          tenantId: tenantB,
          objectTenantId: tenantB,
          now,
        },
      );
      assert.deepEqual(conflictingAccess, { allowed: false, reason: "ROLE_CONFLICT" });

      const suspendedContext = await resolveStaffTenantContext(
        repository,
        { issuer, subject: "suspended-subject" },
        tenantA,
      );
      assert.equal(suspendedContext.principal?.staffStatus, "SUSPENDED");
      assert.equal(suspendedContext.membership, null);
      assert.deepEqual(
        authorizeStaffAccess(
          {
            principal: suspendedContext.principal,
            membership: suspendedContext.membership,
            platformRoleGrants: suspendedContext.platformRoleGrants,
          },
          {
            permissionCode: "staff.self.read",
            scope: "SELF",
            targetStaffId: suspendedStaff,
            now,
          },
        ),
        { allowed: false, reason: "STAFF_NOT_ACTIVE" },
      );

      const inactiveMembershipContext = await resolveStaffTenantContext(
        repository,
        { issuer, subject: "platform-subject" },
        tenantB,
      );
      assert.equal(inactiveMembershipContext.membership?.status, "SUSPENDED");
      assert.deepEqual(
        authorizeStaffAccess(
          {
            principal: inactiveMembershipContext.principal,
            membership: inactiveMembershipContext.membership,
            platformRoleGrants: inactiveMembershipContext.platformRoleGrants,
          },
          {
            permissionCode: "catalog.read",
            scope: "TENANT",
            tenantId: tenantB,
            objectTenantId: tenantB,
            now,
          },
        ),
        { allowed: false, reason: "MEMBERSHIP_NOT_ACTIVE" },
      );

      const readerClient = new Client({ connectionString: readerUrl });
      await readerClient.connect();
      try {
        assert.equal((await readerClient.query("SELECT current_user")).rows[0].current_user, identity.readerRole);
        const noContext = await readerClient.query(
          "SELECT tenant_id FROM nukhabapay.staff_memberships",
        );
        assert.equal(noContext.rowCount, 0);
        const noContextGrants = await readerClient.query(
          "SELECT tenant_id FROM nukhabapay.tenant_role_grants",
        );
        assert.equal(noContextGrants.rowCount, 0);

        await readerClient.query("BEGIN");
        await readerClient.query(
          "SELECT set_config('nukhabapay.tenant_id', $1, true)",
          [tenantA],
        );
        const scopedRows = await readerClient.query(
          "SELECT tenant_id FROM nukhabapay.staff_memberships",
        );
        assert.ok(scopedRows.rows.length > 0);
        assert.ok(scopedRows.rows.every((row: { tenant_id: string }) => row.tenant_id === tenantA));
        const scopedGrantRows = await readerClient.query(
          "SELECT tenant_id FROM nukhabapay.tenant_role_grants",
        );
        assert.ok(scopedGrantRows.rows.length > 0);
        assert.ok(scopedGrantRows.rows.every(
          (row: { tenant_id: string }) => row.tenant_id === tenantA,
        ));
        await readerClient.query("ROLLBACK");

        await assert.rejects(
          () => readerClient.query(
            `INSERT INTO nukhabapay.tenant_role_grants
               (id, membership_id, tenant_id, role_code, granted_at, grant_source, evidence_reference)
             VALUES ($1, $2, $3, 'TENANT_ADMIN', $4, 'TEST', 'brick3a.denied')`,
            [randomUUID(), membershipA, tenantA, oldGrantAt],
          ),
          /permission|read-only|denied/i,
        );
        await assert.rejects(
          () => readerClient.query(
            `INSERT INTO nukhabapay.platform_role_grants
               (id, staff_id, role_code, granted_at, grant_source, evidence_reference)
             VALUES ($1, $2, 'SECURITY_ADMIN', $3, 'TEST', 'brick3a.denied')`,
            [randomUUID(), activeStaff, oldGrantAt],
          ),
          /permission|read-only|denied/i,
        );
        await assert.rejects(
          () => readerClient.query(
            "UPDATE nukhabapay.iam_roles SET description = 'changed' WHERE code = 'TENANT_ADMIN'",
          ),
          /permission|read-only|denied/i,
        );
        await assert.rejects(
          () => readerClient.query("SELECT contact_email FROM nukhabapay.staff_users"),
          /permission|denied/i,
        );
        await assert.rejects(
          () => readerClient.query("SELECT code FROM nukhabapay.iam_permissions"),
          /permission|denied/i,
        );
        await assert.rejects(
          () => readerClient.query("DELETE FROM nukhabapay.security_audit_events"),
          /permission|read-only|denied/i,
        );
        await assert.rejects(
          () => readerClient.query(
            "UPDATE nukhabapay.security_audit_events SET outcome = 'DENIED'",
          ),
          /permission|read-only|denied/i,
        );
        await assert.rejects(
          () => readerClient.query("CREATE TABLE nukhabapay.reader_ddl_probe (id integer)"),
          /permission|read-only|denied/i,
        );
      } finally {
        await readerClient.end();
      }

      const pooledTenantContext = await readerPool.query<{ tenant_id: string | null }>(
        "SELECT current_setting('nukhabapay.tenant_id', true) AS tenant_id",
      );
      assert.ok(
        pooledTenantContext.rows[0]?.tenant_id === null ||
        pooledTenantContext.rows[0]?.tenant_id === "",
      );

      const invalidWrites = [
        () => fixtureDatabase.query(
          `INSERT INTO nukhabapay.staff_identities (id, staff_id, issuer, subject, status)
           VALUES ($1, $2, $3, $4, 'ACTIVE')`,
          [randomUUID(), platformOnlyStaff, issuer, "CaseSensitive-Subject"],
        ),
        () => fixtureDatabase.query(
          `INSERT INTO nukhabapay.tenant_role_grants
             (id, membership_id, tenant_id, role_code, granted_at, grant_source, evidence_reference)
           VALUES ($1, $2, $3, 'TENANT_ADMIN', $4, 'TEST', 'brick3a.cross-tenant')`,
          [randomUUID(), membershipA, tenantB, oldGrantAt],
        ),
        () => fixtureDatabase.query(
          `INSERT INTO nukhabapay.tenant_role_grants
             (id, membership_id, tenant_id, role_code, scope, granted_at, grant_source, evidence_reference)
           VALUES ($1, $2, $3, 'GOVERNANCE_OWNER', 'TENANT', $4, 'TEST', 'brick3a.role-scope')`,
          [randomUUID(), membershipA, tenantA, oldGrantAt],
        ),
        () => fixtureDatabase.query(
          `INSERT INTO nukhabapay.platform_role_grants
             (id, staff_id, role_code, granted_at, grant_source, evidence_reference)
           VALUES ($1, $2, 'TENANT_ADMIN', $3, 'TEST', 'brick3a.role-scope')`,
          [randomUUID(), activeStaff, oldGrantAt],
        ),
        () => fixtureDatabase.query(
          `INSERT INTO nukhabapay.iam_role_permissions (role_code, permission_code, scope)
           VALUES ('TENANT_ADMIN', 'platform.audit.read', 'PLATFORM')`,
        ),
      ];
      for (const invalidWrite of invalidWrites) {
        await assert.rejects(invalidWrite, /unique|duplicate|foreign key|violates|not valid/i);
      }

      const auditColumns = await fixtureDatabase.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'nukhabapay' AND table_name = 'security_audit_events'`,
      );
      const columnNames = auditColumns.rows.map((row: { column_name: string }) => row.column_name);
      assert.ok(!columnNames.some((name: string) => /secret|token|url|metadata|freeform/i.test(name)));

      await auditRepository.appendSecurityAuditEvents([
        buildAuditEvent(activeStaff, tenantA, baselineRequest),
        buildAuditEvent(activeStaff, tenantB, otherTenantBaselineRequest),
      ]);
      await assert.rejects(
        () => auditRepository.appendSecurityAuditEvents([
          buildAuditEvent(activeStaff, tenantA, failedRequest),
          buildAuditEvent(randomUUID(), tenantA, randomUUID()),
        ]),
        /foreign key|violates|not valid/i,
      );
      const persistedAudit = await fixtureDatabase.query(
        `SELECT request_id FROM nukhabapay.security_audit_events
         WHERE request_id = ANY($1::uuid[]) ORDER BY request_id`,
        [[baselineRequest, otherTenantBaselineRequest, failedRequest]],
      );
      assert.deepEqual(
        persistedAudit.rows.map((row: { request_id: string }) => row.request_id),
        [baselineRequest, otherTenantBaselineRequest].sort(),
      );

      await assert.rejects(
        () => fixtureDatabase.query(
          "UPDATE nukhabapay.security_audit_events SET outcome = 'DENIED' WHERE request_id = $1",
          [baselineRequest],
        ),
        /append-only/i,
      );
      await assert.rejects(
        () => fixtureDatabase.query(
          "DELETE FROM nukhabapay.security_audit_events WHERE request_id = $1",
          [baselineRequest],
        ),
        /append-only/i,
      );

      const writerClient = new Client({ connectionString: writerUrl });
      await writerClient.connect();
      try {
        assert.equal((await writerClient.query("SELECT current_user")).rows[0].current_user, identity.writerRole);
        await assert.rejects(
          () => writerClient.query("SELECT request_id FROM nukhabapay.security_audit_events"),
          /permission|denied/i,
        );
        await assert.rejects(
          () => writerClient.query(
            "UPDATE nukhabapay.iam_permissions SET description = 'changed' WHERE code = 'staff.self.read'",
          ),
          /permission|denied/i,
        );
        await assert.rejects(
          () => writerClient.query("DELETE FROM nukhabapay.security_audit_events"),
          /permission|denied/i,
        );
        await assert.rejects(
          () => writerClient.query(
            "UPDATE nukhabapay.security_audit_events SET outcome = 'DENIED'",
          ),
          /permission|denied/i,
        );
        await assert.rejects(
          () => writerClient.query(
            `INSERT INTO nukhabapay.tenant_role_grants
               (id, membership_id, tenant_id, role_code, granted_at, grant_source, evidence_reference)
             VALUES ($1, $2, $3, 'TENANT_ADMIN', $4, 'TEST', 'brick3a.denied')`,
            [randomUUID(), membershipA, tenantA, oldGrantAt],
          ),
          /permission|denied/i,
        );
        await assert.rejects(
          () => writerClient.query(
            `INSERT INTO nukhabapay.platform_role_grants
               (id, staff_id, role_code, granted_at, grant_source, evidence_reference)
             VALUES ($1, $2, 'SECURITY_ADMIN', $3, 'TEST', 'brick3a.denied')`,
            [randomUUID(), activeStaff, oldGrantAt],
          ),
          /permission|denied/i,
        );
        await assert.rejects(
          () => writerClient.query("CREATE TABLE nukhabapay.writer_ddl_probe (id integer)"),
          /permission|denied/i,
        );
      } finally {
        await writerClient.end();
      }

      const tenantAudit = await readerPool.connect();
      try {
        await tenantAudit.query("BEGIN");
        await tenantAudit.query(
          "SELECT set_config('nukhabapay.tenant_id', $1, true)",
          [tenantA],
        );
        const rows = await tenantAudit.query(
          "SELECT request_id FROM nukhabapay.security_audit_events",
        );
        assert.equal(rows.rowCount, 1);
        assert.equal(rows.rows[0]?.request_id, baselineRequest);
        await tenantAudit.query("ROLLBACK");
      } finally {
        tenantAudit.release();
      }

      for (const applicationUrl of [
        databaseUrl(catalog.runtimeUrl, databaseName),
        databaseUrl(catalog.importUrl, databaseName),
      ]) {
        const applicationClient = new Client({ connectionString: applicationUrl });
        await applicationClient.connect();
        try {
          await assert.rejects(
            () => applicationClient.query("UPDATE nukhabapay.security_audit_events SET outcome = 'DENIED'"),
            /permission|read-only|denied/i,
          );
          await assert.rejects(
            () => applicationClient.query("DELETE FROM nukhabapay.security_audit_events"),
            /permission|read-only|denied/i,
          );
        } finally {
          await applicationClient.end();
        }
      }
    } finally {
      if (fixtureConnected) await fixtureDatabase.end();
      await readerPool.end();
      await writerPool.end();
      await dropDatabase(databaseName);
    }
  },
);
