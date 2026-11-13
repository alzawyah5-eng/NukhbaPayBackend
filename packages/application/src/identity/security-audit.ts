export type SecurityAuditAction =
  | "STAFF_IDENTITY_RESOLUTION"
  | "STAFF_MEMBERSHIP_RESOLUTION"
  | "AUTHORIZATION_DECISION"
  | "SECURITY_AUDIT_APPEND";
export type SecurityAuditOutcome = "SUCCESS" | "DENIED" | "FAILURE";
export type SecurityAuditTarget =
  | "STAFF_USER"
  | "STAFF_IDENTITY"
  | "STAFF_MEMBERSHIP"
  | "ROLE_GRANT"
  | "PERMISSION"
  | "AUTHORIZATION"
  | "SYSTEM";
export type SecurityAuditReason =
  | "NONE"
  | "IDENTITY_NOT_FOUND"
  | "STAFF_NOT_ACTIVE"
  | "MEMBERSHIP_NOT_ACTIVE"
  | "PERMISSION_UNKNOWN"
  | "PERMISSION_INACTIVE"
  | "SCOPE_MISMATCH"
  | "GRANT_INACTIVE"
  | "TENANT_MISMATCH"
  | "ROLE_CONFLICT"
  | "SELF_APPROVAL"
  | "MISSING_CONTEXT"
  | "DEPENDENCY_UNAVAILABLE";

export interface SecurityAuditEvent {
  readonly occurredAt: string;
  readonly actorStaffId: string | null;
  readonly tenantId: string | null;
  readonly action: SecurityAuditAction;
  readonly outcome: SecurityAuditOutcome;
  readonly targetType: SecurityAuditTarget;
  readonly targetId: string | null;
  readonly requestId: string | null;
  readonly reasonCode: SecurityAuditReason;
}

export interface SecurityAuditWriter {
  readonly appendSecurityAuditEvents: (
    events: readonly SecurityAuditEvent[],
  ) => Promise<void>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuidOrNull(value: string | null, label: string): void {
  if (value !== null && !uuidPattern.test(value)) {
    throw new TypeError(`${label} must be a UUID or null`);
  }
}

export async function recordSecurityAuditEvents(
  writer: SecurityAuditWriter,
  events: readonly SecurityAuditEvent[],
): Promise<void> {
  if (events.length === 0 || events.length > 50) {
    throw new RangeError("A security audit batch must contain between 1 and 50 events");
  }
  for (const event of events) {
    if (!Number.isFinite(Date.parse(event.occurredAt))) {
      throw new TypeError("Audit event time must be a valid timestamp");
    }
    assertUuidOrNull(event.actorStaffId, "Audit actor");
    assertUuidOrNull(event.tenantId, "Audit tenant");
    assertUuidOrNull(event.targetId, "Audit target");
    assertUuidOrNull(event.requestId, "Audit request");
  }
  await writer.appendSecurityAuditEvents(events);
}
