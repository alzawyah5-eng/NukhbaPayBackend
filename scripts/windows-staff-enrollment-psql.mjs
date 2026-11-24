import path from 'node:path';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {archiveInfo,candidate,insist,pilotIssuer,root,sha} from './windows-staff-migration.mjs';
import {guardedBlock,installedChecks,targetChecks} from './windows-staff-install-sql.mjs';

const read=file=>readFileSync(path.join(root,file),'utf8');

// The input arrives through the local psql client's COPY stream. Only the
// tenant UUID is written back to the launcher after a successful commit.
export function enrollmentPsql({pin,rehearsal=false,bundle,backupHash,run,rosterDigest,receipt}) {
  insist(/^[a-f0-9]{32}$/.test(run) && /^[a-f0-9]{64}$/.test(rosterDigest) && path.win32.isAbsolute(receipt) &&
    /^[a-zA-Z0-9 :./_\\-]+$/.test(receipt),'Invalid operator handoff');
  const protection=guardedBlock(targetChecks(pin,rehearsal)+'\n'+installedChecks(bundle.candidateHash,backupHash,pilotIssuer)+
    "\nIF NOT EXISTS(SELECT FROM pg_authid WHERE rolname='nukhabapay_session_backend' AND rolcanlogin AND rolpassword LIKE 'SCRAM-SHA-256$%') THEN RAISE EXCEPTION 'Finish session credential setup first'; END IF;");
  const enrollment=`DO LANGUAGE plpgsql $first_staff$
DECLARE
  approved jsonb;
  org constant text:='nukhbapay-staff-dev';
  issuer_url constant text:='${pilotIssuer}';
  work_name text;
  work_email text;
  auth_subject text;
  org_id uuid;
  person_id uuid;
  identity_id uuid;
  member_id uuid;
  departments constant text[]:=ARRAY['Operations','Catalogue','Security','Support','Finance','Compliance'];
BEGIN
  SELECT convert_from(decode(payload,'base64'),'UTF8')::jsonb INTO STRICT approved FROM pg_temp.nukhbapay_first_staff_input;
  work_name:=approved->>'name'; work_email:=approved->>'email'; auth_subject:=approved->>'subject';
  IF approved->>'tenantKey' IS DISTINCT FROM org OR length(work_name) NOT BETWEEN 2 AND 120 OR length(work_email)>254 OR
    work_name IS NULL OR work_email IS NULL OR auth_subject IS NULL OR auth_subject !~ '^auth0[|][a-zA-Z0-9_-]{1,128}$' OR
    encode(sha256(convert_to('['||to_json(org)::text||','||to_json(work_name)::text||','||to_json(work_email)::text||']','UTF8')),'hex')
      IS DISTINCT FROM '${rosterDigest}'
    THEN RAISE EXCEPTION 'Private identity or roster does not match'; END IF;
  IF NOT EXISTS(SELECT FROM nukhabapay.windows_staff_enrollments) THEN
    IF EXISTS(SELECT FROM nukhabapay.tenants) OR EXISTS(SELECT FROM nukhabapay.staff_users) THEN
      RAISE EXCEPTION 'Existing staff or organization requires reconciliation'; END IF;
    org_id:=gen_random_uuid(); person_id:=gen_random_uuid(); identity_id:=gen_random_uuid(); member_id:=gen_random_uuid();
    INSERT INTO nukhabapay.tenants(id,tenant_key) VALUES(org_id,org);
    INSERT INTO nukhabapay.staff_users(id,display_name,contact_email,status) VALUES(person_id,work_name,work_email,'ACTIVE');
    INSERT INTO nukhabapay.staff_identities(id,staff_id,issuer,subject,status) VALUES(identity_id,person_id,issuer_url,auth_subject,'ACTIVE');
    INSERT INTO nukhabapay.staff_memberships(id,staff_id,tenant_id,status) VALUES(member_id,person_id,org_id,'ACTIVE');
    WITH added AS (INSERT INTO nukhbapay_staff_workspace.departments(tenant_id,id,name)
      SELECT org_id,gen_random_uuid(),d FROM unnest(departments) AS d RETURNING tenant_id,id,name)
      INSERT INTO nukhbapay_staff_departments.directory(tenant_id,department_id,code) SELECT tenant_id,id,lower(name) FROM added;
    INSERT INTO nukhabapay.windows_staff_enrollments(tenant_id,staff_id,membership_id,identity_id) VALUES(org_id,person_id,member_id,identity_id);
  END IF;
  SELECT t.id INTO STRICT org_id FROM nukhabapay.windows_staff_enrollments e
    JOIN nukhabapay.tenants t ON t.id=e.tenant_id
    JOIN nukhabapay.staff_memberships m ON (m.id,m.tenant_id,m.staff_id)=(e.membership_id,t.id,e.staff_id)
    JOIN nukhabapay.staff_users u ON u.id=e.staff_id
    JOIN nukhabapay.staff_identities i ON (i.id,i.staff_id)=(e.identity_id,u.id)
    WHERE t.tenant_key=org AND u.display_name=work_name AND u.contact_email=work_email AND i.issuer=issuer_url AND i.subject=auth_subject
      AND i.status='ACTIVE' AND u.status='ACTIVE' AND m.status='ACTIVE'
      AND NOT EXISTS(SELECT FROM nukhabapay.platform_role_grants WHERE staff_id=u.id)
      AND NOT EXISTS(SELECT FROM nukhabapay.tenant_role_grants WHERE membership_id=m.id AND tenant_id=t.id);
  IF (SELECT count(*) FROM nukhbapay_staff_departments.directory d JOIN nukhbapay_staff_workspace.departments w
      ON (w.tenant_id,w.id)=(d.tenant_id,d.department_id) WHERE d.tenant_id=org_id AND w.name=ANY(departments) AND d.code=lower(w.name))<>6
    THEN RAISE EXCEPTION 'Department readback differs'; END IF;
  INSERT INTO pg_temp.nukhbapay_enrollment_result VALUES(org_id);
END $first_staff$;`;
  return [
    '\\set ON_ERROR_STOP on','\\set ECHO none','\\pset pager off','\\pset tuples_only on','\\pset format unaligned',
    'BEGIN ISOLATION LEVEL SERIALIZABLE;','SET LOCAL search_path=pg_catalog;', "SET LOCAL lock_timeout='5s';",
    "SELECT pg_advisory_xact_lock(hashtextextended('nukhbapay_staff.first_enrollment.v1',0));",protection,
    'CREATE TEMP TABLE nukhbapay_first_staff_input(payload text CHECK(length(payload) BETWEEN 1 AND 4096)) ON COMMIT DROP;',
    'CREATE TEMP TABLE nukhbapay_enrollment_result(tenant_id uuid PRIMARY KEY) ON COMMIT PRESERVE ROWS;',
    "\\copy pg_temp.nukhbapay_first_staff_input(payload) FROM '//./pipe/nukhbapay-enroll-"+run+"'",
    enrollment,'COMMIT;','SELECT tenant_id FROM pg_temp.nukhbapay_enrollment_result',
    "\\g '"+receipt.replaceAll('\\','/')+"'",
    'DROP TABLE pg_temp.nukhbapay_enrollment_result;','\\echo Login-only membership verified. Return to private PowerShell.',''
  ].join('\n');
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {
    const [run,rosterDigest]=process.argv.slice(2);
    insist(process.argv.length===4 && /^[a-f0-9]{32}$/.test(run),'Invalid enrollment request');
    const backup=archiveInfo(),bundle=await candidate(),report=JSON.parse(read('.local/windows-staff-rehearsal.json'));
    insist(report.status==='passed' && report.candidateHash===bundle.candidateHash && report.backupHash===backup.sha256 &&
      report.sourceDatabaseOid===backup.databaseOid && report.sourceCluster===backup.systemIdentifier,'Candidate or target mismatch');
    const pin={port:5432,directory:process.env.NUKHBAPAY_REGISTERED_PG_DIRECTORY,databaseOid:backup.databaseOid,systemIdentifier:backup.systemIdentifier};
    const receipt=path.join(root,'.local','windows-enrollment-'+run+'.txt');
    insist(!existsSync(receipt),'This enrollment run already has a receipt');
    const script=enrollmentPsql({pin,bundle,backupHash:backup.sha256,run,rosterDigest,receipt});
    const file=path.join(root,'.local','windows-enrollment-'+run+'-'+sha(script).slice(0,12)+'.psql');
    writeFileSync(file,script,{flag:'wx'});console.info(file);
  }catch{console.error('Private enrollment preparation stopped. Check target, roster, and backup evidence.');process.exitCode=1;}
}
