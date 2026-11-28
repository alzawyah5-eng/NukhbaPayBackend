import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import type { TrustedStaffActorBoundary } from "@nukhbapay/application";
import { Auth0Login, transactionCookie } from "../src/auth0.js";
import { config, fixture } from "./fixtures/auth0-fixture.js";
type Claims = Record<string, unknown>;

test('private callback diagnostics report a fixed stage and preserve the public error', async () => {
  const f = await fixture();
  const stages: string[] = [];
  const login = new Auth0Login(config, {
    actors: { establish: async () => assert.fail('Rejected tokens must stop before IAM') },
    sessions: f.sessions, fetch: f.fetch, now: f.now,
    reportCallbackFailure: stage => {
      stages.push(stage);
      throw new Error('Diagnostic sink failed');
    },
  });
  try {
    await assert.rejects(login.complete('/auth/callback?code=fixture-code', undefined), {message:'Staff authentication failed'});
    f.tokens({expires_in:301});
    const first = f.callbackFor(login.begin());
    await assert.rejects(login.complete(first.callback,first.cookie), {message:'Staff authentication failed'});
    f.tokens({}); f.id({amr:['pwd']});
    const second = f.callbackFor(login.begin());
    await assert.rejects(login.complete(second.callback,second.cookie), {message:'Staff authentication failed'});
    assert.deepEqual(stages,['callback-state','access-token-lifetime','id-token-mfa']);
    assert.equal(f.rows.size, 0);
  } finally { login.close(); f.login.close(); }
});

test('local sign-in waits for the signed time boundary and rejects timestamps outside its wait limit', async () => {
  const local = await fixture(config.callbackUrl, {localSessionLifetimeSeconds:600});
  local.advance(850);
  const now = Math.floor(local.now().getTime()/1000);
  const near = now+1;
  local.id({iat:near,auth_time:near});
  local.access({iat:near});
  const started = local.begin();
  const pending = local.login.complete(started.callback,started.cookie);
  try {
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(local.rows.size,0);
    local.advance(150);
    assert.equal((await local.sessions.validate(await pending)).ok,true);
    assert.equal(local.exchanges(),1);
  } finally { local.login.close(); }

  const outside = await fixture(config.callbackUrl, {localSessionLifetimeSeconds:600});
  try {
    const tooFar = Math.floor(outside.now().getTime()/1000)+3;
    outside.id({iat:tooFar,auth_time:tooFar});
    const attempt = outside.begin();
    await assert.rejects(outside.login.complete(attempt.callback,attempt.cookie),{message:'Staff authentication failed'});
    assert.equal(outside.rows.size,0);
  } finally { outside.login.close(); }
});

test('normal reauthentication recovers an expired prior session and fails closed on an unavailable store', async () => {
  const expired=await fixture();
  const first=expired.begin(), old=await expired.login.complete(first.callback,first.cookie);
  expired.advance(299_000);
  const renewal=expired.begin(old);
  expired.advance(2_000);
  const fresh=await expired.login.complete(renewal.callback,renewal.cookie);
  assert.notEqual(fresh,old);
  assert.equal((await expired.sessions.validate(old)).ok,false);
  assert.equal((await expired.sessions.validate(fresh)).ok,true);

  const rebound=await fixture();
  const original=rebound.begin(), former=await rebound.login.complete(original.callback,original.cookie);
  rebound.advance(299_000);
  const afterRebinding=rebound.begin(former);
  rebound.rebindStaff('00000000-0000-4000-8000-000000000099');
  rebound.advance(2_000);
  await assert.rejects(rebound.login.complete(afterRebinding.callback,afterRebinding.cookie),{message:'Staff authentication failed'});
  assert.equal(rebound.rows.size,1);

  const unavailable=await fixture();
  const started=unavailable.begin(), prior=await unavailable.login.complete(started.callback,started.cookie);
  const retry=unavailable.begin(prior);
  unavailable.store();
  await assert.rejects(unavailable.login.complete(retry.callback,retry.cookie),{message:'Staff authentication failed'});
  assert.equal(unavailable.rows.size,1);
});

test('current staff projection requires fresh session, enrollment, tenant authority and audited store availability',async()=>{
  const f=await fixture(),start=f.begin(),raw=await f.login.complete(start.callback,start.cookie);
  const self=await f.sessions.readProfile(raw);assert.equal(self.ok,true);
  if(!self.ok)throw new Error('Profile denied');
  assert.equal(self.profile.staffId,'00000000-0000-4000-8000-000000000001');assert.equal(self.profile.tenantId,config.tenantId);
  assert.equal(JSON.stringify(self).includes('synthetic-staff'),false);assert.equal(JSON.stringify(self).includes(raw),false);
  assert.equal((await f.sessions.readProfile('A'.repeat(43))).ok,false);
  f.membership();assert.equal((await f.sessions.readProfile(raw)).ok,false);
  for(const change of ['store','audit','suspend','unenroll','version','database','disabledIdentity']as const) {
    const next=await fixture(),s=next.begin(),token=await next.login.complete(s.callback,s.cookie);next[change]();
    assert.equal((await next.sessions.readProfile(token)).ok,false);
  }
  const expired=await fixture(),s=expired.begin(),token=await expired.login.complete(s.callback,s.cookie);
  expired.advance(300001);assert.equal((await expired.sessions.readProfile(token)).ok,false);
});

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
  for (const change of ["unenroll", "suspend", "membership", "audit", "store", "database", "disabledIdentity"] as const) {
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

test("cancelling the callback aborts an outstanding code exchange and consumes the transaction", async () => {
  const f = await fixture();
  let enter!: (signal: AbortSignal) => void;
  const entered = new Promise<AbortSignal>(resolve => { enter = resolve; });
  const login = new Auth0Login(config, {
    actors: { establish: async () => assert.fail('A cancelled exchange must stop before IAM') },
    sessions: f.sessions,
    now: f.now,
    fetch: async (_url, options) => {
      assert.ok(options?.signal);
      enter(options.signal);
      return new Promise<Response>(() => {});
    },
  });
  const start = f.callbackFor(login.begin());
  const rejected = assert.rejects(login.complete(start.callback, start.cookie), /Staff authentication failed/);
  const signal = await entered;
  login.cancel(start.cookie);
  assert.equal(signal.aborted, true);
  await rejected;
  await assert.rejects(login.complete(start.callback, start.cookie), /Staff authentication failed/);
  assert.equal(f.rows.size, 0);
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


test('a signed credential expiring during session persistence cannot become a browser cookie', async () => {
  const f = await fixture();
  const initial = Math.floor(f.now().getTime() / 1000);
  f.access({ exp: initial + 2 });
  f.pauseStore(async () => { f.advance(2000); });
  const start = f.begin();
  await assert.rejects(f.login.complete(start.callback, start.cookie), /Staff authentication failed/);
  assert.equal([...f.rows.values()].some(row => !row.revoked && row.expires > f.now().getTime()), false);
});

function suspension(now: Date): Extract<import("../src/auth0.js").StaffStepUpCommand,{operation:"SUSPEND_MEMBERSHIP"}> {
  return {
    actorStaffId: "00000000-0000-4000-8000-000000000001", tenantId: config.tenantId,
    targetStaffId: "00000000-0000-4000-8000-000000000003",
    requestId: "00000000-0000-4000-8000-000000000004", requestVersion: "1", requestDigest: "a".repeat(64), approvalDigest: "c".repeat(64),
    idempotencyKey: "00000000-0000-4000-8000-000000000005", permission: "tenant.staff.suspend",
    operation: "SUSPEND_MEMBERSHIP", expiresAtMs: now.getTime() + 120_000,
  };
}

test("step-up consumes opaque proof once for the original canonical command and rotated session", async () => {
  const f = await fixture(undefined, {}, {
    stepUpPolicy: async () => true, verifyStepUpFactor: async claims => ({eventId:randomUUID(),authenticatedAtMs:Number(claims["auth_time"])*1000}),
  });
  const start = f.begin();
  let session = await f.login.complete(start.callback, start.cookie);
  const command = suspension(f.now());
  await assert.rejects(() => f.beginStepUp({ ...command, tenantId: command.targetStaffId }, session));
  for (const [operation, permission] of [['SUSPEND_STAFF', 'platform.staff.suspend'], ['REVOKE_STAFF_SESSIONS', 'platform.sessions.revoke']]) {
    await assert.rejects(() => f.beginStepUp({ ...command, operation, permission } as unknown as typeof command, session));
  }
  const wrongCallback = await f.beginStepUp(command, session);
  await assert.rejects(() => f.login.complete(wrongCallback.callback, wrongCallback.cookie));
  const pending = await f.beginStepUp(command, session);
  await assert.rejects(() => f.login.completeStepUp(pending.callback, pending.cookie, "B".repeat(43)));

  for (const change of [{ requestVersion: "2" }, { targetStaffId: command.requestId }, { approvalDigest: "d".repeat(64) },
    { operation: "RESTORE_MEMBERSHIP" as typeof command.operation }, {}]) {
    const attempt = await f.beginStepUp(command, session);
    const { proof, token } = await f.login.completeStepUp(attempt.callback, attempt.cookie);
    assert.equal((await f.sessions.validate(session)).ok, false);
    session = token;
    await assert.rejects(() => f.login.completeStepUp(attempt.callback, attempt.cookie));
    assert.equal(await f.login.consumeStepUp({ ...proof }, command, session), false);
    const authorization = await f.login.consumeStepUp(proof, { ...command, ...change }, session);
    assert.equal(Boolean(authorization), !Object.keys(change).length);
    assert.equal(await f.login.consumeStepUp(proof, command, session), false);
    if (authorization) {
      assert.equal(await authorization.revalidate(), true);
      f.advance(60_000);
      assert.equal(await authorization.revalidate(), false);
    }
  }
});

test("step-up requires fresher provider factor evidence, live request authority and a current session", async () => {
  const absent = await fixture(undefined, {}, { stepUpPolicy: async () => true });
  const login = absent.begin();
  const ordinary = await absent.login.complete(login.callback, login.cookie);
  await assert.rejects(() => absent.beginStepUp(suspension(absent.now()), ordinary));
  for (const scenario of ["missing-mfa", "missing-at-hash", "stale-factor", "timestamp-only", "future-factor", "before-challenge", "authority", "expired-command", "expired-factor-during-policy", "revoked-session"] as const) {
    let check = async () => true;
    const f = await fixture(undefined, {}, {
      stepUpPolicy: () => check(), verifyStepUpFactor: async claims => {
        const authenticatedAtMs=Number(claims["auth_time"])*1000;
        if (scenario==="timestamp-only")return authenticatedAtMs as unknown as import("../src/auth0.js").StaffProviderFactorEvent;
        return {eventId:randomUUID(),authenticatedAtMs:authenticatedAtMs+
          (scenario==="stale-factor"?-60_001:scenario==="future-factor"?1000:0)};
      },
    });
    const start = f.begin();
    const first = await f.login.complete(start.callback, start.cookie);
    const command = { ...suspension(f.now()), ...(scenario === "expired-command" && { expiresAtMs: f.now().getTime() + 1 }) };
    if (scenario==="before-challenge") f.advance(100);
    const attempt = await f.beginStepUp(command, first);
    if (["missing-mfa","missing-at-hash","stale-factor","timestamp-only","future-factor","before-challenge"].includes(scenario)) {
      if (scenario === "missing-mfa") f.id({ amr: ["pwd"] });
      if (scenario === "missing-at-hash") f.id({ at_hash: undefined });
      await assert.rejects(() => f.login.completeStepUp(attempt.callback, attempt.cookie));
      assert.equal((await f.sessions.validate(first)).ok, true);
      continue;
    }
    const { token, proof } = await f.login.completeStepUp(attempt.callback, attempt.cookie);
    if (scenario === "authority") check = async () => false;
    if (scenario === "expired-command") f.advance(1);
    if (scenario === "expired-factor-during-policy") check = async () => { f.advance(60_000); return true; };
    if (scenario === "revoked-session") await f.sessions.revoke(token);
    assert.equal(await f.login.consumeStepUp(proof, command, token), false, scenario);
  }
});

test('provider event and BFF forwarding bind to the rotated canonical session', async () => {
  const eventId='00000000-0000-4000-8000-000000000005';
  const f=await fixture(undefined,{},{
    stepUpPolicy:async()=>true,
    verifyStepUpFactor:async claims=>({eventId,authenticatedAtMs:Number(claims['auth_time'])*1000}),
  });
  const login=f.begin();
  const old=await f.login.complete(login.callback,login.cookie);
  const intent=suspension(f.now()),pending=await f.beginStepUp(intent,old);
  const {token,proof}=await f.login.completeStepUp(pending.callback,pending.cookie);
  const accepted=await f.login.consumeStepUp(proof,intent,token);
  assert.ok(accepted && accepted.factorEvent);
  assert.equal(accepted.factorEvent.eventId,eventId);
  assert.equal(accepted.factorEvent.issuer,config.issuer);
  assert.equal(accepted.factorEvent.subject,'synthetic-staff');
  assert.equal(accepted.factorEvent.sessionDigest,createHash('sha256').update(token).digest('hex'));
  await assert.rejects(f.login.readForSession(old,async()=>{throw new Error('rotated credential reached forwarding');}),{message:'Staff authentication failed'});
  assert.equal(await f.login.readForSession(token,async(identity,tenant)=>{
    assert.equal(identity.subject,'synthetic-staff');
    assert.equal(tenant,config.tenantId);
    return 'scoped';
  }),'scoped');
  const replay=await f.beginStepUp(intent,token);
  await assert.rejects(f.login.completeStepUp(replay.callback,replay.cookie,token),{message:'Staff authentication failed'});
  await assert.rejects(f.login.readForSession(token,async()=>{
    await f.sessions.revoke(token);
    return 'private';
  }),{message:'Staff authentication failed'});
});

test('a stalled verifier is interrupted by the command deadline, cancellation or shutdown', { timeout: 10000 }, async () => {
  for (const action of ['deadline', 'cancel', 'close']) {
    let started!: (signal: AbortSignal) => void;
    let complete!: (factor: { eventId: string; authenticatedAtMs: number }) => void;
    const entered = new Promise<AbortSignal>(resolve => { started = resolve; });
    const pendingFactor = new Promise<{ eventId: string; authenticatedAtMs: number }>(resolve => { complete = resolve; });
    const f = await fixture(undefined, {}, {
      stepUpPolicy: async () => true,
      verifyStepUpFactor: async (_claims, _challenge, signal) => { started(signal); return pendingFactor; },
    });
    const initial = f.begin();
    const session = await f.login.complete(initial.callback, initial.cookie);
    const now = f.now();
    const command = { ...suspension(now), expiresAtMs: now.getTime() + (action === 'deadline' ? 100 : 15000) };
    const attempt = await f.beginStepUp(command, session);
    const rejected = assert.rejects(f.login.completeStepUp(attempt.callback, attempt.cookie), { message: 'Staff authentication failed' });
    const signal = await entered;
    if (action === 'cancel') f.login.cancel(attempt.cookie);
    if (action === 'close') f.login.close();
    await rejected;
    assert.equal(signal.aborted, true, action);
    complete({ eventId: randomUUID(), authenticatedAtMs: now.getTime() });
    await new Promise<void>(resolve => setImmediate(resolve));
    await assert.rejects(f.login.completeStepUp(attempt.callback, attempt.cookie));
    assert.equal(f.rows.size, 1, action);
    assert.equal((await f.sessions.validate(session)).ok, true, action);
    f.login.close();
  }
});

test('step-up that expires during actor lookup leaves the existing session intact', async () => {
  let expireOnIdentityLookup: () => void;
  const f = await fixture(undefined, {}, {
    stepUpPolicy: async () => true,
    verifyStepUpFactor: async (_claims, challenge) => {
      expireOnIdentityLookup();
      return { eventId: randomUUID(), authenticatedAtMs: challenge.challengeStartedAtMs };
    },
  });
  const initial = f.begin();
  const session = await f.login.complete(initial.callback, initial.cookie);
  expireOnIdentityLookup = () => f.onIdentityLookup(() => {
    f.onIdentityLookup(undefined);
    f.advance(1000);
  });
  const now = f.now();
  const command = { ...suspension(now), expiresAtMs: now.getTime() + 1000 };
  const attempt = await f.beginStepUp(command, session);
  await assert.rejects(f.login.completeStepUp(attempt.callback, attempt.cookie), { message: 'Staff authentication failed' });
  assert.equal(f.rows.size, 1);
  assert.equal((await f.sessions.validate(session)).ok, true);
  f.login.close();
});

test('step-up rechecks the command after factor verification and before rotating the session', async () => {
  for (const scenario of ['withdrawn', 'expired-during-recheck']) {
    let factorVerified = false, reachDeadline = () => {};
    const f = await fixture(undefined, {}, {
      stepUpPolicy: async () => {
        if (!factorVerified) return true;
        if (scenario === 'withdrawn') return false;
        reachDeadline();
        return true;
      },
      verifyStepUpFactor: async (_claims, challenge) => {
        factorVerified = true;
        return { eventId: randomUUID(), authenticatedAtMs: challenge.challengeStartedAtMs };
      },
    });
    const initial = f.begin(), session = await f.login.complete(initial.callback, initial.cookie);
    reachDeadline = () => f.advance(1000);
    const now = f.now(), command = { ...suspension(now), expiresAtMs: now.getTime() + 1000 };
    const attempt = await f.beginStepUp(command, session);
    await assert.rejects(f.login.completeStepUp(attempt.callback, attempt.cookie), { message: 'Staff authentication failed' });
    assert.equal(factorVerified, true, scenario);
    assert.equal(f.rows.size, 1, scenario);
    assert.equal((await f.sessions.validate(session)).ok, true, scenario);
    f.login.close();
  }
});

test('a stalled command authority recheck observes cancellation and the assurance deadline', async () => {
  for (const scenario of ['cancel', 'deadline']) {
    let started!: () => void, finish!: (value: boolean) => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<boolean>(resolve => { finish = resolve; });
    let factorCompleted = false;
    const f = await fixture(undefined, {}, {
      stepUpPolicy: async () => {
        if (!factorCompleted) return true;
        started();
        return pending;
      },
      verifyStepUpFactor: async (_claims, challenge) => {
        factorCompleted = true;
        return { eventId: randomUUID(), authenticatedAtMs: challenge.challengeStartedAtMs };
      },
    });
    const initial = f.begin(), session = await f.login.complete(initial.callback, initial.cookie);
    const now = f.now(), command = { ...suspension(now), expiresAtMs: now.getTime() + 150 };
    const attempt = await f.beginStepUp(command, session);
    const rejected = assert.rejects(f.login.completeStepUp(attempt.callback, attempt.cookie), { message: 'Staff authentication failed' });
    await entered;
    if (scenario === 'cancel') f.login.cancel(attempt.cookie);
    await rejected;
    finish(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.rows.size, 1, scenario);
    assert.equal((await f.sessions.validate(session)).ok, true, scenario);
    f.login.close();
  }
});
