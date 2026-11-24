import assert from "node:assert/strict";
import test from "node:test";
import { onExecutePostLogin } from "../auth0/staff-mfa-observation.cjs";

const started = Date.parse("2026-11-23T10:00:00.000Z");
const nonce = "a".repeat(43);
const state = "b".repeat(43);
const subject = "auth0|synthetic-staff";
const oldFactor = { name: "mfa", type: "otp", timestamp: new Date(started - 1000).toISOString() };
const factor = { name: "mfa", type: "otp", timestamp: new Date(started + 500).toISOString() };

function fixture(t) {
  let now = started;
  t.mock.method(Date, "now", () => now);
  const log = t.mock.method(console, "log", () => {});
  const metadata = {};
  const api = { transaction: { setMetadata(key, value) { metadata[key] = value; } } };
  const event = {
    secrets: { NUKHBAPAY_STAFF_CLIENT_ID: "synthetic-client", NUKHBAPAY_MFA_PROBE_SUBJECT: subject,
      NUKHBAPAY_MFA_PROBE_STAGE: "before" },
    client: { client_id: "synthetic-client" },
    user: { user_id: subject, enrolledFactors: [{ type: "otp" }] },
    transaction: { id: "synthetic-transaction", state, protocol: "oidc-basic-profile",
      redirect_uri: "https://localhost:3001/auth/callback", metadata },
    request: { query: { nonce } },
    authentication: { methods: [oldFactor] }
  };
  const before = () => onExecutePostLogin(event, api);
  async function after(methods, update = current => current) {
    now = started + 1000;
    await onExecutePostLogin(update({ ...event, secrets: { ...event.secrets, NUKHBAPAY_MFA_PROBE_STAGE: "after" },
      authentication: { methods } }), {});
    const line = log.mock.calls.at(-1)?.arguments[0];
    assert.ok(line?.startsWith("NUKHBAPAY_MFA_OBSERVATION "));
    assert.ok(line.length <= 256);
    return JSON.parse(line.slice("NUKHBAPAY_MFA_OBSERVATION ".length));
  }
  return { event, api, metadata, log, before, after };
}

test("reports a fresh approved factor even when Auth0 replaces the request after the challenge", async t => {
  const f = fixture(t);
  await f.before();
  const result = await f.after([oldFactor, factor], event => ({ ...event, request: { query: {} } }));
  assert.deepEqual(result, { sameTransaction: true, sameState: true, nonceBefore: true, sameNonce: false, freshFactor: true });
  assert.equal((await f.after([oldFactor, factor])).sameNonce, true);
  const recorded = JSON.stringify({ metadata: f.metadata, lines: f.log.mock.calls.map(call => call.arguments) });
  for (const value of [nonce, state, subject, f.event.transaction.id, factor.timestamp]) {
    assert.equal(recorded.includes(value), false);
  }
});

test("distinguishes stale, duplicated, unapproved, malformed and substituted factor observations", async t => {
  const f = fixture(t);
  await f.before();
  for (const methods of [[oldFactor], [oldFactor, oldFactor], [oldFactor, factor, factor], [factor],
    [oldFactor, { ...factor, type: "recovery-code" }], [oldFactor, { ...factor, timestamp: "2026-11-23T10:00:00Z" }],
    [oldFactor, { ...factor, timestamp: new Date(started + 1500).toISOString() }],
    [oldFactor, { ...factor, timestamp: new Date(started - 500).toISOString() }], undefined]) {
    assert.equal((await f.after(methods)).freshFactor, false);
  }
  const switched = await f.after([oldFactor, factor], event => ({
    ...event, transaction: { ...event.transaction, id: "another-transaction" }
  }));
  assert.equal(switched.sameTransaction, false);
  assert.equal(switched.freshFactor, false);
});

test("scopes observations to the selected staff login and handles missing metadata safely", async t => {
  const f = fixture(t);
  for (const update of [
    { user: { user_id: "auth0|different" } }, { client: { client_id: "different" } },
    { user: { ...f.event.user, enrolledFactors: [] } },
    { transaction: { ...f.event.transaction, protocol: "oauth2-refresh-token" } },
    { transaction: { ...f.event.transaction, redirect_uri: "https://other.fixture.invalid/" } }
  ]) await onExecutePostLogin({ ...f.event, ...update }, f.api);
  assert.deepEqual(f.metadata, {});
  assert.equal(f.log.mock.callCount(), 0);
  assert.equal((await f.after([factor])).freshFactor, false);
  await onExecutePostLogin(f.event, {});
  assert.equal(f.log.mock.calls.at(-1).arguments[0], "NUKHBAPAY_MFA_OBSERVATION_UNAVAILABLE");
});
