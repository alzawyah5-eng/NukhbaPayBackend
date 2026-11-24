import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const local=path.join(root,'.local');
const literal=value=>"E'"+value.replaceAll('\\','\\\\').replaceAll("'","''")+"'";
const name=process.env.NUKHBAPAY_BOOTSTRAP_APPROVER_NAME;
const subject=process.env.NUKHBAPAY_BOOTSTRAP_APPROVER_SUBJECT;
const approval=process.env.NUKHBAPAY_BOOTSTRAP_APPROVAL;
if(!name||name.trim()!==name||name.length<2||name.length>160||/[\u0000-\u001f\u007f]/.test(name))throw new Error('Invalid approver name');
if(!subject||!/^auth0\|[A-Za-z0-9_-]{1,128}$/.test(subject))throw new Error('Invalid approver identity');
if(approval!=='APPROVE SYMH TENANT STAFF MANAGER')throw new Error('Approval phrase missing');
const pin=JSON.parse(readFileSync(path.join(local,'windows-staff-inspection.json'),'utf8'));
if(pin.targetVerified!==true||!/^\d{1,10}$/.test(pin.databaseOid)||!/^\d{15,20}$/.test(pin.systemIdentifier))throw new Error('Invalid target pin');
const digest=createHash('sha256').update(JSON.stringify(['nukhbapay-staff-dev','symh@nukhbalzawiya.com','TENANT_STAFF_MANAGER','admin@nukhbalzawiya.com',subject])).digest('hex');
const evidence='OWNER_APPROVAL_'+digest.slice(0,32);
const requestId=randomUUID();
const sql=`\\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(711235031);
DO $guard$ DECLARE d pg_database%ROWTYPE; BEGIN
 SELECT * INTO STRICT d FROM pg_database WHERE datname=current_database();
 IF current_database()<>'nukhbapay_staff' OR d.oid::text<>${literal(pin.databaseOid)} OR
   (SELECT system_identifier::text FROM pg_control_system())<>${literal(pin.systemIdentifier)} OR
   pg_get_userbyid(d.datdba)<>'nukhabapay_migrator' OR current_user<>'postgres' OR session_user<>'postgres' OR
   system_user IS DISTINCT FROM 'scram-sha-256:postgres' OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1' OR
   inet_server_port()<>5432 OR current_setting('server_version_num')::int/10000<>18 OR pg_is_in_recovery() OR
   shobj_description(d.oid,'pg_database')<>'NukhbaPay Windows staff development v1'
 THEN RAISE EXCEPTION 'Central manager target guard failed'; END IF;
 IF NOT EXISTS(SELECT FROM nukhabapay.windows_staff_schema_history WHERE version=1 AND issuer='https://dev-whz1tr4aj20nxswq.us.auth0.com/')
 THEN RAISE EXCEPTION 'Installed staff schema evidence missing'; END IF;
END $guard$;
ALTER TABLE nukhabapay.iam_roles DISABLE TRIGGER fixed_iam_roles;
ALTER TABLE nukhabapay.iam_permissions DISABLE TRIGGER fixed_iam_permissions;
ALTER TABLE nukhabapay.iam_role_permissions DISABLE TRIGGER fixed_iam_role_permissions;
INSERT INTO nukhabapay.iam_permissions(code,scope,description,activation_phase) VALUES
 ('tenant.departments.manage','TENANT','Create and rename departments for one tenant.','3C') ON CONFLICT DO NOTHING;
INSERT INTO nukhabapay.iam_roles(code,scope,description,privileged) VALUES
 ('TENANT_STAFF_MANAGER','TENANT','Read staff records, submit onboarding requests, and manage departments for one tenant.',true) ON CONFLICT DO NOTHING;
INSERT INTO nukhabapay.iam_role_permissions(role_code,permission_code,scope) VALUES
 ('TENANT_STAFF_MANAGER','tenant.staff.read','TENANT'),
 ('TENANT_STAFF_MANAGER','tenant.audit.read','TENANT'),
 ('TENANT_STAFF_MANAGER','tenant.access.request','TENANT'),
 ('TENANT_STAFF_MANAGER','tenant.departments.manage','TENANT') ON CONFLICT DO NOTHING;
ALTER TABLE nukhabapay.iam_role_permissions ENABLE TRIGGER fixed_iam_role_permissions;
ALTER TABLE nukhabapay.iam_permissions ENABLE TRIGGER fixed_iam_permissions;
ALTER TABLE nukhabapay.iam_roles ENABLE TRIGGER fixed_iam_roles;
CREATE TABLE IF NOT EXISTS nukhabapay.windows_staff_bootstrap_receipts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES nukhabapay.tenants(id),
 beneficiary_staff_id uuid NOT NULL REFERENCES nukhabapay.staff_users(id),approver_staff_id uuid NOT NULL REFERENCES nukhabapay.staff_users(id),
 grant_id uuid NOT NULL UNIQUE REFERENCES nukhabapay.tenant_role_grants(id),role_code text NOT NULL CHECK(role_code='TENANT_STAFF_MANAGER'),
 evidence_reference text NOT NULL UNIQUE,request_id uuid NOT NULL UNIQUE,applied_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 authorized_by name NOT NULL DEFAULT session_user,CHECK(beneficiary_staff_id<>approver_staff_id));
ALTER TABLE nukhabapay.windows_staff_bootstrap_receipts OWNER TO nukhabapay_migrator;
DO $receipt_trigger$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='nukhabapay.windows_staff_bootstrap_receipts'::regclass AND tgname='immutable_windows_staff_bootstrap_receipt') THEN
  CREATE TRIGGER immutable_windows_staff_bootstrap_receipt BEFORE UPDATE OR DELETE ON nukhabapay.windows_staff_bootstrap_receipts
   FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation();
 END IF;
END $receipt_trigger$;
DO $apply$ DECLARE tenant uuid; beneficiary uuid; membership uuid; approver uuid; approver_membership uuid; approver_membership_status text; manager_grant uuid; created boolean:=false; BEGIN
 IF NOT EXISTS(SELECT FROM nukhabapay.iam_permissions WHERE code='tenant.departments.manage' AND scope='TENANT' AND description='Create and rename departments for one tenant.' AND activation_phase='3C') OR
    NOT EXISTS(SELECT FROM nukhabapay.iam_roles WHERE code='TENANT_STAFF_MANAGER' AND scope='TENANT' AND privileged AND description='Read staff records, submit onboarding requests, and manage departments for one tenant.') OR
    (SELECT array_agg(permission_code::text ORDER BY permission_code) FROM nukhabapay.iam_role_permissions WHERE role_code='TENANT_STAFF_MANAGER')
      IS DISTINCT FROM ARRAY['tenant.access.request','tenant.audit.read','tenant.departments.manage','tenant.staff.read']::text[]
 THEN RAISE EXCEPTION 'Canonical central manager catalogue mismatch'; END IF;
 SELECT e.tenant_id,e.staff_id,e.membership_id INTO STRICT tenant,beneficiary,membership FROM nukhabapay.windows_staff_enrollments e
 JOIN nukhabapay.tenants t ON t.id=e.tenant_id JOIN nukhabapay.staff_users u ON u.id=e.staff_id
 JOIN nukhabapay.staff_memberships m ON (m.id,m.tenant_id,m.staff_id)=(e.membership_id,e.tenant_id,e.staff_id)
 JOIN nukhabapay.staff_identities i ON (i.id,i.staff_id)=(e.identity_id,e.staff_id)
 WHERE t.tenant_key='nukhbapay-staff-dev' AND u.display_name='SYMH' AND lower(u.contact_email)='symh@nukhbalzawiya.com'
 AND u.status='ACTIVE' AND m.status='ACTIVE' AND i.status='ACTIVE' AND i.issuer='https://dev-whz1tr4aj20nxswq.us.auth0.com/';
 SELECT u.id INTO approver FROM nukhabapay.staff_users u JOIN nukhabapay.staff_identities i ON i.staff_id=u.id
 WHERE u.display_name=${literal(name)} AND lower(u.contact_email)='admin@nukhbalzawiya.com' AND u.status='ACTIVE'
 AND i.issuer='https://dev-whz1tr4aj20nxswq.us.auth0.com/' AND i.subject=${literal(subject)} AND i.status='ACTIVE';
 IF approver IS NULL THEN
  IF EXISTS(SELECT FROM nukhabapay.staff_users WHERE lower(contact_email)='admin@nukhbalzawiya.com') OR
     EXISTS(SELECT FROM nukhabapay.staff_identities WHERE issuer='https://dev-whz1tr4aj20nxswq.us.auth0.com/' AND subject=${literal(subject)})
  THEN RAISE EXCEPTION 'Approver identity requires reconciliation'; END IF;
  approver:=gen_random_uuid();
  INSERT INTO nukhabapay.staff_users(id,display_name,contact_email,status) VALUES(approver,${literal(name)},'admin@nukhbalzawiya.com','ACTIVE');
  INSERT INTO nukhabapay.staff_identities(id,staff_id,issuer,subject,status) VALUES(gen_random_uuid(),approver,'https://dev-whz1tr4aj20nxswq.us.auth0.com/',${literal(subject)},'ACTIVE');
 END IF;
 SELECT id,status INTO approver_membership,approver_membership_status FROM nukhabapay.staff_memberships WHERE staff_id=approver AND tenant_id=tenant;
 IF approver_membership IS NULL THEN
  approver_membership:=gen_random_uuid();
  INSERT INTO nukhabapay.staff_memberships(id,staff_id,tenant_id,status) VALUES(approver_membership,approver,tenant,'ACTIVE');
 ELSIF approver_membership_status<>'ACTIVE' THEN RAISE EXCEPTION 'Approver tenant membership is not active'; END IF;
 IF approver=beneficiary THEN RAISE EXCEPTION 'Beneficiary cannot approve own grant'; END IF;
 SELECT id INTO manager_grant FROM nukhabapay.tenant_role_grants WHERE membership_id=membership AND tenant_id=tenant AND role_code='TENANT_STAFF_MANAGER' AND revoked_at IS NULL;
 IF manager_grant IS NULL THEN manager_grant:=gen_random_uuid();created:=true;
  INSERT INTO nukhabapay.tenant_role_grants(id,membership_id,tenant_id,role_code,scope,granted_at,grant_source,evidence_reference)
   VALUES(manager_grant,membership,tenant,'TENANT_STAFF_MANAGER','TENANT',transaction_timestamp(),'BOOTSTRAP',${literal(evidence)});
  INSERT INTO nukhabapay.security_audit_events(id,occurred_at,actor_staff_id,tenant_id,action,outcome,target_type,target_id,request_id,reason_code)
   VALUES(gen_random_uuid(),transaction_timestamp(),approver,tenant,'SECURITY_AUDIT_APPEND','SUCCESS','ROLE_GRANT',manager_grant,${literal(requestId)}::uuid,'NONE');
  INSERT INTO nukhabapay.windows_staff_bootstrap_receipts(id,tenant_id,beneficiary_staff_id,approver_staff_id,grant_id,role_code,evidence_reference,request_id)
   VALUES(gen_random_uuid(),tenant,beneficiary,approver,manager_grant,'TENANT_STAFF_MANAGER',${literal(evidence)},${literal(requestId)}::uuid);
 END IF;
 IF NOT created AND NOT EXISTS(SELECT FROM nukhabapay.windows_staff_bootstrap_receipts WHERE grant_id=manager_grant AND beneficiary_staff_id=beneficiary AND approver_staff_id=approver)
 THEN RAISE EXCEPTION 'Existing manager grant lacks bootstrap receipt'; END IF;
 IF (SELECT count(*) FROM nukhabapay.tenant_role_grants WHERE membership_id=membership AND tenant_id=tenant AND role_code='TENANT_STAFF_MANAGER' AND revoked_at IS NULL)<>1
 THEN RAISE EXCEPTION 'Central manager grant verification failed'; END IF;
END $apply$;
COMMIT;
\\echo Central staff management grant committed and verified.
`;
const run=randomUUID().replaceAll('-','');
const file=path.join(local,`central-manager-bootstrap-${run}.psql`);
writeFileSync(file,sql,{encoding:'utf8',mode:0o600,flag:'wx'});
process.stdout.write(file);
