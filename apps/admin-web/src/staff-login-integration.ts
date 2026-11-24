import { inspect } from 'node:util';
import { StaffSessionLifecycle, TrustedStaffActorBoundary } from '@nukhbapay/application';
import type { SecurityAuditWriter, StaffAuthorizationRepository, StaffSessionStore } from '@nukhbapay/application';
import { Auth0Login, validateAuth0Configuration, type Auth0Configuration } from './auth0.js';
import type { InternalSessionPort } from './portal.js';

/** Existing Track A/application ports. The caller owns accepted adapters, readiness and resource cleanup. */
export interface StaffLoginBackendPorts {
  readonly repository: StaffAuthorizationRepository;
  readonly auditWriter: SecurityAuditWriter;
  readonly sessionStore: StaffSessionStore;
  readonly checkReadiness: () => Promise<boolean>;
}

const unavailable = () => new Error('Staff login integration unavailable');
const denied = () => Object.freeze({ ok: false as const, reason: 'UNAVAILABLE' as const, execution: 'NOT_AUTHORIZED' as const });

/**
 * Trusted programmatic assembly only: no env reader, pool, listener, enrollment or startup registration.
 * Construction does not authenticate. Tests supply synthetic transport and ports; real use remains separately gated.
 */
export async function prepareStaffLoginIntegration(config: Auth0Configuration, dependencies: {
  readonly backend: StaffLoginBackendPorts;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly reportCallbackFailure?: NonNullable<ConstructorParameters<typeof Auth0Login>[1]['reportCallbackFailure']>;
  readonly stepUp?: Required<Pick<ConstructorParameters<typeof Auth0Login>[1], 'stepUpPolicy' | 'verifyStepUpFactor'>>;
}) {
  try {
    const settings = validateAuth0Configuration(config), backend = dependencies.backend;
    if (!backend || !backend.repository || !backend.auditWriter || !backend.sessionStore ||
        typeof backend.repository.findByTrustedIdentity !== 'function' || typeof backend.repository.findTenantMembership !== 'function' ||
        typeof backend.repository.findPlatformRoleGrants !== 'function' || typeof backend.auditWriter.appendSecurityAuditEvents !== 'function' ||
        typeof backend.sessionStore.execute !== 'function' || typeof backend.checkReadiness !== 'function' ||
        typeof dependencies.fetch !== 'function' || typeof dependencies.now !== 'function') throw unavailable();

    // Pin trusted functions before the first await; callers cannot substitute ports or configuration mid-login.
    const findIdentity = backend.repository.findByTrustedIdentity.bind(backend.repository);
    const findMembership = backend.repository.findTenantMembership.bind(backend.repository);
    const findGrants = backend.repository.findPlatformRoleGrants.bind(backend.repository);
    const appendAudit = backend.auditWriter.appendSecurityAuditEvents.bind(backend.auditWriter);
    const execute = backend.sessionStore.execute.bind(backend.sessionStore);
    const history = backend.sessionStore.history?.bind(backend.sessionStore);
    const backendReady = backend.checkReadiness.bind(backend), fetcher = dependencies.fetch, now = dependencies.now;
    const stepUp = dependencies.stepUp;
    const effectPolicy = stepUp?.stepUpPolicy, factorVerifier = stepUp?.verifyStepUpFactor;
    let closed = false, checking: Promise<boolean> | undefined;
    const checkReadiness = (): Promise<boolean> => {
      if (closed) return Promise.resolve(false);
      return checking ??= Promise.resolve().then(backendReady).then(value => !closed && value === true, () => false)
        .finally(() => { checking = undefined; });
    };
    const requireReady = async () => { if (!await checkReadiness()) throw unavailable(); };
    const read = async <T>(operation: () => Promise<T>): Promise<T> => {
      await requireReady(); const value = await operation(); await requireReady(); return value;
    };
    await requireReady();

    const repository: StaffAuthorizationRepository = {
      findByTrustedIdentity: identity => read(() => identity.issuer === settings.issuer ? findIdentity(identity) : Promise.resolve(null)),
      findTenantMembership: (staffId, tenantId) => read(() => tenantId === settings.tenantId ? findMembership(staffId, tenantId) : Promise.resolve(null)),
      findPlatformRoleGrants: staffId => read(() => findGrants(staffId)),
    };
    const auditWriter: SecurityAuditWriter = { appendSecurityAuditEvents: events => read(() => appendAudit(events)) };
    const store: StaffSessionStore = { ...(history && {history:ticket=>read(()=>history(ticket))}), execute: async ticket => {
      if (!await checkReadiness()) return 'UNRESOLVED';
      try {
        const outcome = await execute(ticket);
        return await checkReadiness() ? outcome : 'UNRESOLVED';
      } catch { return 'UNRESOLVED'; }
    } };
    const actors = new TrustedStaffActorBoundary({ repository, auditWriter, now, sessionIssuers: [settings.issuer] });
    const lifecycle = new StaffSessionLifecycle({ actors, store, now, enabled: true });
    const guard = async <T>(operation: () => Promise<T>) => {
      try {
        if (!await checkReadiness()) return denied();
        const result = await operation();
        return await checkReadiness() ? result : denied();
      } catch { return denied(); }
    };
    // Always reach the lifecycle's local revocation barrier, including during a
    // readiness outage. A recovered backend cannot revive a logged-out cookie.
    const revoke = async (token: string) => {
      try {
        const result = await lifecycle.revoke(token);
        return await checkReadiness() ? result : denied();
      } catch { return denied(); }
    };
    const readProfile=(token:string)=>guard(()=>lifecycle.readProfile(token));
    const reportCallbackFailure = dependencies.reportCallbackFailure;
    const login = new Auth0Login(settings, { fetch: fetcher, now,
      ...(typeof reportCallbackFailure === 'function' && { reportCallbackFailure }),
      ...(typeof effectPolicy === 'function' && typeof factorVerifier === 'function' && {
        stepUpPolicy: command=>read(()=>effectPolicy(command)),
        verifyStepUpFactor: (claims,challenge,signal)=>read(()=>{
          signal.throwIfAborted();
          return factorVerifier(claims,challenge,signal);
        }),
      }),
      actors: { establish: async (identity, tenantId) => {
        const reject = () => Object.freeze({ allowed: false as const, reason: 'DEPENDENCY_UNAVAILABLE', execution: 'NOT_AUTHORIZED' as const });
        if ((tenantId ?? null) !== settings.tenantId || !await checkReadiness()) return reject();
        const actor = await actors.establish(identity, tenantId);
        return await checkReadiness() ? actor : reject();
      } },
      sessions: {
        create: actor => guard(() => lifecycle.create(actor)),
        rotate: (actor, token) => guard(() => lifecycle.rotate(actor, token)),
        reauthenticate: (actor, token) => guard(() => lifecycle.reauthenticate(actor, token)),
        readProfile,
        revoke,
      },
    });
    const sessions = Object.freeze({
      validate: (token: string) => guard(() => lifecycle.validate(token)),
      readProfile,
      ...(history && {readHistory:(token:string)=>guard(()=>lifecycle.readHistory(token))}),
      revoke,
      verifyRevocation: (token: string) => guard(() => lifecycle.verifyRevocation(token)),
      toJSON: () => '[StaffLoginSessions: internal]',
      [inspect.custom]: () => '[StaffLoginSessions: internal]',
    }) satisfies InternalSessionPort;
    const close = () => { closed = true; login.close(); };
    return Object.freeze({ login, sessions, checkReadiness, close,
      toJSON: () => '[StaffLoginIntegration: internal]',
      [inspect.custom]: () => '[StaffLoginIntegration: internal]',
    });
  } catch { throw unavailable(); }
}
