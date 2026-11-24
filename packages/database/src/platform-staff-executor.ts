import { createHash, createHmac } from 'node:crypto';
import { canonicalDigest, preparePlatformStaffProposal } from '@nukhbapay/application';
import type { Pool, PoolClient } from 'pg';

export const DISPOSABLE_PLATFORM_STAFF_EFFECT = 'DISPOSABLE_PLATFORM_STAFF_EFFECT_V1';
export const AUTH0_PLATFORM_STAFF_PILOT = 'AUTH0_PLATFORM_STAFF_PILOT_V1';
type AssuranceProfile = typeof DISPOSABLE_PLATFORM_STAFF_EFFECT | typeof AUTH0_PLATFORM_STAFF_PILOT;
type Command = 'REVOKE_SESSION' | 'REVOKE_ALL_SESSIONS' | 'SUSPEND_STAFF';
type Action = 'SUBMIT' | 'APPROVE' | 'REJECT' | 'CANCEL' | 'EXECUTE' | 'LOOKUP';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const opaqueSession = /^[A-Za-z0-9_-]{43}$/;
const id = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && hex.test(value);
const requestVersion = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,17}$/.test(value);
const denied = Object.freeze({ kind: 'DENIED' } as const);
const unresolved = Object.freeze({ kind: 'UNRESOLVED' } as const);

export interface PlatformStaffIntent {
  readonly scope: 'PLATFORM';
  readonly action: Action;
  readonly command: Command;
  readonly actorStaffId: string;
  readonly targetStaffId: string;
  readonly requestId: string;
  readonly requestVersion: string;
  readonly requestDigest: string;
  readonly idempotencyKey: string;
  readonly proposal?: NonNullable<ReturnType<typeof preparePlatformStaffProposal>>;
  readonly previousDigest?: string | null;
  readonly intentDigest: string;
}

export interface VerifiedPlatformStaffAssurance {
  readonly profile: AssuranceProfile;
  readonly actorStaffId: string;
  readonly intentDigest: string;
  readonly sessionDigest: string;
  readonly eventId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly identityIssuedAtMs: number;
  readonly expiresAtMs: number;
  revalidate(): Promise<boolean>;
}

function fields(value: object, keys: readonly string[]) {
  const proto: unknown = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && Reflect.ownKeys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}

function normalize(value: unknown): PlatformStaffIntent | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const action = Object.getOwnPropertyDescriptor(input,'action')?.value as unknown;
  if (action === 'SUBMIT') {
    if (!fields(input, ['action','proposal','previousDigest','idempotencyKey']) || !id(input['idempotencyKey'])) return null;
    const proposal = preparePlatformStaffProposal(input['proposal'], Date.now());
    const previousDigest = input['previousDigest'];
    if (!proposal || !requestVersion(proposal.requestVersion.toString()) ||
        (proposal.requestVersion === 1n ? previousDigest !== null : !digest(previousDigest))) return null;
    if (previousDigest !== null && !digest(previousDigest)) return null;
    const data: Omit<PlatformStaffIntent,'intentDigest'> = { scope: 'PLATFORM', action, command: proposal.target.kind, actorStaffId: proposal.requesterStaffId,
      targetStaffId: proposal.target.staffId, requestId: proposal.requestId, requestVersion: proposal.requestVersion.toString(),
      requestDigest: proposal.requestDigest, idempotencyKey: input['idempotencyKey'], proposal, previousDigest };
    return Object.freeze({ ...data, intentDigest: canonicalDigest(['platform-staff-command-v1', data]) });
  }
  if (action !== 'APPROVE' && action !== 'REJECT' && action !== 'CANCEL' && action !== 'EXECUTE' && action !== 'LOOKUP') return null;
  if (!fields(input, ['scope','action','command','actorStaffId','targetStaffId','requestId','requestVersion','requestDigest','idempotencyKey'])) return null;
  const { scope, command, actorStaffId, targetStaffId, requestId, requestDigest, idempotencyKey } = input;
  const version = input['requestVersion'];
  if (scope !== 'PLATFORM' || (command !== 'REVOKE_SESSION' && command !== 'REVOKE_ALL_SESSIONS' && command !== 'SUSPEND_STAFF') ||
      !id(actorStaffId) || !id(targetStaffId) || actorStaffId === targetStaffId || !id(requestId) || !requestVersion(version) ||
      !digest(requestDigest) || !id(idempotencyKey)) return null;
  const data: Omit<PlatformStaffIntent,'intentDigest'> = { scope, action, command, actorStaffId, targetStaffId, requestId, requestDigest, idempotencyKey, requestVersion: version };
  return Object.freeze({ ...data, intentDigest: canonicalDigest(['platform-staff-command-v1', data]) });
}

async function withinAssuranceBudget<T>(read: () => Promise<T>, expiresAtMs = Infinity): Promise<T> {
  const limit = Math.min(3000, expiresAtMs - Date.now());
  if (limit <= 0) throw denied;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(denied), limit); });
    return await Promise.race([read(),timeout]);
  } finally { clearTimeout(timer); }
}

export async function createDisposablePlatformStaffExecutor(pool: Pool, options: {
  readonly signingKey: Uint8Array;
  readonly consumeAssurance: (intent: PlatformStaffIntent, proof: unknown, credential: string) => Promise<VerifiedPlatformStaffAssurance | null>;
} & (Readonly<{capability:typeof DISPOSABLE_PLATFORM_STAFF_EFFECT}> |
    Readonly<{capability:typeof AUTH0_PLATFORM_STAFF_PILOT; approvedIssuer:string}>)) {
  const capability = options.capability;
  if (![DISPOSABLE_PLATFORM_STAFF_EFFECT,AUTH0_PLATFORM_STAFF_PILOT].includes(capability) || options.signingKey.length !== 32)
    throw new Error('Platform staff effect unavailable');
  const approvedIssuer=options.capability===AUTH0_PLATFORM_STAFF_PILOT ? options.approvedIssuer : undefined;
  if (capability===AUTH0_PLATFORM_STAFF_PILOT) {
    let issuer:URL;
    try { issuer=new URL(approvedIssuer!); } catch { throw new Error('Platform staff effect unavailable'); }
    if (issuer.protocol!=='https:' || issuer.href!==approvedIssuer || issuer.href!==issuer.origin+'/' || issuer.port ||
        !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(issuer.hostname) || /\.(?:invalid|test|local|localhost|example)$/.test(issuer.hostname))
      throw new Error('Platform staff effect unavailable');
  }
  const { rows } = await pool.query(`SELECT current_database() AS database, current_user AS role,
    host(inet_server_addr()) AS host, inet_server_port() AS port,
    current_setting('nukhbapay.effective_staff_fixture',true) AS fixture,
    (rolsuper OR rolcreaterole OR rolcreatedb OR rolinherit OR rolbypassrls OR rolreplication) AS unsafe,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS membership,
    has_any_column_privilege(current_user,'nukhabapay.staff_users','UPDATE') OR
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='nukhbapay_sessions' AND c.relname='events' AND has_any_column_privilege(current_user,c.oid,'INSERT')) OR
    has_table_privilege(current_user,'nukhabapay.platform_staff_receipts','INSERT') AS excess
    FROM pg_roles r WHERE r.rolname=current_user`);
  const scope = rows[0];
  if (scope?.host !== '127.0.0.1' || scope.fixture !== 'isolated' || scope.role !== 'nukh_platform_executor' ||
      typeof scope.port !== 'number' || scope.port <= 1024 || [5432,55437].includes(scope.port) ||
      !/^nukhabapay_effect_[0-9a-f]{32}$/.test(scope.database) || scope.unsafe || scope.membership || scope.excess) throw new Error('Platform staff effect unavailable');
  if (capability===AUTH0_PLATFORM_STAFF_PILOT && (await pool.query(
    'SELECT nukhabapay.platform_staff_pilot_issuer_matches($1) AS allowed',[approvedIssuer],
  )).rows[0]?.allowed!==true) throw new Error('Platform staff effect unavailable');

  const key = Buffer.from(options.signingKey), consume = options.consumeAssurance;
  const prepared = new WeakSet<object>();
  return Object.freeze({
    prepare(input: unknown) {
      const intent = normalize(input);
      if (intent) prepared.add(intent);
      return intent;
    },
    async run(intent: PlatformStaffIntent, proof: unknown, credential: string) {
      if (!prepared.has(intent) || typeof credential !== 'string' || !opaqueSession.test(credential)) return denied;
      let client: PoolClient | undefined;
      let committing = false, discard = false;
      try {
        const sessionDigest = createHash('sha256').update(credential).digest('hex');
        const assurance = await withinAssuranceBudget(() => consume(intent, proof, credential));
        if (!assurance || assurance.profile !== capability || assurance.sessionDigest !== sessionDigest ||
            assurance.intentDigest !== intent.intentDigest || assurance.actorStaffId !== intent.actorStaffId || !id(assurance.eventId) ||
            typeof assurance.issuer !== 'string' || (approvedIssuer===undefined ? !assurance.issuer.endsWith('.invalid/') : assurance.issuer!==approvedIssuer) ||
            typeof assurance.subject !== 'string' || !assurance.subject || assurance.subject.length > 512 ||
            !Number.isSafeInteger(assurance.identityIssuedAtMs) || !Number.isSafeInteger(assurance.expiresAtMs) ||
            !await withinAssuranceBudget(() => assurance.revalidate(),assurance.expiresAtMs)) return denied;
        const { profile, eventId, issuer, subject, identityIssuedAtMs, expiresAtMs } = assurance;
        const body = JSON.stringify({ ...intent, profile, eventId, issuer, subject, identityIssuedAtMs, expiresAtMs, sessionDigest },
          (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
        const signature = createHmac('sha256', key).update(body).digest('hex');
        client = await pool.connect();
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout='4s'; SET LOCAL lock_timeout='1s'");
        const result = (await client.query('SELECT nukhabapay.apply_platform_staff_effect($1,$2) AS result', [body,signature])).rows[0]?.result;
        if (!result || !['RECORDED','APPLIED','REPLAYED','ABSENT'].includes(result.kind) ||
            !await withinAssuranceBudget(() => assurance.revalidate(),expiresAtMs)) throw denied;
        committing = true;
        if ((await client.query('COMMIT')).command !== 'COMMIT') throw unresolved;
        return Object.freeze(result as { kind: 'RECORDED' | 'APPLIED' | 'REPLAYED' | 'ABSENT'; receiptId?: string; auditId?: string; revokedSessions?: number });
      } catch (error) {
        discard = committing;
        if (client) try { await client.query('ROLLBACK'); } catch { discard = true; }
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        return committing && code !== '42501' ? unresolved : denied;
      } finally { client?.release(discard); }
    },
  });
}
