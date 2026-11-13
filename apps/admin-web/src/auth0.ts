import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { inspect } from "node:util";
import { createRemoteJWKSet, customFetch, decodeProtectedHeader, jwtVerify } from "jose";
import { attestVerifiedStaffIdentity } from "@nukhbapay/application/verified-identity";
import type { StaffSessionLifecycle, TrustedStaffActorBoundary } from "@nukhbapay/application";

export const TRANSACTION_COOKIE_NAME = "__Host-nukhbapay_oidc";
const opaque = /^[A-Za-z0-9_-]{43}$/;
const fail = () => new Error("Staff authentication failed");
const random = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const text = (v: unknown, max = 512): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\s\u0000-\u001f\u007f]/.test(v);
const date = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export interface Auth0Configuration {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly audience: string;
  readonly staffKindClaim: string;
  readonly callbackUrl: string;
  /** Selected by trusted server composition, never callback/query/claim data. */
  readonly tenantId: string;
}

function configuration(input: Auth0Configuration): Readonly<Auth0Configuration> {
  try {
    const issuer = new URL(input.issuer), callback = new URL(input.callbackUrl), claim = new URL(input.staffKindClaim), audience = new URL(input.audience);
    if (issuer.protocol !== "https:" || issuer.href !== input.issuer || issuer.pathname !== "/" || issuer.search || issuer.hash ||
        issuer.username || issuer.password || issuer.port || isIP(issuer.hostname) || !issuer.hostname.includes(".") ||
        /(?:^|\.)(?:localhost|local)$/.test(issuer.hostname) ||
        callback.href !== input.callbackUrl || callback.origin !== `https://localhost:${callback.port}` || !callback.port ||
        callback.pathname !== "/auth/callback" || callback.search || callback.hash || callback.username || callback.password ||
        !text(input.clientId, 128) || !text(input.clientSecret, 4096) || input.clientSecret.length < 32 ||
        !["https:", "urn:"].includes(audience.protocol) || audience.username || audience.password || audience.search || audience.hash ||
        claim.protocol !== "https:" || claim.href !== input.staffKindClaim || claim.pathname === "/" || claim.search || claim.hash || claim.username || claim.password ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.tenantId)) throw fail();
    return Object.freeze({ ...input });
  } catch { throw fail(); }
}

/** Bound the complete exchange, including streamed bodies. No redirects or ambient credentials. */
async function json(fetcher: typeof fetch, url: string, init: RequestInit, maximum: number): Promise<Record<string, unknown>> {
  const signal = AbortSignal.timeout(3000);
  const abortable = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const abort = () => reject(fail());
    if (signal.aborted) { void operation.catch(() => undefined); reject(fail()); return; }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, () => reject(fail())).finally(() => signal.removeEventListener("abort", abort));
  });
  const response = await abortable(fetcher(url, { ...init, signal, redirect: "error", credentials: "omit", cache: "no-store" }));
  const length = response.headers.get("content-length");
  if (response.status !== 200 || response.url && response.url !== url ||
      !["application/json", "application/jwk-set+json"].includes(response.headers.get("content-type")?.split(";")[0]?.trim() ?? "") ||
      length !== null && (!/^\d{1,10}$/.test(length) || Number(length) > maximum) || !response.body) {
    void response.body?.cancel().catch(() => undefined); throw fail();
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await abortable(reader.read());
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

interface Transaction {
  readonly state: string; readonly nonce: string; readonly verifier: string; readonly expires: number; readonly started: number;
  readonly previousToken?: string;
  cancelled: boolean;
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
  constructor(config: Auth0Configuration, dependencies: {
    readonly actors: Pick<TrustedStaffActorBoundary, "establish">;
    readonly sessions: Pick<StaffSessionLifecycle, "create" | "rotate" | "revoke">;
    readonly fetch?: typeof fetch; readonly now?: () => Date;
  }) {
    this.#config = configuration(config);
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#now = dependencies.now ?? (() => new Date());
    this.#actors = dependencies.actors; this.#sessions = dependencies.sessions;
    const jwksUrl = new URL(".well-known/jwks.json", this.#config.issuer).href;
    this.#keys = createRemoteJWKSet(new URL(jwksUrl), {
      cacheMaxAge: 300_000, cooldownDuration: 30_000, timeoutDuration: 3000,
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
    const now = this.#time();
    for (const [id, t] of this.#transactions) if (t.expires <= now) this.#transactions.delete(id);
    this.cancel(previousTransaction);
    if (this.#closed || this.#transactions.size + this.#inflight.size >= 1000 || previousToken !== undefined && !opaque.test(previousToken)) throw fail();
    const id = random(), state = random(), nonce = random(), verifier = random();
    this.#transactions.set(id, { state, nonce, verifier, expires: now + 300_000, started: Math.floor(now / 1000), cancelled: false, ...(previousToken ? { previousToken } : {}) });
    const location = new URL("authorize", this.#config.issuer);
    location.search = new URLSearchParams({ response_type: "code", response_mode: "query", client_id: this.#config.clientId,
      redirect_uri: this.#config.callbackUrl, audience: this.#config.audience, scope: "openid", state, nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      max_age: "0", prompt: "login" }).toString();
    return { location: location.href, cookie: transactionCookie(id) };
  }
  async #verify(token: unknown, kind: "id" | "access", now: Date) {
    if (!text(token, 8192) || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw fail();
    const h = decodeProtectedHeader(token);
    if (h.alg !== "RS256" || !text(h.kid, 128) || h.typ !== (kind === "id" ? "JWT" : "at+jwt") ||
        Object.keys(h).some(n => !["alg", "kid", "typ"].includes(n))) throw fail();
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
        p.exp - p.iat > (kind === "id" ? 3600 : 300) ||
        p.aud !== (kind === "id" ? this.#config.clientId : this.#config.audience) ||
        p.nbf !== undefined && (!date(p.nbf) || p.nbf >= p.exp) ||
        ["act", "may_act", "gty", "sub_profile", "client_profile"].some(n => n in p)) throw fail();
    if (kind === "access" && (!text(p.jti, 256) || p['client_id'] !== this.#config.clientId ||
        p[this.#config.staffKindClaim] !== "human" || 'azp' in p)) throw fail();
    if (kind === "id" && (p['azp'] !== undefined && p['azp'] !== this.#config.clientId ||
        !date(p['auth_time']) || p['auth_time'] > seconds || seconds - p['auth_time'] > 300 || p['auth_time'] > p.iat ||
        !Array.isArray(p['amr']) || p['amr'].length > 16 || !p['amr'].every(v => text(v, 64)) || !p['amr'].includes("mfa"))) throw fail();
    return p;
  }
  async complete(rawUrl: string, transactionId: string | undefined, currentToken?: string): Promise<string> {
    // Consume before any await: replay, concurrent callbacks and failed exchanges cannot retry.
    const transaction = transactionId && opaque.test(transactionId) ? this.#transactions.get(transactionId) : undefined;
    if (transactionId) this.#transactions.delete(transactionId);
    if (transaction && transactionId) this.#inflight.set(transactionId, transaction);
    try {
      if (this.#closed || !transaction || transaction.expires <= this.#time() || rawUrl.length > 4096 ||
          !rawUrl.startsWith("/auth/callback?") || rawUrl.includes("#")) throw fail();
      const url = new URL(rawUrl, this.origin), params = url.searchParams;
      if (url.origin !== this.origin || url.pathname !== "/auth/callback" ||
          [...params.keys()].some(k => !["code", "state", "iss"].includes(k)) ||
          params.getAll("code").length !== 1 || params.getAll("state").length !== 1 || params.getAll("iss").length > 1 ||
          params.has("iss") && params.get("iss") !== this.#config.issuer ||
          !opaque.test(params.get("state") ?? "") || !equal(params.get("state")!, transaction.state) ||
          !text(params.get("code"), 2048) || currentToken !== undefined && currentToken !== transaction.previousToken) throw fail();
      const tokens = await json(this.#fetch, new URL("oauth/token", this.#config.issuer).href, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: this.#config.clientId,
          client_secret: this.#config.clientSecret, redirect_uri: this.#config.callbackUrl, code: params.get("code")!, code_verifier: transaction.verifier }),
      }, 32_768);
      if (tokens['token_type'] !== "Bearer" || !date(tokens['expires_in']) || tokens['expires_in'] < 1 || tokens['expires_in'] > 300 ||
          'refresh_token' in tokens) throw fail();
      const now = new Date(this.#time());
      const id = await this.#verify(tokens['id_token'], "id", now), access = await this.#verify(tokens['access_token'], "access", now);
      if (!text(id['nonce'], 128) || !equal(id['nonce'], transaction.nonce) || id.sub !== access.sub || (id['auth_time'] as number) < transaction.started ||
          id['at_hash'] !== undefined && id['at_hash'] !== createHash("sha256").update(tokens['access_token'] as string).digest().subarray(0, 16).toString("base64url") ||
          transaction.expires <= this.#time() || this.#time() >= Math.min(id.exp!, access.exp!) * 1000) throw fail();
      const identity = attestVerifiedStaffIdentity({ issuer: this.#config.issuer, subject: access.sub!, security: {
        audience: this.#config.audience, clientId: this.#config.clientId, profile: "rfc9068-staff-v1", principalKind: "human",
        issuedAt: access.iat!, expiresAt: Math.min(access.exp!, id.exp!, (id['auth_time'] as number) + 300), assurance: "not-established",
      } });
      const actor = await this.#actors.establish(identity, this.#config.tenantId);
      if (!actor.allowed || transaction.cancelled || this.#closed || transaction.expires <= this.#time()) throw fail();
      const session = transaction.previousToken ? await this.#sessions.rotate(actor.actor, transaction.previousToken) : await this.#sessions.create(actor.actor);
      if (!session.ok) throw fail();
      const token = session.credential.cookieValue();
      if (!opaque.test(token)) throw fail();
      if (transaction.cancelled || this.#closed || transaction.expires <= this.#time()) {
        await this.#sessions.revoke(token); throw fail();
      }
      return token;
    } catch { throw fail(); }
    finally { if (transactionId && this.#inflight.get(transactionId) === transaction) this.#inflight.delete(transactionId); }
  }
  close(): void {
    this.#closed = true;
    for (const t of [...this.#transactions.values(), ...this.#inflight.values()]) t.cancelled = true;
    this.#transactions.clear();
  }
  cancel(id: string | undefined): void {
    if (!id) return;
    const t = this.#transactions.get(id) ?? this.#inflight.get(id);
    if (t) t.cancelled = true;
    this.#transactions.delete(id);
  }
}
