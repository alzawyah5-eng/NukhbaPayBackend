import type {
  ResolvedStaffMembership,
  ResolvedStaffPrincipal,
  StaffAuthorizationRepository,
  StaffGrantScope,
  StaffIdentityStatus,
  StaffMembershipStatus,
  StaffRoleGrant,
  StaffStatus,
} from "../../../application/src/identity/staff-access.js";
import type { SecurityAuditEvent, SecurityAuditWriter } from "../../../application/src/identity/security-audit.js";
import type { Pool, PoolClient, QueryResultRow } from "pg";

interface IdentityRow extends QueryResultRow {
  readonly staff_id: string;
  readonly staff_status: string;
  readonly identity_status: string;
  readonly authz_version: string;
  readonly tokens_valid_after: Date | string | null;
}

interface MembershipRow extends QueryResultRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly status: string;
  readonly version: string;
}

interface RoleGrantRow extends QueryResultRow {
  readonly role_code: string;
  readonly scope: string;
  readonly granted_at: Date | string;
  readonly expires_at: Date | string | null;
  readonly revoked_at: Date | string | null;
}

function assertStaffStatus(value: string): StaffStatus {
  if (value === "PENDING" || value === "ACTIVE" || value === "SUSPENDED" || value === "DISABLED") {
    return value;
  }
  throw new TypeError("Database returned an unknown staff status");
}

function assertIdentityStatus(value: string): StaffIdentityStatus {
  if (value === "ACTIVE" || value === "DISABLED") return value;
  throw new TypeError("Database returned an unknown identity status");
}

function assertMembershipStatus(value: string): StaffMembershipStatus {
  if (value === "ACTIVE" || value === "SUSPENDED" || value === "REVOKED") {
    return value;
  }
  throw new TypeError("Database returned an unknown membership status");
}

function assertGrantScope(value: string): StaffGrantScope {
  if (value === "PLATFORM" || value === "TENANT") return value;
  throw new TypeError("Database returned an unknown role-grant scope");
}

function toTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("Database returned an invalid role-grant timestamp");
  }
  return date.toISOString();
}

function toNullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : toTimestamp(value);
}

function mapGrant(row: RoleGrantRow): StaffRoleGrant {
  return {
    roleCode: row.role_code,
    scope: assertGrantScope(row.scope),
    grantedAt: toTimestamp(row.granted_at),
    expiresAt: toNullableTimestamp(row.expires_at),
    revokedAt: toNullableTimestamp(row.revoked_at),
  };
}

async function inTenantTransaction<Result>(
  pool: Pool,
  tenantId: string,
  work: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('nukhabapay.tenant_id', $1, true)",
        [tenantId],
      );
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error
          ? rollbackError
          : new Error("Identity transaction rollback failed");
        throw new AggregateError(
          [error, rollbackError],
          "Identity transaction failed and rollback could not complete",
        );
      }
      throw error;
    }
  } finally {
    client.release(releaseError);
  }
}

export class StaffIdentityPostgresRepository implements StaffAuthorizationRepository {
  constructor(private readonly readerPool: Pool) {}

  async findByTrustedIdentity(
    identity: { readonly issuer: string; readonly subject: string },
  ): Promise<ResolvedStaffPrincipal | null> {
    const result = await this.readerPool.query<IdentityRow>(
      `SELECT si.staff_id, si.status AS identity_status, su.status AS staff_status,
              su.authz_version::text AS authz_version, su.tokens_valid_after
       FROM nukhabapay.staff_identities AS si
       JOIN nukhabapay.staff_users AS su ON su.id = si.staff_id
       WHERE si.issuer = $1 AND si.subject = $2`,
      [identity.issuer, identity.subject],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) {
      throw new Error("Trusted identity uniqueness constraint was violated");
    }
    const row = result.rows[0];
    if (row === undefined) throw new Error("Trusted identity result row is missing");
    return {
      staffId: row.staff_id,
      staffStatus: assertStaffStatus(row.staff_status),
      identityStatus: assertIdentityStatus(row.identity_status),
      authzVersion: BigInt(row.authz_version),
      tokensValidAfter: toNullableTimestamp(row.tokens_valid_after),
    };
  }

  async findTenantMembership(
    staffId: string,
    tenantId: string,
  ): Promise<ResolvedStaffMembership | null> {
    return inTenantTransaction(this.readerPool, tenantId, async (client) => {
      const result = await client.query<MembershipRow>(
        `SELECT id, tenant_id, status, version::text AS version
         FROM nukhabapay.staff_memberships
         WHERE staff_id = $1 AND tenant_id = $2`,
        [staffId, tenantId],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) {
        throw new Error("Staff membership uniqueness constraint was violated");
      }
      const row = result.rows[0];
      if (row === undefined) throw new Error("Staff membership result row is missing");

      const grants = await client.query<RoleGrantRow>(
        `SELECT role_code, scope, granted_at, expires_at, revoked_at
         FROM nukhabapay.tenant_role_grants
         WHERE membership_id = $1 AND tenant_id = $2
         ORDER BY role_code`,
        [row.id, tenantId],
      );
      return {
        membershipId: row.id,
        tenantId: row.tenant_id,
        status: assertMembershipStatus(row.status),
        version: BigInt(row.version),
        roleGrants: grants.rows.map(mapGrant),
      };
    });
  }

  async findPlatformRoleGrants(staffId: string): Promise<readonly StaffRoleGrant[]> {
    const result = await this.readerPool.query<RoleGrantRow>(
      `SELECT role_code, scope, granted_at, expires_at, revoked_at
       FROM nukhabapay.platform_role_grants
       WHERE staff_id = $1
       ORDER BY role_code`,
      [staffId],
    );
    return result.rows.map(mapGrant);
  }
}

async function inWriterTransaction<Result>(
  pool: Pool,
  work: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error
          ? rollbackError
          : new Error("Audit transaction rollback failed");
        throw new AggregateError(
          [error, rollbackError],
          "Audit transaction failed and rollback could not complete",
        );
      }
      throw error;
    }
  } finally {
    client.release(releaseError);
  }
}

export class SecurityAuditPostgresRepository implements SecurityAuditWriter {
  constructor(private readonly writerPool: Pool) {}

  async appendSecurityAuditEvents(events: readonly SecurityAuditEvent[]): Promise<void> {
    if (events.length === 0 || events.length > 50) {
      throw new RangeError("A security audit batch must contain between 1 and 50 events");
    }

    await inWriterTransaction(this.writerPool, async (client) => {
      for (const event of events) {
        await client.query(
          "SELECT set_config('nukhabapay.tenant_id', $1, true)",
          [event.tenantId ?? ""],
        );
        await client.query(
          `INSERT INTO nukhabapay.security_audit_events
            (occurred_at, actor_staff_id, tenant_id, action, outcome,
             target_type, target_id, request_id, reason_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            event.occurredAt,
            event.actorStaffId,
            event.tenantId,
            event.action,
            event.outcome,
            event.targetType,
            event.targetId,
            event.requestId,
            event.reasonCode,
          ],
        );
      }
    });
  }
}
