import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {archiveInfo,assertTarget,candidate,connection,insist,pilotIssuer,sha,verifyInstalled} from './windows-staff-migration.mjs';

const departments=['Operations','Catalogue','Security','Support','Finance','Compliance'];
export async function enrollFirstStaff(client,{pin,rehearsal=false,bundle,backupHash,profile,rosterDigest}) {
  const {name,email,subject,tenantKey}=profile;
  insist(typeof name==='string' && name===name.trim() && name.length>=2 && name.length<=120 &&
    typeof email==='string' && email===email.trim().toLowerCase() && email.length<=254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    tenantKey==='nukhbapay-staff-dev' && typeof subject==='string' && /^auth0\|[a-zA-Z0-9_-]{1,128}$/.test(subject) &&
    sha(JSON.stringify([tenantKey,name,email]))===rosterDigest,'Private enrollment does not match the approved roster');
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('nukhbapay_staff.first_enrollment.v1',0))");
    await assertTarget(client,pin,rehearsal);
    await verifyInstalled(client,bundle,backupHash,pilotIssuer);
    const readback=async()=>(await client.query(`SELECT t.id AS "tenantId",u.id AS "staffId"
      FROM nukhabapay.windows_staff_enrollments e JOIN nukhabapay.tenants t ON t.id=e.tenant_id
      JOIN nukhabapay.staff_memberships m ON (m.id,m.tenant_id,m.staff_id)=(e.membership_id,t.id,e.staff_id)
      JOIN nukhabapay.staff_users u ON u.id=e.staff_id JOIN nukhabapay.staff_identities i ON (i.id,i.staff_id)=(e.identity_id,u.id)
      WHERE t.tenant_key=$1 AND u.display_name=$2 AND u.contact_email=$3 AND i.issuer=$4 AND i.subject=$5
        AND i.status='ACTIVE' AND m.status='ACTIVE' AND u.status='ACTIVE'
        AND NOT EXISTS(SELECT FROM nukhabapay.platform_role_grants WHERE staff_id=u.id)
        AND NOT EXISTS(SELECT FROM nukhabapay.tenant_role_grants WHERE membership_id=m.id AND tenant_id=t.id)`,
      [tenantKey,name,email,pilotIssuer,subject])).rows[0];
    let binding=await readback();
    if(!binding){
      insist((await client.query(`SELECT NOT EXISTS(SELECT FROM nukhabapay.tenants) AND NOT EXISTS(SELECT FROM nukhabapay.staff_users)
        AND NOT EXISTS(SELECT FROM nukhabapay.windows_staff_enrollments) AS empty`)).rows[0].empty,'Existing staff or tenant requires reconciliation');
      const tenantId=randomUUID(),staffId=randomUUID(),identityId=randomUUID(),membershipId=randomUUID();
      await client.query('INSERT INTO nukhabapay.tenants(id,tenant_key) VALUES($1,$2)',[tenantId,tenantKey]);
      await client.query("INSERT INTO nukhabapay.staff_users(id,display_name,contact_email,status) VALUES($1,$2,$3,'ACTIVE')",[staffId,name,email]);
      await client.query("INSERT INTO nukhabapay.staff_identities(id,staff_id,issuer,subject,status) VALUES($1,$2,$3,$4,'ACTIVE')",[identityId,staffId,pilotIssuer,subject]);
      await client.query("INSERT INTO nukhabapay.staff_memberships(id,staff_id,tenant_id,status) VALUES($1,$2,$3,'ACTIVE')",[membershipId,staffId,tenantId]);
      await client.query(`WITH created AS (INSERT INTO nukhbapay_staff_workspace.departments(tenant_id,id,name)
        SELECT $1,gen_random_uuid(),name FROM unnest($2::text[]) d(name) RETURNING id,tenant_id,name)
        INSERT INTO nukhbapay_staff_departments.directory(tenant_id,department_id,code) SELECT tenant_id,id,lower(name) FROM created`,[tenantId,departments]);
      await client.query('INSERT INTO nukhabapay.windows_staff_enrollments(tenant_id,staff_id,membership_id,identity_id) VALUES($1,$2,$3,$4)',[tenantId,staffId,membershipId,identityId]);
      binding=await readback();insist(binding?.tenantId===tenantId && binding.staffId===staffId,'Login-only enrollment readback failed');
    }
    await client.query('COMMIT');return binding;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {
    insist(process.argv.length===2,'Unexpected arguments');
    let input='';for await(const chunk of process.stdin){input+=chunk;insist(input.length<=4096,'Invalid private enrollment');}
    const profile=JSON.parse(input),backup=archiveInfo(),bundle=await candidate();
    const pin={port:5432,databaseOid:backup.databaseOid,systemIdentifier:backup.systemIdentifier,directory:process.env.NUKHBAPAY_REGISTERED_PG_DIRECTORY};
    const client=await connection(5432,process.env.PGPASSWORD);
    try {
      const binding=await enrollFirstStaff(client,{pin,bundle,backupHash:backup.sha256,profile,rosterDigest:process.env.NUKHBAPAY_FIRST_ROSTER_SHA256});
      // Only the generated tenant UUID goes to the calling private launcher.
      process.stdout.write(binding.tenantId+'\n');
    }finally{await client.end();}
  }catch{console.error('Private login-only enrollment stopped; check the target and approved identity binding.');process.exitCode=1;}
}
