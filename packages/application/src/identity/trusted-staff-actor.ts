import { createHash, randomUUID } from "node:crypto";
import { authorizeStaffAccess, resolveStaffPlatformContext, resolveStaffTenantContext, type StaffAuthorizationContext, type StaffAuthorizationRepository } from "./staff-access.js";
import { isVerifiedStaffIdentity, type VerifiedStaffIdentity } from "./verified-staff-identity.js";
import { recordSecurityAuditEvents, type SecurityAuditWriter } from "./security-audit.js";
import { STAFF_LIFECYCLE_POLICY_VERSION } from "./staff-lifecycle.js";
import { normalizeStaffRequestCommand, staffAuthorityDigest, staffRequestResult, canonicalDigest, type StaffRequestCommand, type StaffRequestResult, type SyntheticStaffRequestStore } from "./durable-staff-request.js";
import { SYNTHETIC_ASSURANCE_ISSUER, SYNTHETIC_ASSURANCE_PROFILE, type SyntheticAssuranceVerifier, type SyntheticAssuranceChallenge,
  type VerifiedSyntheticApprovalProvenance, type SyntheticApprovalBinding } from "./synthetic-assurance.js";
import { normalizeWorkflowRead, eligibleWorkflowRead, safeWorkflowPage, type StaffWorkflowReadInput, type StaffWorkflowReadResult,
  type StaffWorkflowReadCursor, type StaffWorkflowQuery, type WorkflowPosition, type AuthorizedStaffWorkflowRead, type SyntheticStaffWorkflowReads } from "./staff-workflow-read.js";
import {normalizeApprovalIntake,eligibleApprovalIntake,safeApprovalIntakeResult,failedApprovalIntake,type StaffApprovalIntakeCommand,
  type StaffApprovalIntakeResult,type SyntheticStaffApprovalIntake,type ApprovalIntakeBinding} from "./staff-approval-intake.js";

declare const actorBrand: unique symbol;
export interface TrustedStaffActor { readonly [actorBrand]: true }

declare const sessionActorBrand: unique symbol;
export interface VerifiedSessionActor {
  readonly [sessionActorBrand]: true;
  readonly staffId: string; readonly issuer: string; readonly subject: string;
  readonly tenantId: string | null; readonly authzVersion: string; readonly membershipVersion: string | null;
  readonly authorityDigest: string; readonly identityExpiresAtMs: number;
  revalidate(): Promise<boolean>;
}
const sessionActors = new WeakMap<object, TrustedStaffActor>();
/** Verification only: JSON, prototypes and copied evidence never become session actors. */
export function isVerifiedSessionActor(value: unknown, actor: TrustedStaffActor): value is VerifiedSessionActor {
  return typeof value === "object" && value !== null && sessionActors.get(value) === actor;
}
declare const observationBrand: unique symbol;
/** Authenticated identity observation only: NEVER an accepted approval or execution authority. */
export interface StaffApprovalObservation {
  readonly [observationBrand]: true;
  readonly actor: TrustedStaffActor;
  readonly staffId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly requestVersion: string;
  readonly policyVersion: typeof STAFF_LIFECYCLE_POLICY_VERSION;
  readonly observedAt: string;
  readonly assurance: "not-established";
  readonly execution: "NOT_AUTHORIZED";
  readonly acceptedApproval: false;
  readonly requiredEvidence: readonly ["FRESH_STRONG_MFA", "ACTIVE_APPROVAL_PERMISSION", "DURABLE_APPROVAL_BINDING"];
}
export interface ApprovalRequestSnapshot {
  readonly id: string;
  readonly digest: string;
  readonly version: string;
  readonly policyVersion: string;
  readonly requesterStaffId: string;
  readonly beneficiaryStaffId: string;
  readonly tenantId: string | null;
  readonly expiresAt: string;
  readonly permission: "platform.access.approve" | "platform.access.approve_privileged";
}
export interface NonAuthorizedReceiptRow {
  readonly operationId: string; readonly actorStaffId: string; readonly tenantId: string;
  readonly key: string; readonly digest: string;
  readonly outcome: "SIMULATION_RECORDED"; readonly execution: "NOT_AUTHORIZED";
}
declare const receiptQueryBrand: unique symbol;
export interface AuthorizedSyntheticReceiptQuery {
  readonly [receiptQueryBrand]: true;
  readonly actorStaffId: string; readonly tenantId: string; readonly key: string;
  readonly operationId?: string; readonly expectedDigest: string;
}
const receiptQueries = new WeakSet<object>();
declare const requestTicketBrand: unique symbol;
export interface AuthorizedStaffRequest {
  readonly [requestTicketBrand]: true; readonly staffId: string; readonly issuer: string; readonly subject: string;
  readonly tenantId: string | null; readonly authorityDigest: string; readonly command: StaffRequestCommand;
  readonly nowMs: number; readonly validUntilMs: number;
  readonly syntheticProvenance?: VerifiedSyntheticApprovalProvenance;
  readonly approvalIntake?:ApprovalIntakeBinding;
  readonly executionRehearsal?: true;
  revalidate(expiresAtMs?: number): Promise<boolean>;
}
const staffRequests = new WeakSet<object>();
const workflowReads = new WeakSet<object>();
export function consumeAuthorizedStaffWorkflowRead(value:unknown):value is AuthorizedStaffWorkflowRead {
  if(typeof value!=="object" || value===null || !workflowReads.has(value))return false;
  workflowReads.delete(value);return true;
}
export function consumeAuthorizedStaffRequest(value: unknown): value is AuthorizedStaffRequest {
  if(typeof value!=="object" || value===null || !staffRequests.has(value)) return false;
  staffRequests.delete(value); return true;
}
/** Adapter validation only. No public attester; a query is valid for one in-flight use. */
export function consumeAuthorizedSyntheticReceiptQuery(value: unknown): value is AuthorizedSyntheticReceiptQuery {
  if (typeof value !== "object" || value === null || !receiptQueries.has(value)) return false;
  receiptQueries.delete(value); return true;
}
/** Trusted DI port for local synthetic acceptance only. Not a permission-catalog override. */
export interface SyntheticReceiptAcceptance {
  readonly capability: "NON_AUTHORIZED_RECEIPT_RECONCILE";
  allows(context: StaffAuthorizationContext): Promise<boolean>;
  lookup(binding: AuthorizedSyntheticReceiptQuery): Promise<NonAuthorizedReceiptRow | null | "UNRESOLVED">;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const denied = (reason: string) => Object.freeze({ allowed: false as const, reason, execution: "NOT_AUTHORIZED" as const });
const stamp = (context: StaffAuthorizationContext) => createHash("sha256").update(JSON.stringify(context, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value)).digest("hex");
class ActorRejected extends Error { constructor(readonly reason: string) { super("Staff actor rejected"); } }

/** Internal, instance-bound actor registry; no raw-header, JSON, UUID or enrollment entry point. */
export class TrustedStaffActorBoundary {
  readonly #actors = new WeakMap<object, { identity: VerifiedStaffIdentity; tenantId?: string; stamp: string }>();
  readonly #observations = new WeakSet<object>();
  readonly #challenges = new WeakMap<object, { actor: TrustedStaffActor; used: boolean }>();
  readonly #proofs = new WeakMap<object, { actor: TrustedStaffActor; key?: string }>();
  readonly #authenticationEvents = new Map<string, number>();
  readonly #workflowCursors = new WeakMap<object,{actor:TrustedStaffActor;query:string;position:WorkflowPosition;expiresAtMs:number}>();
  constructor(private readonly dependencies: {
    repository: StaffAuthorizationRepository; auditWriter: SecurityAuditWriter; now: () => Date;
    /** Reviewed BFF issuer allowlist, trusted composition only. Default remains synthetic-only. */
    sessionIssuers?: readonly string[];
    requests?: { find(id: string, tenantId?: string): Promise<ApprovalRequestSnapshot | null> };
    syntheticReceipts?: SyntheticReceiptAcceptance;
    syntheticRequests?: SyntheticStaffRequestStore;
    syntheticAssuranceVerifier?: SyntheticAssuranceVerifier;
    syntheticWorkflowReads?: SyntheticStaffWorkflowReads;
    syntheticApprovalIntake?:SyntheticStaffApprovalIntake;
    syntheticExecution?: { capability: "STAFF_EXECUTION_REHEARSAL_ONLY"; execute: (ticket:AuthorizedStaffRequest)=>Promise<StaffRequestResult> };
  }) {}

  async #resolve(identity: VerifiedStaffIdentity, tenantId?: string): Promise<StaffAuthorizationContext> {
    const now = this.dependencies.now().getTime();
    if (!isVerifiedStaffIdentity(identity) || !Number.isFinite(now) || identity.security.expiresAt * 1000 <= now ||
        identity.security.issuedAt * 1000 > now || identity.security.assurance !== "not-established" ||
        (tenantId !== undefined && !uuid.test(tenantId))) throw new ActorRejected("INVALID_IDENTITY");
    const context = tenantId === undefined
      ? { ...await resolveStaffPlatformContext(this.dependencies.repository, identity), membership: null }
      : await resolveStaffTenantContext(this.dependencies.repository, identity, tenantId);
    const resolvedAt = this.dependencies.now().getTime();
    if (!Number.isFinite(resolvedAt) || resolvedAt < now || resolvedAt >= identity.security.expiresAt * 1000) {
      throw new ActorRejected("INVALID_IDENTITY");
    }
    if (!context.principal || context.principal.staffStatus !== "ACTIVE" || context.principal.identityStatus !== "ACTIVE") throw new ActorRejected("STAFF_NOT_ACTIVE");
    if (tenantId !== undefined && (!context.membership || context.membership.status !== "ACTIVE" || context.membership.tenantId !== tenantId)) throw new ActorRejected("MEMBERSHIP_NOT_ACTIVE");
    return context;
  }
  async #fresh(actor: TrustedStaffActor) {
    const binding = typeof actor === "object" && actor !== null ? this.#actors.get(actor) : undefined;
    if (!binding) throw new ActorRejected("UNTRUSTED_ACTOR");
    const context = await this.#resolve(binding.identity, binding.tenantId);
    if (stamp(context) !== binding.stamp) throw new ActorRejected("STALE_AUTHORITY");
    return { context, binding };
  }
  async #audit(context: StaffAuthorizationContext, success: boolean, targetId: string | null = null) {
    await recordSecurityAuditEvents(this.dependencies.auditWriter, [{ occurredAt: this.dependencies.now().toISOString(),
      actorStaffId: context.principal!.staffId, tenantId: context.membership?.tenantId ?? null,
      action: "AUTHORIZATION_DECISION", outcome: success ? "SUCCESS" : "DENIED", targetType: "AUTHORIZATION",
      targetId, requestId: randomUUID(), reasonCode: success ? "NONE" : "PERMISSION_INACTIVE" }]);
  }
  async establish(identity: VerifiedStaffIdentity, tenantId?: string) {
    try {
      const context = await this.#resolve(identity, tenantId);
      const actor = Object.freeze({}) as TrustedStaffActor;
      this.#actors.set(actor, { identity, ...(tenantId === undefined ? {} : { tenantId }), stamp: stamp(context) });
      return Object.freeze({ allowed: true as const, actor, execution: "NOT_AUTHORIZED" as const });
    } catch (error) {
      const reason = error instanceof ActorRejected ? error.reason : "DEPENDENCY_UNAVAILABLE";
      // Unknown identities are not staff actors. Record only a fixed denial category;
      // never copy provider subjects, emails, token/metadata claims or dependency errors.
      try {
        await recordSecurityAuditEvents(this.dependencies.auditWriter, [{
          occurredAt: this.dependencies.now().toISOString(), actorStaffId: null, tenantId: null,
          action: "STAFF_IDENTITY_RESOLUTION", outcome: reason === "DEPENDENCY_UNAVAILABLE" ? "FAILURE" : "DENIED",
          targetType: "STAFF_IDENTITY", targetId: null, requestId: randomUUID(),
          reasonCode: reason === "STAFF_NOT_ACTIVE" ? "STAFF_NOT_ACTIVE" :
            reason === "MEMBERSHIP_NOT_ACTIVE" ? "MEMBERSHIP_NOT_ACTIVE" :
            reason === "INVALID_IDENTITY" ? "MISSING_CONTEXT" : "DEPENDENCY_UNAVAILABLE",
        }]);
      } catch { return denied("DEPENDENCY_UNAVAILABLE"); }
      return denied(reason);
    }
  }

  /** Internal session foundation only; no authentication or privileged permission is created. */
  async inspectSessionActor(actor: TrustedStaffActor): Promise<VerifiedSessionActor | null> {
    try {
    const { context, binding } = await this.#fresh(actor);
    const now = this.dependencies.now().getTime();
    if (!(this.dependencies.sessionIssuers?.includes(binding.identity.issuer) ?? new URL(binding.identity.issuer).hostname.endsWith(".invalid")) ||
      !authorizeStaffAccess(context, { permissionCode: "staff.self.read", scope: "SELF",
        targetStaffId: context.principal!.staffId, now: new Date(now).toISOString() }).allowed) return null;
    const digest = (c: StaffAuthorizationContext, time: number) => canonicalDigest([staffAuthorityDigest(c),
      [...c.platformRoleGrants, ...(c.membership?.roleGrants ?? [])].map(g => [g.roleCode, g.scope,
        Date.parse(g.grantedAt) <= time && (g.expiresAt === null || time < Date.parse(g.expiresAt)) &&
        (g.revokedAt === null || time < Date.parse(g.revokedAt))]).sort()]);
    const authorityDigest = digest(context, now);
    const revalidate = async () => { try {
      const current = await this.#fresh(actor);
      return digest(current.context, this.dependencies.now().getTime()) === authorityDigest;
    } catch { return false; } };
    await this.#audit(context, true);
    if (!await revalidate()) return null;
    const evidence = Object.freeze({ staffId: context.principal!.staffId, issuer: binding.identity.issuer,
      subject: binding.identity.subject, tenantId: binding.tenantId ?? null,
      authzVersion: context.principal!.authzVersion.toString(), membershipVersion: context.membership?.version.toString() ?? null,
      authorityDigest, identityExpiresAtMs: binding.identity.security.expiresAt * 1000, revalidate }) as VerifiedSessionActor;
    sessionActors.set(evidence, actor); return evidence;
    } catch(error) { if(error instanceof ActorRejected)return null;throw new Error("Session authority unavailable"); }
  }

  async readStaffWorkflow(actor:TrustedStaffActor,input:StaffWorkflowReadInput):Promise<StaffWorkflowReadResult> {
    const reject=(reason:"READ_DENIED"|"UNAVAILABLE"="READ_DENIED"):StaffWorkflowReadResult=>Object.freeze({allowed:false,reason,execution:"NOT_AUTHORIZED"});
    try{
      const {context,binding}=await this.#fresh(actor),port=this.dependencies.syntheticWorkflowReads;
      let normalized:StaffWorkflowQuery;
      try{normalized=normalizeWorkflowRead(input);}catch{await this.#audit(context,false);return reject();}
      const nowMs=this.dependencies.now().getTime(),validUntilMs=Math.min(nowMs+5000,binding.identity.security.expiresAt*1000);
      if(!new URL(binding.identity.issuer).hostname.endsWith(".invalid") || port?.capability!=="NON_AUTHORIZED_STAFF_WORKFLOW_READ" ||
        !eligibleWorkflowRead(context,normalized,nowMs) || !await port.allows(context,normalized)){await this.#audit(context,false);return reject();}
      const continuation=input.cursor===undefined?undefined:this.#workflowCursors.get(input.cursor);
      if(input.cursor!==undefined){
        this.#workflowCursors.delete(input.cursor);
        if(!continuation || continuation.actor!==actor || continuation.query!==JSON.stringify(normalized) || nowMs>=continuation.expiresAtMs){await this.#audit(context,false);return reject();}
      }
      const query:StaffWorkflowQuery=Object.freeze({...normalized,...(continuation?{position:continuation.position}:{})});
      const fresh=async()=>{try{const current=await this.#fresh(actor),now=this.dependencies.now().getTime();
        return now<validUntilMs && eligibleWorkflowRead(current.context,query,now) && await port.allows(current.context,query);
      }catch{return false;}};
      const ticket=Object.freeze({staffId:context.principal!.staffId,tenantId:binding.tenantId??null,query,nowMs,validUntilMs,revalidate:fresh}) as AuthorizedStaffWorkflowRead;
      workflowReads.add(ticket);
      try{
        const page=await port.read(ticket);
        if(page==="UNAVAILABLE")return reject("UNAVAILABLE");
        if(page==="NOT_AVAILABLE"){await this.#audit(context,false);return reject();}
        const safe=safeWorkflowPage(page,ticket); // Copy before audit/freshness awaits.
        if(!await fresh())return reject();
        await this.#audit(context,true);
        if(!await fresh())return reject();
        let cursor:StaffWorkflowReadCursor|undefined;
        if(safe.next){cursor=Object.freeze({}) as StaffWorkflowReadCursor;
          this.#workflowCursors.set(cursor,{actor,query:JSON.stringify(normalized),position:safe.next,expiresAtMs:Math.min(nowMs+60000,binding.identity.security.expiresAt*1000)});}
        return Object.freeze({allowed:true,data:safe.data,...(cursor?{cursor}:{}),execution:"NOT_AUTHORIZED",acceptedApproval:false});
      }finally{workflowReads.delete(ticket);}
    }catch(error){return reject(error instanceof ActorRejected?"READ_DENIED":"UNAVAILABLE");}
  }

  async inspectApproval(actor: TrustedStaffActor, requestId: string, previous: readonly StaffApprovalObservation[] = []) {
    try {
      const { context, binding } = await this.#fresh(actor);
      if (!uuid.test(requestId) || previous.length > 10) return denied("INVALID_REQUEST");
      const raw = await this.dependencies.requests?.find(requestId);
      if (!raw) return denied("REQUEST_UNAVAILABLE");
      const request = Object.freeze({ ...raw }); // Copy trusted repository snapshot before any await.
      if (request.id !== requestId || !hex.test(request.digest) || !/^[1-9][0-9]{0,18}$/.test(request.version) ||
          request.policyVersion !== STAFF_LIFECYCLE_POLICY_VERSION || !uuid.test(request.requesterStaffId) || !uuid.test(request.beneficiaryStaffId) ||
          !["platform.access.approve", "platform.access.approve_privileged"].includes(request.permission) ||
          !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= this.dependencies.now().getTime()) return denied("STALE_REQUEST");
      if (request.tenantId !== (binding.tenantId ?? null)) return denied("TENANT_MISMATCH");
      const staffId = context.principal!.staffId;
      if (staffId === request.requesterStaffId) return denied("SELF_APPROVAL");
      if (staffId === request.beneficiaryStaffId) return denied("BENEFICIARY_APPROVAL");
      for (const observation of previous) {
        if (!this.#observations.has(observation) || observation.requestId !== request.id || observation.requestDigest !== request.digest || observation.requestVersion !== request.version) return denied("UNTRUSTED_PROVENANCE");
        await this.#fresh(observation.actor);
        if (observation.staffId === staffId) return denied("DUPLICATE_PERSON");
      }
      // Tenant membership cannot inherit platform approval authority.
      if (binding.tenantId !== undefined) return denied("PERMISSION_INACTIVE");
      const decision = authorizeStaffAccess(context, { permissionCode: request.permission, scope: "PLATFORM", now: this.dependencies.now().toISOString() });
      if (decision.reason !== "PERMISSION_INACTIVE") return denied(decision.reason === "ALLOW" ? "EXECUTION_BLOCKED" : decision.reason);
      const latest = await this.dependencies.requests!.find(requestId);
      if (!latest || JSON.stringify(latest) !== JSON.stringify(request)) return denied("STALE_REQUEST");
      await this.#fresh(actor);
      if (Date.parse(request.expiresAt) <= this.dependencies.now().getTime()) return denied("STALE_REQUEST");
      await this.#audit(context, false, request.id);
      for (const observation of previous) await this.#fresh(observation.actor);
      await this.#fresh(actor);
      if (Date.parse(request.expiresAt) <= this.dependencies.now().getTime()) return denied("STALE_REQUEST");
      const observation = Object.freeze({ actor, staffId, requestId, requestDigest: request.digest, requestVersion: request.version,
        policyVersion: STAFF_LIFECYCLE_POLICY_VERSION, observedAt: this.dependencies.now().toISOString(), assurance: "not-established" as const,
        execution: "NOT_AUTHORIZED" as const, acceptedApproval: false as const,
        requiredEvidence: Object.freeze(["FRESH_STRONG_MFA", "ACTIVE_APPROVAL_PERMISSION", "DURABLE_APPROVAL_BINDING"] as const) }) as StaffApprovalObservation;
      this.#observations.add(observation);
      return Object.freeze({ ...denied("ASSURANCE_AND_PERMISSION_BLOCKED"), observation });
    } catch (error) { return denied(error instanceof ActorRejected ? error.reason : "DEPENDENCY_UNAVAILABLE"); }
  }

  async reconcileOwnReceipt(actor: TrustedStaffActor, key: string, digest: string, operationId?: string) {
    try {
      const { context, binding } = await this.#fresh(actor);
      const port = this.dependencies.syntheticReceipts;
      if (!uuid.test(key) || !hex.test(digest) || (operationId !== undefined && !hex.test(operationId)) || !binding.tenantId ||
          !new URL(binding.identity.issuer).hostname.endsWith(".invalid") || port?.capability !== "NON_AUTHORIZED_RECEIPT_RECONCILE" ||
          !await port.allows(context)) return denied("RECEIPT_ACCESS_DENIED");
      const query = Object.freeze({ actorStaffId: context.principal!.staffId, tenantId: binding.tenantId, key, expectedDigest: digest,
        ...(operationId === undefined ? {} : { operationId }) }) as AuthorizedSyntheticReceiptQuery;
      receiptQueries.add(query);
      let found: NonAuthorizedReceiptRow | null | "UNRESOLVED";
      try { found = await port.lookup(query); } finally { receiptQueries.delete(query); }
      const row = found === null || found === "UNRESOLVED" ? found : Object.freeze({ ...found });
      if (row === "UNRESOLVED" || row === null) return denied("UNRESOLVED"); // Absence alone never proves rollback.
      if (row.actorStaffId !== context.principal!.staffId || row.tenantId !== binding.tenantId || row.key !== key ||
          !hex.test(row.operationId) || (operationId !== undefined && row.operationId !== operationId) || row.outcome !== "SIMULATION_RECORDED" || row.execution !== "NOT_AUTHORIZED") return denied("RECEIPT_ACCESS_DENIED");
      if (row.digest !== digest) return denied("CONFLICT");
      await this.#audit(context, true); // Committed audit is required before disclosure.
      const fresh = await this.#fresh(actor);
      if (!await port.allows(fresh.context)) return denied("RECEIPT_ACCESS_DENIED");
      return Object.freeze({ allowed: true as const, operationId: row.operationId, outcome: "SIMULATION_RECORDED" as const, execution: "NOT_AUTHORIZED" as const });
    } catch (error) { return denied(error instanceof ActorRejected ? error.reason : "DEPENDENCY_UNAVAILABLE"); }
  }
  async #syntheticBinding(actor: TrustedStaffActor, requestId: string, intendedDecision?: "APPROVE" | "REJECT") {
    const current = await this.#fresh(actor), { context, binding } = current;
    if (this.dependencies.syntheticAssuranceVerifier?.capability !== "LOCAL_SYNTHETIC_ASSURANCE_ONLY" ||
      !new URL(binding.identity.issuer).hostname.endsWith(".invalid") || !uuid.test(requestId)) throw new ActorRejected("SYNTHETIC_ASSURANCE_DISABLED");
    const raw = await this.dependencies.requests?.find(requestId, binding.tenantId);
    if (!raw) throw new ActorRejected("REQUEST_UNAVAILABLE");
    const request = Object.freeze({ ...raw });
    await this.#fresh(actor);
    if (request.id !== requestId || !hex.test(request.digest) || !/^[1-9][0-9]{0,6}$/.test(request.version) || BigInt(request.version) > 1000000n ||
      request.policyVersion !== STAFF_LIFECYCLE_POLICY_VERSION || !uuid.test(request.requesterStaffId) || !uuid.test(request.beneficiaryStaffId) ||
      !["platform.access.approve","platform.access.approve_privileged"].includes(request.permission) ||
      !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= this.dependencies.now().getTime()) throw new ActorRejected("STALE_REQUEST");
    if (request.tenantId !== (binding.tenantId ?? null)) throw new ActorRejected("TENANT_MISMATCH");
    if ([request.requesterStaffId, request.beneficiaryStaffId].includes(context.principal!.staffId)) throw new ActorRejected("SELF_OR_BENEFICIARY_APPROVAL");
    const permission = binding.tenantId ? "tenant.access.request" : context.platformRoleGrants.some(g => g.roleCode === "GOVERNANCE_OWNER") ? "platform.access.approve_privileged" : request.permission;
    const decision = authorizeStaffAccess(context, { permissionCode: permission, scope: binding.tenantId ? "TENANT" : "PLATFORM", now: this.dependencies.now().toISOString(),
      ...(binding.tenantId ? { tenantId: binding.tenantId, objectTenantId: binding.tenantId } : {}) });
    if (decision.reason !== "PERMISSION_INACTIVE") throw new ActorRejected("APPROVAL_ROLE_NOT_ELIGIBLE");
    const evidenceBinding: SyntheticApprovalBinding = Object.freeze({ staffId: context.principal!.staffId, identityIssuer: binding.identity.issuer,
      identitySubject: binding.identity.subject, requestId, requestVersion: request.version, requestDigest: request.digest,
      policyVersion: request.policyVersion, tenantId: binding.tenantId ?? null, authorityDigest: staffAuthorityDigest(context),
      ...(intendedDecision && {decision:intendedDecision}) });
    return { ...current, request, evidenceBinding };
  }

  async beginSyntheticApprovalChallenge(actor: TrustedStaffActor, requestId: string, decision?: "APPROVE" | "REJECT") {
    try {
      if (decision !== undefined && decision !== "APPROVE" && decision !== "REJECT") return denied("INVALID_DECISION");
      const current = await this.#syntheticBinding(actor, requestId, decision);
      if (decision && (current.binding.tenantId !== undefined || !this.dependencies.syntheticApprovalIntake)) return denied("DECISION_UNAVAILABLE");
      const issuedAtMs = Math.floor(this.dependencies.now().getTime() / 1000) * 1000;
      const expiresAtMs = Math.min(issuedAtMs + 60000, Date.parse(current.request.expiresAt), current.binding.identity.security.expiresAt * 1000);
      if (expiresAtMs <= this.dependencies.now().getTime()) return denied("CHALLENGE_EXPIRED");
      await this.#audit(current.context, false);
      const latest = await this.#syntheticBinding(actor, requestId, decision);
      if (this.dependencies.now().getTime() >= expiresAtMs || canonicalDigest(latest.evidenceBinding) !== canonicalDigest(current.evidenceBinding)) return denied("STALE_AUTHORITY");
      const id = randomUUID();
      const challenge = Object.freeze({ id, binding: current.evidenceBinding, issuedAtMs, expiresAtMs,
        bindingDigest: canonicalDigest([id,current.evidenceBinding,issuedAtMs,expiresAtMs]) }) as SyntheticAssuranceChallenge;
      this.#challenges.set(challenge, { actor, used: false });
      return Object.freeze({ allowed: true as const, challenge, acceptedApproval: false as const, execution: "NOT_AUTHORIZED" as const });
    } catch (error) { return denied(error instanceof ActorRejected ? error.reason : "DEPENDENCY_UNAVAILABLE"); }
  }

  async verifySyntheticApprovalProvenance(actor: TrustedStaffActor, challenge: SyntheticAssuranceChallenge, assertion: string) {
    try {
      const state = typeof challenge === "object" && challenge !== null ? this.#challenges.get(challenge) : undefined;
      if (!state || state.actor !== actor || state.used) return denied("UNTRUSTED_OR_REPLAYED_CHALLENGE");
      state.used = true; // A failed or concurrent attempt cannot reuse the challenge.
      let current = await this.#syntheticBinding(actor, challenge.binding.requestId, challenge.binding.decision);
      const startedAt = this.dependencies.now().getTime();
      if (startedAt >= challenge.expiresAtMs || canonicalDigest(current.evidenceBinding) !== canonicalDigest(challenge.binding)) return denied("STALE_CHALLENGE");
      const evidence = await this.dependencies.syntheticAssuranceVerifier!.verify(assertion, challenge);
      const now = this.dependencies.now().getTime();
      if (!Number.isFinite(now) || now < startedAt || now >= challenge.expiresAtMs) return denied("STALE_CHALLENGE");
      if (evidence.providerIssuer !== SYNTHETIC_ASSURANCE_ISSUER || evidence.profile !== SYNTHETIC_ASSURANCE_PROFILE ||
        evidence.challengeId !== challenge.id || evidence.bindingDigest !== challenge.bindingDigest || !uuid.test(evidence.authenticationEventId) || !hex.test(evidence.assertionDigest) || !/^[A-Za-z0-9_-]{1,80}$/.test(evidence.signingKeyId) ||
        !Number.isSafeInteger(evidence.authenticatedAtMs) || evidence.authenticatedAtMs < challenge.issuedAtMs || evidence.authenticatedAtMs > now ||
        !Number.isSafeInteger(evidence.expiresAtMs) || evidence.expiresAtMs > challenge.expiresAtMs || evidence.expiresAtMs <= now) return denied("INVALID_SYNTHETIC_EVIDENCE");
      for (const [id, expiry] of this.#authenticationEvents) if (expiry <= now) this.#authenticationEvents.delete(id);
      if (this.#authenticationEvents.has(evidence.authenticationEventId) || this.#authenticationEvents.size >= 1024) return denied("REPLAYED_AUTHENTICATION_EVENT");
      this.#authenticationEvents.set(evidence.authenticationEventId, evidence.expiresAtMs);
      current = await this.#syntheticBinding(actor, challenge.binding.requestId, challenge.binding.decision);
      if (canonicalDigest(current.evidenceBinding) !== canonicalDigest(challenge.binding) || this.dependencies.now().getTime() >= evidence.expiresAtMs) return denied("STALE_AUTHORITY");
      await this.#audit(current.context, false);
      const afterAudit = await this.#syntheticBinding(actor, challenge.binding.requestId, challenge.binding.decision);
      if (canonicalDigest(afterAudit.evidenceBinding) !== canonicalDigest(challenge.binding) || this.dependencies.now().getTime() >= evidence.expiresAtMs) return denied("STALE_AUTHORITY");
      const data = { binding: challenge.binding, challengeId: challenge.id, authenticationEventId: evidence.authenticationEventId,
        authenticatedAtMs: evidence.authenticatedAtMs, expiresAtMs: evidence.expiresAtMs, assertionDigest: evidence.assertionDigest,
        providerIssuer: SYNTHETIC_ASSURANCE_ISSUER, signingKeyId: evidence.signingKeyId, synthetic: true as const, operationalAssurance: "not-established" as const,
        acceptedApproval: false as const, execution: "NOT_AUTHORIZED" as const };
      const provenance = Object.freeze({ ...data, recordDigest: canonicalDigest(data) }) as VerifiedSyntheticApprovalProvenance;
      this.#proofs.set(provenance, { actor });
      return Object.freeze({ allowed: true as const, provenance, acceptedApproval: false as const, execution: "NOT_AUTHORIZED" as const });
    } catch (error) { return denied(error instanceof ActorRejected ? error.reason : "SYNTHETIC_ASSURANCE_UNVERIFIED"); }
  }

  async #checkSyntheticProof(actor: TrustedStaffActor, provenance: VerifiedSyntheticApprovalProvenance, command: StaffRequestCommand, decision?: "APPROVE" | "REJECT") {
    const proof = typeof provenance === "object" && provenance !== null ? this.#proofs.get(provenance) : undefined;
    if (!proof || proof.actor !== actor || command.kind !== "REVIEW" || provenance.expiresAtMs <= this.dependencies.now().getTime() ||
      decision !== provenance.binding.decision || command.id !== provenance.binding.requestId || command.version.toString() !== provenance.binding.requestVersion || command.requestDigest !== provenance.binding.requestDigest ||
      (proof.key !== undefined && proof.key !== command.key)) throw new ActorRejected("UNTRUSTED_OR_REPLAYED_PROVENANCE");
    const current = await this.#syntheticBinding(actor, command.id, decision);
    if (this.dependencies.now().getTime() >= provenance.expiresAtMs || canonicalDigest(current.evidenceBinding) !== canonicalDigest(provenance.binding)) throw new ActorRejected("STALE_PROVENANCE");
    if (proof.key !== undefined && proof.key !== command.key) throw new ActorRejected("UNTRUSTED_OR_REPLAYED_PROVENANCE");
    proof.key = command.key;
  }

  async intakeStaffApproval(actor:TrustedStaffActor,input:StaffApprovalIntakeCommand,provenance?:VerifiedSyntheticApprovalProvenance):Promise<StaffApprovalIntakeResult> {
    let persistenceStarted=false;
    try{
      const {context,binding}=await this.#fresh(actor),command=normalizeApprovalIntake(input),port=this.dependencies.syntheticApprovalIntake;
      const eligible=async()=>{const current=await this.#fresh(actor);
        return eligibleApprovalIntake(current.context,this.dependencies.now().getTime()) && port?.capability==="NON_AUTHORIZED_STAFF_APPROVAL_INTAKE" && await port.allows(current.context,command.kind);};
      if(!new URL(binding.identity.issuer).hostname.endsWith(".invalid") || !await eligible())return failedApprovalIntake();
      const underlying:StaffRequestCommand=command.kind==="ATTEMPT"?Object.freeze({kind:"REVIEW",key:command.key,id:command.id,version:command.version,requestDigest:command.requestDigest}):
        Object.freeze({kind:"LOOKUP",key:command.key,id:command.id,version:command.version});
      if(command.kind==="ATTEMPT"){
        if(!provenance)return failedApprovalIntake();
        await this.#checkSyntheticProof(actor,provenance,underlying,command.decision);
      }else if(provenance!==undefined)return failedApprovalIntake();
      const nowMs=this.dependencies.now().getTime(),validUntilMs=Math.min(nowMs+5000,binding.identity.security.expiresAt*1000);
      const ticket=Object.freeze({staffId:context.principal!.staffId,issuer:binding.identity.issuer,subject:binding.identity.subject,tenantId:binding.tenantId??null,
        authorityDigest:staffAuthorityDigest(context),command:underlying,nowMs,validUntilMs,
        approvalIntake:Object.freeze({profile:"BLOCKED_SYNTHETIC_REVIEW",requestDigest:command.requestDigest,policyVersion:command.policyVersion,
          ...(command.decision && {decision:command.decision})}),
        ...(provenance===undefined?{}:{syntheticProvenance:provenance}),revalidate:async()=>{
          try{if(this.dependencies.now().getTime()>=validUntilMs || !await eligible())return false;
            if(provenance)await this.#checkSyntheticProof(actor,provenance,underlying,command.decision);
            await this.#fresh(actor);
            const finished=this.dependencies.now().getTime();
            return finished>=nowMs && finished<validUntilMs;
          }catch{return false;}
        }}) as AuthorizedStaffRequest;
      staffRequests.add(ticket);
      let result:StaffRequestResult;
      try{persistenceStarted=true;result=await port!.execute(ticket);}finally{staffRequests.delete(ticket);}
      const safe=safeApprovalIntakeResult(result,command,context.principal!.staffId);
      if(safe.kind==="RECORDED" || safe.kind==="REPLAYED"){
        if(!await eligible())return failedApprovalIntake("UNRESOLVED");
        // Artifact audit is in the write transaction. Receipt disclosure separately requires committed read audit.
        if(command.kind==="RECONCILE"){await this.#audit(context,true);if(!await eligible())return failedApprovalIntake("UNRESOLVED");}
      }
      return safe;
    }catch{return failedApprovalIntake(persistenceStarted?"UNRESOLVED":"DENIED");}
  }

  /** Exercises the disposable store only. Its result cannot authorize a staff write. */
  async rehearseStaffExecution(actor: TrustedStaffActor, input: Extract<StaffRequestCommand,{kind:"REVIEW"}>): Promise<StaffRequestResult> {
    try {
      const {context,binding}=await this.#fresh(actor);
      const port=this.dependencies.syntheticExecution;
      const command=normalizeStaffRequestCommand(input);
      if (command.kind!=="REVIEW" || binding.tenantId!==undefined ||
          !new URL(binding.identity.issuer).hostname.endsWith(".invalid") ||
          port?.capability!=="STAFF_EXECUTION_REHEARSAL_ONLY") return staffRequestResult("DENIED");
      const nowMs=this.dependencies.now().getTime();
      const validUntilMs=Math.min(nowMs+5000,binding.identity.security.expiresAt*1000);
      const ticket=Object.freeze({staffId:context.principal!.staffId,issuer:binding.identity.issuer,subject:binding.identity.subject,
        tenantId:null,authorityDigest:staffAuthorityDigest(context),command,nowMs,validUntilMs,executionRehearsal:true,
        revalidate:async(expiresAtMs=validUntilMs)=>{
          try {
            await this.#fresh(actor);
            const finished=this.dependencies.now().getTime();
            return finished>=nowMs && finished<Math.min(expiresAtMs,validUntilMs);
          }catch{return false;}
        }
      }) as AuthorizedStaffRequest;
      staffRequests.add(ticket);
      try{
        const result=await port.execute(ticket);
        if (!await ticket.revalidate() || result.execution!=="NOT_AUTHORIZED" || result.acceptedApproval!==false) return staffRequestResult("UNRESOLVED");
        if(result.kind!=="RECORDED" && result.kind!=="REPLAYED") return staffRequestResult(result.kind);
        if(result.requestId!==command.id||result.version!==command.version.toString()||result.requestDigest!==command.requestDigest||
           result.operationId!==canonicalDigest(["staff-execution-rehearsal-v1",ticket.staffId,command.key])) return staffRequestResult("UNRESOLVED");
        return staffRequestResult(result.kind,{operationId:result.operationId,requestId:result.requestId,version:result.version,requestDigest:result.requestDigest});
      }finally{staffRequests.delete(ticket);}
    }catch{return staffRequestResult("DENIED");}
  }

  async recordStaffRequest(actor: TrustedStaffActor, input: StaffRequestCommand, provenance?: VerifiedSyntheticApprovalProvenance): Promise<StaffRequestResult> {
    try {
      const {context,binding}=await this.#fresh(actor);
      const command=normalizeStaffRequestCommand(input), port=this.dependencies.syntheticRequests;
      if (provenance !== undefined) await this.#checkSyntheticProof(actor, provenance, command);
      if(!new URL(binding.identity.issuer).hostname.endsWith(".invalid") || port?.capability!=="NON_AUTHORIZED_STAFF_REQUESTS" ||
        !await port.allows(context,command.kind)) return staffRequestResult("DENIED",{reason:"REQUEST_ACCESS_DENIED"});
      const nowMs=this.dependencies.now().getTime();
      const ticket=Object.freeze({staffId:context.principal!.staffId,issuer:binding.identity.issuer,subject:binding.identity.subject,
        tenantId:binding.tenantId??null,authorityDigest:staffAuthorityDigest(context),command,nowMs,
        ...(provenance === undefined ? {} : { syntheticProvenance: provenance }),
        validUntilMs:Math.min(nowMs+5000,binding.identity.security.expiresAt*1000),
        revalidate: async (expiresAtMs = Infinity) => {
          try {
            const deadline = Math.min(nowMs + 5000, binding.identity.security.expiresAt * 1000, expiresAtMs);
            if (this.dependencies.now().getTime() >= deadline) return false;
            const current = await this.#fresh(actor);
            if (provenance !== undefined) await this.#checkSyntheticProof(actor, provenance, command);
            return staffAuthorityDigest(current.context) === staffAuthorityDigest(context) &&
              await port.allows(current.context, command.kind) && this.dependencies.now().getTime() < deadline;
          } catch { return false; }
        }
      }) as AuthorizedStaffRequest;
      staffRequests.add(ticket);
      try {return await port.execute(ticket);} finally {staffRequests.delete(ticket);}
    } catch(error) {return staffRequestResult("DENIED",{reason:error instanceof ActorRejected?error.reason:"DEPENDENCY_UNAVAILABLE"});}
  }
}
