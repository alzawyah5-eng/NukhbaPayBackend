import { administrationUuid } from './access.js';
import type { TrustedStaffActorBoundary, StaffApprovalObservation } from '../identity/trusted-staff-actor.js';
import { isVerifiedStaffIdentity, type VerifiedStaffIdentity } from '../identity/verified-staff-identity.js';

const blocked = Object.freeze({
  execution: 'NOT_AUTHORIZED',
  acceptedApproval: false,
  assurance: 'not-established',
} as const);

/** Internal platform review boundary. The existing actor registry binds observations
 * to fresh canonical people and the current persisted request version/digest. */
export class PrivilegedStaffBoundary {
  constructor(private readonly actors: TrustedStaffActorBoundary) {}

  async inspect(
    requestId: string,
    reviewers: readonly VerifiedStaffIdentity[],
  ) {
    if (!administrationUuid.test(requestId) || reviewers.length < 1 || reviewers.length > 2 ||
        reviewers.some(identity => !isVerifiedStaffIdentity(identity))) {
      return Object.freeze({ ...blocked, outcome: 'DENIED' as const, observed: 0 });
    }

    const observations: StaffApprovalObservation[] = [];
    for (const identity of reviewers) {
      const actor = await this.actors.establish(identity);
      if (!actor.allowed) return Object.freeze({ ...blocked, outcome: 'DENIED' as const, observed: 0 });
      const inspection = await this.actors.inspectApproval(actor.actor, requestId, observations);
      if (inspection.reason !== 'ASSURANCE_AND_PERMISSION_BLOCKED' || !('observation' in inspection)) {
        return Object.freeze({ ...blocked, outcome: 'DENIED' as const, observed: 0 });
      }
      observations.push(inspection.observation as StaffApprovalObservation);
    }

    // Recheck earlier observations against the canonical request and freshly resolved reviewers.
    const first = observations[0]!;
    const verification = await this.actors.inspectApproval(first.actor, requestId, observations.slice(1));
    const finalObservation = 'observation' in verification
      ? verification.observation as StaffApprovalObservation
      : undefined;
    if (!finalObservation || finalObservation.requestDigest !== first.requestDigest ||
        finalObservation.requestVersion !== first.requestVersion) {
      return Object.freeze({ ...blocked, outcome: 'DENIED' as const, observed: 0 });
    }
    return Object.freeze({ ...blocked, outcome: 'OBSERVED' as const, observed: observations.length });
  }

  /** The operational assurance and atomic restricted executor remain unavailable. */
  execute(_command: unknown) {
    return Object.freeze({ ...blocked, outcome: 'DENIED' as const, observed: 0 });
  }
}
