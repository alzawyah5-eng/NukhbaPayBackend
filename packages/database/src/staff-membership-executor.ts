import { createHash, createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { isVerifiedStaffIdentity, type VerifiedStaffIdentity } from '@nukhbapay/application/verified-identity';
import {
  accessChangeRequestDigest, canonicalDigest, classifyLifecycleGrant, planStaffLifecycle, prepareStaffCommand,
  type AccessChangeRequest, type ApprovalSlot, type LifecycleActor, type LifecycleApproval, type LifecycleGrant,
  type LifecyclePolicyContext, type LifecycleTarget,
} from '@nukhbapay/application';

interface RequestBinding {
  readonly requestId: string;
  readonly requestVersion: string;
  readonly requestDigest: string;
  readonly targetStaffId: string;
  readonly tenantId: string;
  readonly actorStaffId: string;
}

interface CommandBinding extends RequestBinding {
  readonly approvalDigest: string;
  readonly idempotencyKey: string;
  readonly expiresAtMs: number;
}
type ReviewDecision = 'APPROVE' | 'REJECT';
type ApprovalIntent = CommandBinding & Readonly<{purpose:'DECIDE';slot:ApprovalSlot;decision:ReviewDecision}>;
export type MembershipEffectIntent = ApprovalIntent | (CommandBinding & Readonly<{purpose:'EXECUTE'}>);

export interface VerifiedMembershipEffect {
  readonly profile: 'DISPOSABLE_STAFF_EFFECT_V1';
  readonly eventId: string;
  readonly staffId: string;
  readonly tenantId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly identityIssuedAtMs: number;
  readonly sessionDigest: string;
  readonly expiresAtMs: number;
  revalidate(): Promise<boolean>;
}

type EffectResult = Readonly<{ kind: 'APPLIED' | 'RECORDED' | 'REPLAYED' | 'DENIED' | 'UNRESOLVED'; operationId?: string }>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const denied = Object.freeze({ kind: 'DENIED' } as const);

function copyIntent(value: MembershipEffectIntent): MembershipEffectIntent {
  const { actorStaffId, tenantId, targetStaffId, requestId, requestVersion, requestDigest } = value;
  if (![actorStaffId, tenantId, targetStaffId, requestId].every(id => typeof id === 'string' && uuid.test(id)) ||
      actorStaffId === targetStaffId || typeof requestVersion !== 'string' || !/^[1-9][0-9]{0,5}$|^1000000$/.test(requestVersion) ||
      typeof requestDigest !== 'string' || !hex.test(requestDigest)) throw denied;
  const {idempotencyKey,approvalDigest,expiresAtMs}=value;
  if (typeof idempotencyKey!=='string' || !uuid.test(idempotencyKey) ||
      typeof approvalDigest!=='string' || !hex.test(approvalDigest) || !Number.isSafeInteger(expiresAtMs)) throw denied;
  const binding = {actorStaffId,tenantId,targetStaffId,requestId,requestVersion,requestDigest,idempotencyKey,approvalDigest,expiresAtMs};
  if (value.purpose==='EXECUTE') return Object.freeze({...binding,purpose:value.purpose});
  if (value.purpose==='DECIDE' && (value.slot==='SECURITY_ADMIN'||value.slot==='GOVERNANCE_OWNER') &&
      (value.decision==='APPROVE'||value.decision==='REJECT'))
    return Object.freeze({...binding,purpose:value.purpose,slot:value.slot,decision:value.decision});
  throw denied;
}

async function person(client: PoolClient, id: string, tenant: string) {
  const { rows:[user] } = await client.query(`SELECT u.status AS staff_status,u.authz_version,u.tokens_valid_after,
    m.id AS membership_id,m.status AS membership_status,m.version AS membership_version
    FROM nukhabapay.staff_users u LEFT JOIN nukhabapay.staff_memberships m ON m.staff_id=u.id AND m.tenant_id=$2
    WHERE u.id=$1`, [id,tenant]);
  if (!user) throw denied;
  const rows = (await client.query(`SELECT id,role_code,'PLATFORM' AS scope,granted_at,expires_at,revoked_at
     FROM nukhabapay.platform_role_grants WHERE staff_id=$1
     UNION ALL SELECT id,role_code,'TENANT',granted_at,expires_at,revoked_at
     FROM nukhabapay.tenant_role_grants WHERE membership_id=$2 AND tenant_id=$3
     ORDER BY id`, [id,user.membership_id ?? null,tenant])).rows;
  const grants:LifecycleGrant[] = rows.map(row => ({
    id:row.id, staffId:id, roleCode:row.role_code,
    scope:row.scope==='PLATFORM'?{kind:'PLATFORM'}:{kind:'TENANT',tenantId:tenant},
    grantedAtMs:row.granted_at.getTime(), expiresAtMs:row.expires_at?.getTime() ?? null, revokedAtMs:row.revoked_at?.getTime() ?? null,
  }));
  const actor:LifecycleActor = { staffId:id, status:user.staff_status, authzVersion:BigInt(user.authz_version), grants,
    memberships:user.membership_id ? [{tenantId:tenant,status:user.membership_status}] : [] };
  const target:LifecycleTarget = { staffId:id, status:actor.status, authzVersion:actor.authzVersion, grants,
    membership:user.membership_id ? {tenantId:tenant,status:user.membership_status,version:BigInt(user.membership_version)} : null };
  return { actor, target, cutoff:user.tokens_valid_after?.getTime() ?? 0,
    stamp:canonicalDigest([actor,user.membership_id,String(user.membership_version),user.tokens_valid_after]) };
}

async function activeIdentity(client: PoolClient, id: string, issuer: string, subject: string) {
  return (await client.query(`SELECT 1 FROM nukhabapay.staff_identities
    WHERE staff_id=$1 AND issuer=$2 AND subject=$3 AND status='ACTIVE'`, [id,issuer,subject])).rowCount === 1;
}

async function clock(client: PoolClient) {
  return Number((await client.query<{ now_ms:string }>(
    'SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint AS now_ms',
  )).rows[0]!.now_ms);
}

async function approvalContext(client: PoolClient, policy: LifecyclePolicyContext, request: AccessChangeRequest,
  tenantId: string, requestDigest: string): Promise<LifecyclePolicyContext> {
  const rows = (await client.query(`SELECT * FROM nukhabapay.staff_effect_decisions
    WHERE request_id=$1 AND request_version=$2 AND request_digest=$3 ORDER BY slot`,
  [request.id,request.version.toString(),requestDigest])).rows;
  const approvals:LifecycleApproval[] = [];
  const approvers:LifecycleActor[] = [];
  for (const entry of rows) {
    const reviewer = await person(client,entry.reviewer_staff_id,tenantId);
    if (reviewer.stamp!==entry.authority_digest || reviewer.target.membership?.status!=='ACTIVE' ||
        !await activeIdentity(client,entry.reviewer_staff_id,entry.issuer,entry.subject)) throw denied;
    approvers.push(reviewer.actor);
    approvals.push({ requestId:request.id, requestVersion:request.version, requestDigest, policyVersion:request.policyVersion,
      slot:entry.slot, decision:entry.decision, approverStaffId:entry.reviewer_staff_id, approverAuthzVersion:BigInt(entry.reviewer_authz_version),
      decidedAtMs:Number(entry.decided_at_ms), expiresAtMs:Number(entry.expires_at_ms) });
  }
  return {...policy,approvals,approvers};
}

async function requestHead(client: PoolClient, requestId: string, tenantId: string) {
  const row = (await client.query(`SELECT payload,request_digest,requester_authz_version FROM nukhabapay.staff_access_requests
    WHERE request_id=$1 AND scope_key=$2 ORDER BY version DESC LIMIT 1`,[requestId,tenantId])).rows[0];
  if (!row) throw denied;
  const payload = row.payload as AccessChangeRequest;
  const request:AccessChangeRequest = { ...payload, version:BigInt(payload.version), expectedAuthzVersion:BigInt(payload.expectedAuthzVersion),
    expectedMembershipVersion:payload.expectedMembershipVersion===null ? null : BigInt(payload.expectedMembershipVersion) };
  if (request.state !== 'SUBMITTED' || request.scope.kind !== 'TENANT' || request.scope.tenantId !== tenantId ||
      request.operation.kind !== 'SUSPEND' || request.operation.target !== 'MEMBERSHIP' || request.proposedRoles.length ||
      accessChangeRequestDigest(request) !== row.request_digest ||
      (await client.query('SELECT 1 FROM nukhabapay.staff_request_cancellations WHERE request_id=$1',[requestId])).rowCount) throw denied;
  return {request,digest:String(row.request_digest),requesterVersion:BigInt(row.requester_authz_version)};
}

function eligibleSuspender(actor: LifecycleActor, now: number) {
  return actor.status==='ACTIVE' && actor.grants.some(g =>
    g.scope.kind==='TENANT' && g.roleCode==='TENANT_ADMIN' && classifyLifecycleGrant(g,now)==='ACTIVE');
}

function reviewerGrant(actor: LifecycleActor, request: AccessChangeRequest, policy: LifecyclePolicyContext,
  slots: readonly ApprovalSlot[], now: number) {
  if (actor.staffId===request.requesterStaffId || actor.staffId===request.targetStaffId ||
      policy.approvals.some(approval=>approval.approverStaffId===actor.staffId)) throw denied;
  const available=slots.filter(slot=>!policy.approvals.some(approval=>approval.slot===slot));
  const grants=available.flatMap(slot=>actor.grants.filter(grant=>grant.scope.kind==='PLATFORM' &&
    grant.roleCode===slot && classifyLifecycleGrant(grant,now)==='ACTIVE').map(grant=>({slot,grant})));
  if (grants.length!==1) throw denied;
  return grants[0]!;
}

/** Explicit local composition. The verification callback consumes an opaque
 * proof minted by the configured, session-bound authenticator. */
export async function createStaffMembershipExecutor(pool: Pool, options: {
  readonly capability: 'DISPOSABLE_STAFF_EFFECT_V1';
  readonly signingKey: Uint8Array;
  readonly consumeAssurance: (intent: MembershipEffectIntent, proof: unknown, session: string) => Promise<VerifiedMembershipEffect | null>;
}) {
  if (options.capability !== 'DISPOSABLE_STAFF_EFFECT_V1' || options.signingKey.length !== 32) throw new Error('Staff effect unavailable');
  const scope = (await pool.query(`SELECT current_database() AS database, current_user AS role,
    host(inet_server_addr()) AS host, inet_server_port() AS port,
    current_setting('nukhbapay.effective_staff_fixture',true) AS fixture,
    (rolsuper OR rolcreaterole OR rolcreatedb OR rolinherit OR rolbypassrls) AS unsafe,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS membership,
    has_table_privilege(current_user,'nukhabapay.staff_memberships','UPDATE') OR
      has_any_column_privilege(current_user,'nukhabapay.staff_memberships','UPDATE') OR
      has_table_privilege(current_user,'nukhabapay.staff_effect_receipts','INSERT') AS excess
    FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  if (scope?.host !== '127.0.0.1' || scope.fixture !== 'isolated' || scope.role !== 'nukh_effect_executor' ||
      typeof scope.port !== 'number' || scope.port <= 1024 || [5432,55437].includes(scope.port) ||
      !/^nukhabapay_effect_[0-9a-f]{32}$/.test(scope.database) || scope.unsafe || scope.membership || scope.excess)
    throw new Error('Staff effect unavailable');

  const key = Buffer.from(options.signingKey);
  const consumeAssurance = options.consumeAssurance;
  async function prepareCommand(identity: VerifiedStaffIdentity, tenantId: string, actorStaffId: string,
    requestId: string, idempotencyKey: string, decision?: ReviewDecision): Promise<MembershipEffectIntent|null> {
    if (!isVerifiedStaffIdentity(identity) || ![tenantId,actorStaffId,requestId,idempotencyKey].every(id=>uuid.test(id))) return null;
    let client:PoolClient|undefined;
    let discard=false;
    try {
      client=await pool.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='3s'");
      await client.query("SELECT set_config('nukhabapay.workflow_scope',$1,true),set_config('nukhabapay.tenant_id',$1,true)",[tenantId]);
      const now=await clock(client);
      const {request,digest,requesterVersion}=await requestHead(client,requestId,tenantId);
      if (identity.security.issuedAt*1000>now || identity.security.expiresAt*1000<=now ||
          !await activeIdentity(client,actorStaffId,identity.issuer,identity.subject) ||
          (!decision && request.requesterStaffId!==actorStaffId)) throw denied;
      const current=await person(client,actorStaffId,tenantId);
      const requester=request.requesterStaffId===actorStaffId ? current : await person(client,request.requesterStaffId,tenantId);
      if (!eligibleSuspender(requester.actor,now) || requester.target.membership?.status!=='ACTIVE' ||
          current.actor.status!=='ACTIVE' || current.target.membership?.status!=='ACTIVE' ||
          requesterVersion!==requester.actor.authzVersion || identity.security.issuedAt*1000<current.cutoff ||
          (await client.query('SELECT 1 FROM nukhabapay.staff_effect_receipts WHERE request_id=$1',[requestId])).rowCount) throw denied;
      const target=await person(client,request.targetStaffId,tenantId);
      const policy=await approvalContext(client,{currentRequestVersion:request.version,currentRequestDigest:digest,
        requester:requester.actor,target:target.target,approvals:[],approvers:[],knownTenantIds:[tenantId],objectTenantId:tenantId},request,tenantId,digest);
      const evaluatedAt=await clock(client);
      const evaluated=planStaffLifecycle(request,policy,evaluatedAt);
      const prepared=prepareStaffCommand(request,policy,idempotencyKey,evaluatedAt);
      if (evaluated.kind!=='PLAN' || prepared.kind!=='CANDIDATE' ||
          identity.security.expiresAt*1000<=evaluatedAt || !eligibleSuspender(requester.actor,evaluatedAt)) throw denied;
      const binding={actorStaffId,tenantId,targetStaffId:request.targetStaffId,requestId,requestVersion:request.version.toString(),
        requestDigest:digest,approvalDigest:prepared.command.approvalDigest,idempotencyKey,expiresAtMs:request.expiresAtMs};
      let intent:MembershipEffectIntent;
      if (decision) {
        const {slot}=reviewerGrant(current.actor,request,policy,evaluated.requiredApprovals,evaluatedAt);
        intent={...binding,purpose:'DECIDE',slot,decision};
      } else {
        if (evaluated.quorum!=='PRESENT') throw denied;
        intent={...binding,purpose:'EXECUTE'};
      }
      if ((await client.query('COMMIT')).command!=='COMMIT') throw new Error('Unconfirmed read');
      return Object.freeze(intent);
    } catch {
      if (client) try {await client.query('ROLLBACK');} catch {discard=true;}
      return null;
    } finally {client?.release(discard);}
  }

  return Object.freeze({
    prepareSuspension(identity: VerifiedStaffIdentity, tenantId: string, actorStaffId: string, requestId: string, idempotencyKey: string) {
      return prepareCommand(identity,tenantId,actorStaffId,requestId,idempotencyKey);
    },
    async prepareApproval(identity: VerifiedStaffIdentity, tenantId: string, actorStaffId: string, requestId: string,
      idempotencyKey: string, decision: ReviewDecision): Promise<ApprovalIntent|null> {
      if (decision!=='APPROVE' && decision!=='REJECT') return null;
      const intent=await prepareCommand(identity,tenantId,actorStaffId,requestId,idempotencyKey,decision);
      return intent?.purpose==='DECIDE' ? intent : null;
    },
    async run(value: MembershipEffectIntent, proof: unknown, session: string): Promise<EffectResult> {
      let client: PoolClient | undefined;
      let committing = false, locked = false;
      let discard = false;
      let operationId: string | undefined;
      try {
        const intent = copyIntent(value);
        if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(session)) return denied;
        const sessionDigest = createHash('sha256').update(session).digest('hex');
        const verified = await consumeAssurance(intent,proof,session);
        if (!verified || verified.profile !== options.capability || verified.staffId !== intent.actorStaffId ||
            verified.tenantId !== intent.tenantId || verified.sessionDigest !== sessionDigest || typeof verified.issuer !== 'string' ||
            !verified.issuer.endsWith('.invalid/') || typeof verified.subject !== 'string' || !verified.subject ||
            !uuid.test(verified.eventId) || !Number.isSafeInteger(verified.identityIssuedAtMs) || !Number.isSafeInteger(verified.expiresAtMs) ||
            !await verified.revalidate()) return denied;
        const { eventId, issuer, subject, identityIssuedAtMs, expiresAtMs } = verified;
        client = await pool.connect();
        // Reserve authority before the serializable snapshot. A session whose
        // creation commits just before this reservation must be visible.
        locked=(await client.query('SELECT pg_try_advisory_lock(38216,1) AS locked')).rows[0]?.locked===true;
        if (!locked) throw denied;
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await client.query("SET LOCAL statement_timeout='4s'");
        await client.query("SET LOCAL lock_timeout='1s'");
        await client.query("SELECT set_config('nukhabapay.workflow_scope',$1,true),set_config('nukhabapay.tenant_id',$1,true)",[intent.tenantId]);
        const now = await clock(client);
        const current = await person(client,intent.actorStaffId,intent.tenantId);
        if (current.actor.status !== 'ACTIVE' || current.target.membership?.status !== 'ACTIVE' ||
            identityIssuedAtMs > now || identityIssuedAtMs < current.cutoff || expiresAtMs <= now ||
            !await activeIdentity(client,intent.actorStaffId,issuer,subject)) throw denied;

        const {request,digest,requesterVersion}=await requestHead(client,intent.requestId,intent.tenantId);
        if (digest!==intent.requestDigest || request.version.toString()!==intent.requestVersion ||
            request.targetStaffId!==intent.targetStaffId || request.expiresAtMs<=now) throw denied;
        const requester = intent.actorStaffId===request.requesterStaffId ? current : await person(client,request.requesterStaffId,intent.tenantId);
        if (requesterVersion!==requester.actor.authzVersion || !eligibleSuspender(requester.actor,now) ||
            requester.target.membership?.status!=='ACTIVE' ||
            (intent.purpose==='EXECUTE' && intent.actorStaffId!==request.requesterStaffId)) throw denied;
        const target = await person(client,request.targetStaffId,intent.tenantId);
        const policy:LifecyclePolicyContext = { currentRequestVersion:request.version, currentRequestDigest:intent.requestDigest,
          requester:requester.actor, target:target.target, approvals:[], approvers:[], knownTenantIds:[intent.tenantId], objectTenantId:intent.tenantId };
        operationId = intent.purpose==='EXECUTE' ? canonicalDigest(['staff-member-effect-v1',intent.actorStaffId,intent.idempotencyKey]) : eventId;
        const prior = (await client.query(`SELECT operation_id,request_id,request_digest,approval_digest,request_version
          FROM nukhabapay.staff_effect_receipts WHERE request_id=$1 OR (requester_staff_id=$2 AND operation_id=$3)`,
        [intent.requestId,intent.actorStaffId,operationId])).rows;
        if (prior.length) {
          const [receipt] = prior;
          await client.query('ROLLBACK');
          return intent.purpose==='EXECUTE' && prior.length===1 && receipt.operation_id===operationId &&
            receipt.request_id===intent.requestId && receipt.request_digest===intent.requestDigest && receipt.approval_digest===intent.approvalDigest &&
            String(receipt.request_version)===intent.requestVersion && await verified.revalidate() ? { kind:'REPLAYED', operationId } : denied;
        }
        const inputs=await approvalContext(client,policy,request,intent.tenantId,intent.requestDigest);
        const evaluatedAt=await clock(client);
        const evaluated=planStaffLifecycle(request,inputs,evaluatedAt);
        const prepared=prepareStaffCommand(request,inputs,intent.idempotencyKey,evaluatedAt);
        if (evaluated.kind!=='PLAN' || prepared.kind!=='CANDIDATE' ||
            prepared.command.approvalDigest!==intent.approvalDigest) throw denied;
        let deadline=Math.min(now+60000,expiresAtMs,request.expiresAtMs,intent.expiresAtMs,
          ...inputs.approvals.map(approval=>approval.expiresAtMs));
        let details: Record<string, unknown>;
        if (intent.purpose==='DECIDE') {
          const {slot,grant}=reviewerGrant(current.actor,request,inputs,evaluated.requiredApprovals,evaluatedAt);
          if (slot!==intent.slot) throw denied;
          deadline=Math.min(deadline,grant.expiresAtMs ?? Infinity);
          details={slot,decision:intent.decision,idempotencyKey:intent.idempotencyKey,
            reviewerAuthzVersion:current.actor.authzVersion.toString(),authorityDigest:current.stamp,decidedAtMs:evaluatedAt,
            decisionExpiresAtMs:Math.min(request.expiresAtMs,grant.expiresAtMs ?? Infinity)};
        } else {
          if (evaluated.quorum!=='PRESENT') throw denied;
          details={approvalDigest:intent.approvalDigest,operationId,idempotencyKey:intent.idempotencyKey};
        }
        // Bound the transaction by all currently active grants used to establish the snapshot.
        const expiring = [...current.actor.grants,...requester.actor.grants].filter(g=>classifyLifecycleGrant(g,now)==='ACTIVE');
        deadline = Math.min(deadline,...expiring.map(grant=>grant.expiresAtMs ?? Infinity));
        if (!await verified.revalidate() || await clock(client)>=deadline) throw denied;
        const body = JSON.stringify({ ...details, purpose:intent.purpose, profile:verified.profile, issuer, subject, eventId, sessionDigest, identityIssuedAtMs,
          expiresAtMs:deadline, staffId:intent.actorStaffId, tenantId:intent.tenantId, targetStaffId:intent.targetStaffId,
          requestId:intent.requestId, requestVersion:intent.requestVersion, requestDigest:intent.requestDigest });
        const signature = createHmac('sha256',key).update(body).digest('hex');
        await client.query('SELECT nukhabapay.apply_staff_membership_effect($1,$2)',[body,signature]);
        if (!await verified.revalidate()) throw denied;
        committing = true;
        if ((await client.query('COMMIT')).command!=='COMMIT') throw new Error('Commit unresolved');
        return { kind:intent.purpose==='EXECUTE' ? 'APPLIED' : 'RECORDED', operationId };
      } catch {
        discard = committing;
        if (client) try { await client.query('ROLLBACK'); } catch { discard = true; }
        return committing ? { kind:'UNRESOLVED', ...(operationId && {operationId}) } : denied;
      } finally {
        if (client && locked) {
          try {if (!(await client.query('SELECT pg_advisory_unlock(38216,1) AS released')).rows[0]?.released) discard=true;}
          catch {discard=true;}
        }
        client?.release(discard);
      }
    },
  });
}
