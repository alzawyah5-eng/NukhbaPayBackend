import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import type { TrustedStaffActorBoundary } from "@nukhbapay/application";
import { Auth0Login, transactionCookie } from "../src/auth0.js";
import { config, fixture } from "./fixtures/auth0-fixture.js";
type Claims = Record<string, unknown>;

test("authorization request binds independent state/nonce and S256 PKCE, confidential exchange stays server-side", async () => {
  const f = await fixture(), start = f.begin(), p = start.url.searchParams;
  assert.equal(start.url.origin, new URL(config.issuer).origin); assert.equal(p.get("redirect_uri"), config.callbackUrl);
  assert.equal(p.get("scope"), "openid"); assert.equal(p.get("code_challenge_method"), "S256"); assert.equal(p.get("response_mode"), "query");
  assert.notEqual(p.get("state"), p.get("nonce")); assert.equal(p.has("client_secret"), false);
  assert.match(start.cookieHeader, /Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=300/); assert.equal(start.cookieHeader.includes("Domain="), false);
  const raw = await f.login.complete(start.callback, start.cookie);
  assert.match(raw, /^[A-Za-z0-9_-]{43}$/); assert.equal((await f.sessions.validate(raw)).ok, true);
  assert.equal(f.body().get("client_secret"), config.clientSecret); assert.equal(f.body().get("redirect_uri"), config.callbackUrl);
  assert.equal(createHash("sha256").update(f.body().get("code_verifier")!).digest("base64url"), p.get("code_challenge"));
  assert.equal(JSON.stringify([...f.rows]).includes(raw), false);
  for (const s of [JSON.stringify(f.login), inspect(f.login), start.location]) assert.equal(s.includes(config.clientSecret), false);
  await assert.rejects(() => f.login.complete(start.callback, start.cookie), { message: "Staff authentication failed" });
  assert.equal(f.exchanges(), 1);
});

test("exact callback/state/browser binding rejects substitutions, duplicates, errors, expiry and concurrent replay", async () => {
  for (const change of ["state", "cookie", "duplicate", "error", "issuer", "path", "absolute", "fragment", "extra", "expired", "session"]) {
    const f = await fixture(), s = f.begin(); let path = s.callback, cookie: string | undefined = s.cookie;
    if (change === "state") path = path.replace(/state=.*/, "state=" + "A".repeat(43));
    if (change === "cookie") cookie = undefined;
    if (change === "duplicate") path += "&code=second";
    if (change === "error") path += "&error=access_denied";
    if (change === "issuer") path += "&iss=https%3A%2F%2Fattacker.invalid%2F";
    if (change === "path") path = path.replace("/auth/callback", "/auth/%63allback");
    if (change === "absolute") path = config.callbackUrl + path.slice(path.indexOf("?"));
    if (change === "fragment") path += "#fragment";
    if (change === "extra") path += "&tenant=forged";
    if (change === "expired") f.advance(300000);
    await assert.rejects(() => f.login.complete(path, cookie, change === "session" ? "B".repeat(43) : undefined));
    assert.equal(f.exchanges(), 0, change); assert.equal(f.rows.size, 0);
  }
  const f = await fixture(), s = f.begin();
  const results = await Promise.allSettled([f.login.complete(s.callback, s.cookie), f.login.complete(s.callback, s.cookie)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(f.exchanges(), 1);
});

test("signed ID token requires exact trust, nonce, subject, MFA, fresh auth_time and access-token hash", async () => {
  const invalid: Claims[] = [{ iss: "https://wrong.invalid/" }, { aud: "other-client" }, { aud: [config.clientId, "other"] },
    { azp: "other" }, { sub: "other-person" }, { nonce: "wrong" }, { amr: ["pwd"] }, { amr: null },
    { auth_time: undefined }, { auth_time: 0 }, { auth_time: Date.UTC(2026, 10, 13) / 1000 - 1 },
    { auth_time: 9999999999 }, { iat: 9999999999 }, { exp: 0 }, { at_hash: "wrong" }];
  for (const claims of invalid) {
    const f = await fixture(), s = f.begin(); f.id(claims);
    await assert.rejects(() => f.login.complete(s.callback, s.cookie), { message: "Staff authentication failed" }); assert.equal(f.rows.size, 0);
  }
  const f = await fixture(), s = f.begin(); f.wrongKey(); await assert.rejects(() => f.login.complete(s.callback, s.cookie));
});

test("RFC9068 access-token audience, client, human profile and identity must match; ID tokens cannot replace access tokens", async () => {
  for (const claims of [{ iss: "https://wrong.invalid/" }, { aud: config.clientId }, { client_id: "other" }, { azp: config.clientId },
    { [config.staffKindClaim]: "machine" }, { jti: undefined }, { sub: "other" }, { act: {} }, { exp: 9999999999 }]) {
    const f = await fixture(), s = f.begin(); f.access(claims); await assert.rejects(() => f.login.complete(s.callback, s.cookie)); assert.equal(f.rows.size, 0);
  }
  for (const tokens of [{ token_type: "other" }, { expires_in: 301 }, { refresh_token: "unexpected" }, { access_token: "opaque-token" }, { id_token: undefined }]) {
    const f = await fixture(), s = f.begin(); f.tokens(tokens); await assert.rejects(() => f.login.complete(s.callback, s.cookie)); assert.equal(f.rows.size, 0);
  }
});

test("unenrolled/suspended staff, foreign membership, audit and store failures never mint browser sessions", async () => {
  for (const change of ["unenroll", "suspend", "membership", "audit", "store"] as const) {
    const f = await fixture(), s = f.begin(); f[change](); await assert.rejects(() => f.login.complete(s.callback, s.cookie)); assert.equal(f.rows.size, 0);
  }
  for (const change of ["suspend", "membership", "version"] as const) {
    const f = await fixture(), s = f.begin(), raw = await f.login.complete(s.callback, s.cookie); f[change]();
    assert.equal((await f.sessions.validate(raw)).ok, false);
  }
});

test("reauthentication rotates captured Strict-cookie session and logout cancels outstanding authentication", async () => {
  const f = await fixture(), s = f.begin(), old = await f.login.complete(s.callback, s.cookie), next = f.begin(old);
  // SameSite=Strict session is absent on the cross-site callback; previous credential is server-side.
  const raw = await f.login.complete(next.callback, next.cookie); assert.notEqual(raw, old);
  assert.equal((await f.sessions.validate(old)).ok, false); assert.equal((await f.sessions.validate(raw)).ok, true);
  const pending = f.begin(raw); f.login.cancel(pending.cookie); await assert.rejects(() => f.login.complete(pending.callback, pending.cookie));
  assert.equal((await f.sessions.revoke(raw)).ok, true); assert.equal((await f.sessions.validate(raw)).ok, false);
});

test("network errors, redirects, oversized/malformed responses consume transactions and disclose no provider details", async () => {
  for (const mode of ["error", "redirect", "oversize", "bad-json", "jwks-private", "jwks-empty", "jwks-error"]) {
    const f = await fixture(), s = f.begin(); f.mode(mode);
    await assert.rejects(() => f.login.complete(s.callback, s.cookie), { message: "Staff authentication failed" });
    await assert.rejects(() => f.login.complete(s.callback, s.cookie)); assert.equal(f.exchanges(), 1); assert.equal(f.rows.size, 0);
  }
});

test("logout or shutdown during an in-flight session commit never returns a credential", async () => {
  for (const shutdown of [false, true]) {
    const f = await fixture(), s = f.begin();
    let resume!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { resume = r; }), paused = new Promise<void>(r => { entered = r; });
    f.pauseStore(async () => { entered(); await gate; });
    const callback = f.login.complete(s.callback, s.cookie);
    const rejected = assert.rejects(() => callback, { message: "Staff authentication failed" });
    await paused;
    if (shutdown) f.login.close(); else f.login.cancel(s.cookie);
    resume(); await rejected;
    assert.equal(f.rows.size, 1); assert.equal([...f.rows.values()].every(row => row.revoked), true);
  }
});

test("the exchange deadline covers a stalled response body, not just response headers", async () => {
  const f = await fixture(), s = f.begin(); f.mode("stalled-body");
  const keepAlive = setTimeout(() => undefined, 5000);
  try { await assert.rejects(() => f.login.complete(s.callback, s.cookie), { message: "Staff authentication failed" }); }
  finally { clearTimeout(keepAlive); }
  assert.equal(f.rows.size, 0); assert.equal(f.exchanges(), 1);
});

test("configuration rejects callback aliases, untrusted endpoints, missing credentials and client-supplied tenant scope", async () => {
  const f = await fixture();
  for (const change of [{ issuer: "http://auth.synthetic.invalid/" }, { issuer: "https://localhost/" }, { issuer: "https://auth.synthetic.invalid/other/" },
    { callbackUrl: "https://localhost:3001/auth/callback/" }, { callbackUrl: "https://localhost:3001/auth/callback?x=1" },
    { callbackUrl: "https://attacker.invalid/auth/callback" }, { clientSecret: "" }, { tenantId: "forged" }]) {
    assert.throws(() => new Auth0Login({ ...config, ...change }, { actors: {} as TrustedStaffActorBoundary, sessions: f.sessions }));
  }
  assert.match(transactionCookie("", true), /Max-Age=0/);
  const pending = f.begin(); f.login.close(); await assert.rejects(() => f.login.complete(pending.callback, pending.cookie));
});
