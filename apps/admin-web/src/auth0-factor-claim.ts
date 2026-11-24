import type { StaffFactorChallenge, StaffProviderFactorEvent } from './auth0.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const label = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const evidenceKeys = ['version','eventId','challengeNonce','factor','completedAtMs'];

/** Parser for an approved namespaced Action claim in ID-token claims already verified by Auth0Login.
 * The tenant must prove the Action's provenance and event identity before composition. */
export function createAuth0FactorClaimVerifier(options: {
  readonly claimName: string;
  readonly version: string;
  readonly acceptedFactors: readonly string[];
}) {
  const { claimName, version } = options;
  let namespace: URL;
  try { namespace = new URL(claimName); }
  catch { throw new Error('Invalid Auth0 factor claim contract'); }
  const factors = new Set(options.acceptedFactors);
  if (namespace.protocol !== 'https:' || namespace.href !== claimName || namespace.pathname === '/' ||
      namespace.username || namespace.password || namespace.search || namespace.hash || claimName.length > 256 ||
      typeof version !== 'string' || !label.test(version) || factors.size === 0 || factors.size > 12 ||
      [...factors].some(factor => typeof factor !== 'string' || !label.test(factor) || factor.includes('recovery')))
    throw new Error('Invalid Auth0 factor claim contract');

  return async function verify(claims: Readonly<Record<string,unknown>>, challenge: StaffFactorChallenge,
    signal: AbortSignal): Promise<StaffProviderFactorEvent | null> {
    if (signal.aborted || claims['iss'] !== challenge.issuer || claims['sub'] !== challenge.subject ||
        claims['aud'] !== challenge.clientId || claims['nonce'] !== challenge.nonce || !Object.hasOwn(claims,claimName)) return null;
    const claim = claims[claimName];
    if (!claim || typeof claim !== 'object' || Array.isArray(claim) || Reflect.ownKeys(claim).length !== evidenceKeys.length ||
        !evidenceKeys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(claim,key) ?? {},'value'))) return null;
    const { version: schema, eventId, challengeNonce, factor, completedAtMs } = claim as Record<string,unknown>;
    if (schema !== version || typeof eventId !== 'string' || !uuid.test(eventId) || challengeNonce !== challenge.nonce ||
        typeof factor !== 'string' || !factors.has(factor) || typeof completedAtMs !== 'number' || !Number.isSafeInteger(completedAtMs) ||
        completedAtMs < challenge.challengeStartedAtMs || completedAtMs >= challenge.credentialExpiresAtMs) return null;
    return Object.freeze({ eventId, authenticatedAtMs: completedAtMs });
  };
}
