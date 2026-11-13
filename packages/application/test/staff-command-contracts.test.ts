import assert from "node:assert/strict";
import test from "node:test";
import { prepareStaffCommand, describeStaffCommandBundle, staffReceiptLookup, resolveStaffReceipt, StaffCommandContractError,
  type StaffCommandCandidate, type StaffCommandReceipt } from "../src/identity/staff-command-contracts.js";
import { proposeAccessRequestTransition } from "../src/identity/access-change-policy.js";
import { InMemoryStaffSimulation, barrier } from "./fixtures/staff-command-simulation.js";
import { actor, candidate, commandFixture, NOW, refresh, uid } from "./fixtures/staff-command-fixtures.js";

const text = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => typeof v === "bigint" ? v.toString() : v);
function altered() {
  const f = commandFixture();
  return candidate(refresh({ ...f, request: { ...f.request, proposedRoles: ["GOVERNANCE_OWNER"] } }));
}
function tenantCandidate(tenantId = uid(20)) {
  const f = commandFixture("SUSPEND");
  return candidate(refresh({
    request: { ...f.request, operation: { kind: "SUSPEND", target: "MEMBERSHIP" }, scope: { kind: "TENANT", tenantId }, expectedMembershipVersion: 1n },
    context: { ...f.context, requester: actor(1, "ACCESS_ADMIN"), objectTenantId: tenantId,
      target: { ...f.context.target, membership: { tenantId, status: "ACTIVE", version: 1n } } },
  }));
}
const empty = { intents: 0, audits: 0, receipts: 0, reservations: 0 };

test("all typed operations produce fixed safe audit intents and simulation-only receipts", () => {
  for (const kind of ["CREATE", "ACTIVATE", "SUSPEND", "REVOKE", "REACTIVATE", "DISABLE", "RECOVER"] as const) {
    const command = candidate(commandFixture(kind)); const bundle = describeStaffCommandBundle(command, NOW);
    assert.equal(bundle.auditIntent.eventName, `STAFF_${kind}_INTENT`);
    assert.equal(bundle.receipt.outcome, "SIMULATION_RECORDED");
    assert.equal(bundle.receipt.operationId, command.operationId);
    assert.equal(bundle.auditIntent.actorStaffId, command.actorStaffId);
    assert.equal(bundle.auditIntent.targetStaffId, command.targetStaffId);
    for (const record of [command, bundle, bundle.mutationIntent, bundle.auditIntent, bundle.receipt]) {
      assert.equal(record.execution, "NOT_AUTHORIZED"); assert.ok(Object.isFrozen(record));
      assert.deepEqual(record.executionBlockers, ["ASSURANCE_NOT_ESTABLISHED", "RESERVED_PERMISSION_INACTIVE", "NO_EXECUTOR"]);
    }
  }
});
test("operation IDs and payload digests are deterministic with canonical roles and approvals", () => {
  const f = commandFixture(); const first = candidate(f); const second = candidate(f);
  assert.equal(first.operationId, second.operationId); assert.equal(first.commandDigest, second.commandDigest);
  assert.equal(candidate({ ...f, context: { ...f.context, approvals: [...f.context.approvals].reverse() } }).commandDigest, first.commandDigest);
  assert.equal(candidate({ ...f, request: { ...f.request, state: "APPROVED" } }).commandDigest, first.commandDigest);
  assert.notEqual(candidate(f, uid(71)).operationId, first.operationId);
});
test("changed role, target, tenant or approval payload cannot reuse the same actor/key receipt", () => {
  const original = candidate(); const record = describeStaffCommandBundle(original, NOW).receipt;
  const f = commandFixture();
  const changedTarget = candidate(refresh({ request: { ...f.request, targetStaffId: uid(5) }, context: { ...f.context, target: { ...f.context.target, staffId: uid(5) } } }));
  const changedApproval = candidate({ ...f, context: { ...f.context, approvals: f.context.approvals.map((a) => ({ ...a, expiresAtMs: a.expiresAtMs - 1 })) } });
  for (const command of [altered(), changedTarget, changedApproval]) {
    assert.equal(command.operationId, original.operationId); assert.notEqual(command.commandDigest, original.commandDigest);
    assert.equal(resolveStaffReceipt(staffReceiptLookup(command), record).kind, "CONFLICT");
  }
  const a = tenantCandidate(); const b = tenantCandidate(uid(21));
  assert.equal(a.operationId, b.operationId);
  assert.equal(resolveStaffReceipt(staffReceiptLookup(b), describeStaffCommandBundle(a, NOW).receipt).kind, "CONFLICT");
});
test("construction copies only safe fields and freezes role/scope/operation values", () => {
  const f = commandFixture(); const before = structuredClone(f);
  const request = { ...f.request, token: "synthetic-private-marker", email: "synthetic-private-marker", operationId: "untrusted-id" };
  const command = candidate({ ...f, request });
  assert.deepEqual(f, before); assert.equal(text(command).includes("synthetic-private-marker"), false);
  assert.equal(text(command).includes("untrusted-id"), false);
  assert.ok(Object.isFrozen(command.operation)); assert.ok(Object.isFrozen(command.scope)); assert.ok(Object.isFrozen(command.roleCodes));
  assert.throws(() => (command.roleCodes as string[]).push("SECURITY_ADMIN"), TypeError);
});
test("invalid keys, stale requests and unknown operation profiles reject without producing a candidate", () => {
  const f = commandFixture();
  for (const key of ["", "private-input-marker", "x".repeat(8192)]) {
    const result = prepareStaffCommand(f.request, f.context, key, NOW);
    assert.equal(result.kind, "REJECTED"); assert.equal(text(result).includes(key || "unused"), false);
  }
  assert.equal(prepareStaffCommand(f.request, { ...f.context, currentRequestVersion: 2n }, uid(70), NOW).kind, "REJECTED");
  assert.equal(prepareStaffCommand({ ...f.request, state: "DRAFT" }, { ...f.context, approvals: [] }, uid(70), NOW).kind, "REJECTED");
});
test("bundle description rejects clones, invalid timestamps and expired candidates", () => {
  const command = candidate();
  for (const time of [Number.NaN, command.createdAtMs - 1, command.expiresAtMs]) {
    assert.throws(() => describeStaffCommandBundle(command, time), { message: "Invalid staff command contract" });
  }
  assert.throws(() => describeStaffCommandBundle(structuredClone(command) as StaffCommandCandidate, NOW), StaffCommandContractError);
  assert.throws(() => staffReceiptLookup(structuredClone(command) as StaffCommandCandidate), StaffCommandContractError);
});
test("receipt lookup reconstitutes only immutable allowlisted fields", () => {
  const command = candidate(); const receipt = describeStaffCommandBundle(command, NOW).receipt;
  const result = resolveStaffReceipt(staffReceiptLookup(command), { ...receipt, privateDetail: "private-marker" } as StaffCommandReceipt);
  assert.equal(result.kind, "RECORDED_SIMULATION"); assert.equal(text(result).includes("private-marker"), false);
  if (result.kind === "RECORDED_SIMULATION") { assert.ok(Object.isFrozen(result.receipt)); assert.ok(Object.isFrozen(result.receipt.scope)); }
});
test("same-digest receipt tampering of actor, target, tenant, event or outcome is rejected", () => {
  const command = tenantCandidate(); const receipt = describeStaffCommandBundle(command, NOW).receipt; const lookup = staffReceiptLookup(command);
  assert.equal(resolveStaffReceipt(lookup, { ...receipt, actorStaffId: uid(8) }).kind, "NOT_FOUND");
  for (const changed of [{ ...receipt, targetStaffId: uid(5) }, { ...receipt, scope: { kind: "TENANT" as const, tenantId: uid(21) } },
    { ...receipt, auditEventId: "wrong" }, { ...receipt, recordedAtMs: command.expiresAtMs },
    { ...receipt, outcome: "APPLIED" }, { ...receipt, execution: "AUTHORIZED" }]) {
    assert.equal(resolveStaffReceipt(lookup, changed as unknown as StaffCommandReceipt).kind, "INVALID_RECEIPT");
  }
});
test("lookup rejects mismatched namespace and cannot disclose another actor's receipt", () => {
  const command = candidate(); const lookup = staffReceiptLookup(command); const receipt = describeStaffCommandBundle(command, NOW).receipt;
  assert.equal(resolveStaffReceipt({ ...lookup, actorStaffId: uid(8) }, receipt).kind, "INVALID_LOOKUP");
  assert.equal(resolveStaffReceipt({ ...lookup, idempotencyKey: uid(71) }, receipt).kind, "INVALID_LOOKUP");
  assert.equal(resolveStaffReceipt(null as unknown as typeof lookup, receipt).kind, "INVALID_LOOKUP");
  const f = commandFixture(); const other = candidate(refresh({ request: { ...f.request, requesterStaffId: uid(8) }, context: { ...f.context, requester: actor(8, "ACCESS_ADMIN") } }));
  const result = resolveStaffReceipt(staffReceiptLookup(other), receipt);
  assert.equal(result.kind, "NOT_FOUND"); assert.equal("receipt" in result, false);
});
test("identical replay returns the original receipt without another intent or audit", async () => {
  const store = new InMemoryStaffSimulation(() => NOW); const command = candidate();
  const first = await store.simulate(command); const replay = await store.simulate(candidate());
  assert.equal(first.kind, "RECORDED"); assert.equal(replay.kind, "REPLAYED");
  if (first.kind === "RECORDED" && replay.kind === "REPLAYED") assert.deepEqual(first.receipt, replay.receipt);
  assert.deepEqual(store.stats(), { intents: 1, audits: 1, receipts: 1, reservations: 0 });
});
test("same key with a changed payload rejects and preserves the original receipt", async () => {
  const store = new InMemoryStaffSimulation(() => NOW); await store.simulate(candidate());
  const changed = await store.simulate(altered());
  assert.equal(changed.kind, "REJECTED"); if (changed.kind === "REJECTED") assert.equal(changed.reason, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(store.stats(), { intents: 1, audits: 1, receipts: 1, reservations: 0 });
});
test("concurrent identical requests serialize to one recorded simulation and one replay", async () => {
  const store = new InMemoryStaffSimulation(() => NOW); const entered = barrier(); const release = barrier(); const command = candidate();
  const first = store.simulate(command, { beforeCommit: async () => { entered.release(); await release.promise; } });
  await entered.promise;
  const second = store.simulate(candidate());
  assert.equal((await store.lookup(staffReceiptLookup(command))).kind, "PENDING");
  assert.deepEqual(store.stats(), { ...empty, reservations: 1 });
  release.release(); const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((r) => r.kind), ["RECORDED", "REPLAYED"]);
  assert.deepEqual(store.stats(), { intents: 1, audits: 1, receipts: 1, reservations: 0 });
});
test("concurrent changed payloads cannot create two bundles for one actor/key", async () => {
  const store = new InMemoryStaffSimulation(() => NOW); const entered = barrier(); const release = barrier();
  const first = store.simulate(candidate(), { beforeCommit: async () => { entered.release(); await release.promise; } });
  await entered.promise; const second = store.simulate(altered()); release.release();
  assert.deepEqual((await Promise.all([first, second])).map((r) => r.kind), ["RECORDED", "REJECTED"]);
  assert.deepEqual(store.stats(), { intents: 1, audits: 1, receipts: 1, reservations: 0 });
});
test("failure at every precommit stage returns no receipt and publishes no partial state", async () => {
  for (const failure of ["BEGIN", "AFTER_READ", "AFTER_INTENT", "AFTER_AUDIT", "AFTER_RECEIPT", "BEFORE_COMMIT", "ROLLBACK"] as const) {
    const store = new InMemoryStaffSimulation(() => NOW); const command = candidate();
    const result = await store.simulate(command, { failure });
    assert.equal(result.kind, "FAILED", failure); assert.equal("receipt" in result, false); assert.equal(result.execution, "NOT_AUTHORIZED");
    assert.equal(text(result).includes("private"), false); assert.deepEqual(store.stats(), empty);
    assert.equal((await store.lookup(staffReceiptLookup(command))).kind, "NOT_FOUND");
  }
});
test("failed new operations never erase prior recorded history", async () => {
  const store = new InMemoryStaffSimulation(() => NOW); const original = candidate(); await store.simulate(original);
  const next = candidate(commandFixture(), uid(71)); await store.simulate(next, { failure: "AFTER_AUDIT" });
  assert.equal((await store.lookup(staffReceiptLookup(original))).kind, "RECORDED_SIMULATION");
  assert.equal((await store.lookup(staffReceiptLookup(next))).kind, "NOT_FOUND");
  assert.deepEqual(store.stats(), { intents: 1, audits: 1, receipts: 1, reservations: 0 });
});
test("retry after precommit failure or cleanup failure reacquires the key and records once", async () => {
  for (const failure of ["AFTER_INTENT", "ROLLBACK"] as const) {
    const store = new InMemoryStaffSimulation(() => NOW); const command = candidate();
    assert.equal((await store.simulate(command, { failure })).kind, "FAILED");
    assert.equal((await store.simulate(command)).kind, "RECORDED");
    assert.equal((await store.simulate(command)).kind, "REPLAYED");
    assert.deepEqual(store.stats(), { intents: 1, audits: 1, receipts: 1, reservations: 0 });
  }
});
test("lost acknowledgement after atomic publication returns UNCERTAIN until scoped lookup resolves it", async () => {
  const store = new InMemoryStaffSimulation(() => NOW); const command = candidate();
  const result = await store.simulate(command, { failure: "ACK_LOST_AFTER_COMMIT" });
  assert.equal(result.kind, "UNCERTAIN"); assert.equal("receipt" in result, false);
  assert.equal((await store.lookup(staffReceiptLookup(command))).kind, "RECORDED_SIMULATION");
  assert.equal((await store.simulate(command)).kind, "REPLAYED");
  assert.deepEqual(store.stats(), { intents: 1, audits: 1, receipts: 1, reservations: 0 });
});
test("unknown commit without publication stays uncertain; missing receipt requires reservation before retry", async () => {
  const store = new InMemoryStaffSimulation(() => NOW); const command = candidate();
  const result = await store.simulate(command, { failure: "ACK_LOST_WITHOUT_COMMIT" });
  assert.equal(result.kind, "UNCERTAIN"); assert.equal("receipt" in result, false);
  const lookup = await store.lookup(staffReceiptLookup(command)); assert.equal(lookup.kind, "NOT_FOUND");
  if (lookup.kind === "NOT_FOUND") assert.equal(lookup.retryRequiresReservation, true);
  assert.equal((await store.simulate(command)).kind, "RECORDED"); assert.equal(store.stats().receipts, 1);
});
test("unavailable lookup cannot turn uncertain acknowledgement into a successful response", async () => {
  const store = new InMemoryStaffSimulation(() => NOW); const command = candidate();
  const result = await store.simulate(command, { failure: "ACK_LOST_AFTER_COMMIT" });
  store.lookupUnavailable = true;
  assert.equal((await store.lookup(staffReceiptLookup(command))).kind, "LOOKUP_UNAVAILABLE"); assert.equal(result.kind, "UNCERTAIN");
  store.lookupUnavailable = false; assert.equal((await store.lookup(staffReceiptLookup(command))).kind, "RECORDED_SIMULATION");
});
test("an incomplete pending operation cannot be mistaken for an absent terminal receipt", async () => {
  const store = new InMemoryStaffSimulation(() => NOW); const command = candidate(); const entered = barrier(); const release = barrier();
  const work = store.simulate(command, { failure: "BEFORE_COMMIT", beforeCommit: async () => { entered.release(); await release.promise; } });
  await entered.promise; const status = await store.lookup(staffReceiptLookup(command));
  assert.equal(status.kind, "PENDING"); assert.equal("receipt" in status, false);
  release.release(); assert.equal((await work).kind, "FAILED");
  assert.equal((await store.lookup(staffReceiptLookup(command))).kind, "NOT_FOUND");
});
test("concurrent failure recovery records once and uncertain completion becomes replay", async () => {
  for (const failure of ["BEFORE_COMMIT", "ACK_LOST_AFTER_COMMIT"] as const) {
    const store = new InMemoryStaffSimulation(() => NOW); const entered = barrier(); const release = barrier(); const command = candidate();
    const first = store.simulate(command, { failure, beforeCommit: async () => { entered.release(); await release.promise; } });
    await entered.promise; const second = store.simulate(candidate()); release.release();
    assert.deepEqual((await Promise.all([first, second])).map((r) => r.kind), failure === "BEFORE_COMMIT" ? ["FAILED", "RECORDED"] : ["UNCERTAIN", "REPLAYED"]);
    assert.deepEqual(store.stats(), { intents: 1, audits: 1, receipts: 1, reservations: 0 });
  }
});
test("transaction stages and complete bundle bindings reject partial or substituted audit/receipt data", async () => {
  const store = new InMemoryStaffSimulation(() => NOW); const command = candidate(); const bundle = describeStaffCommandBundle(command, NOW);
  const tx = await store.begin(command);
  await assert.rejects(() => tx.commit()); await assert.rejects(() => tx.stageAudit(bundle.auditIntent));
  await tx.inspectReceipt(); await tx.stageIntent(bundle.mutationIntent);
  await tx.stageAudit({ ...bundle.auditIntent, targetStaffId: uid(9) }); await tx.stageReceipt(bundle.receipt);
  await assert.rejects(() => tx.commit()); await tx.rollback(); await tx.rollback(); assert.deepEqual(store.stats(), empty);
  assert.equal((await store.simulate(command)).kind, "RECORDED");
});
test("the same idempotency key belongs to different actor namespaces without cross-actor replay", async () => {
  const store = new InMemoryStaffSimulation(() => NOW); const original = candidate(); const f = commandFixture();
  const other = candidate(refresh({ request: { ...f.request, requesterStaffId: uid(8) }, context: { ...f.context, requester: actor(8, "ACCESS_ADMIN") } }));
  assert.notEqual(other.operationId, original.operationId);
  assert.equal((await store.simulate(original)).kind, "RECORDED"); assert.equal((await store.simulate(other)).kind, "RECORDED");
  assert.deepEqual(store.stats(), { intents: 2, audits: 2, receipts: 2, reservations: 0 });
});
test("expiry during a paused simulation prevents publication and releases the reservation", async () => {
  let now = NOW; const store = new InMemoryStaffSimulation(() => now); const command = candidate();
  const result = await store.simulate(command, { beforeCommit: async () => { now = command.expiresAtMs; } });
  assert.equal(result.kind, "FAILED"); assert.equal("receipt" in result, false); assert.deepEqual(store.stats(), empty);
});
test("recorded simulation receipts can be reconciled after command expiry without recording another intent", async () => {
  let now = NOW; const store = new InMemoryStaffSimulation(() => now); const command = candidate();
  await store.simulate(command); now = command.expiresAtMs + 1;
  assert.equal((await store.lookup(staffReceiptLookup(command))).kind, "RECORDED_SIMULATION");
  assert.equal((await store.simulate(command)).kind, "REPLAYED"); assert.equal(store.stats().receipts, 1);
});
test("all simulation outcomes remain non-authorized and cannot enable APPLY", async () => {
  const f = commandFixture(); const command = candidate(f); const store = new InMemoryStaffSimulation(() => NOW);
  const outcomes = [await store.simulate(command), await store.simulate(command), await store.simulate(altered())];
  for (const outcome of outcomes) assert.equal(outcome.execution, "NOT_AUTHORIZED");
  const apply = proposeAccessRequestTransition(f.request, f.context, "APPLY", NOW);
  assert.equal(apply.kind, "REJECTED"); if (apply.kind === "REJECTED") assert.equal(apply.reason, "EXECUTION_UNAVAILABLE");
});
