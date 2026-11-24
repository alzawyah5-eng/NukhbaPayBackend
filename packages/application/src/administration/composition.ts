import { PrivilegedStaffBoundary } from './privileged-staff.js';
import { randomUUID } from 'node:crypto';
import { createAdministrationAuthority, freshAdministration, type AdministrationLease } from './access.js';
import { StaffManagementService, type StaffAdministrationReader } from './staff-management.js';
import { StaffCatalogueService } from '../catalog/staff-catalogue.js';
import type { SyntheticStaffRequestStore } from '../identity/durable-staff-request.js';
import { recordSecurityAuditEvents, type SecurityAuditWriter } from '../identity/security-audit.js';
import type { IsolatedStaffReadScope, StaffAuthorizationRepository } from '../identity/staff-access.js';
import { TrustedStaffActorBoundary, type ApprovalRequestSnapshot } from '../identity/trusted-staff-actor.js';

export interface AdministrationReaders {
  readonly staff?: StaffAdministrationReader;
  readonly catalogue?: ConstructorParameters<typeof StaffCatalogueService>[0]['read'];
  readonly requests?: { find(id: string, tenantId?: string): Promise<ApprovalRequestSnapshot | null> };
  readonly syntheticRequests?: SyntheticStaffRequestStore;
}

/** Internal composition shares the canonical IAM repository and committed audit writer. */
export function createStaffAdministration(deps: {
  readonly repository: StaffAuthorizationRepository;
  readonly auditWriter: SecurityAuditWriter;
  readonly readers: AdministrationReaders;
  readonly isolatedStaffReadScope?: IsolatedStaffReadScope;
  readonly isolatedWorkspaceTenant?: string;
  readonly now: () => Date;
}) {
  const { repository, auditWriter, readers, now } = deps;
  const authority = createAdministrationAuthority(repository, now);
  const actors = new TrustedStaffActorBoundary({
    repository, auditWriter, now,
    ...(readers.requests && { requests: readers.requests }),
    ...(readers.syntheticRequests && { syntheticRequests: readers.syntheticRequests }),
  });

  async function auditRead(lease: AdministrationLease): Promise<void> {
    await freshAdministration(lease);
    await recordSecurityAuditEvents(auditWriter, [{
      occurredAt: now().toISOString(),
      actorStaffId: lease.staffId,
      tenantId: lease.tenantId,
      action: 'AUTHORIZATION_DECISION',
      outcome: 'SUCCESS',
      targetType: 'AUTHORIZATION',
      targetId: null,
      requestId: randomUUID(),
      reasonCode: 'NONE',
    }]);
  }

  return Object.freeze({
    privilegedStaff: new PrivilegedStaffBoundary(actors),
    ...(readers.staff && {
      staffAdministration: new StaffManagementService({
        authority: deps.isolatedStaffReadScope || deps.isolatedWorkspaceTenant
          ? createAdministrationAuthority(repository, now, deps.isolatedStaffReadScope, deps.isolatedWorkspaceTenant) : authority,
        reader: readers.staff, actors, auditRead,
      }),
    }),
    ...(readers.catalogue && {
      staffCatalogue: new StaffCatalogueService({ authority, read: readers.catalogue, audit: auditRead, now }),
    }),
  });
}
