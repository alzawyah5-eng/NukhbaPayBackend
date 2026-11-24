import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdministrationAuthority } from '../src/administration/access.js';
import { StaffWorkspaceService, consumeWorkspaceDataAccess, parseStaffWorkspaceCommand,
  type StaffWorkspaceStore } from '../src/administration/staff-workspace.js';
import { attestVerifiedStaffIdentity } from '../src/identity/verified-staff-identity.js';
import type { StaffAuthorizationRepository } from '../src/identity/staff-access.js';

const tenantId='00000000-0000-4000-8000-000000000001';
const otherTenant='00000000-0000-4000-8000-000000000002';
const staffId='00000000-0000-4000-8000-000000000003';
const id='00000000-0000-4000-8000-000000000004';
const initial=Date.UTC(2026,10,21,10,0,0);

test('personal contact edits accept only display fields and cannot change the sign-in identity or permissions',()=>{
  const input={action:'save-settings',version:1,timeZone:'UTC',locale:'en-GB',contact:{name:' Staff Member ',email:'STAFF@example.invalid'}};
  assert.deepEqual(parseStaffWorkspaceCommand(input),{...input,contact:{name:'Staff Member',email:'staff@example.invalid'}});
  for(const contact of [{...input.contact,subject:'another'},{...input.contact,role:'SECURITY_ADMIN'},
    {...input.contact,email:'bad address'},{...input.contact,name:' '}])assert.throws(()=>parseStaffWorkspaceCommand({...input,contact}),{status:400});
});

function fixture(roleCode:string) {
  let time=initial,sessionActive=true,revokedAt:string|null=null;
  const repository:StaffAuthorizationRepository={
    findByTrustedIdentity:async identity=>identity.subject==='workspace-fixture'
      ? {staffId,staffStatus:'ACTIVE',identityStatus:'ACTIVE',authzVersion:1n,tokensValidAfter:null} : null,
    findTenantMembership:async(_staff,tenant)=>({membershipId:id,tenantId:tenant,status:'ACTIVE',version:1n,
      roleGrants:[{roleCode,scope:'TENANT',grantedAt:new Date(initial-1000).toISOString(),expiresAt:null,revokedAt}]}),
    findPlatformRoleGrants:async()=>[],
  };
  const identity=attestVerifiedStaffIdentity({issuer:'https://staff-workspace.fixture.invalid/',subject:'workspace-fixture',
    security:{audience:'urn:fixture-workspace',clientId:'fixture',profile:'rfc9068-staff-v1',principalKind:'human',
      issuedAt:initial/1000,expiresAt:initial/1000+300,assurance:'not-established'}});
  const writes:unknown[]=[];
  let beforeCommit=()=>{};
  const store:StaffWorkspaceStore={
    read: async()=>{throw new Error('Unexpected storage read');},
    save:async(ticket,command)=>{
      assert.equal(consumeWorkspaceDataAccess(ticket).tenantId,tenantId);
      assert.throws(()=>consumeWorkspaceDataAccess(ticket),{status:403});
      assert.equal(ticket.staffId,staffId);
      beforeCommit();
      assert.equal(await ticket.revalidate(),true,'fresh authority required at commit');
      writes.push(command);
    },
  };
  const now=()=>new Date(time);
  return {identity,writes,session:{staffId,revalidate:async()=>sessionActive},
    beforeCommit:(callback:()=>void)=>{beforeCommit=callback;},
    expire:()=>{time+=300_000;},revoke:()=>{revokedAt=new Date(time).toISOString();},
    logout:()=>{sessionActive=false;},
    service:new StaffWorkspaceService({authority:createAdministrationAuthority(repository,now,undefined,tenantId),repository,store,now}),
  };
}

test('real workspace views follow persisted tenant grants with separate personal and management pages',async()=>{
  const manager=fixture('TENANT_STAFF_MANAGER'),viewer=fixture('TENANT_STAFF_VIEWER'),support=fixture('SUPPORT_AGENT');
  for (const [user,views] of [[manager,['roles','departments','invitations','security','sessions','reports','settings','activity']],
    [viewer,['roles','security','sessions','reports','settings','activity']],
    [support,['roles','security','sessions','settings']]] as const) {
    assert.deepEqual(await user.service.availableViews(user.identity,tenantId,user.session),views);
  }
  const personal=await support.service.read(support.identity,tenantId,support.session,'roles');
  assert.ok('roles' in personal);
  assert.deepEqual(personal.roles.map(role=>[role.code,role.assigned]),[['SUPPORT_AGENT',true]]);
  support.logout();
  await assert.rejects(support.service.availableViews(support.identity,tenantId,support.session),{status:403});
  await assert.rejects(viewer.service.command(viewer.identity,tenantId,viewer.session,{action:'create-department',id,name:'Support'}),{status:403});
  await assert.rejects(manager.service.command(manager.identity,otherTenant,manager.session,{action:'create-department',id,name:'Support'}),{status:403});
  await assert.rejects(manager.service.command({...manager.identity},tenantId,manager.session,{action:'create-department',id,name:'Support'}),{status:401});
});

test('workspace mutations rely on a fresh signed session, request fields, and a one-use repository ticket',async()=>{
  const command={action:'submit-invitation',id,name:' New Staff ',email:'NEW@example.invalid',departmentId:null,role:'SUPPORT_AGENT'};
  const fixtureRole=fixture('TENANT_STAFF_MANAGER');
  await fixtureRole.service.command(fixtureRole.identity,tenantId,fixtureRole.session,command);
  assert.deepEqual(fixtureRole.writes,[{...command,name:'New Staff',email:'new@example.invalid'}]);
  const newDepartment={action:'create-department',id,name:'  Operations  '};
  const rename={action:'rename-department',id,version:1,name:'Field Operations'};
  await fixtureRole.service.command(fixtureRole.identity,tenantId,fixtureRole.session,newDepartment);
  await fixtureRole.service.command(fixtureRole.identity,tenantId,fixtureRole.session,rename);
  assert.deepEqual(fixtureRole.writes.slice(1),[{...newDepartment,name:'Operations'},rename]);
  for (const invalidate of ['expire','revoke','logout'] as const) {
    const stale=fixture('TENANT_STAFF_MANAGER');
    stale.beforeCommit(stale[invalidate]);
    await assert.rejects(stale.service.command(stale.identity,tenantId,stale.session,command),/fresh authority required/);
    assert.equal(stale.writes.length,0);
  }
  for (const input of [{...command,role:'TENANT_ADMIN'},{...command,tenantId:otherTenant},
    {...command,subject:'forged'},{...command,departmentId:'outside-scope'}, {...command,email:'x@example.invalid\nextra'},
    {action:'save-settings',version:0,timeZone:'Invalid/Zone',locale:'en-GB'}]) {
    assert.throws(()=>parseStaffWorkspaceCommand(input),{status:400});
  }
});
