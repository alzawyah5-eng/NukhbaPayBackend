import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { StaffSessionLifecycle, TrustedStaffActorBoundary, consumeStaffSessionTicket } from "@nukhbapay/application";
import type { StaffAuthorizationRepository, StaffSessionStore, SessionStoreOutcome, SecurityAuditEvent, SecurityAuditWriter } from "@nukhbapay/application";
import { Auth0Login, type Auth0Configuration, type StaffStepUpCommand } from "../../src/auth0.js";

export const config = {
  issuer: "https://auth.synthetic.invalid/", clientId: "synthetic-browser", clientSecret: "synthetic-secret-".repeat(3),
  audience: "urn:nukhbapay:synthetic:staff-api", staffKindClaim: "https://claims.synthetic.invalid/principal",
  callbackUrl: "https://localhost:3001/auth/callback", tenantId: "00000000-0000-4000-8000-000000000002",
} satisfies Auth0Configuration;
const staffId = "00000000-0000-4000-8000-000000000001";
const keys = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(keys.publicKey), kid: "synthetic-key", alg: "RS256", use: "sig" };
type Claims = Record<string, unknown>;
export async function fixture(callbackUrl = config.callbackUrl, configuration: Partial<Auth0Configuration> = {},
  stepUp: Pick<ConstructorParameters<typeof Auth0Login>[1], "stepUpPolicy" | "verifyStepUpFactor"> = {},
  person = {staffId,subject:"synthetic-staff"}) {
  const settings = { ...config, callbackUrl, ...configuration };
  let ms = Date.UTC(2026, 10, 13), version = 1n, suspended = false, member = true, enrolled = true, auditFailure = false, storeFailure = false;
  let idChanges: Claims = {}, accessChanges: Claims = {}, tokenChanges: Claims = {}, wrongKey = false, exchanges = 0;
  let idHeader: Claims = {}, accessHeader: Claims = {};
  let responseMode = "ok", nonce = "", lastBody = new URLSearchParams();
  let beforeStore: (() => Promise<void>) | undefined;
  let beforeIdentityLookup: (() => void) | undefined;
  let databaseFailure=false,disabledIdentity=false;
  let tokensValidAfter:string|null=null,principalStaffId=person.staffId;
  const auditEvents:SecurityAuditEvent[]=[];
  const rows = new Map<string, { revoked: boolean; binding: string; expires: number }>();
  const repository: StaffAuthorizationRepository = {
      findByTrustedIdentity: async i => {
        beforeIdentityLookup?.();
        if(databaseFailure)throw new Error('Private synthetic database failure');
        return enrolled && i.issuer === config.issuer && i.subject === person.subject ? {
          staffId:principalStaffId, staffStatus: suspended ? "SUSPENDED" : "ACTIVE", identityStatus: disabledIdentity?'DISABLED':'ACTIVE', tokensValidAfter, authzVersion: version,
        } : null;
      },
      findPlatformRoleGrants: async () => [],
      findTenantMembership: async (_staff, tenant) => member && tenant === config.tenantId ? {
        membershipId: config.tenantId, tenantId: config.tenantId, status: "ACTIVE", version: 1n, roleGrants: [],
      } : null,
  };
  const auditWriter: SecurityAuditWriter = { appendSecurityAuditEvents: async events => {
    if (auditFailure) throw new Error("private audit failure"); auditEvents.push(...events);
  } };
  const actors = new TrustedStaffActorBoundary({ now: () => new Date(ms), sessionIssuers: [config.issuer], repository, auditWriter });
  const store: StaffSessionStore = { execute: async (t): Promise<SessionStoreOutcome> => {
    if (!consumeStaffSessionTicket(t) || !await t.revalidate()) return "DENIED";
    if (storeFailure) return "UNRESOLVED";
    if (t.operation === "CREATE" || t.operation === "ROTATE") {
      await beforeStore?.();
      if (t.previousHash) { const old = rows.get(t.previousHash); if (!old || old.revoked) return "DENIED"; old.revoked = true; }
      rows.set(t.tokenHash, { revoked: false, binding: JSON.stringify(t.binding), expires: t.expiresAtMs }); return "COMMITTED";
    }
    const row = rows.get(t.tokenHash);
    if (!row || row.binding !== JSON.stringify(t.binding)) return "DENIED";
    if (t.operation === "REVOKE") { row.revoked = true; return "REVOKED"; }
    if (t.operation === "CHECK_REVOKED") return row.revoked ? "REVOKED" : "ACTIVE";
    return !row.revoked && t.nowMs < row.expires ? "ACTIVE" : "DENIED";
  } };
  const sessions = new StaffSessionLifecycle({ actors, store, now: () => new Date(ms), enabled: true });
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(options?.redirect, "error"); assert.equal(options?.credentials, "omit"); assert.equal(options?.cache, "no-store");
    if (String(url).endsWith("/.well-known/jwks.json")) {
      if (responseMode === "jwks-private") return Response.json({ keys: [{ ...jwk, d: "private-material" }] });
      if (responseMode === "jwks-empty") return Response.json({ keys: [] });
      if (responseMode === "jwks-error") throw new Error("private JWKS transport error");
      return Response.json({ keys: [jwk] });
    }
    assert.equal(String(url), "https://auth.synthetic.invalid/oauth/token"); exchanges++;
    lastBody = new URLSearchParams(options?.body as URLSearchParams);
    assert.equal(options?.method, "POST");
    if (responseMode === "error") throw new Error("private secret transport failure");
    if (responseMode === "redirect") return new Response("", { status: 302, headers: { location: "https://attacker.invalid/" } });
    if (responseMode === "oversize") return new Response("x".repeat(32769), { headers: { "content-type": "application/json" } });
    if (responseMode === "bad-json") return new Response("{", { headers: { "content-type": "application/json" } });
    if (responseMode === "stalled-body") return new Response(new ReadableStream({ pull: () => new Promise<void>(() => undefined) }), { headers: { "content-type": "application/json" } });
    const seconds = Math.floor(ms / 1000);
    const sign = async (claims: Claims, typ: string, header: Claims) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: jwk.kid, typ, ...header })
      .sign(wrongKey ? (await generateKeyPair("RS256")).privateKey : keys.privateKey);
    const access = await sign({ iss: config.issuer, sub: person.subject, aud: config.audience, iat: seconds, exp: seconds + 300,
      jti: "synthetic-event", client_id: config.clientId, [settings.staffKindClaim]: "human", ...accessChanges }, "at+jwt", accessHeader);
    const id = await sign({ iss: config.issuer, sub: person.subject, aud: config.clientId, iat: seconds, exp: seconds + 300,
      nonce, auth_time: seconds, amr: ["pwd", "mfa"], at_hash: createHash("sha256").update(access).digest().subarray(0, 16).toString("base64url"), ...idChanges }, "JWT", idHeader);
    return Response.json({ token_type: "Bearer", expires_in: 300, id_token: id, access_token: access, ...tokenChanges });
  };
  const login = new Auth0Login(settings, { actors, sessions, fetch: fetcher, now: () => new Date(ms), ...stepUp });
  const callbackFor = (started: ReturnType<Auth0Login["begin"]>) => {
    const url = new URL(started.location);
    nonce = url.searchParams.get("nonce")!;
    const cookie = started.cookie.split(";")[0]!.split("=")[1]!;
    const callback = "/auth/callback?" + new URLSearchParams({ code: "synthetic-code", state: url.searchParams.get("state")! });
    return { ...started, cookieHeader: started.cookie, url, cookie, callback };
  };
  return { login, sessions, callbackFor, begin: (old?: string) => callbackFor(login.begin(old)),
    beginStepUp: async (command: StaffStepUpCommand, session: string) => callbackFor(await login.beginStepUp(command, session)), rows, auditEvents, fetch:fetcher, now:()=>new Date(ms), exchanges: () => exchanges, body: () => lastBody,
    backend: { repository, auditWriter, sessionStore: store, checkReadiness: async () => !databaseFailure && !storeFailure && !auditFailure },
    cutoff:(value:string|null)=>{tokensValidAfter=value;},rebindStaff:(value:string)=>{principalStaffId=value;},
    restoreStaff:()=>{suspended=false;},restoreIdentity:()=>{disabledIdentity=false;},
    pauseStore: (callback: () => Promise<void>) => { beforeStore = callback; },
    onIdentityLookup: (callback: (() => void) | undefined) => { beforeIdentityLookup = callback; },
    id: (v: Claims) => { idChanges = v; }, access: (v: Claims) => { accessChanges = v; }, tokens: (v: Claims) => { tokenChanges = v; },
    idHeader: (v: Claims) => { idHeader = v; }, accessHeader: (v: Claims) => { accessHeader = v; },
    mode: (v: string) => { responseMode = v; }, wrongKey: () => { wrongKey = true; }, advance: (v: number) => { ms += v; },
    suspend: () => { suspended = true; }, membership: () => { member = false; }, unenroll: () => { enrolled = false; },
    version: () => { version++; }, audit: () => { auditFailure = true; }, store: () => { storeFailure = true; },
    database:()=>{databaseFailure=true;},disabledIdentity:()=>{disabledIdentity=true;},
  };
}
