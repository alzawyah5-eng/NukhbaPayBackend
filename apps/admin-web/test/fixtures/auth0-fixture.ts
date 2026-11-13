import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { StaffSessionLifecycle, TrustedStaffActorBoundary, consumeStaffSessionTicket } from "@nukhbapay/application";
import type { StaffSessionStore, SessionStoreOutcome } from "@nukhbapay/application";
import { Auth0Login, type Auth0Configuration } from "../../src/auth0.js";

export const config: Auth0Configuration = {
  issuer: "https://auth.synthetic.invalid/", clientId: "synthetic-browser", clientSecret: "synthetic-secret-".repeat(3),
  audience: "urn:nukhbapay:synthetic:staff-api", staffKindClaim: "https://claims.synthetic.invalid/principal",
  callbackUrl: "https://localhost:3001/auth/callback", tenantId: "00000000-0000-4000-8000-000000000002",
};
const staffId = "00000000-0000-4000-8000-000000000001";
const keys = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(keys.publicKey), kid: "synthetic-key", alg: "RS256", use: "sig" };
type Claims = Record<string, unknown>;
export async function fixture(callbackUrl = config.callbackUrl) {
  let ms = Date.UTC(2026, 10, 13), version = 1n, suspended = false, member = true, enrolled = true, auditFailure = false, storeFailure = false;
  let idChanges: Claims = {}, accessChanges: Claims = {}, tokenChanges: Claims = {}, wrongKey = false, exchanges = 0;
  let responseMode = "ok", nonce = "", lastBody = new URLSearchParams();
  let beforeStore: (() => Promise<void>) | undefined;
  const rows = new Map<string, { revoked: boolean; binding: string; expires: number }>();
  const actors = new TrustedStaffActorBoundary({ now: () => new Date(ms), sessionIssuers: [config.issuer],
    repository: {
      findByTrustedIdentity: async i => enrolled && i.issuer === config.issuer && i.subject === "synthetic-staff" ? {
        staffId, staffStatus: suspended ? "SUSPENDED" : "ACTIVE", identityStatus: "ACTIVE", tokensValidAfter: null, authzVersion: version,
      } : null,
      findPlatformRoleGrants: async () => [],
      findTenantMembership: async (_staff, tenant) => member && tenant === config.tenantId ? {
        membershipId: config.tenantId, tenantId: config.tenantId, status: "ACTIVE", version: 1n, roleGrants: [],
      } : null,
    }, auditWriter: { appendSecurityAuditEvents: async () => { if (auditFailure) throw new Error("private audit failure"); } },
  });
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
    const sign = async (claims: Claims, typ: string) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: jwk.kid, typ })
      .sign(wrongKey ? (await generateKeyPair("RS256")).privateKey : keys.privateKey);
    const access = await sign({ iss: config.issuer, sub: "synthetic-staff", aud: config.audience, iat: seconds, exp: seconds + 300,
      jti: "synthetic-event", client_id: config.clientId, [config.staffKindClaim]: "human", ...accessChanges }, "at+jwt");
    const id = await sign({ iss: config.issuer, sub: "synthetic-staff", aud: config.clientId, iat: seconds, exp: seconds + 300,
      nonce, auth_time: seconds, amr: ["pwd", "mfa"], at_hash: createHash("sha256").update(access).digest().subarray(0, 16).toString("base64url"), ...idChanges }, "JWT");
    return Response.json({ token_type: "Bearer", expires_in: 300, id_token: id, access_token: access, ...tokenChanges });
  };
  const login = new Auth0Login({ ...config, callbackUrl }, { actors, sessions, fetch: fetcher, now: () => new Date(ms) });
  const begin = (old?: string) => {
    const started = login.begin(old), url = new URL(started.location);
    nonce = url.searchParams.get("nonce")!;
    const cookie = started.cookie.split(";")[0]!.split("=")[1]!;
    const callback = "/auth/callback?" + new URLSearchParams({ code: "synthetic-code", state: url.searchParams.get("state")! });
    return { ...started, cookieHeader: started.cookie, url, cookie, callback };
  };
  return { login, sessions, begin, rows, exchanges: () => exchanges, body: () => lastBody,
    pauseStore: (callback: () => Promise<void>) => { beforeStore = callback; },
    id: (v: Claims) => { idChanges = v; }, access: (v: Claims) => { accessChanges = v; }, tokens: (v: Claims) => { tokenChanges = v; },
    mode: (v: string) => { responseMode = v; }, wrongKey: () => { wrongKey = true; }, advance: (v: number) => { ms += v; },
    suspend: () => { suspended = true; }, membership: () => { member = false; }, unenroll: () => { enrolled = false; },
    version: () => { version++; }, audit: () => { auditFailure = true; }, store: () => { storeFailure = true; },
  };
}
