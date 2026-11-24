import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAuth0Configuration, type Auth0Configuration } from "../src/auth0.js";
import { config, fixture } from "./fixtures/auth0-fixture.js";

const now = Date.UTC(2026, 10, 13) / 1000;
const userinfo = new URL("userinfo", config.issuer).href;
const approved = { accessTokenAudienceMode: "api-and-userinfo" as const };
type Claims = Record<string, unknown>;

test("RFC9068 audience pair requires explicit server opt-in and exactly the reviewed set", async t => {
  const cases: { name: string; aud: unknown; mode?: Auth0Configuration['accessTokenAudienceMode']; ok: boolean }[] = [
    { name: "default scalar API", aud: config.audience, ok: true },
    { name: "default array denied", aud: [config.audience, userinfo], ok: false },
    { name: "explicit api-only array denied", aud: [config.audience, userinfo], mode: "api-only", ok: false },
    { name: "approved scalar API", aud: config.audience, mode: "api-and-userinfo", ok: true },
    { name: "approved pair", aud: [config.audience, userinfo], mode: "api-and-userinfo", ok: true },
    { name: "approved reversed pair", aud: [userinfo, config.audience], mode: "api-and-userinfo", ok: true },
    ...[
      "wrong-api", userinfo, [], [config.audience], [userinfo], [config.audience, config.audience],
      [config.audience, userinfo, userinfo], [config.audience, userinfo, "urn:unexpected"],
      [config.audience, "https://other.invalid/userinfo"], [config.audience, userinfo + "/"],
      [config.audience, null], [config.audience, { audience: userinfo }],
      [config.audience + "/", userinfo], { audience: config.audience },
    ].map((aud, i) => ({ name: `unreviewed shape ${i}`, aud, mode: "api-and-userinfo" as const, ok: false })),
  ];
  for (const c of cases) await t.test(c.name, async () => {
    const f = await fixture(config.callbackUrl, c.mode === undefined ? {} : { accessTokenAudienceMode: c.mode });
    const s = f.begin(); f.access({ aud: c.aud });
    if (c.ok) {
      const token = await f.login.complete(s.callback, s.cookie);
      assert.equal((await f.sessions.validate(token)).ok, true);
    } else {
      await assert.rejects(() => f.login.complete(s.callback, s.cookie), { message: "Staff authentication failed" });
      assert.equal(f.rows.size, 0);
      await assert.rejects(() => f.login.complete(s.callback, s.cookie));
      assert.equal(f.exchanges(), 1);
    }
  });
});

test("audience compatibility preserves every ID/access security check", async t => {
  const common: [string, Claims][] = [
    ["wrong issuer", { iss: "https://wrong.invalid/" }], ["issuer alias", { iss: config.issuer.slice(0, -1) }],
    ["missing issuer", { iss: undefined }], ["missing subject", { sub: undefined }],
    ["subject mismatch", { sub: "another-human" }], ["missing issuance", { iat: undefined }],
    ["future issuance", { iat: now + 1 }], ["old issuance", { iat: now - 301, exp: now + 1 }],
    ["missing expiry", { exp: undefined }], ["expired", { iat: now - 10, exp: now - 1 }],
    ["expires now", { iat: now - 10, exp: now }], ["zero lifetime", { exp: now }],
    ["fractional issuance", { iat: now - 0.5 }], ["fractional expiry", { exp: now + 299.5 }],
    ["future nbf", { nbf: now + 1 }], ["invalid nbf", { nbf: "now" }],
    ...["act", "may_act", "gty", "sub_profile", "client_profile"].map(name => [`forbidden ${name}`, { [name]: null }] as [string, Claims]),
  ];
  const id: [string, Claims][] = [
    ["wrong audience", { aud: "other-client" }], ["client audience array", { aud: [config.clientId] }],
    ["multiple client audiences", { aud: [config.clientId, "other"] }], ["wrong azp", { azp: "other" }],
    ["invalid nonce", { nonce: "wrong" }], ["missing nonce", { nonce: undefined }],
    ["missing MFA", { amr: ["pwd"] }], ["missing amr", { amr: undefined }],
    ["missing auth time", { auth_time: undefined }], ["stale auth time", { auth_time: now - 301 }],
    ["future auth time", { auth_time: now + 1 }], ["auth time after issuance", { iat: now - 1 }],
    ["excessive ID lifetime", { exp: now + 3601 }], ["bad access hash", { at_hash: "wrong" }],
  ];
  const access: [string, Claims][] = [
    ["wrong client", { client_id: "other" }], ["missing client", { client_id: undefined }],
    ["default Auth0 profile", { azp: config.clientId }], ["missing jti", { jti: undefined }], ["empty jti", { jti: "" }],
    ["missing human", { [config.staffKindClaim]: undefined }], ["machine", { [config.staffKindClaim]: "machine" }],
    ["human case mismatch", { [config.staffKindClaim]: "Human" }], ["human array", { [config.staffKindClaim]: ["human"] }],
    ["excessive access lifetime", { exp: now + 301 }],
  ];
  for (const kind of ["id", "access"] as const) for (const [name, claims] of [...common, ...(kind === "id" ? id : access)]) {
    await t.test(`${kind}: ${name}`, async () => {
      const f = await fixture(config.callbackUrl, approved), s = f.begin();
      f.access({ aud: [config.audience, userinfo] });
      f[kind](kind === "access" ? { aud: [config.audience, userinfo], ...claims } : claims);
      await assert.rejects(() => f.login.complete(s.callback, s.cookie), { message: "Staff authentication failed" });
      assert.equal(f.rows.size, 0);
    });
  }
  for (const [kind, claims] of [
    ["idHeader", { typ: "at+jwt" }], ["accessHeader", { typ: "JWT" }],
    ["accessHeader", { jku: "https://wrong.invalid/keys" }],
    ...[0, 301, 1.5, "300"].map(expires_in => ["tokens", { expires_in }] as const),
    ["tokens", { refresh_token: "forbidden" }],
  ] as readonly (readonly ["idHeader" | "accessHeader" | "tokens", Claims])[]) {
    await t.test(`${kind}: ${JSON.stringify(claims)}`, async () => {
      const f = await fixture(config.callbackUrl, approved), s = f.begin();
      f.access({ aud: [config.audience, userinfo] }); f[kind](claims);
      await assert.rejects(() => f.login.complete(s.callback, s.cookie)); assert.equal(f.rows.size, 0);
    });
  }
});

test("valid lifetime boundaries retain exact client binding and bound session expiry", async () => {
  const f = await fixture(config.callbackUrl, approved), s = f.begin();
  f.access({ aud: [config.audience, userinfo] }); f.id({ exp: now + 3600, azp: config.clientId });
  const token = await f.login.complete(s.callback, s.cookie), profile = await f.sessions.readProfile(token);
  assert.equal(profile.ok, true);
  if (!profile.ok) throw new Error("Profile denied");
  assert.equal(profile.profile.expiresAtMs, (now + 300) * 1000);
  f.advance(300000); assert.equal((await f.sessions.validate(token)).ok, false);
  for (const kind of ["id", "access"] as const) {
    const shorter = await fixture(config.callbackUrl, approved), start = shorter.begin();
    shorter.access({ aud: [config.audience, userinfo] });
    shorter[kind](kind === "access" ? { aud: [config.audience, userinfo], exp: now + 60 } : { exp: now + 60 });
    const raw = await shorter.login.complete(start.callback, start.cookie);
    assert.equal([...shorter.rows.values()][0]!.expires, (now + 60) * 1000);
    shorter.advance(60000); assert.equal((await shorter.sessions.validate(raw)).ok, false);
  }
});

test("fresh auth_time must also be at or after this login transaction", async () => {
  const f = await fixture(config.callbackUrl, approved); f.advance(10000); const s = f.begin();
  f.access({ aud: [config.audience, userinfo] }); f.id({ auth_time: now + 9 });
  await assert.rejects(() => f.login.complete(s.callback, s.cookie)); assert.equal(f.rows.size, 0);
});

test("human classification uses only the exact configured access-token claim", async () => {
  const claim = "https://claims.nukhbapay.com/principal";
  const valid = await fixture(config.callbackUrl, { ...approved, staffKindClaim: claim }), s = valid.begin();
  valid.access({ aud: [config.audience, userinfo] });
  assert.equal((await valid.sessions.validate(await valid.login.complete(s.callback, s.cookie))).ok, true);
  for (const claims of [{ [config.staffKindClaim]: "human" }, { [claim + "/"]: "human" }]) {
    const f = await fixture(config.callbackUrl, { ...approved, staffKindClaim: claim }), start = f.begin();
    f.id({ [claim]: "human" }); f.access({ aud: [config.audience, userinfo], [claim]: undefined, ...claims });
    await assert.rejects(() => f.login.complete(start.callback, start.cookie)); assert.equal(f.rows.size, 0);
  }
});

test("invalid compatibility configuration fails closed", () => {
  for (const staffKindClaim of ["", "principal_kind", "http://claims.example.com/kind", "https://claims.example.com/",
    "https://claims.example.com/kind?x=1", "https://claims.example.com/kind#x", "https://auth0.com/kind",
    "https://tenant.auth0.com/kind", "https://webtask.io/kind", "https://webtask.run/kind", "https://127.0.0.1/kind"]) {
    assert.throws(() => validateAuth0Configuration({ ...config, staffKindClaim }));
  }
  for (const accessTokenAudienceMode of ["", "anything", "true", null, ["api-and-userinfo"]]) {
    assert.throws(() => validateAuth0Configuration({ ...config, accessTokenAudienceMode } as unknown as Auth0Configuration));
  }
  assert.throws(() => validateAuth0Configuration({ ...config, audience: userinfo }));
});
