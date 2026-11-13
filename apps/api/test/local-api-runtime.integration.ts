import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import test from "node:test";
import { createLocalApiRuntime, LocalRuntimeUnavailableError } from "../src/local-api-runtime.js";
import { bootstrap } from "../src/main.js";
import { createIdentityRuntime } from "@nukhbapay/database/identity-runtime";
import { withDisposableIamDatabase } from "./fixtures/disposable-iam-database.js";
import { staffHttpAcceptance } from "./fixtures/staff-http-acceptance.js";
import { claims, environment, ISSUER, keySource, NOW, signingKey } from "./fixtures/oidc-test-issuer.js";

test("local synthetic runtime lifecycle uses disposable restricted IAM and leaves zero sessions", async (context) => {
  await withDisposableIamDatabase(async (fixture) => {
    const db = fixture.fixtureClient; const staffId = randomUUID();
    await db.query("INSERT INTO nukhabapay.staff_users(id,display_name,contact_email,status) VALUES($1,'Synthetic lifecycle staff','lifecycle@example.invalid','ACTIVE')", [staffId]);
    await db.query("INSERT INTO nukhabapay.staff_identities(id,staff_id,issuer,subject,status) VALUES($1,$2,$3,'lifecycle-subject','ACTIVE')", [randomUUID(), staffId, ISSUER]);
    const key = await signingKey("runtime-key"); const source = keySource([key.publicJwk]);
    const env = { API_STAFF_AUTH_MODE: "local-synthetic", ...environment(), ...fixture.runtimeEnv };
    const options = { logger: false as const, fetchKeys: source.fetchKeys, now: () => new Date(NOW) };
    const sessions = async () => Number((await db.query("SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname=current_database() AND application_name IN ('nukhbapay-identity-reader','nukhbapay-identity-audit-writer')")).rows[0].total);
    await context.test("failed JWKS startup cleans both actual restricted pools, then healthy startup recovers", async () => {
      const failed = keySource([]); failed.state.response = () => { throw new Error("synthetic private dependency detail"); };
      await assert.rejects(() => createLocalApiRuntime(env, { ...options, fetchKeys: failed.fetchKeys }), LocalRuntimeUnavailableError);
      assert.equal(await sessions(), 0);
      const recovered = await createLocalApiRuntime(env, options);
      try { assert.deepEqual(await recovered.checkReadiness(), { ready: true }); assert.equal(await sessions(), 2); }
      finally { await recovered.close(); }
      assert.equal(await sessions(), 0);
    });
    await context.test("missing IAM schema fails readiness and releases all connections without migrating", async () => {
      await db.query("BEGIN");
      // Target-local transactional DDL only; restored before any later acceptance.
      await db.query("ALTER TABLE nukhabapay.staff_users RENAME TO lifecycle_hidden_staff");
      // Commit the rename so restricted connections see it, then restore in finally.
      await db.query("COMMIT");
      try { await assert.rejects(() => createLocalApiRuntime(env, options), LocalRuntimeUnavailableError); assert.equal(await sessions(), 0); }
      finally { await db.query("ALTER TABLE nukhabapay.lifecycle_hidden_staff RENAME TO staff_users"); }
    });
    await context.test("partial IAM connection failure closes the connected counterpart", async () => {
      assert.match(fixture.databaseName, /^nukhabapay_b3b3_[0-9a-f]{32}$/);
      const quotedTarget = '"' + fixture.databaseName + '"';
      // Temporary CONNECT denial on this generated database only; never alter cluster roles.
      await db.query(`REVOKE CONNECT ON DATABASE ${quotedTarget} FROM nukhabapay_identity_writer`);
      try {
        await assert.rejects(() => createLocalApiRuntime(env, options), LocalRuntimeUnavailableError);
        assert.equal(await sessions(), 0);
      } finally { await db.query(`GRANT CONNECT ON DATABASE ${quotedTarget} TO nukhabapay_identity_writer`); }
    });
    await context.test("an unavailable database fails closed without creating or migrating it", async () => {
      const absent = "nukhabapay_absent_" + randomUUID().replaceAll("-", "");
      assert.equal((await db.query("SELECT count(*)::int AS total FROM pg_database WHERE datname=$1", [absent])).rows[0].total, 0);
      const missing: Record<string, string | undefined> = { ...env };
      for (const name of ["DB_IDENTITY_READER_URL", "DB_IDENTITY_WRITER_URL"] as const) {
        const url = new URL(missing[name]!); url.pathname = "/" + absent; missing[name] = url.href;
      }
      await assert.rejects(() => createLocalApiRuntime(missing, options), LocalRuntimeUnavailableError);
      assert.equal(await sessions(), 0);
    });
    await context.test("listener startup failure closes IAM and removes installed shutdown hooks", async () => {
      const blocker = createServer();
      await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
      const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
      try {
        await assert.rejects(() => bootstrap({ ...env, API_PORT: String((blocker.address() as AddressInfo).port) }, options), LocalRuntimeUnavailableError);
        assert.equal(await sessions(), 0);
        assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
      } finally { await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(new Error("Fixture listener cleanup failed")) : resolve())); }
    });
    await context.test("composition authorizes audited self only in test bootstrap and pool loss recovers by reconnecting", async () => {
      const runtime = await createLocalApiRuntime(env, { ...options, ...staffHttpAcceptance(randomUUID()) });
      try {
        await runtime.app.listen(0, "127.0.0.1");
        const base = `http://127.0.0.1:${(runtime.app.getHttpServer().address() as AddressInfo).port}`;
        const token = await key.sign(claims({ sub: "lifecycle-subject" }));
        const send = () => fetch(base + "/__acceptance/staff/self", { headers: { Authorization: "Bearer " + token } });
        assert.equal((await send()).status, 200);
        assert.equal((await db.query("SELECT count(*)::int AS total FROM nukhabapay.security_audit_events WHERE actor_staff_id=$1 AND outcome='SUCCESS'", [staffId])).rows[0].total, 1);
        await db.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='nukhbapay-identity-reader' AND pid<>pg_backend_pid()");
        // First probe may observe the broken connection; a subsequent bounded probe must reconnect.
        await runtime.checkReadiness();
        assert.deepEqual(await runtime.checkReadiness(), { ready: true });
        assert.equal((await send()).status, 200);
        assert.equal((await fetch(base + "/health/live")).status, 200);
        assert.equal((await fetch(base + "/health/ready")).status, 404);
      } finally { await Promise.all([runtime.close(), runtime.close()]); }
      assert.equal(await sessions(), 0); assert.deepEqual(await runtime.checkReadiness(), { ready: false });
    });
    await context.test("closed IAM makes readiness and authorization fail closed; restart recovers", async () => {
      const iam = await createIdentityRuntime(fixture.runtimeEnv);
      const runtime = await createLocalApiRuntime(env, { ...options, ...staffHttpAcceptance(randomUUID()), createIam: async () => iam });
      try {
        await iam.close(); assert.deepEqual(await runtime.checkReadiness(), { ready: false });
        await runtime.app.listen(0, "127.0.0.1");
        const base = `http://127.0.0.1:${(runtime.app.getHttpServer().address() as AddressInfo).port}`;
        assert.equal((await fetch(base + "/__acceptance/staff/self", { headers: { Authorization: "Bearer " + await key.sign(claims({ sub: "lifecycle-subject" })) } })).status, 503);
        assert.equal((await fetch(base + "/health/live")).status, 200);
      } finally { await runtime.close(); }
      const restarted = await createLocalApiRuntime(env, options);
      try { assert.deepEqual(await restarted.checkReadiness(), { ready: true }); } finally { await restarted.app.close(); }
      assert.equal(await sessions(), 0);
    });
  }, "b3b3");
});
