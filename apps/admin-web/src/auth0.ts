import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { inspect } from "node:util";
import { createRemoteJWKSet, customFetch, decodeProtectedHeader, jwtVerify } from "jose";
import { attestVerifiedStaffIdentity } from "@nukhbapay/application/verified-identity";
import { normalizePublicationCommand, type PublicationCommand, type StaffSessionLifecycle, type TrustedStaffActorBoundary } from "@nukhbapay/application";

export const TRANSACTION_COOKIE_NAME = "__Host-nukhbapay_oidc";
const opaque = /^[A-Za-z0-9_-]{43}$/;
const fail = () => new Error("Staff authentication failed");
const random = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const text = (v: unknown, max = 512): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\s\u0000-\u001f\u007f]/.test(v);
const date = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const AUTH0_DEPENDENCY_TIMEOUT_MS = 3000;

export type StaffCallbackFailureStage =
  | "callback-state" | "authorization-response" | "token-exchange" | "token-response"
  | "id-token-format" | "id-token-verification" | "id-token-lifetime" | "id-token-mfa"
  | "access-token-profile" | "access-token-verification" | "access-token-lifetime" | "access-token-audience"
  | "access-token-claims" | "staff-principal-claim" | "signed-token-binding"
  | "privileged-assurance" | "staff-authorization" | "session-persistence";

export interface Auth0Configuration {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly audience: string;
  /** Trusted server opt-in only. Absent means scalar API audience only. */
  readonly accessTokenAudienceMode?: "api-only" | "api-and-userinfo";
  /** Exact operator-owned HTTPS claim name; the signed access-token value must be "human". */
  readonly staffKindClaim: string;
  readonly callbackUrl: string;
  /** Selected by trusted server composition, never callback/query/claim data. */
  readonly tenantId: string | null;
}

export function validateAuth0Configuration(input: Auth0Configuration): Readonly<Auth0Configuration> {
  try {
    const issuer = new URL(input.issuer), callback = new URL(input.callbackUrl), claim = new URL(input.staffKindClaim), audience = new URL(input.audience);
    if (issuer.protocol !== "https:" || issuer.href !== input.issuer || issuer.pathname !== "/" || issuer.search || issuer.hash ||
        issuer.username || issuer.password || issuer.port || isIP(issuer.hostname) || !issuer.hostname.includes(".") ||
        /(?:^|\.)(?:localhost|local)$/.test(issuer.hostname) ||
        callback.href !== input.callbackUrl || callback.origin !== `https://localhost:${callback.port}` || !callback.port ||
        callback.pathname !== "/auth/callback" || callback.search || callback.hash || callback.username || callback.password ||
        !text(input.clientId, 128) || !text(input.clientSecret, 4096) || input.clientSecret.length < 32 ||
        !["https:", "urn:"].includes(audience.protocol) || audience.username || audience.password || audience.search || audience.hash ||
        input.audience === new URL("userinfo", issuer).href ||
        input.accessTokenAudienceMode !== undefined && !["api-only", "api-and-userinfo"].includes(input.accessTokenAudienceMode) ||
        claim.protocol !== "https:" || claim.href !== input.staffKindClaim || claim.pathname === "/" || claim.search || claim.hash || claim.username || claim.password ||
        !text(input.staffKindClaim) || claim.port || isIP(claim.hostname) || !claim.hostname.includes(".") ||
        /(?:^|\.)(?:localhost|local|auth0\.com|webtask\.io|webtask\.run)$/.test(claim.hostname) ||
        (input.tenantId !== null && (typeof input.tenantId !== 'string' || !uuid.test(input.tenantId)))) throw fail();
    const value={...input,clientSecret:input.clientSecret};
    Object.defineProperty(value,'clientSecret',{value:input.clientSecret,enumerable:false,writable:false});
    return Object.freeze(value);
  } catch { throw fail(); }
}

function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail());
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw fail();
      return operation();
    }).then(resolve, abort).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function boundedDependency<T>(operation: (signal: AbortSignal) => Promise<T>, remainingMs: number,
  cancellation?: AbortSignal): Promise<T> {
  const budget = Math.min(AUTH0_DEPENDENCY_TIMEOUT_MS, remainingMs);
  if (budget <= 0) throw fail();
  const deadline = new AbortController();
  const signal = cancellation ? AbortSignal.any([deadline.signal, cancellation]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), budget);
  try { return await abortable(() => operation(signal), signal); }
  finally { clearTimeout(timer); }
}

/** Bound the complete exchange, including streamed bodies. No redirects or ambient credentials. */
async function json(fetcher: typeof fetch, url: string, init: RequestInit, maximum: number,
  cancellation?: AbortSignal): Promise<Record<string, unknown>> {
  const deadline = AbortSignal.timeout(AUTH0_DEPENDENCY_TIMEOUT_MS);
  const signal = cancellation ? AbortSignal.any([deadline, cancellation]) : deadline;
  const response = await abortable(() => fetcher(url, { ...init, signal, redirect: "error", credentials: "omit", cache: "no-store" }), signal);
  const length = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || response.url && response.url !== url ||
      !["application/json", "application/jwk-set+json"].includes(response.headers.get("content-type")?.split(";")[0]?.trim() ?? "") ||
      length !== null && (!/^\d{1,10}$/.test(length) || Number(length) > maximum) || !response.body) {
    void response.body?.cancel().catch(() => undefined); throw fail();
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await abortable(() => reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maximum || chunks.length >= 1024) throw fail();
      chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
    return value as Record<string, unknown>;
  } catch { void reader.cancel().catch(() => undefined); throw fail(); }
  finally { reader.releaseLock(); }
}

export function transactionCookie(value: string, clear = false): string {
  if (!opaque.test(value) && !(clear && value === "")) throw fail();
  return `${TRANSACTION_COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 300}`;
}

export interface StaffStepUpBinding {
  readonly actorStaffId: string;
  readonly tenantId: string;
  readonly targetStaffId: string;
  readonly requestId: string;
  readonly requestVersion: string;
  readonly requestDigest: string;
  readonly approvalDigest: string;
  readonly idempotencyKey: string;
  readonly expiresAtMs: number;
}

export type StaffReviewDecision = "APPROVE" | "REJECT";

export type StaffMembershipStepUpCommand = StaffStepUpBinding & (
  Readonly<{operation:"SUSPEND_MEMBERSHIP";permission:"tenant.staff.suspend"}> |
  (Readonly<{operation:"DECIDE_SUSPENSION";decision:StaffReviewDecision}> & (
    Readonly<{slot:"SECURITY_ADMIN";permission:"platform.access.approve"}> |
    Readonly<{slot:"GOVERNANCE_OWNER";permission:"platform.access.approve_privileged"}>
  ))
);

export interface StaffPublicationStepUpCommand {
  readonly operation:"CATALOGUE_PUBLICATION";
  readonly actorStaffId:string;
  readonly tenantId:string;
  readonly expiresAtMs:number;
  readonly command:PublicationCommand;
  readonly commandDigest:string;
  readonly authorityDigest:string;
}

export interface StaffPlatformStepUpCommand {
  readonly operation: 'PLATFORM_STAFF_SECURITY';
  readonly actorStaffId: string;
  readonly intentDigest: string;
  readonly expiresAtMs: number;
}

export type StaffStepUpCommand = StaffMembershipStepUpCommand | StaffPublicationStepUpCommand | StaffPlatformStepUpCommand;

declare const stepUpBrand: unique symbol;
export interface StaffStepUpProof { readonly [stepUpBrand]: true }

export interface StaffProviderFactorEvent {
  readonly eventId: string;
  readonly authenticatedAtMs: number;
}

export interface StaffFactorChallenge {
  readonly issuer:string;
  readonly subject:string;
  readonly clientId:string;
  readonly audience:string;
  readonly nonce:string;
  readonly challengeStartedAtMs:number;
  readonly credentialExpiresAtMs:number;
}

export interface StaffStepUpAuthorization {
  readonly expiresAtMs: number;
  readonly factorEvent: StaffProviderFactorEvent & Readonly<{
    issuer: string; subject: string; identityIssuedAtMs: number; sessionDigest: string;
  }>;
  /** Use at the final authorization boundary after asynchronous work. */
  revalidate(): Promise<boolean>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STEP_UP_FRESHNESS_MS = 60_000;
function copyStepUpCommand(command: StaffStepUpCommand): StaffStepUpCommand {
  if (command.operation === 'PLATFORM_STAFF_SECURITY') {
    const {operation,actorStaffId,intentDigest,expiresAtMs}=command;
    if (Reflect.ownKeys(command).length !== 4 || !['operation','actorStaffId','intentDigest','expiresAtMs'].every(k=>Object.hasOwn(command,k)) ||
        typeof actorStaffId !== 'string' || !uuid.test(actorStaffId) || typeof intentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(intentDigest) ||
        !date(expiresAtMs)) throw fail();
    return Object.freeze({operation,actorStaffId,intentDigest,expiresAtMs});
  }
  if (command.operation==="CATALOGUE_PUBLICATION") {
    const {operation,actorStaffId,tenantId,expiresAtMs,commandDigest,authorityDigest}=command;
    const publication=normalizePublicationCommand(command.command);
    if (typeof actorStaffId!=="string"||!uuid.test(actorStaffId)||tenantId!==publication.tenantId||!date(expiresAtMs)||
        typeof commandDigest!=="string"||!/^[0-9a-f]{64}$/.test(commandDigest)||
        typeof authorityDigest!=="string"||!/^[0-9a-f]{64}$/.test(authorityDigest)) throw fail();
    return Object.freeze({operation,actorStaffId,tenantId,expiresAtMs,commandDigest,authorityDigest,command:publication});
  }
  const {actorStaffId,tenantId,targetStaffId,requestId,requestVersion,requestDigest,approvalDigest,idempotencyKey,
    permission,operation,expiresAtMs}=command;
  if (![actorStaffId,tenantId,targetStaffId,requestId,idempotencyKey].every(id=>typeof id==="string"&&uuid.test(id)) ||
      actorStaffId===targetStaffId || !/^[1-9][0-9]{0,6}$/.test(requestVersion) ||
      Number(requestVersion)>1000000 || !/^[0-9a-f]{64}$/.test(requestDigest) || !/^[0-9a-f]{64}$/.test(approvalDigest) ||
      !date(expiresAtMs)) throw fail();
  const binding = {actorStaffId,tenantId,targetStaffId,requestId,requestVersion,requestDigest,approvalDigest,idempotencyKey,expiresAtMs};
  if (operation==="SUSPEND_MEMBERSHIP" && permission==="tenant.staff.suspend")
    return Object.freeze({...binding,operation,permission});
  if (operation==="DECIDE_SUSPENSION" && (command.decision==="APPROVE" || command.decision==="REJECT")) {
    const {slot,decision}=command;
    if (slot==="SECURITY_ADMIN" && permission==="platform.access.approve")
      return Object.freeze({...binding,operation,permission,slot,decision});
    if (slot==="GOVERNANCE_OWNER" && permission==="platform.access.approve_privileged")
      return Object.freeze({...binding,operation,permission,slot,decision});
  }
  throw fail();
}

interface Transaction {
  readonly state: string; readonly nonce: string; readonly verifier: string; readonly expires: number; readonly startedAtMs: number;
  readonly previousToken?: string;
  readonly stepUp?: StaffStepUpCommand;
  readonly cancellation: AbortController;
}

/** Source-only integration. CLI never constructs this class or selects its trusted ports. */
export class Auth0Login {
  readonly #config;
  readonly #transactions = new Map<string, Transaction>();
  readonly #inflight = new Map<string, Transaction>();
  #closed = false;
  readonly #keys;
  readonly #fetch;
  readonly #now;
  readonly #actors;
  readonly #sessions;
  readonly #stepUpPolicy;
  readonly #verifyStepUpFactor;
  readonly #reportCallbackFailure;
  readonly #factorEvents = new Map<string, number>();
  readonly #staffSessions = new Map<string, ReturnType<typeof attestVerifiedStaffIdentity>>();
  readonly #stepUpProofs = new WeakMap<object, {
    command: StaffStepUpCommand; session: string; expiresAtMs: number; issuedAtMs: number; factorEvent: StaffStepUpAuthorization["factorEvent"];
  }>();
  constructor(config: Auth0Configuration, dependencies: {
    readonly actors: Pick<TrustedStaffActorBoundary, "establish">;
    readonly sessions: Pick<StaffSessionLifecycle, "create" | "rotate" | "revoke"> &
      Partial<Pick<StaffSessionLifecycle, "readProfile" | "reauthenticate">>;
    /** Trusted server composition. Re-read exact persisted intent and permission. */
    readonly stepUpPolicy?: (command: StaffStepUpCommand) => Promise<boolean>;
    /** Resolve the enrolled provider's factor event and stop evidence I/O on abort. */
    readonly verifyStepUpFactor?: (signedIdClaims: Readonly<Record<string, unknown>>,
      challenge: StaffFactorChallenge, signal: AbortSignal) => Promise<StaffProviderFactorEvent | null>;
    readonly fetch?: typeof fetch; readonly now?: () => Date;
    /** Private attended diagnostics. Receives only a fixed stage name. */
    readonly reportCallbackFailure?: (stage: StaffCallbackFailureStage) => void;
  }) {
    this.#config = validateAuth0Configuration(config);
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#now = dependencies.now ?? (() => new Date());
    this.#actors = dependencies.actors; this.#sessions = dependencies.sessions;
    this.#stepUpPolicy = dependencies.stepUpPolicy;
    this.#verifyStepUpFactor = dependencies.verifyStepUpFactor;
    this.#reportCallbackFailure = dependencies.reportCallbackFailure;
    const jwksUrl = new URL(".well-known/jwks.json", this.#config.issuer).href;
    this.#keys = createRemoteJWKSet(new URL(jwksUrl), {
      cacheMaxAge: 300_000, cooldownDuration: 30_000, timeoutDuration: AUTH0_DEPENDENCY_TIMEOUT_MS,
      [customFetch]: async url => {
        if (url !== jwksUrl) throw fail();
        const set = await json(this.#fetch, jwksUrl, { method: "GET" }, 65_536);
        if (!Array.isArray(set['keys']) || set['keys'].length < 1 || set['keys'].length > 32 || set['keys'].some(k =>
          !k || typeof k !== "object" || ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(n => n in k))) throw fail();
        return new Response(JSON.stringify(set), { headers: { "content-type": "application/json" } });
      },
    });
  }
  toJSON(): string { return "[Auth0Login: internal]"; }
  [inspect.custom](): string { return this.toJSON(); }
  get origin(): string { return new URL(this.#config.callbackUrl).origin; }
  /** Public parameters only; returned after committed, CSRF-protected local revocation. */
  get logoutUrl(): string {
    const url = new URL("v2/logout", this.#config.issuer);
    url.search = new URLSearchParams({ client_id: this.#config.clientId, returnTo: this.origin + "/auth/logged-out" }).toString();
    return url.href;
  }
  #time(): number {
    const value = this.#now().getTime();
    if (!Number.isSafeInteger(value) || value < 0) throw fail();
    return value;
  }
  begin(previousToken?: string, previousTransaction?: string): { location: string; cookie: string } {
    return this.#begin(previousToken,previousTransaction);
  }

  async beginStepUp(command: StaffStepUpCommand, session: string, previousTransaction?: string) {
    const intent = copyStepUpCommand(command);
    if (!await this.#validStepUp(intent,session)) throw fail();
    return this.#begin(session,previousTransaction,intent);
  }

  async #validStepUp(command: StaffStepUpCommand, session: string,
    expiresAtMs = command.expiresAtMs, cancellation?: AbortSignal): Promise<boolean> {
    const policy = this.#stepUpPolicy, sessions = this.#sessions;
    const scope = command.operation === 'PLATFORM_STAFF_SECURITY' ? null : command.tenantId;
    if (this.#closed || !opaque.test(session) || !policy || !this.#verifyStepUpFactor || !sessions.readProfile ||
        scope!==this.#config.tenantId) return false;
    const expires = Math.min(expiresAtMs, command.expiresAtMs);
    const checkedAt = this.#time();
    if (checkedAt >= expires) return false;
    return boundedDependency(async signal => {
      const live = (now: number) => !this.#closed && !signal.aborted && now >= checkedAt && now < expires;
      if (!await policy(command) || !live(this.#time())) return false;
      const profile = await sessions.readProfile!(session);
      const now = this.#time();
      return live(now) && profile.ok && now < profile.profile.expiresAtMs &&
        profile.profile.staffId === command.actorStaffId && profile.profile.tenantId === scope;
    }, expires - checkedAt, cancellation);
  }

  #begin(previousToken?: string, previousTransaction?: string, stepUp?: StaffStepUpCommand): { location: string; cookie: string } {
    const now = this.#time();
    for (const [id, t] of this.#transactions) if (t.expires <= now) this.#transactions.delete(id);
    this.cancel(previousTransaction);
    if (this.#closed || this.#transactions.size + this.#inflight.size >= 1000 || previousToken !== undefined && !opaque.test(previousToken)) throw fail();
    const id = random(), state = random(), nonce = random(), verifier = random();
    this.#transactions.set(id, { state, nonce, verifier, expires: now + 300_000, startedAtMs: now, cancellation: new AbortController(), ...(previousToken ? { previousToken } : {}), ...(stepUp && {stepUp}) });
    const location = new URL("authorize", this.#config.issuer);
    location.search = new URLSearchParams({ response_type: "code", response_mode: "query", client_id: this.#config.clientId,
      redirect_uri: this.#config.callbackUrl, audience: this.#config.audience, scope: "openid", state, nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      max_age: "0", prompt: "login" }).toString();
    return { location: location.href, cookie: transactionCookie(id) };
  }
  async #verify(token: unknown, kind: "id" | "access", now: Date, mark: (stage: StaffCallbackFailureStage) => void) {
    mark(kind === "id" ? "id-token-format" : "access-token-profile");
    if (!text(token, 8192) || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw fail();
    const h = decodeProtectedHeader(token);
    if (h.alg !== "RS256" || !text(h.kid, 128) || h.typ !== (kind === "id" ? "JWT" : "at+jwt") ||
        Object.keys(h).some(n => !["alg", "kid", "typ"].includes(n))) throw fail();
    mark(kind === "id" ? "id-token-verification" : "access-token-verification");
    const { payload: p } = await jwtVerify(token, async (header, jwt) => {
      const key = await this.#keys(header, jwt);
      if (!(key instanceof CryptoKey) || key.type !== "public" || key.algorithm.name !== "RSASSA-PKCS1-v1_5" ||
          !("modulusLength" in key.algorithm) || typeof key.algorithm.modulusLength !== "number" ||
          key.algorithm.modulusLength < 2048 || key.algorithm.modulusLength > 4096) throw fail();
      return key;
    }, { algorithms: ["RS256"], issuer: this.#config.issuer,
      audience: kind === "id" ? this.#config.clientId : this.#config.audience,
      requiredClaims: ["iss", "sub", "aud", "iat", "exp"], currentDate: now, clockTolerance: 0,
      maxTokenAge: 300 });
    const seconds = now.getTime() / 1000;
    if (!text(p.sub) || !date(p.iat) || !date(p.exp) || p.iat > seconds || p.exp <= p.iat ||
        p.nbf !== undefined && (!date(p.nbf) || p.nbf >= p.exp) ||
        ["act", "may_act", "gty", "sub_profile", "client_profile"].some(n => n in p)) throw fail();
    mark(kind === "id" ? "id-token-lifetime" : "access-token-lifetime");
    if (p.exp - p.iat > (kind === "id" ? 3600 : 300)) throw fail();
    mark(kind === "id" ? "id-token-verification" : "access-token-audience");
    if (!(kind === "id" ? p.aud === this.#config.clientId : this.#accessAudience(p.aud))) throw fail();
    mark(kind === "id" ? "id-token-mfa" : "access-token-claims");
    if (kind === "access" && (!text(p.jti, 256) || p['client_id'] !== this.#config.clientId ||
        'azp' in p)) throw fail();
    // Initial staff sign-in requests only openid and needs no Auth0 API permissions.
    // Reject unexpected management/linking scopes; local authority still comes only from IAM.
    if (kind === "access" && ('scope' in p && p['scope'] !== 'openid' ||
        'permissions' in p && (!Array.isArray(p['permissions']) || p['permissions'].length !== 0))) throw fail();
    if (kind === "access") {
      mark("staff-principal-claim");
      if (p[this.#config.staffKindClaim] !== "human") throw fail();
    }
    if (kind === "id" && (p['azp'] !== undefined && p['azp'] !== this.#config.clientId ||
        !date(p['auth_time']) || p['auth_time'] > seconds || seconds - p['auth_time'] > 300 || p['auth_time'] > p.iat ||
        !Array.isArray(p['amr']) || p['amr'].length > 16 || !p['amr'].every(v => text(v, 64)) || !p['amr'].includes("mfa"))) throw fail();
    return p;
  }
  #accessAudience(audience: unknown): boolean {
    if (audience === this.#config.audience) return true;
    // jose checks membership; the BFF additionally requires this complete, duplicate-free set.
    // No arbitrary second resource, alias, singleton array or token-selected trust configuration.
    const userinfo = new URL("userinfo", this.#config.issuer).href;
    return this.#config.accessTokenAudienceMode === "api-and-userinfo" && Array.isArray(audience) &&
      audience.length === 2 && audience.includes(this.#config.audience) && audience.includes(userinfo);
  }
  /** Invoke only a server-owned reader. Recheck the same canonical session
   * after work and before disclosing the returned data. */
  async readForSession<T>(token: string, read: (
    identity: ReturnType<typeof attestVerifiedStaffIdentity>, tenantId: string, staffId: string,
    revalidate:()=>Promise<boolean>
  ) => Promise<T>): Promise<T> {
    const tenantId = this.#config.tenantId;
    if (tenantId === null) throw fail();
    return this.#readScopedSession(token,(identity,staffId,revalidate)=>read(identity,tenantId,staffId,revalidate));
  }

  async readForPlatformSession<T>(token: string, read: (identity: ReturnType<typeof attestVerifiedStaffIdentity>, staffId: string) => Promise<T>): Promise<T> {
    if (this.#config.tenantId !== null) throw fail();
    return this.#readScopedSession(token,read);
  }

  get platformScope(): boolean { return this.#config.tenantId === null; }

  async #readScopedSession<T>(token: string, read: (identity: ReturnType<typeof attestVerifiedStaffIdentity>,
    staffId:string,revalidate:()=>Promise<boolean>) => Promise<T>): Promise<T> {
    const sessions=this.#sessions;
    if (!opaque.test(token) || this.#closed || !sessions.readProfile) throw fail();
    const key = createHash('sha256').update(token).digest('hex');
    const identity = this.#staffSessions.get(key);
    const before = await sessions.readProfile(token);
    if (!identity || !before.ok || before.profile.tenantId !== this.#config.tenantId ||
        this.#time() >= Math.min(identity.security.expiresAt*1000,before.profile.expiresAtMs)) throw fail();
    const revalidate=async()=>{
      const after=await sessions.readProfile!(token);
      return after.ok && !this.#closed && this.#staffSessions.get(key)===identity &&
        after.profile.staffId===before.profile.staffId && after.profile.tenantId===before.profile.tenantId &&
        this.#time()<Math.min(identity.security.expiresAt*1000,after.profile.expiresAtMs);
    };
    const result = await read(identity,before.profile.staffId,revalidate);
    if (!await revalidate()) throw fail();
    return result;
  }

  forgetSession(token: string): void {
    this.#staffSessions.delete(createHash('sha256').update(token).digest('hex'));
  }

  #rememberSession(token: string, identity: ReturnType<typeof attestVerifiedStaffIdentity>): void {
    const now = this.#time();
    for (const [key,value] of this.#staffSessions) if (value.security.expiresAt*1000 <= now) this.#staffSessions.delete(key);
    if (this.#staffSessions.size < 2048) this.#staffSessions.set(createHash('sha256').update(token).digest('hex'),identity);
  }

  /** The server selects the callback mode from the captured transaction. */
  async completeBrowserCallback(rawUrl: string, transactionId: string | undefined, currentToken?: string) {
    const command = transactionId ? this.#transactions.get(transactionId)?.stepUp : undefined;
    const result = await this.#complete(rawUrl,transactionId,currentToken,Boolean(command));
    if (command && result.proof) return { token:result.token, stepUp:{command,proof:result.proof} };
    return { token:result.token };
  }

  hasLiveStepUp(proof: StaffStepUpProof, session: string): boolean {
    const evidence = this.#stepUpProofs.get(proof);
    if (!evidence?.factorEvent || this.#closed || evidence.session!==session) return false;
    const now = this.#time();
    return now>=evidence.issuedAtMs && now<evidence.expiresAtMs;
  }

  async complete(rawUrl: string, transactionId: string | undefined, currentToken?: string): Promise<string> {
    return (await this.#complete(rawUrl, transactionId, currentToken, false)).token;
  }

  async completeStepUp(rawUrl: string, transactionId: string | undefined, currentToken?: string) {
    const result=await this.#complete(rawUrl,transactionId,currentToken,true);
    if(!result.proof)throw fail();
    return { token:result.token, proof:result.proof };
  }

  /** Consume even on mismatch; approval and execution are separate, downstream gates. */
  async consumeStepUp(proof: StaffStepUpProof, command: StaffStepUpCommand, session: string): Promise<StaffStepUpAuthorization | false> {
    const issued = this.#stepUpProofs.get(proof);
    this.#stepUpProofs.delete(proof);
    try {
      if (!issued || this.#closed || session !== issued.session ||
          JSON.stringify(copyStepUpCommand(command)) !== JSON.stringify(issued.command)) return false;
      const live = () => this.#time() >= issued.issuedAtMs && this.#time() < issued.expiresAtMs;
      const revalidate = async () => {
        try { return live() && await this.#validStepUp(issued.command, session, issued.expiresAtMs) && live(); }
        catch { return false; }
      };
      if (!await revalidate()) return false;
      return Object.freeze({ expiresAtMs: issued.expiresAtMs, factorEvent:issued.factorEvent, revalidate });
    } catch { return false; }
  }

  async #resolveStepUpFactor(claims: Readonly<Record<string, unknown>>, challenge: StaffFactorChallenge,
    transaction: Transaction, expiresAtMs: number): Promise<StaffProviderFactorEvent | null> {
    const verify = this.#verifyStepUpFactor;
    if (!verify) throw fail();
    return boundedDependency(signal => verify(claims, challenge, signal), expiresAtMs - this.#time(), transaction.cancellation.signal);
  }

  async #complete(rawUrl: string, transactionId: string | undefined, currentToken: string | undefined, stepUp: boolean):
      Promise<{ token: string; proof?: StaffStepUpProof }> {
    let stage: StaffCallbackFailureStage = "callback-state";
    const mark = (next: StaffCallbackFailureStage) => { stage = next; };
    // Consume before any await: replay, concurrent callbacks and failed exchanges cannot retry.
    const transaction = transactionId && opaque.test(transactionId) ? this.#transactions.get(transactionId) : undefined;
    if (transactionId) this.#transactions.delete(transactionId);
    if (transaction && transactionId) this.#inflight.set(transactionId, transaction);
    try {
      if (this.#closed || !transaction || transaction.expires <= this.#time() || rawUrl.length > 4096 ||
          !rawUrl.startsWith("/auth/callback?") || rawUrl.includes("#")) throw fail();
      if (stepUp !== Boolean(transaction.stepUp)) throw fail();
      if (transaction.stepUp && (!transaction.previousToken ||
          currentToken !== undefined && currentToken !== transaction.previousToken ||
          !await this.#validStepUp(transaction.stepUp, transaction.previousToken, transaction.expires, transaction.cancellation.signal))) throw fail();
      if (this.#closed || transaction.cancellation.signal.aborted || transaction.expires <= this.#time()) throw fail();
      const url = new URL(rawUrl, this.origin), params = url.searchParams;
      if (params.has("error")) mark("authorization-response");
      if (url.origin !== this.origin || url.pathname !== "/auth/callback" ||
          [...params.keys()].some(k => !["code", "state", "iss"].includes(k)) ||
          params.getAll("code").length !== 1 || params.getAll("state").length !== 1 || params.getAll("iss").length > 1 ||
          params.has("iss") && params.get("iss") !== this.#config.issuer ||
          !opaque.test(params.get("state") ?? "") || !equal(params.get("state")!, transaction.state) ||
          !text(params.get("code"), 2048) || currentToken !== undefined && currentToken !== transaction.previousToken) throw fail();
      mark("token-exchange");
      const tokens = await json(this.#fetch, new URL("oauth/token", this.#config.issuer).href, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: this.#config.clientId,
          client_secret: this.#config.clientSecret, redirect_uri: this.#config.callbackUrl, code: params.get("code")!, code_verifier: transaction.verifier }),
      }, 32_768, transaction.cancellation.signal);
      mark("token-response");
      if (tokens['token_type'] !== "Bearer" || !date(tokens['expires_in']) || tokens['expires_in'] < 1 || 'refresh_token' in tokens) throw fail();
      mark("access-token-lifetime");
      if (tokens['expires_in'] > 300) throw fail();
      const now = new Date(this.#time());
      const id = await this.#verify(tokens['id_token'], "id", now, mark), access = await this.#verify(tokens['access_token'], "access", now, mark);
      mark("signed-token-binding");
      const expiry = Math.min(access.exp!, id.exp!, (id['auth_time'] as number) + 300);
      const current = () => !transaction.cancellation.signal.aborted && !this.#closed &&
        this.#time() < Math.min(transaction.expires, expiry * 1000);
      if (!text(id['nonce'], 128) || !equal(id['nonce'], transaction.nonce) || id.sub !== access.sub || (id['auth_time'] as number) < Math.floor(transaction.startedAtMs/1000) ||
          (transaction.stepUp || id['at_hash'] !== undefined) && id['at_hash'] !== createHash("sha256").update(tokens['access_token'] as string).digest().subarray(0, 16).toString("base64url") ||
          !current()) throw fail();
      let stepUpExpiry: number | undefined;
      let factorEvent: StaffProviderFactorEvent | undefined;
      if (transaction.stepUp) {
        mark("privileged-assurance");
        const challenge=Object.freeze({issuer:this.#config.issuer,subject:access.sub!,clientId:this.#config.clientId,
          audience:this.#config.audience,nonce:transaction.nonce,challengeStartedAtMs:transaction.startedAtMs,
          credentialExpiresAtMs:expiry*1000});
        const expiresAtMs = Math.min(challenge.credentialExpiresAtMs, transaction.expires,
          transaction.stepUp.expiresAtMs, (id["auth_time"] as number)*1000 + STEP_UP_FRESHNESS_MS);
        const factor=await this.#resolveStepUpFactor(Object.freeze({...id}),challenge,transaction,expiresAtMs);
        if(!factor||typeof factor!=="object")throw fail();
        const {eventId,authenticatedAtMs}=factor;
        if(typeof eventId!=="string"||!uuid.test(eventId)||!date(authenticatedAtMs))throw fail();
        factorEvent=Object.freeze({eventId,authenticatedAtMs});
        const factorAtMs=factorEvent.authenticatedAtMs,checkedAtMs=this.#time();
        if(factorAtMs<challenge.challengeStartedAtMs||factorAtMs>checkedAtMs||!current())throw fail();
        stepUpExpiry=Math.min(expiresAtMs,factorAtMs+STEP_UP_FRESHNESS_MS);
        if(checkedAtMs>=stepUpExpiry)throw fail();
        for(const [eventId,expires] of this.#factorEvents)if(expires<=checkedAtMs)this.#factorEvents.delete(eventId);
        if(this.#factorEvents.has(factorEvent.eventId)||this.#factorEvents.size>=2048)throw fail();
        this.#factorEvents.set(factorEvent.eventId,factorAtMs+STEP_UP_FRESHNESS_MS);
      }
      const identity = attestVerifiedStaffIdentity({ issuer: this.#config.issuer, subject: access.sub!, security: {
        audience: this.#config.audience, clientId: this.#config.clientId, profile: "rfc9068-staff-v1", principalKind: "human",
        issuedAt: access.iat!, expiresAt: expiry, assurance: "not-established",
      } });
      mark("staff-authorization");
      const actor = await this.#actors.establish(identity, this.#config.tenantId ?? undefined);
      const mayRotate = () => current() && (stepUpExpiry === undefined || this.#time() < stepUpExpiry);
      if (!actor.allowed || !mayRotate()) throw fail();
      // Provider verification and actor lookup can outlast the persisted command's authority.
      if (transaction.stepUp && (!transaction.previousToken ||
          !await this.#validStepUp(transaction.stepUp, transaction.previousToken, stepUpExpiry, transaction.cancellation.signal) || !mayRotate())) throw fail();
      mark("session-persistence");
      const previous=transaction.previousToken;
      const session = !previous ? await this.#sessions.create(actor.actor) :
        !transaction.stepUp && this.#sessions.reauthenticate
          ? await this.#sessions.reauthenticate(actor.actor, previous)
          : await this.#sessions.rotate(actor.actor, previous);
      if (!session.ok) throw fail();
      const token = session.credential.cookieValue();
      if (!opaque.test(token)) throw fail();
      if (transaction.previousToken) this.forgetSession(transaction.previousToken);
      if (!current()) {
        await this.#sessions.revoke(token); throw fail();
      }
      if (transaction.stepUp) {
        const command=transaction.stepUp;
        const issuedAtMs=this.#time();
        const expiresAtMs = stepUpExpiry ?? 0;
        try {
          if (!factorEvent || issuedAtMs>=expiresAtMs || !await this.#validStepUp(command,token,expiresAtMs,transaction.cancellation.signal) ||
              !current() || this.#time()>=expiresAtMs) throw fail();
          const proof=Object.freeze({}) as StaffStepUpProof;
          const verifiedEvent = Object.freeze({ ...factorEvent, issuer:this.#config.issuer, subject:access.sub!,
            identityIssuedAtMs:access.iat!*1000, sessionDigest:createHash('sha256').update(token).digest('hex') });
          this.#stepUpProofs.set(proof,{command,session:token,issuedAtMs,expiresAtMs,factorEvent:verifiedEvent});
          this.#rememberSession(token,identity);
          return {token,proof};
        } catch { await this.#sessions.revoke(token); throw fail(); }
      }
      this.#rememberSession(token,identity);
      return { token };
    } catch {
      try { this.#reportCallbackFailure?.(stage); } catch { /* Diagnostics must never alter authentication. */ }
      throw fail();
    }
    finally { if (transactionId && this.#inflight.get(transactionId) === transaction) this.#inflight.delete(transactionId); }
  }
  close(): void {
    this.#closed = true;
    this.#staffSessions.clear();
    this.#factorEvents.clear();
    for (const t of [...this.#transactions.values(), ...this.#inflight.values()]) t.cancellation.abort();
    this.#transactions.clear();
  }
  cancel(id: string | undefined): void {
    if (!id) return;
    const t = this.#transactions.get(id) ?? this.#inflight.get(id);
    t?.cancellation.abort();
    this.#transactions.delete(id);
  }
}
