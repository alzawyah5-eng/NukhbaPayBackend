import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {StaffManagementService,consumeAdministrationRead} from '../src/administration/staff-management.js';
import {createAdministrationAuthority} from '../src/administration/access.js';
import {attestVerifiedStaffIdentity} from '../src/identity/verified-staff-identity.js';
import {createStaffAdministration} from '../src/administration/composition.js';
import {STAFF_LIFECYCLE_POLICY_VERSION} from '../src/identity/staff-lifecycle.js';
import {TrustedStaffActorBoundary} from '../src/identity/trusted-staff-actor.js';
const tenant=randomUUID(),staff=randomUUID(),target=randomUUID(),now=Date.parse('2026-11-19T10:00:00Z');
const identity=attestVerifiedStaffIdentity({issuer:'https://staff.invalid/',subject:'unit',security:{audience:'unit',clientId:'unit',profile:'rfc9068-staff-v1',principalKind:'human',issuedAt:now/1000,expiresAt:now/1000+300,assurance:'not-established'}});
const repository={findByTrustedIdentity:async()=>({staffId:staff,staffStatus:'ACTIVE' as const,identityStatus:'ACTIVE' as const,authzVersion:1n,tokensValidAfter:null}),findPlatformRoleGrants:async()=>[],
  findTenantMembership:async()=>({membershipId:randomUUID(),tenantId:tenant,status:'ACTIVE' as const,version:1n,roleGrants:[{roleCode:'TENANT_ADMIN',scope:'TENANT' as const,grantedAt:'2026-01-01T00:00:00Z',expiresAt:null,revokedAt:null}]})};
test('existing inactive permissions and forged identities cannot activate administration',async()=>{
  const authority=createAdministrationAuthority(repository,()=>new Date(now));
  await assert.rejects(()=>authority.require(identity,tenant,'tenant.staff.read'),{status:403});
  await assert.rejects(()=>authority.require({...identity},tenant,'tenant.staff.read'),{status:401});
  await assert.rejects(()=>authority.require(identity,tenant,'unlisted.permission'),{status:403});
});
test('directory projection, deterministic pagination, scope and read audit use isolated authority/reader doubles',async()=>{
  let fresh=true,audits=0,foreign=false,auditFailure=false;const ids=[target,randomUUID()].sort();
  const actors=new TrustedStaffActorBoundary({repository,now:()=>new Date(now),auditWriter:{appendSecurityAuditEvents:async()=>undefined}});
  const service=new StaffManagementService({authority:{require:async()=>({staffId:staff,tenantId:tenant,revalidate:async()=>fresh})},actors,
    reader:{staff:async t=>{consumeAdministrationRead(t);return ids.map(id=>({id,tenantId:foreign?randomUUID():tenant,status:'ACTIVE',membershipStatus:'ACTIVE',version:'1',roles:['SUPPORT_AGENT'],password:'PRIVATE'}));},audit:async t=>{consumeAdministrationRead(t);return [];}},
    auditRead:async()=>{audits++;if(auditFailure)throw new Error('isolated audit unavailable');}});
  const first=await service.read(identity,tenant,'STAFF',{limit:'1'});assert.equal(first.items.length,1);assert.equal(first.next,ids[0]);assert.equal(JSON.stringify(first).includes('PRIVATE'),false);
  const second=await service.read(identity,tenant,'STAFF',{limit:'1',after:first.next!});assert.equal(second.items[0]!.id,ids[1]);assert.equal(audits,2);
  foreign=true;await assert.rejects(()=>service.read(identity,tenant,'STAFF',{}),{status:503});foreign=false;
  auditFailure=true;await assert.rejects(()=>service.read(identity,tenant,'STAFF',{}));auditFailure=false;
  fresh=false;await assert.rejects(()=>service.read(identity,tenant,'STAFF',{}),{status:403});
  await assert.rejects(()=>service.read(identity,tenant,'STAFF',{sort:'password'}),{status:400});
});
test('self requests and privileged role delegation are denied before request persistence',async()=>{
  const actors=new TrustedStaffActorBoundary({repository,now:()=>new Date(now),auditWriter:{appendSecurityAuditEvents:async()=>undefined}});
  const service=new StaffManagementService({authority:{require:async()=>({staffId:staff,tenantId:tenant,revalidate:async()=>true})},actors,reader:{staff:async()=>[],audit:async()=>[]},auditRead:async()=>undefined});
  const command={kind:'SUBMIT' as const,key:randomUUID(),id:randomUUID(),version:1n,previousDigest:null,targetStaffId:staff,operation:{kind:'ACTIVATE' as const,target:'STAFF' as const},proposedRoles:[],expectedAuthzVersion:1n,expectedMembershipVersion:1n,expiresAtMs:now+10000};
  await assert.rejects(()=>service.request(identity,tenant,command),{status:403});
  await assert.rejects(()=>service.request(identity,tenant,{...command,targetStaffId:target,proposedRoles:['TENANT_ADMIN']}),{status:403});
});

test('trusted composition keeps tenant permissions closed before selecting a durable reader', async () => {
  let reads = 0;
  const composition = createStaffAdministration({
    repository, now: () => new Date(now),
    auditWriter: { appendSecurityAuditEvents: async () => undefined },
    readers: { staff: { staff: async () => { reads++; return []; }, audit: async () => [] } },
  });
  await assert.rejects(composition.staffAdministration!.read(identity, tenant, 'STAFF', {}), { status: 403 });
  await assert.rejects(composition.staffAdministration!.read(identity, randomUUID(), 'STAFF', {}), { status: 403 });
  assert.deepEqual(await composition.staffAdministration!.availableViews(identity, tenant), []);
  await assert.rejects(composition.staffAdministration!.availableViews({...identity}, tenant), {status:401});
  assert.equal(reads, 0);
});

test('privileged reviews identify distinct people and reject tenant, request and provenance substitution', async () => {
  const secondId = randomUUID();
  const reviewers = ['first', 'alias', 'second'].map(subject => attestVerifiedStaffIdentity({
    issuer: identity.issuer, subject, security: identity.security,
  }));
  let request = {
    id: randomUUID(), digest: 'a'.repeat(64), version: '1', policyVersion: STAFF_LIFECYCLE_POLICY_VERSION,
    requesterStaffId: randomUUID(), beneficiaryStaffId: target, tenantId: null as string | null,
    expiresAt: new Date(now + 60000).toISOString(), permission: 'platform.access.approve' as const,
  };
  let changeAfterFirstObservation = false;
  let reads = 0;
  const composition = createStaffAdministration({
    repository: {
      ...repository,
      findByTrustedIdentity: async ({ subject }) => ({
        staffId: subject === 'second' ? secondId : staff, staffStatus: 'ACTIVE',
        identityStatus: 'ACTIVE', authzVersion: 1n, tokensValidAfter: null,
      }),
      findPlatformRoleGrants: async () => [{
        roleCode: 'SECURITY_ADMIN', scope: 'PLATFORM', grantedAt: new Date(now - 1000).toISOString(),
        expiresAt: null, revokedAt: null,
      }],
    },
    auditWriter: { appendSecurityAuditEvents: async () => undefined },
    now: () => new Date(now),
    readers: { requests: { find: async () => {
      reads++;
      return changeAfterFirstObservation && reads >= 3 ? { ...request, version: '2' } : request;
    } } },
  });
  const boundary = composition.privilegedStaff;
  const approvedPeople = await boundary.inspect(request.id, [reviewers[0]!, reviewers[2]!]);
  assert.deepEqual(approvedPeople, {
    assurance: 'not-established', acceptedApproval: false, execution: 'NOT_AUTHORIZED',
    outcome: 'OBSERVED', observed: 2,
  });
  assert.equal((await boundary.inspect(request.id, [reviewers[0]!, reviewers[1]!])).outcome, 'DENIED');
  assert.equal((await boundary.inspect(request.id, [{ ...reviewers[0]! }])).outcome, 'DENIED');
  assert.equal((await boundary.inspect(randomUUID(), [reviewers[0]!])).outcome, 'DENIED');
  reads = 0; changeAfterFirstObservation = true;
  assert.equal((await boundary.inspect(request.id, [reviewers[0]!, reviewers[2]!])).outcome, 'DENIED');
  changeAfterFirstObservation = false;
  request = { ...request, tenantId: tenant };
  assert.equal((await boundary.inspect(request.id, [reviewers[0]!])).outcome, 'DENIED');
  assert.equal(boundary.execute({ assurance: 'verified', approvedPeople }).execution, 'NOT_AUTHORIZED');
});


test('actor establishment and review disclosure recheck expiry after repository awaits', async () => {
  let clock = now, identityDelay = false, reads = 0;
  const request = {
    id: randomUUID(), digest: 'a'.repeat(64), version: '1', policyVersion: STAFF_LIFECYCLE_POLICY_VERSION,
    requesterStaffId: randomUUID(), beneficiaryStaffId: target, tenantId: null,
    expiresAt: new Date(now + 1000).toISOString(), permission: 'platform.access.approve' as const,
  };
  const boundary = new TrustedStaffActorBoundary({
    repository: {
      ...repository,
      findByTrustedIdentity: async () => {
        if (identityDelay) clock += 300000;
        return repository.findByTrustedIdentity();
      },
      findPlatformRoleGrants: async () => [{
        roleCode: 'SECURITY_ADMIN', scope: 'PLATFORM', grantedAt: new Date(now - 1000).toISOString(),
        revokedAt: null, expiresAt: null,
      }],
    },
    now: () => new Date(clock),
    auditWriter: { appendSecurityAuditEvents: async () => undefined },
    requests: { find: async () => { if (++reads === 2) clock += 1000; return request; } },
  });
  const admitted = await boundary.establish(identity);
  assert.equal(admitted.allowed, true);
  if (!admitted.allowed) throw new Error('Fixture actor denied');
  const review = await boundary.inspectApproval(admitted.actor, request.id);
  assert.equal(review.reason, 'STALE_REQUEST');
  assert.equal('observation' in review, false);
  clock = now; identityDelay = true;
  const delayed = await boundary.establish(identity);
  assert.equal(delayed.allowed, false);
  assert.equal(delayed.reason, 'INVALID_IDENTITY');
});
