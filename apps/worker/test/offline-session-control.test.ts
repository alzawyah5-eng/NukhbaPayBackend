import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import test, { type TestContext } from "node:test";
import { MockControlAuthority, MockSessionDriver, OfflineSessionController } from "../src/jobs/product-intelligence/offline-session-control.js";
import { ControlBudget, MockOperations, OfflineControlAudit, OfflineControlError, PROPOSED_MOCK_TIMING as T, controlled,
  systemControlClock, type ControlClock, type ControlCode, type ControlEvent } from "../src/jobs/product-intelligence/offline-control-primitives.js";

async function flush() { for (let i = 0; i < 160; i++) await Promise.resolve(); }
class Clock implements ControlClock {
  time = 0;
  #id = 0;
  #timers = new Map<number, { at: number; callback: () => void }>();
  now() { return this.time; }
  wall() { return Date.parse("2026-11-18T08:00:00Z") + this.time; }
  after(ms: number, callback: () => void) { const id = ++this.#id; this.#timers.set(id, { at: this.time + Math.max(0, ms), callback }); return () => { this.#timers.delete(id); }; }
  async advance(ms: number) {
    await flush(); const end = this.time + ms;
    while (true) {
      const entry = [...this.#timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!entry) break;
      this.time = entry[1].at; this.#timers.delete(entry[0]); entry[1].callback(); await flush();
    }
    this.time = end; await flush();
  }
}
const capture = <T>(p: Promise<T>) => p.then(value => ({ ok: true as const, value }), (e: unknown) => ({ ok: false as const, code: (e as { code?: string }).code }));
async function fixture(t: TestContext, start = true) {
  const clock = new Clock(), driver = new MockSessionDriver(clock), authority = new MockControlAuthority(clock), audit = new OfflineControlAudit();
  const controller = new OfflineSessionController({ capability: "OFFLINE_MOCK_SESSION_CONTROL_ONLY", clock, driver, authority, audit });
  t.after(() => controller.close());
  const tenant = randomUUID(), otherTenant = randomUUID();
  const request = () => { const r = { schemaVersion: "ai-job-v1", idempotencyKey: randomUUID(), snapshotId: randomUUID(),
    sourceVersion: "synthetic-v1", offerId: randomUUID(), candidateProductId: randomUUID() }; driver.snapshots.set(r.snapshotId, tenant); return r; };
  const token = authority.issue("client-a", tenant);
  if (start) await controller.startup();
  return { clock, driver, authority, audit, controller, tenant, otherTenant, request, token };
}

test("proposed clocks have explicit containment and cleanup reserve; policy stays inactive", () => {
  assert.equal(T.active, false);
  assert.ok(T.physicalMs < T.preflightMs);
  assert.ok(T.preflightMs + T.networkMs + T.assertionMs < T.connectionSetupMs);
  assert.ok(T.connectionSetupMs * 4 < T.startupMs);
  assert.equal(T.authenticationMs + T.queueMs + T.serviceMs + T.cleanupMs, T.requestMs);
  assert.ok(T.transactionMs < T.serviceMs);
  assert.ok(T.startupMs < T.runMs);
});
test("startup is explicit and opens exactly four mock sessions, two per purpose", async t => {
  const f = await fixture(t, false);
  assert.equal((await capture(f.controller.execute(f.token, f.request()))).ok, false);
  assert.equal(f.driver.connectCalls, 0);
  await f.controller.startup();
  assert.equal(f.driver.sessions.length, 4); assert.equal(f.driver.connectCalls, 4);
  assert.deepEqual(f.driver.sessions.map(s => s.kind), ["jobs", "jobs", "source", "source"]);
  await assert.rejects(f.controller.startup()); assert.equal(f.driver.connectCalls, 4);
});
test("structurally forged mock dependencies cannot grant startup authority", async t => {
  const f = await fixture(t);
  assert.throws(() => new OfflineSessionController({ capability: "OFFLINE_MOCK_SESSION_CONTROL_ONLY", clock: f.clock,
    driver: { constructor: MockSessionDriver } as unknown as MockSessionDriver, authority: f.authority, audit: f.audit }));
});
for (const variant of ["forged", "expired", "hashFailure", "physicalFailure"] as const) test("physical fail-closed: " + variant, async t => {
  const f = await fixture(t, false);
  if (variant === "forged") f.driver.proofSystemId = "wrong-cluster";
  if (variant === "expired") f.driver.proofExpired = true;
  if (variant === "hashFailure") f.driver.operations.plan("hashes", { failure: "IDENTITY" });
  if (variant === "physicalFailure") f.driver.operations.plan("physical", { failure: "IDENTITY" });
  await assert.rejects(f.controller.startup());
  assert.equal(f.controller.state, "FAILED"); assert.equal(f.driver.connectCalls, 0);
  assert.equal((await capture(f.controller.execute(f.token, f.request()))).ok, false);
});
test("physical timeout cancels even an uncooperative owned mock, before any connection", async t => {
  const f = await fixture(t, false);
  f.driver.operations.plan("physical", { delayMs: 30_000, ignoreCancellation: true,
    progress: [{ atMs: 5000, step: 1 }, { atMs: 10_000, step: 2 }] });
  const result = capture(f.controller.startup()); await f.clock.advance(15_001);
  assert.equal((await result).ok, false); assert.equal(f.driver.connectCalls, 0);
  assert.equal(f.driver.operations.active, 0); assert.ok(f.driver.operations.forced > 0);
  await f.clock.advance(40_000); assert.equal(f.driver.connectCalls, 0);
});
test("total preflight is not reset by physical progress", async t => {
  const f = await fixture(t, false);
  f.driver.operations.plan("hashes", { delayMs: 9000 });
  f.driver.operations.plan("physical", { delayMs: 14_000, progress: [{ atMs: 5000, step: 1 }, { atMs: 9000, step: 2 }] });
  const result = capture(f.controller.startup()); await f.clock.advance(20_001);
  assert.equal((await result).ok, false); assert.equal(f.driver.connectCalls, 0); assert.equal(f.driver.operations.active, 0);
});
test("duplicate and forged progress cannot suppress stall rejection", async t => {
  const f = await fixture(t, false);
  f.driver.operations.plan("physical", { delayMs: 14_000,
    progress: [{ atMs: 1000, step: 1 }, { atMs: 9000, step: 1 }, { atMs: 9500, step: 99 }] });
  const result = capture(f.controller.startup()); await f.clock.advance(11_001);
  assert.equal((await result).ok, false); assert.equal(f.driver.connectCalls, 0);
});
test("identity ages before socket start and fails closed without a late connect", async t => {
  const f = await fixture(t, false); f.driver.beforeSocketDelayMs = 1001;
  const result = capture(f.controller.startup()); await f.clock.advance(1002);
  assert.equal((await result).ok, false); assert.equal(f.driver.connectCalls, 0);
});
test("opaque authentication rejects anonymous, forged, wrong-scope and expired tokens", async t => {
  const f = await fixture(t);
  for (const lifetime of [NaN, Infinity, 0, 300_001]) assert.throws(() => f.authority.issue("client-a", f.tenant, lifetime));
  for (const token of ["", "forged", f.authority.issue("client-a", f.tenant, 300_000, "ai.jobs.submit")])
    assert.equal((await capture(f.controller.execute(token, f.request()))).ok, false);
  const expired = f.authority.issue("client-a", f.tenant, 1); await f.clock.advance(2);
  assert.equal((await capture(f.controller.execute(expired, f.request()))).ok, false);
  assert.equal(f.driver.committed.size, 0);
});
test("authentication timeout joins its operation and cannot continue into a transaction", async t => {
  const f = await fixture(t); f.driver.operations.plan("authentication", { delayMs: 2000 });
  const result = capture(f.controller.execute(f.token, f.request())); await f.clock.advance(1001);
  assert.equal((await result).ok, false); assert.equal(f.driver.operations.active, 0);
  await f.clock.advance(5000); assert.equal(f.driver.committed.size, 0);
});
test("tenant is derived from the authority; foreign snapshots and payload tenant claims deny", async t => {
  const f = await fixture(t), r = f.request();
  const other = f.authority.issue("client-b", f.otherTenant);
  await assert.rejects(f.controller.execute(other, r));
  await assert.rejects(f.controller.execute(f.token, { ...r, tenant_id: f.otherTenant }));
  assert.equal(f.driver.committed.size, 0);
});
test("sequential tenants reuse only clean sessions and never share transaction context", async t => {
  const f = await fixture(t), first = await f.controller.execute(f.token, f.request());
  const r = f.request(); f.driver.snapshots.set(r.snapshotId, f.otherTenant);
  const second = await f.controller.execute(f.authority.issue("client-b", f.otherTenant), r);
  assert.notEqual(first.tenant, second.tenant);
  assert.ok(f.driver.sessions.every(s => s.tenant === null && s.lease === null && !s.transaction));
  assert.equal(f.driver.connectCalls, 4);
});
for (const variant of ["expiry", "role", "cluster", "context"] as const) test("session reuse rejects " + variant, async t => {
  const f = await fixture(t), s = f.driver.sessions[0]!;
  if (variant === "expiry") s.expires = f.clock.wall() - 1;
  if (variant === "role") s.role = "superuser";
  if (variant === "cluster") s.systemId = "wrong-cluster";
  if (variant === "context") s.tenant = f.otherTenant;
  await assert.rejects(f.controller.execute(f.token, f.request()));
  assert.equal(f.controller.state, "FAILED"); assert.equal(f.driver.connectCalls, 4);
  assert.ok(f.driver.sessions.every(session => !session.open));
});
test("two concurrent requests use separate pairs; bounded queue rejects excess callers", async t => {
  const f = await fixture(t);
  f.driver.operations.plan("work", { delayMs: 8000 }); f.driver.operations.plan("work", { delayMs: 8000 });
  const busy = [capture(f.controller.execute(f.token, f.request())), capture(f.controller.execute(f.token, f.request()))];
  await flush();
  const queued = Array.from({ length: T.queueDepth }, () => capture(f.controller.execute(f.token, f.request())));
  await flush(); assert.equal(f.controller.queued, T.queueDepth);
  const rejected = await capture(f.controller.execute(f.token, f.request())); assert.equal(rejected.ok, false);
  assert.equal(f.driver.sessions.filter(s => s.transaction).length, 2);
  await f.clock.advance(1001);
  assert.ok((await Promise.all(queued)).every(r => !r.ok)); assert.equal(f.controller.queued, 0);
  await f.clock.advance(7000); assert.ok((await Promise.all(busy)).every(r => r.ok));
  assert.equal(f.driver.connectCalls, 4); assert.equal(f.driver.committed.size, 2);
});
test("cancelled queue entry is removed without taking a pair or opening a connection", async t => {
  const f = await fixture(t);
  f.driver.operations.plan("work", { delayMs: 5000 }); f.driver.operations.plan("work", { delayMs: 5000 });
  const busy = [capture(f.controller.execute(f.token, f.request())), capture(f.controller.execute(f.token, f.request()))];
  await flush(); const cancel = new AbortController();
  const queued = capture(f.controller.execute(f.token, f.request(), cancel.signal)); await flush(); cancel.abort("SECRET");
  assert.equal((await queued).ok, false); assert.equal(f.controller.queued, 0);
  await f.clock.advance(5001); await Promise.all(busy); assert.equal(f.driver.connectCalls, 4);
});
test("cancellation rolls back, joins work and holds duplicate exclusion through cleanup", async t => {
  const f = await fixture(t), r = f.request(), cancel = new AbortController();
  f.driver.operations.plan("work", { delayMs: 8000, ignoreCancellation: true });
  f.driver.operations.plan("rollback", { delayMs: 500 });
  const first = capture(f.controller.execute(f.token, r, cancel.signal)); await flush(); cancel.abort(); await flush();
  const duplicate = await capture(f.controller.execute(f.token, r)); assert.equal(duplicate.ok, false);
  await f.clock.advance(501); assert.equal((await first).ok, false); assert.equal(f.driver.operations.active, 0);
  const retry = await f.controller.execute(f.token, r); assert.equal(retry.can_publish, false);
  assert.equal(f.driver.committed.size, 1);
  const events = f.audit.records().map(e => e["event"]);
  assert.ok(events.includes("ROLLBACK") && events.includes("REJECT") && events.includes("COMMIT"));
});
test("duplicate transactions commit once and replay only within the same tenant/client", async t => {
  const f = await fixture(t), r = f.request();
  f.driver.operations.plan("work", { delayMs: 100 });
  const first = capture(f.controller.execute(f.token, r)); await flush();
  const duplicate = await capture(f.controller.execute(f.token, r)); assert.equal(duplicate.ok, false);
  await f.clock.advance(101); const result = await first; assert.equal(result.ok, true);
  const replay = await f.controller.execute(f.token, r); if (result.ok) assert.equal(replay.operationId, result.value.operationId);
  await assert.rejects(f.controller.execute(f.token, { ...r, sourceVersion: "changed" }));
  assert.equal(f.driver.committed.size, 1); assert.equal(f.audit.records().filter(e => e["event"] === "COMMIT").length, 1);
});
test("service expiry drains work, rolls back, and leaves no delayed commit", async t => {
  const f = await fixture(t); f.driver.operations.plan("work", { delayMs: 20_000, ignoreCancellation: true });
  const result = capture(f.controller.execute(f.token, f.request())); await f.clock.advance(10_001);
  assert.equal((await result).ok, false); assert.equal(f.driver.operations.active, 0);
  assert.ok(f.driver.sessions.every(s => !s.transaction && s.tenant === null));
  await f.clock.advance(20_000); assert.equal(f.driver.committed.size, 0);
});
test("cleanup timeout quarantines every session; no automatic reconnect or retry", async t => {
  const f = await fixture(t); f.driver.operations.plan("reset", { delayMs: 5000, ignoreCancellation: true });
  const result = capture(f.controller.execute(f.token, f.request())); await f.clock.advance(2001);
  assert.equal((await result).ok, false); assert.equal(f.controller.state, "FAILED");
  assert.equal(f.driver.operations.active, 0); assert.ok(f.driver.sessions.every(s => !s.open));
  await assert.rejects(f.controller.execute(f.token, f.request())); assert.equal(f.driver.connectCalls, 4);
});
test("network interruption after commit is retained as an uncertain outcome, never retried", async t => {
  const f = await fixture(t), r = f.request(); f.driver.operations.plan("afterCommit", { failure: "NETWORK" });
  await assert.rejects(f.controller.execute(f.token, r));
  assert.equal(f.driver.committed.size, 1); assert.equal(f.controller.state, "FAILED");
  await assert.rejects(f.controller.execute(f.token, r)); assert.equal(f.driver.committed.size, 1);
  assert.ok(f.audit.records().some(e => e["event"] === "COMMIT"));
  assert.ok(f.audit.records().some(e => e["code"] === "NETWORK"));
});
test("revocation during work denies commit and publication/price payload fields deny", async t => {
  const f = await fixture(t); f.driver.operations.plan("work", { delayMs: 100 });
  const pending = capture(f.controller.execute(f.token, f.request())); await flush(); f.authority.disable("client-a");
  await f.clock.advance(101); assert.equal((await pending).ok, false); assert.equal(f.driver.committed.size, 0);
  const token = f.authority.issue("client-b", f.otherTenant), r = f.request(); f.driver.snapshots.set(r.snapshotId, f.otherTenant);
  for (const patch of [{ can_publish: true }, { price: "1.00" }]) await assert.rejects(f.controller.execute(token, { ...r, ...patch }));
});
test("audit failure fails closed and never discloses a successful result", async t => {
  const f = await fixture(t); f.audit.fail = true;
  await assert.rejects(f.controller.execute(f.token, f.request()));
  assert.equal(f.controller.state, "FAILED"); assert.equal(f.driver.committed.size, 0);
});
test("run expiry and explicit close cancel active/queued operations without replacement", async t => {
  const f = await fixture(t); await f.clock.advance(T.runMs + 1);
  assert.equal(f.controller.state, "CLOSED"); assert.ok(f.driver.sessions.every(s => !s.open));
  await assert.rejects(f.controller.execute(f.token, f.request())); assert.equal(f.driver.connectCalls, 4);
});
test("audit is append-only, chained and contains no token or raw abort reason", async t => {
  const f = await fixture(t), cancel = new AbortController();
  cancel.abort("PRIVATE_ABORT_SECRET"); await assert.rejects(f.controller.execute(f.token, f.request(), cancel.signal));
  await assert.rejects(f.controller.execute("unknown-credential", f.request()));
  await f.controller.execute(f.token, f.request());
  const records = f.audit.records(); assert.ok(Object.isFrozen(records)); assert.ok(records.every(Object.isFrozen));
  const text = JSON.stringify(records); assert.ok(!text.includes(f.token) && !text.includes("PRIVATE_ABORT_SECRET"));
  assert.ok(records.some(e => e["event"] === "REJECT")); assert.ok(records.some(e => e["event"] === "COMMIT"));
});
test("real timer cancellation joins an owned mock operation without late continuation", async () => {
  const operations = new MockOperations(); operations.plan("work", { delayMs: 1000, ignoreCancellation: true });
  await assert.rejects(controlled(new ControlBudget(systemControlClock, 20), scope => operations.run("work", scope)));
  assert.equal(operations.active, 0); assert.equal(operations.forced, 1);
});

test("invalid deadline configuration rejects and a larger child cap cannot escape its parent", async () => {
  const clock = new Clock(), operations = new MockOperations();
  for (const cap of [NaN, Infinity, -1]) assert.throws(() => new ControlBudget(clock, cap));
  operations.plan("physical", { delayMs: 6000 });
  const pending = capture(controlled(new ControlBudget(clock, 5000), parent =>
    controlled(new ControlBudget(clock, 15_000, parent), child => operations.run("physical", child))));
  await clock.advance(5001); assert.equal((await pending).ok, false); assert.equal(operations.active, 0);
});
test("measured cold physical duration fits the proposed hierarchy only with trusted progress", async t => {
  const f = await fixture(t, false);
  f.driver.operations.plan("hashes", { delayMs: 3607 });
  f.driver.operations.plan("physical", { delayMs: 11_977, progress: [{ atMs: 5000, step: 1 }, { atMs: 9000, step: 2 }] });
  f.driver.operations.plan("network", { delayMs: 6499 }); f.driver.operations.plan("assertion", { delayMs: 3999 });
  const pending = capture(f.controller.startup()); await f.clock.advance(27_000);
  assert.equal((await pending).ok, true); assert.equal(f.controller.state, "READY"); assert.equal(f.driver.connectCalls, 4);
});
test("identity expiry during queued wait cannot authenticate a later lease", async t => {
  const f = await fixture(t);
  f.driver.operations.plan("work", { delayMs: 800 }); f.driver.operations.plan("work", { delayMs: 800 });
  const busy = [capture(f.controller.execute(f.token, f.request())), capture(f.controller.execute(f.token, f.request()))];
  await flush(); const short = f.authority.issue("client-a", f.tenant, 500);
  const pending = capture(f.controller.execute(short, f.request())); await f.clock.advance(801);
  assert.equal((await pending).ok, false); await Promise.all(busy); assert.equal(f.driver.committed.size, 2);
});
test("session loss and target identity drift during active work prevent commit", async t => {
  const f = await fixture(t); f.driver.operations.plan("work", { delayMs: 100 });
  const pending = capture(f.controller.execute(f.token, f.request())); await flush(); f.driver.proofExpired = true;
  await f.clock.advance(101); assert.equal((await pending).ok, false);
  assert.equal(f.driver.committed.size, 0); assert.equal(f.controller.state, "FAILED"); assert.equal(f.driver.connectCalls, 4);
});
test("cancellation during commit prevents a delayed mutation", async t => {
  const f = await fixture(t), cancel = new AbortController();
  f.driver.operations.plan("commit", { delayMs: 1000, ignoreCancellation: true });
  const pending = capture(f.controller.execute(f.token, f.request(), cancel.signal)); await flush(); cancel.abort();
  assert.equal((await pending).ok, false); await f.clock.advance(2000); assert.equal(f.driver.committed.size, 0);
});
test("rollback failure quarantines the pool and keeps the original rejection", async t => {
  const f = await fixture(t), cancel = new AbortController();
  f.driver.operations.plan("work", { delayMs: 5000 }); f.driver.operations.plan("rollback", { failure: "CLEANUP" });
  const pending = capture(f.controller.execute(f.token, f.request(), cancel.signal)); await flush(); cancel.abort();
  assert.equal((await pending).ok, false); assert.equal(f.controller.state, "FAILED");
  assert.ok(f.audit.records().some(r => r["code"] === "CANCELLED"));
  assert.ok(f.audit.records().some(r => r["code"] === "CLEANUP")); assert.equal(f.driver.operations.active, 0);
});
test("audit failure at commit rolls back the synthetic mutation", async t => {
  const f = await fixture(t); f.driver.operations.plan("work", { delayMs: 100 });
  const pending = capture(f.controller.execute(f.token, f.request())); await flush(); f.audit.fail = true;
  await f.clock.advance(101); assert.equal((await pending).ok, false); assert.equal(f.driver.committed.size, 0);
});
test("credentials expiring during reset cannot disclose a successful response", async t => {
  const f = await fixture(t), short = f.authority.issue("client-a", f.tenant, 100);
  f.driver.operations.plan("reset", { delayMs: 200 });
  const pending = capture(f.controller.execute(short, f.request())); await f.clock.advance(201);
  assert.equal((await pending).ok, false); assert.equal(f.driver.committed.size, 1);
  assert.ok(f.audit.records().some(r => r["event"] === "COMMIT"));
  assert.ok(f.audit.records().some(r => r["code"] === "AUTHENTICATION"));
});
test("closing with active and queued requests joins all work and releases every session", async t => {
  const f = await fixture(t);
  f.driver.operations.plan("work", { delayMs: 5000 }); f.driver.operations.plan("work", { delayMs: 5000 });
  const pending = [capture(f.controller.execute(f.token, f.request())), capture(f.controller.execute(f.token, f.request()))];
  await flush(); pending.push(capture(f.controller.execute(f.token, f.request()))); await flush();
  await f.controller.close(); assert.ok((await Promise.all(pending)).every(r => !r.ok));
  assert.equal(f.driver.operations.active, 0); assert.equal(f.controller.queued, 0);
  assert.ok(f.driver.sessions.every(s => !s.open)); assert.equal(f.driver.committed.size, 0);
});
test("unexpected replay output cannot introduce publication authority or sensitive fields", async t => {
  const f = await fixture(t), r = f.request(); await f.controller.execute(f.token, r);
  const [key, entry] = [...f.driver.committed][0]!;
  f.driver.committed.set(key, { ...entry, receipt: { ...entry.receipt, can_publish: true } as unknown as typeof entry.receipt });
  await assert.rejects(f.controller.execute(f.token, r));
});
test("audit hash chain verifies across failure and later recovery, without deleting history", async t => {
  const f = await fixture(t); await assert.rejects(f.controller.execute("forged", f.request()));
  const original = f.audit.records(); await f.controller.execute(f.token, f.request());
  const records = f.audit.records(); assert.deepEqual(records.slice(0, original.length), original);
  let previous = "0".repeat(64);
  for (const row of records) {
    const { hash, ...body } = row; assert.equal(row["previous"], previous);
    assert.equal(hash, createHash("sha256").update(JSON.stringify(body)).digest("hex")); previous = hash as string;
  }
});
test("four mock sessions and a request create zero real network connections", async t => {
  const connect = net.Socket.prototype.connect; let calls = 0;
  net.Socket.prototype.connect = function () { calls++; throw new Error("Network forbidden in offline fixture"); };
  try { const f = await fixture(t); await f.controller.execute(f.token, f.request()); await f.controller.close(); }
  finally { net.Socket.prototype.connect = connect; }
  assert.equal(calls, 0);
});
test("startup permits cannot be forged and an active driver cannot acquire another owner", async t => {
  const f = await fixture(t), budget = new ControlBudget(f.clock, T.connectionSetupMs);
  try { await assert.rejects(f.driver.open(0, budget, {})); await assert.rejects(f.driver.open(4, budget)); }
  finally { budget.dispose(); }
  assert.throws(() => new OfflineSessionController({ capability: "OFFLINE_MOCK_SESSION_CONTROL_ONLY", clock: f.clock,
    driver: f.driver, authority: f.authority, audit: f.audit }));
  assert.equal(f.driver.connectCalls, 4);
});
test("transaction deadline remains 8.5 seconds inside the 10-second service cap", async t => {
  const f = await fixture(t); f.driver.operations.plan("work", { delayMs: 9000 });
  const pending = capture(f.controller.execute(f.token, f.request())); await f.clock.advance(T.transactionMs + 1);
  assert.equal((await pending).ok, false); assert.equal(f.driver.operations.active, 0); assert.equal(f.driver.committed.size, 0);
  assert.ok(f.audit.records().some(r => r["event"] === "ROLLBACK"));
});
test("forged error codes and audit labels cannot persist secrets", async t => {
  const f = await fixture(t), cancel = new AbortController();
  const error = new OfflineControlError("PRIVATE_ABORT_SECRET" as ControlCode); assert.equal(error.code, "STATE");
  assert.ok(Object.isFrozen(error)); cancel.abort(error);
  await assert.rejects(f.controller.execute(f.token, f.request(), cancel.signal));
  assert.throws(() => f.audit.append("PRIVATE_ABORT_SECRET" as ControlEvent));
  assert.throws(() => f.audit.append("REJECT", "PRIVATE_ABORT_SECRET" as ControlCode));
  assert.ok(!JSON.stringify(f.audit.records()).includes("PRIVATE_ABORT_SECRET"));
});

test("ownership revocation during cleanup denies disclosure and preserves the committed operation", async t => {
  const f = await fixture(t), r = f.request(); f.driver.operations.plan("reset", { delayMs: 100 });
  const pending = capture(f.controller.execute(f.token, r)); await flush();
  assert.equal(f.driver.committed.size, 1); f.driver.snapshots.set(r.snapshotId, f.otherTenant);
  await f.clock.advance(101); const result = await pending;
  assert.equal(result.ok, false); assert.equal(f.driver.committed.size, 1);
  assert.ok(!f.audit.records().some(e => e["event"] === "DISCLOSED"));
  assert.ok(f.audit.records().some(e => e["code"] === "AUTHORIZATION"));
});
test("revoke-and-restore ownership epochs cannot authorize stale receipts or replay", async t => {
  const f = await fixture(t), r = f.request(); f.driver.operations.plan("reset", { delayMs: 100 });
  const pending = capture(f.controller.execute(f.token, r)); await flush();
  f.driver.snapshots.delete(r.snapshotId); f.driver.snapshots.set(r.snapshotId, f.tenant);
  await f.clock.advance(101); assert.equal((await pending).ok, false);
  await assert.rejects(f.controller.execute(f.token, r)); assert.equal(f.driver.committed.size, 1);
});
test("revocation during replay cleanup and an invalidated authoritative receipt deny", async t => {
  const f = await fixture(t), r = f.request(); await f.controller.execute(f.token, r);
  f.driver.operations.plan("reset", { delayMs: 100 });
  const replay = capture(f.controller.execute(f.token, r)); await flush(); f.driver.snapshots.delete(r.snapshotId);
  await f.clock.advance(101); assert.equal((await replay).ok, false);
});
test("128 unauthenticated requests never exceed two auth operations plus eight queued", async t => {
  const f = await fixture(t); for (let i = 0; i < 128; i++) f.driver.operations.plan("authentication", { delayMs: 900 });
  const pending = Array.from({ length: 128 }, () => capture(f.controller.execute("unknown", f.request())));
  await flush(); assert.equal(f.controller.admittedRequests, 2); assert.equal(f.controller.queued, 8);
  assert.equal(f.controller.activeRequests, 10); assert.equal(f.driver.operations.active, 2);
  await f.clock.advance(1001); await f.controller.close();
  assert.ok((await Promise.all(pending)).every(p => !p.ok)); assert.equal(f.driver.operations.active, 0);
  assert.equal(f.driver.connectCalls, 4); assert.equal(f.controller.terminalConfirmed, true);
});
test("admission capacity is released after cancellation and input bounds reject before auth", async t => {
  const f = await fixture(t), abort = new AbortController();
  f.driver.operations.plan("authentication", { delayMs: 500 });
  const first = capture(f.controller.execute(f.token, f.request(), abort.signal)); await flush(); abort.abort();
  assert.equal((await first).ok, false); await flush(); assert.equal(f.controller.admittedRequests, 0);
  await assert.rejects(f.controller.execute("x".repeat(8193), f.request()));
  await assert.rejects(f.controller.execute(f.token, { ...f.request(), sourceVersion: "x".repeat(100000) }));
  assert.equal(f.driver.operations.active, 0); await f.controller.execute(f.token, f.request());
});
test("idle session expiry closes all sessions without waiting for another request", async t => {
  const f = await fixture(t); await f.clock.advance(T.sessionLifetimeMs + 1); await f.controller.waitForTerminal();
  assert.equal(f.controller.state, "CLOSED"); assert.ok(f.driver.sessions.every(s => !s.open));
  assert.equal(f.controller.terminalConfirmed, true); assert.equal(f.driver.connectCalls, 4);
  await assert.rejects(f.controller.execute(f.token, f.request()));
});
for (const phase of ["authentication", "queue", "transaction", "cleanup"] as const) test("expiry during " + phase + " drains owned work", async t => {
  const f = await fixture(t), pending: ReturnType<typeof capture>[] = [];
  if (phase === "authentication") f.driver.operations.plan("authentication", { delayMs: 1000 });
  if (phase === "transaction" || phase === "queue") f.driver.operations.plan("work", { delayMs: 5000 });
  if (phase === "queue") f.driver.operations.plan("work", { delayMs: 5000 });
  if (phase === "cleanup") f.driver.operations.plan("reset", { delayMs: 500 });
  pending.push(capture(f.controller.execute(f.token, f.request()))); await flush();
  if (phase === "queue") {
    pending.push(capture(f.controller.execute(f.token, f.request()))); await flush();
    pending.push(capture(f.controller.execute(f.token, f.request()))); await flush(); assert.equal(f.controller.queued, 1);
  }
  f.driver.expireSessionsNow(); await f.clock.advance(0);
  if (phase === "cleanup") { assert.equal(f.controller.state, "DRAINING"); assert.equal(f.controller.terminalConfirmed, false); await f.clock.advance(501); }
  await Promise.all(pending); await f.controller.waitForTerminal();
  assert.equal(f.controller.terminalConfirmed, true); assert.equal(f.controller.queued, 0);
  assert.ok(f.driver.sessions.every(s => !s.open && !s.transaction && s.tenant === null && s.lease === null));
  assert.equal(f.driver.operations.active, 0); assert.equal(f.driver.connectCalls, 4);
});
