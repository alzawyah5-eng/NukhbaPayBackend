export {
  importSyntheticCatalogProvider,
  importSyntheticProviderSnapshot,
  readSyntheticProviderSnapshot,
} from "./catalog/synthetic-provider-import.js";
export type {
  SyntheticImportRequest,
  SyntheticImportResult,
} from "./catalog/synthetic-provider-import.js";
export { assertGeneratedDraftPublicationCandidate, classifyAdvisoryPublicationEvidence, generateDraftPublicationCandidate } from "./catalog/publication-candidate.js";
export type { AdvisoryPublicationEvidence, DraftPublicationCandidate, DraftPublicationRequest, PublicationSourceSnapshot } from "./catalog/publication-candidate.js";
export {
  authorizeStaffAccess,
  resolveStaffIdentity,
  resolveStaffPlatformContext,
  resolveStaffTenantContext,
  rolePermissionCodes,
} from "./identity/staff-access.js";
export type {
  ResolvedStaffMembership,
  ResolvedStaffPlatformContext,
  ResolvedStaffPrincipal,
  ResolvedStaffTenantContext,
  StaffAuthorizationContext,
  StaffAuthorizationDecision,
  StaffAuthorizationReason,
  StaffAuthorizationRepository,
  StaffAuthorizationRequest,
  StaffIdentityStatus,
  StaffMembershipStatus,
  StaffRoleGrant,
  StaffStatus,
  TrustedStaffIdentity,
} from "./identity/staff-access.js";
export {
  PERMISSION_CATALOG,
  ROLE_CATALOG,
} from "./identity/permission-catalog.js";
export type {
  ActivationPhase,
  AuthorizationScope,
  PermissionDefinition,
  RoleDefinition,
} from "./identity/permission-catalog.js";
export { recordSecurityAuditEvents } from "./identity/security-audit.js";
export { readAuthorizedStaffSelf, StaffAccessUnavailableError } from "./identity/read-authorized-staff-self.js";
export { planStaffLifecycle, proposeAccessRequestTransition, accessChangeRequestDigest } from "./identity/access-change-policy.js";
export { classifyLifecycleGrant, STAFF_LIFECYCLE_POLICY_VERSION, LIFECYCLE_EXECUTION_BLOCKERS } from "./identity/staff-lifecycle.js";
export type {
  StaffLifecycleOperation, AccessChangeRequest, AccessRequestState, AccessRequestEvent, ApprovalSlot,
  LifecycleScope, LifecycleGrant, LifecycleActor, LifecycleTarget, LifecycleApproval, LifecyclePolicyContext,
  LifecyclePolicyResult, LifecyclePolicyReason, PlanningBoundary,
} from "./identity/staff-lifecycle.js";
export type { RequestTransitionResult } from "./identity/access-change-policy.js";
export { prepareStaffCommand, describeStaffCommandBundle, staffReceiptLookup, resolveStaffReceipt, StaffCommandContractError } from "./identity/staff-command-contracts.js";
export type { StaffCommandCandidate, StaffCommandPreparation, StaffMutationIntent, StaffCommandAuditName, StaffCommandAuditIntent,
  StaffCommandReceipt, StaffCommandBundle, StaffReceiptLookup, StaffReceiptResolution } from "./identity/staff-command-contracts.js";
export type { StaffSimulationTransaction, StaffCommitAcknowledgement, StaffBoundaryLookup, StaffSimulationBoundary } from "./identity/staff-command-ports.js";
export type { InternalStaffRequest, StaffSelfResult } from "./identity/read-authorized-staff-self.js";
export type { AccessTokenVerifier, VerifiedStaffIdentity } from "./identity/verified-staff-identity.js";
export { TrustedStaffActorBoundary } from "./identity/trusted-staff-actor.js";
export type {StaffApprovalIntakeCommand,StaffApprovalIntakeResult,SyntheticStaffApprovalIntake,ApprovalIntakeBinding} from "./identity/staff-approval-intake.js";
export { consumeAuthorizedStaffWorkflowRead } from "./identity/trusted-staff-actor.js";
export type { StaffWorkflowReadInput,StaffWorkflowReadResult,StaffWorkflowReadCursor,StaffWorkflowView,StaffWorkflowQuery,WorkflowPosition,
  AuthorizedStaffWorkflowRead,SyntheticStaffWorkflowReads,StaffWorkflowPage,WorkflowReadData,StaffRequestDetail,StaffReviewSummary } from "./identity/staff-workflow-read.js";
export { SYNTHETIC_ASSURANCE_ISSUER, SYNTHETIC_ASSURANCE_AUDIENCE, SYNTHETIC_ASSURANCE_PROFILE } from "./identity/synthetic-assurance.js";
export type { SyntheticApprovalBinding, SyntheticAssuranceChallenge, SyntheticAssuranceVerifier, VerifiedSyntheticAssertion, VerifiedSyntheticApprovalProvenance } from "./identity/synthetic-assurance.js";
export { consumeAuthorizedStaffRequest } from "./identity/trusted-staff-actor.js";
export type { AuthorizedStaffRequest } from "./identity/trusted-staff-actor.js";
export { normalizeStaffRequestCommand, staffAuthorityDigest, canonicalDigest, staffRequestResult } from "./identity/durable-staff-request.js";
export type { StaffRequestCommand, StaffRequestResult, SyntheticStaffRequestStore } from "./identity/durable-staff-request.js";
export { consumeAuthorizedSyntheticReceiptQuery } from "./identity/trusted-staff-actor.js";
export type { AuthorizedSyntheticReceiptQuery } from "./identity/trusted-staff-actor.js";
export type { TrustedStaffActor, StaffApprovalObservation, ApprovalRequestSnapshot, SyntheticReceiptAcceptance, NonAuthorizedReceiptRow } from "./identity/trusted-staff-actor.js";
export { StaffSessionLifecycle, consumeStaffSessionTicket, STAFF_SESSION_COOKIE, STAFF_SESSION_ABSOLUTE_MS, STAFF_SESSION_IDLE_MS } from "./identity/staff-session.js";
export type { SessionBinding, StaffSessionTicket, StaffSessionStore, SessionStoreOutcome } from "./identity/staff-session.js";
export type {
  SecurityAuditAction,
  SecurityAuditEvent,
  SecurityAuditOutcome,
  SecurityAuditReason,
  SecurityAuditTarget,
  SecurityAuditWriter,
} from "./identity/security-audit.js";

export { prepareSyntheticPriceSubmission, consumeSubmissionEvidence, submissionDigest, SUBMISSION_CANONICALIZATION, PUBLICATION_PERMISSION_CONTRACTS } from "./catalog/submission-evidence.js";
export type { SubmissionEvidence } from "./catalog/submission-evidence.js";

export { prepareSyntheticPublicationCommand, consumePublicationCommand, independentlyVerifyPublicationPayload } from "./catalog/publication-workflow.js";
export type { PublicationAction, PublicationCommand, PublicationCommandTicket, SyntheticPublicationAuthority, SyntheticPublicationPermission } from "./catalog/publication-workflow.js";

export { PublishedCatalogueService, CatalogueAccessError, attestCatalogueClient, consumeCatalogueReadTicket, CATALOGUE_AUDIENCES, CATALOGUE_SCOPES } from "./catalog/published-catalogue.js";
export type { CatalogueClientKind, CatalogueClientIdentity, CatalogueClientBinding, CatalogueBindingRepository, CatalogueRow, CatalogueReadTicket, CatalogueReader, CatalogueReadAudit, CatalogueAuditWriter, PublicCatalogueProduct, PublishedCataloguePage } from "./catalog/published-catalogue.js";
