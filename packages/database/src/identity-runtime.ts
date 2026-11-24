import type { Pool } from "pg";
import { parseIdentityRuntimeConfiguration } from "./identity-runtime.config.js";
import { createIdentityReaderPool, createIdentityWriterPool } from "./pool.js";
import { SecurityAuditPostgresRepository, StaffIdentityPostgresRepository } from "./repositories/staff-identity-repository.js";
import { verifyWindowsStaffConnection, windowsStaffDatabase, windowsStaffTarget, WindowsStaffTargetMismatch, type WindowsStaffTarget } from './windows-staff-target.js';
import type { IdentityRuntimeConfiguration } from './identity-runtime.config.js';

export { parseIdentityRuntimeConfiguration } from "./identity-runtime.config.js";
export type { IdentityRuntimeConfiguration, IdentityPoolSettings } from "./identity-runtime.config.js";

export class IdentityRuntimeUnavailableError extends Error {
  override readonly name = "IdentityRuntimeUnavailableError";
  constructor(
    readonly windowsLogin?: Readonly<{
      role: string;
      reason: "password rejected" | "authentication rejected" | "permission denied" |
        "connection unavailable" | "connection timed out" | "restricted role check failed" |
        "connection or restricted role check failed";
      failedChecks?: readonly string[];
    }>,
  ) {
    super("Restricted IAM runtime unavailable");
  }
}

async function verifyLogin(pool: Pool, expectedRole: string): Promise<void> {
  const result = await pool.query(
    `SELECT current_user AS name, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
            r.rolinherit, r.rolbypassrls,
            EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid OR roleid = r.oid) AS member,
            has_schema_privilege(current_user, 'nukhabapay', 'CREATE') AS ddl,
            d.datdba = r.oid AS database_owner
     FROM pg_roles r JOIN pg_database d ON d.datname = current_database()
     WHERE r.rolname = current_user`,
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (result.rowCount !== 1 || row?.["name"] !== expectedRole || row["rolcanlogin"] !== true ||
      ["rolsuper", "rolcreatedb", "rolcreaterole", "rolinherit", "rolbypassrls", "member", "ddl", "database_owner"]
        .some((flag) => row[flag] !== false)) throw new IdentityRuntimeUnavailableError();
}

/** Explicit initialization only; no migration, fixture, provisioning or API bootstrap. */
export async function createIdentityRuntime(env: Readonly<Record<string, string | undefined>>) {
  return openIdentityRuntime(parseIdentityRuntimeConfiguration(env));
}

export async function createWindowsStaffIdentityRuntime(env: Readonly<Record<string,string|undefined>>, target: WindowsStaffTarget) {
  const config = parseIdentityRuntimeConfiguration(env);
  if (config.host !== '127.0.0.1' || config.port !== 5432 || config.database !== windowsStaffDatabase) throw new IdentityRuntimeUnavailableError();
  return openIdentityRuntime(config,windowsStaffTarget(target.databaseOid,target.systemIdentifier));
}

async function openIdentityRuntime(config: IdentityRuntimeConfiguration, target?: WindowsStaffTarget) {
  const reader = createIdentityReaderPool(config, config, target && (client => verifyWindowsStaffConnection(client,target,config.readerRole)));
  const writer = createIdentityWriterPool(config, config, target && (client => verifyWindowsStaffConnection(client,target,config.writerRole)));
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= Promise.all([reader.end(), writer.end()]).then(() => undefined);
  let loginRole: IdentityRuntimeConfiguration["readerRole" | "writerRole"] = config.readerRole;
  try {
    await verifyLogin(reader, loginRole);
    loginRole = config.writerRole;
    await verifyLogin(writer, loginRole);
    const checkReadiness = async (): Promise<boolean> => {
      if (closing !== undefined) return false;
      try {
        await verifyLogin(reader, config.readerRole);
        await verifyLogin(writer, config.writerRole);
        // Parse/permission checks only: never return or inspect staff records.
        await reader.query(`SELECT u.id,u.status,u.authz_version,u.tokens_valid_after,i.staff_id,i.issuer,i.subject,i.status,
          m.id,m.staff_id,m.tenant_id,m.status,m.version,p.staff_id,p.role_code,p.scope,p.granted_at,p.expires_at,p.revoked_at,
          t.membership_id,t.tenant_id,t.role_code,t.scope,t.granted_at,t.expires_at,t.revoked_at
          FROM nukhabapay.staff_users u,nukhabapay.staff_identities i,nukhabapay.staff_memberships m,
          nukhabapay.platform_role_grants p,nukhabapay.tenant_role_grants t WHERE false`);
        const rights = await writer.query(`SELECT
          has_table_privilege(current_user,'nukhabapay.security_audit_events','INSERT') AS append,
          has_any_column_privilege(current_user,'nukhabapay.security_audit_events','SELECT') AS read,
          has_any_column_privilege(current_user,'nukhabapay.security_audit_events','UPDATE') AS update,
          has_table_privilege(current_user,'nukhabapay.security_audit_events','DELETE') AS delete,
          (SELECT count(*)=3 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class
            WHERE oid=ANY(ARRAY['nukhabapay.staff_memberships'::regclass,'nukhabapay.tenant_role_grants'::regclass,
              'nukhabapay.security_audit_events'::regclass])) AS rls`);
        const row = rights.rows[0];
        return closing === undefined && row?.append === true && row.read === false && row.update === false && row.delete === false && row.rls === true;
      } catch { return false; }
    };
    return Object.freeze({
      repository: new StaffIdentityPostgresRepository(reader),
      auditWriter: new SecurityAuditPostgresRepository(writer),
      close,
      checkReadiness,
    });
  } catch (error) {
    await close().catch(() => undefined);
    if (!target) throw new IdentityRuntimeUnavailableError();
    if (error instanceof WindowsStaffTargetMismatch) {
      throw new IdentityRuntimeUnavailableError({
        role: loginRole, reason: "restricted role check failed", failedChecks: error.failedChecks,
      });
    }
    if (error instanceof Error && [
      "Connection terminated due to connection timeout", "timeout exceeded when trying to connect",
    ].includes(error.message)) {
      throw new IdentityRuntimeUnavailableError({ role: loginRole, reason: "connection timed out" });
    }
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    let reason: NonNullable<IdentityRuntimeUnavailableError["windowsLogin"]>["reason"];
    switch (code) {
      case "28P01": reason = "password rejected"; break;
      case "28000": reason = "authentication rejected"; break;
      case "42501": reason = "permission denied"; break;
      case "ECONNREFUSED":
      case "ETIMEDOUT": reason = "connection unavailable"; break;
      default: reason = "connection or restricted role check failed";
    }
    throw new IdentityRuntimeUnavailableError({ role: loginRole, reason });
  }
}
