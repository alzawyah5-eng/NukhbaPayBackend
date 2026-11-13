import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readAuthorizedStaffSelf, type InternalStaffRequest } from "../src/identity/read-authorized-staff-self.js";
import { attestVerifiedStaffIdentity, isVerifiedStaffIdentity, type VerifiedStaffIdentity } from "../src/identity/verified-staff-identity.js";
import type { StaffAuthorizationRepository, StaffRoleGrant, ResolvedStaffPrincipal, ResolvedStaffMembership } from "../src/identity/staff-access.js";
import type { SecurityAuditEvent } from "../src/identity/security-audit.js";

const now = new Date("2026-11-11T08:00:00Z");
const staffId = randomUUID(); const tenantId = randomUUID();

function verified(): VerifiedStaffIdentity {
  return attestVerifiedStaffIdentity({
    issuer: "https://issuer.synthetic.invalid/", subject: "CaseSensitive-Staff",
    security: {
      audience: "urn:synthetic:staff", clientId: "synthetic", profile: "rfc9068-staff-v1", principalKind: "human",
      issuedAt: now.getTime() / 1000, expiresAt: now.getTime() / 1000 + 300, assurance: "not-established",
    },
  });
}

function fixture() {
  const events: SecurityAuditEvent[] = [];
  const state = {
    principal: { staffId, staffStatus: "ACTIVE", identityStatus: "ACTIVE", tokensValidAfter: null, authzVersion: 1n } as ResolvedStaffPrincipal | null,
    membership: { membershipId: randomUUID(), tenantId, status: "ACTIVE", version: 1n, roleGrants: [] } as ResolvedStaffMembership | null,
    platform: [] as readonly StaffRoleGrant[], reads: 0, readerUnavailable: false, writerUnavailable: false,
    seenIdentity: undefined as { issuer: string; subject: string } | undefined,
  };
  const repository: StaffAuthorizationRepository = {
    async findByTrustedIdentity(identity) {
      state.reads += 1;
      if (state.readerUnavailable) throw new Error("Synthetic sensitive reader detail");
      state.seenIdentity = identity;
      return state.principal;
    },
    async findTenantMembership() { return state.membership; },
    async findPlatformRoleGrants() { return state.platform; },
  };
  const dependencies = {
    repository,
    auditWriter: { async appendSecurityAuditEvents(batch: readonly SecurityAuditEvent[]) {
      if (state.writerUnavailable) throw new Error("Synthetic sensitive writer detail");
      events.push(...batch);
    } },
    now: () => now,
  };
  const request: InternalStaffRequest = { requestId: randomUUID(), permissionCode: "staff.self.read", scope: "SELF" };
  return { state, events, dependencies, request };
}

test("persisted token cutoff requires strictly later verified issuance and fails closed on invalid cutoff",async()=>{
  for(const [cutoff,allowed] of [
    [new Date(now.getTime()-1).toISOString(),true],
    [now.toISOString(),false],
    [new Date(now.getTime()+1).toISOString(),false],
    ['invalid-cutoff',false],
    [undefined,false],
  ] as const) {
    const f=fixture();
    f.state.principal={...f.state.principal!,tokensValidAfter:cutoff as string};
    const result=await readAuthorizedStaffSelf(f.dependencies,verified(),f.request);
    assert.equal(result.allowed,allowed);
    assert.equal(f.events.length,1);assert.equal(f.events[0]!.outcome,allowed?'SUCCESS':'DENIED');
  }
});

test("verified identity provenance survives only trusted adapter objects, not JSON or structural clones", async () => {
  const { dependencies, request, state } = fixture();
  const identity = verified();
  assert.ok(isVerifiedStaffIdentity(identity));
  for (const clone of [{ ...identity }, JSON.parse(JSON.stringify(identity)) as unknown]) {
    assert.equal(isVerifiedStaffIdentity(clone), false);
    const result = await readAuthorizedStaffSelf(dependencies, clone as VerifiedStaffIdentity, request);
    assert.equal(result.allowed, false);
    assert.equal(state.reads, 0);
  }
});

test("active self access uses exact issuer/subject and commits an allow audit before returning minimal data", async () => {
  const { dependencies, request, events, state } = fixture();
  const result = await readAuthorizedStaffSelf(dependencies, verified(), request);
  assert.equal(result.allowed, true);
  if (result.allowed) assert.deepEqual(result.staff, { staffId, authzVersion: 1n, membership: null });
  assert.equal(events[0]?.outcome, "SUCCESS");
  assert.equal(state.seenIdentity?.subject, "CaseSensitive-Staff");
  assert.equal(state.seenIdentity?.issuer, "https://issuer.synthetic.invalid/");
});

test("unknown, pending, suspended, disabled staff and disabled external identities deny without enrollment", async () => {
  for (const principal of [null, ...["PENDING", "SUSPENDED", "DISABLED"].map((status) => ({
    staffId, staffStatus: status, identityStatus: "ACTIVE", tokensValidAfter: null, authzVersion: 1n,
  })), { staffId, staffStatus: "ACTIVE", identityStatus: "DISABLED", tokensValidAfter: null, authzVersion: 1n }]) {
    const { dependencies, request, state, events } = fixture();
    state.principal = principal as ResolvedStaffPrincipal | null;
    assert.equal((await readAuthorizedStaffSelf(dependencies, verified(), request)).allowed, false);
    assert.equal(events[0]?.outcome, "DENIED");
  }
});

test("tenant context requires active membership and matching object scope even for a self summary", async () => {
  const { dependencies, request, state } = fixture();
  const scoped = { ...request, tenantId, objectTenantId: tenantId };
  assert.equal((await readAuthorizedStaffSelf(dependencies, verified(), scoped)).allowed, true);
  for (const membership of [null, { ...state.membership!, status: "SUSPENDED" }, { ...state.membership!, status: "REVOKED" }]) {
    state.membership = membership as ResolvedStaffMembership | null;
    assert.equal((await readAuthorizedStaffSelf(dependencies, verified(), scoped)).allowed, false);
  }
  assert.equal((await readAuthorizedStaffSelf(dependencies, verified(), { ...scoped, objectTenantId: randomUUID() })).allowed, false);
});

test("reserved permissions, absent permission, platform-only grants and inactive tenant grants remain denied", async () => {
  const { dependencies, request, state } = fixture();
  const missingPermission = { ...request };
  delete missingPermission.permissionCode;
  assert.equal((await readAuthorizedStaffSelf(dependencies, verified(), missingPermission)).allowed, false);
  state.platform = [{ roleCode: "GOVERNANCE_OWNER", scope: "PLATFORM", grantedAt: "2025-01-01T00:00:00Z", expiresAt: null, revokedAt: null }];
  const tenantRequest: InternalStaffRequest = { ...request, permissionCode: "catalog.read", scope: "TENANT", tenantId, objectTenantId: tenantId };
  assert.equal((await readAuthorizedStaffSelf(dependencies, verified(), tenantRequest)).allowed, false);
  for (const grant of [
    { expiresAt: "2025-02-01T00:00:00Z", revokedAt: null },
    { expiresAt: null, revokedAt: "2025-02-01T00:00:00Z" },
    { expiresAt: null, revokedAt: null },
  ]) {
    state.membership = { ...state.membership!, roleGrants: [{ roleCode: "CATALOG_OPERATOR", scope: "TENANT", grantedAt: "2025-01-01T00:00:00Z", ...grant }] };
    const result = await readAuthorizedStaffSelf(dependencies, verified(), tenantRequest);
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.reason, grant.expiresAt || grant.revokedAt ? "GRANT_INACTIVE" : "PERMISSION_INACTIVE");
  }
});

test("reader and required allow-audit failures fail closed with sanitized errors", async () => {
  const { dependencies, request, state, events } = fixture();
  state.readerUnavailable = true;
  await assert.rejects(() => readAuthorizedStaffSelf(dependencies, verified(), request),
    { code: "IDENTITY_UNAVAILABLE", message: "Staff authorization dependency unavailable" });
  assert.equal(events[0]?.reasonCode, "DEPENDENCY_UNAVAILABLE");
  state.readerUnavailable = false; state.writerUnavailable = true;
  await assert.rejects(() => readAuthorizedStaffSelf(dependencies, verified(), request),
    { code: "AUDIT_UNAVAILABLE", message: "Staff authorization dependency unavailable" });
  state.principal = null;
  const denied = await readAuthorizedStaffSelf(dependencies, verified(), request);
  assert.deepEqual(denied, { allowed: false, reason: "IDENTITY_NOT_FOUND", auditRecorded: false });
});

test("successes are not cached and expired verified evidence cannot be reused", async () => {
  const { dependencies, request, state } = fixture();
  const identity = verified();
  assert.equal((await readAuthorizedStaffSelf(dependencies, identity, request)).allowed, true);
  state.principal = { ...state.principal!, staffStatus: "SUSPENDED" };
  assert.equal((await readAuthorizedStaffSelf(dependencies, identity, request)).allowed, false);
  assert.equal(state.reads, 2);
  assert.equal((await readAuthorizedStaffSelf({ ...dependencies, now: () => new Date(now.getTime() + 300_000) }, identity, request)).allowed, false);
  assert.equal(state.reads, 2);
});
