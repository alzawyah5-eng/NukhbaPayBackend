import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Client } from 'pg';
import { createDurableStaffRequestStore } from '@nukhbapay/database';
import { TrustedStaffActorBoundary, type StaffAuthorizationRepository, type StaffRequestResult } from '@nukhbapay/application';
import { OidcAccessTokenVerifier } from '../src/modules/identity/oidc-access-token.verifier.js';
import { LocalSyntheticAssuranceVerifier } from '../src/modules/identity/synthetic-assurance-verifier.js';
import { syntheticAssuranceProvider } from './fixtures/synthetic-assurance-provider.js';
import { claims, environment, signingKey, keySource, NOW } from './fixtures/oidc-test-issuer.js';

test('disposable PostgreSQL signs, persists and atomically rehearses staff decisions', async t => {
  const origin = process.env['NUKHBA_DISPOSABLE_PG'];
  const directory = process.env['NUKHBA_DISPOSABLE_PG_DIRECTORY'];
  if (!origin || !directory) throw new Error('Run through the disposable PostgreSQL harness');
  const url = new URL(origin);
  assert.equal(url.hostname,'127.0.0.1');
  assert.equal(url.username,'nukh_fixture');
  assert.equal(url.pathname,'/postgres');
  assert.ok(Number(url.port) > 1024 && url.port !== '5432' && url.port !== '55437');
  const owner = new Client({ connectionString: origin });
  await owner.connect();
  let admin:Client|undefined;
  let store:Awaited<ReturnType<typeof createDurableStaffRequestStore>>|undefined;
  const db='nukhabapay_b3b3_'+randomUUID().replaceAll('-','');
  const role='nukh_request_'+randomUUID().replaceAll('-','').slice(0,20);
  try {
    const target=(await owner.query('SHOW data_directory')).rows[0].data_directory as string;
    assert.equal(target.replaceAll('\\','/').toLowerCase(), directory.replaceAll('\\','/').toLowerCase());
    await owner.query(`CREATE DATABASE "${db}"`);
    await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    url.pathname='/'+db;
    admin=new Client({connectionString:url.href});
    await admin.connect();
    await admin.query(`REVOKE ALL ON DATABASE "${db}" FROM PUBLIC; GRANT CONNECT ON DATABASE "${db}" TO "${role}";
      CREATE ROLE nukhabapay_runtime; CREATE ROLE nukhabapay_importer; CREATE ROLE nukhabapay_identity_reader; CREATE ROLE nukhabapay_identity_writer;
      CREATE SCHEMA nukhabapay; GRANT USAGE ON SCHEMA nukhabapay TO "${role}";
      CREATE TABLE nukhabapay.tenants(id uuid PRIMARY KEY);
      CREATE TABLE nukhabapay.staff_users(id uuid PRIMARY KEY,status text,authz_version bigint);
      CREATE TABLE nukhabapay.staff_identities(staff_id uuid,issuer text,subject text,status text);
      CREATE TABLE nukhabapay.staff_memberships(id uuid,staff_id uuid,tenant_id uuid,status text,version bigint);
      CREATE TABLE nukhabapay.platform_role_grants(id uuid,staff_id uuid,role_code text,scope text,granted_at timestamptz,expires_at timestamptz,revoked_at timestamptz);
      CREATE TABLE nukhabapay.tenant_role_grants(id uuid,membership_id uuid,tenant_id uuid,role_code text,scope text,granted_at timestamptz,expires_at timestamptz,revoked_at timestamptz);
      ALTER TABLE nukhabapay.staff_memberships ENABLE ROW LEVEL SECURITY;
      ALTER TABLE nukhabapay.staff_memberships FORCE ROW LEVEL SECURITY;
      ALTER TABLE nukhabapay.tenant_role_grants ENABLE ROW LEVEL SECURITY;
      ALTER TABLE nukhabapay.tenant_role_grants FORCE ROW LEVEL SECURITY;
      CREATE FUNCTION nukhabapay.reject_security_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'Immutable fixture record' USING ERRCODE='42501'; END $$;`);
    const pending = new URL('../../../../packages/database/pending-migrations/', import.meta.url);
    for(const file of ['005_staff_access_workflows.sql','staff-access-request-records.sql','synthetic-approval-provenance.sql','staff-execution-rehearsal.sql','staff-request-cancellation-PROPOSAL.sql']){
      await admin.query(readFileSync(new URL(file,pending),'utf8'));
    }
    const tables=['staff_request_operations','staff_access_requests','staff_review_observations','staff_request_audit',
      'staff_request_receipts','staff_request_outbox','staff_synthetic_provenance','staff_rehearsal_decisions','staff_execution_rehearsals','staff_request_cancellations'];
    await admin.query(`GRANT SELECT, INSERT ON ${tables.map(n=>'nukhabapay.'+n).join(',')} TO "${role}";
      GRANT SELECT ON nukhabapay.staff_users,nukhabapay.staff_identities,nukhabapay.staff_memberships,
        nukhabapay.platform_role_grants,nukhabapay.tenant_role_grants TO "${role}"`);
    const connection=new URL(url);
    connection.username=role;connection.password=randomUUID();
    store=await createDurableStaffRequestStore({connectionString:connection.href,expectedDatabase:db,expectedRole:role,
      syntheticProvenance:'LOCAL_SYNTHETIC_ONLY',decisionRehearsal:'LOCAL_SYNTHETIC_ONLY',requestCancellation:'LOCAL_SYNTHETIC_ONLY'});
    const roles={requester:'ACCESS_ADMIN',reviewer:'SECURITY_ADMIN',governor:'GOVERNANCE_OWNER',beneficiary:null} as const;
    const people=new Map<string,{id:string;role:string|null}>();
    const issuer=String(claims().iss);
    for(const [subject,grant] of Object.entries(roles)){
      const id=randomUUID();people.set(subject,{id,role:grant});
      await admin.query("INSERT INTO nukhabapay.staff_users VALUES($1,'ACTIVE',1)",[id]);
      await admin.query("INSERT INTO nukhabapay.staff_identities VALUES($1,$2,$3,'ACTIVE')",[id,issuer,subject]);
      if(grant)await admin.query("INSERT INTO nukhabapay.platform_role_grants VALUES($1,$2,$3,'PLATFORM','2025-01-01T00:00:00Z',NULL,NULL)",[randomUUID(),id,grant]);
    }
    const repository:StaffAuthorizationRepository={
      findByTrustedIdentity:async input=>{
        const person=people.get(input.subject);
        return input.issuer===issuer&&person?{staffId:person.id,staffStatus:'ACTIVE',identityStatus:'ACTIVE',authzVersion:1n,tokensValidAfter:null}:null;
      },
      findTenantMembership:async (_person,tenantId)=>({membershipId:tenantId,tenantId,status:'ACTIVE',version:1n,roleGrants:[]}),
      findPlatformRoleGrants:async person=>{
        const grant=[...people.values()].find(p=>p.id===person)?.role;
        return grant?[{roleCode:grant,scope:'PLATFORM',grantedAt:new Date('2025-01-01').toISOString(),expiresAt:null,revokedAt:null}]:[];
      },
    };
    let time=NOW;
    const now=()=>new Date(time);
    const keys=await signingKey("fixture-staff-rehearsal");
    const verifier=new OidcAccessTokenVerifier(environment(),{fetchKeys:keySource([keys.publicJwk]).fetchKeys,now});
    const provider=await syntheticAssuranceProvider(verifier,now);
    const actors=new TrustedStaffActorBoundary({repository,now,auditWriter:{appendSecurityAuditEvents:async()=>undefined},
      syntheticAssuranceVerifier:new LocalSyntheticAssuranceVerifier({mode:'test',keys:[provider.publicJwk],now}),
      syntheticRequests:{capability:'NON_AUTHORIZED_STAFF_REQUESTS',allows:async()=>true,execute:store.execute},
      syntheticApprovalIntake:{capability:'NON_AUTHORIZED_STAFF_APPROVAL_INTAKE',allows:async()=>true,execute:store.execute},
      syntheticExecution:{capability:'STAFF_EXECUTION_REHEARSAL_ONLY',execute:store.execute},
      requests:{find:async id=>{
        const row=(await admin!.query('SELECT * FROM nukhabapay.staff_access_requests WHERE request_id=$1 ORDER BY version DESC LIMIT 1',[id])).rows[0];
        return row?{id,version:row.version,digest:row.request_digest,requesterStaffId:row.requester_staff_id,beneficiaryStaffId:row.target_staff_id,
          tenantId:row.tenant_id,expiresAt:new Date(Number(row.expires_at_ms)).toISOString(),policyVersion:row.policy_version,permission:'platform.access.approve'}:null;
      }},
    });
    async function admit(sub:string,tenant?:string){
      const token=await keys.sign(claims({sub}));
      const result=await actors.establish(await verifier.verify(token),tenant);
      if(!result.allowed)throw new Error('Fixture actor denied');
      return {actor:result.actor,token};
    }
    const requester=await admit('requester'),reviewer=await admit('reviewer'),governor=await admit('governor');
    const prepare=(r:StaffRequestResult,key=randomUUID())=>({kind:'REVIEW' as const,id:r.requestId!,version:BigInt(r.version!),requestDigest:r.requestDigest!,key});
    async function request(prior?:StaffRequestResult){
      const result=await actors.recordStaffRequest(requester.actor,{kind:'SUBMIT',id:prior?.requestId??randomUUID(),key:randomUUID(),
        version:prior?BigInt(prior.version!)+1n:1n,previousDigest:prior?.requestDigest??null,targetStaffId:people.get('beneficiary')!.id,
        operation:{kind:'DISABLE',target:'STAFF'},proposedRoles:[],expectedAuthzVersion:1n,expectedMembershipVersion:null,expiresAtMs:time+300000});
      assert.equal(result.kind,'RECORDED',JSON.stringify(result));return result;
    }
    async function decision(r:StaffRequestResult,person:typeof reviewer,choice:'APPROVE'|'REJECT'){
      const start=await actors.beginSyntheticApprovalChallenge(person.actor,r.requestId!,choice);
      if(!start.allowed)throw new Error('Fixture challenge denied');
      const assertion=await provider.respond(start.challenge,person.token);
      const verify=await actors.verifySyntheticApprovalProvenance(person.actor,start.challenge,assertion);
      if(!verify.allowed)throw new Error('Fixture provenance denied');
      assert.equal((await actors.verifySyntheticApprovalProvenance(person.actor,start.challenge,assertion)).allowed,false);
      const {kind:_,...fields}=prepare(r);void _;
      return { who:person.actor, proof:verify.provenance, command:{...fields,kind:'ATTEMPT' as const,decision:choice,policyVersion:'staff-lifecycle-v1' as const} };
    }
    const submit=(d:Awaited<ReturnType<typeof decision>>)=>actors.intakeStaffApproval(d.who,d.command,d.proof);
    const total=async()=>Number((await admin!.query('SELECT count(*) FROM nukhabapay.staff_execution_rehearsals')).rows[0].count);

    await t.test('signed decision is immutable, bound to actor, exact intent and separation of duties',async()=>{
      const r=await request(),d=await decision(r,reviewer,'APPROVE');
      assert.equal((await actors.beginSyntheticApprovalChallenge(requester.actor,r.requestId!,'APPROVE')).allowed,false);
      assert.equal((await actors.beginSyntheticApprovalChallenge((await admit('beneficiary')).actor,r.requestId!,'APPROVE')).allowed,false);
      assert.equal((await actors.intakeStaffApproval(d.who,{...d.command,decision:'REJECT'},d.proof)).kind,'DENIED');
      assert.equal((await actors.intakeStaffApproval(d.who,d.command,{...d.proof})).kind,'DENIED');
      assert.equal((await submit(d)).kind,'RECORDED');
      assert.equal((await submit(d)).kind,'REPLAYED');
      assert.equal((await actors.intakeStaffApproval(d.who,{...d.command,key:randomUUID()},d.proof)).kind,'DENIED');
      assert.equal((await actors.rehearseStaffExecution(requester.actor,prepare(r))).kind,'DENIED');
      await assert.rejects(admin!.query("UPDATE nukhabapay.staff_rehearsal_decisions SET decision='REJECT'"));
    });
    await t.test('execution consumes exact quorum and concurrent retries commit precisely one receipt/audit event',async()=>{
      const r=await request(),key=randomUUID();
      assert.equal((await submit(await decision(r,reviewer,'APPROVE'))).kind,'RECORDED');
      assert.equal((await submit(await decision(r,governor,'APPROVE'))).kind,'RECORDED');
      const before=await total();
      const replies=await Promise.all([key,key,randomUUID()].map(k=>actors.rehearseStaffExecution(requester.actor,prepare(r,k))));
      assert.equal(replies.filter(reply=>reply.kind==='RECORDED').length,1,JSON.stringify(replies));
      assert.ok(replies.filter(reply=>reply.kind==='RECORDED').length===1 && replies.some(reply=>reply.kind==='CONFLICT'));
      assert.ok(replies.every(reply=>reply.execution==='NOT_AUTHORIZED'&&!reply.acceptedApproval));
      assert.equal(await total(),before+1);
      const winner=replies.find(reply=>reply.kind==='RECORDED')!;
      const row=(await admin!.query('SELECT event_name,request_id FROM nukhabapay.staff_execution_rehearsals WHERE operation_id=$1',[winner.operationId])).rows[0];
      assert.deepEqual(row,{event_name:'STAFF_EXECUTION_REHEARSED',request_id:r.requestId});
      assert.equal((await admin!.query('SELECT status FROM nukhabapay.staff_users WHERE id=$1',[people.get('beneficiary')!.id])).rows[0].status,'ACTIVE');
    });
    await t.test('audit insertion failure rolls back the rehearsal and later exact retry records one event',async()=>{
      const r=await request(),cmd=prepare(r);
      assert.equal((await submit(await decision(r,reviewer,'APPROVE'))).kind,'RECORDED');
      assert.equal((await submit(await decision(r,governor,'APPROVE'))).kind,'RECORDED');
      const before=await total();
      await admin!.query(`CREATE FUNCTION nukhabapay.reject_fixture_event() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'Fixture audit failure' USING ERRCODE='23514'; END $$;
        CREATE TRIGGER reject_fixture_event AFTER INSERT ON nukhabapay.staff_execution_rehearsals FOR EACH ROW
        EXECUTE FUNCTION nukhabapay.reject_fixture_event()`);
      try{
        assert.equal((await actors.rehearseStaffExecution(requester.actor,cmd)).kind,'DENIED');
        assert.equal(await total(),before);
      }finally{
        await admin!.query('DROP TRIGGER reject_fixture_event ON nukhabapay.staff_execution_rehearsals');
      }
      assert.equal((await actors.rehearseStaffExecution(requester.actor,cmd)).kind,'RECORDED');
      assert.equal((await actors.rehearseStaffExecution(requester.actor,cmd)).kind,'REPLAYED');
      assert.equal(await total(),before+1);
      await assert.rejects(admin!.query("SELECT nukhabapay.execute_staff_command('{}'::jsonb)"),{code:'42501'});
    });
    await t.test('rejections, revised requests, cross-tenant actors and expired approval evidence deny execution',async()=>{
      const before=await total(),r=await request();
      assert.equal((await submit(await decision(r,reviewer,'REJECT'))).kind,'RECORDED');
      assert.equal((await submit(await decision(r,governor,'APPROVE'))).kind,'RECORDED');
      assert.equal((await actors.rehearseStaffExecution(requester.actor,prepare(r))).kind,'DENIED');
      const good=await request();
      assert.equal((await submit(await decision(good,reviewer,'APPROVE'))).kind,'RECORDED');
      assert.equal((await submit(await decision(good,governor,'APPROVE'))).kind,'RECORDED');
      assert.equal((await actors.rehearseStaffExecution((await admit('requester',randomUUID())).actor,prepare(good))).kind,'DENIED');
      time+=61000;
      assert.equal((await actors.rehearseStaffExecution(requester.actor,prepare(good))).kind,'DENIED');
      time=NOW;
      await request(good);
      assert.equal((await actors.rehearseStaffExecution(requester.actor,prepare(good))).kind,'DENIED');
      assert.equal(await total(),before);
    });

    await t.test('durable cancellation closes the exact request and serializes against execution', async () => {
      const r = await request();
      const pending = await decision(r, reviewer, 'APPROVE');
      const cmd = { ...prepare(r), kind: 'CANCEL' as const };
      assert.equal((await actors.recordStaffRequest(reviewer.actor, cmd)).kind, 'DENIED');
      assert.equal((await actors.recordStaffRequest(requester.actor, { ...cmd, version:cmd.version + 1n })).kind, 'DENIED');
      const otherTenant = await admit('requester', randomUUID());
      assert.equal((await actors.recordStaffRequest(otherTenant.actor, cmd)).kind, 'DENIED');
      assert.equal((await actors.recordStaffRequest(requester.actor, cmd)).kind, 'RECORDED');
      assert.equal((await actors.recordStaffRequest(requester.actor, cmd)).kind, 'REPLAYED');
      assert.equal((await submit(pending)).kind, 'DENIED');
      assert.equal((await actors.rehearseStaffExecution(requester.actor, prepare(r))).kind, 'DENIED');
      const result = await admin!.query('SELECT event_name,request_digest FROM nukhabapay.staff_request_cancellations WHERE request_id=$1',[r.requestId]);
      assert.deepEqual(result.rows,[{event_name:'STAFF_REQUEST_CANCELLED',request_digest:r.requestDigest}]);
      await assert.rejects(admin!.query('DELETE FROM nukhabapay.staff_request_cancellations WHERE request_id=$1',[r.requestId]),{code:'42501'});

      const race = await request();
      assert.equal((await submit(await decision(race, reviewer, 'APPROVE'))).kind, 'RECORDED');
      assert.equal((await submit(await decision(race, governor, 'APPROVE'))).kind, 'RECORDED');
      const results = await Promise.all([
        actors.recordStaffRequest(requester.actor, { ...prepare(race), kind: 'CANCEL' }),
        actors.rehearseStaffExecution(requester.actor, prepare(race)),
      ]);
      assert.equal(results.filter(row => row.kind === 'RECORDED').length, 1, JSON.stringify(results));
      assert.ok(results.every(row => row.execution === 'NOT_AUTHORIZED'));
      const persisted = await admin!.query(`SELECT request_id FROM nukhabapay.staff_request_cancellations WHERE request_id=$1
        UNION ALL SELECT request_id FROM nukhabapay.staff_execution_rehearsals WHERE request_id=$1`,[race.requestId]);
      assert.equal(persisted.rowCount,1);
    });
  }finally{
    await store?.close();
    await admin?.end();
    await owner.end();
  }
});
