import {createHash} from 'node:crypto';
import path from 'node:path';

// The Node installer and pgAdmin execute the same guarded SQL on a SCRAM-authenticated connection.
const blockTag='$nukhbapay_windows_installer_v1$';
const sqlString=value=>{
  if(typeof value!=='string' || value.includes('\0') || value.includes(blockTag))throw new Error('Invalid SQL input');
  return "E'"+value.replaceAll('\\','\\\\').replaceAll("'","''")+"'";
};
export function guardedBlock(body) {
  if(body.includes(blockTag))throw new Error('Unexpected block delimiter');
  return `DO LANGUAGE plpgsql ${blockTag}
BEGIN
  PERFORM pg_catalog.set_config('search_path','pg_catalog',true);
  ${body}
END
${blockTag};`;
}

export function targetChecks(pin,rehearsal) {
  if(!/^\d{1,10}$/.test(pin.databaseOid) || !/^\d{15,20}$/.test(pin.systemIdentifier) ||
     !path.win32.isAbsolute(pin.directory) || !Number.isInteger(pin.port) ||
     (rehearsal?pin.port<=1024 || [5432,55437].includes(pin.port) || pin.port>65535:pin.port!==5432))
    throw new Error('Invalid Windows target pin');
  const directory=path.win32.normalize(pin.directory).replaceAll('\\','/').toLowerCase();
  const marker=rehearsal?'NukhbaPay private PG18 restore rehearsal':'NukhbaPay Windows staff development v1';
  return `IF NOT EXISTS (
    SELECT FROM pg_database d WHERE d.datname=current_database() AND d.datname='nukhbapay_staff'
      AND d.oid::text=${sqlString(pin.databaseOid)} AND pg_get_userbyid(d.datdba)='nukhabapay_migrator'
      AND (SELECT system_identifier::text FROM pg_control_system())=${sqlString(pin.systemIdentifier)}
      AND lower(replace(current_setting('data_directory'),chr(92),'/'))=${sqlString(directory)}
      AND current_setting('server_version_num')::int/10000=18 AND NOT pg_is_in_recovery()
      AND current_user='postgres' AND session_user='postgres' AND system_user='scram-sha-256:postgres'
      AND host(inet_server_addr())='127.0.0.1' AND inet_server_port()=${pin.port}
      AND shobj_description(d.oid,'pg_database')=${sqlString(marker)}
      AND NOT EXISTS(SELECT FROM aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE a.grantee<>d.datdba
        AND (a.privilege_type<>'CONNECT' OR a.is_grantable OR NOT EXISTS(SELECT FROM pg_roles WHERE oid=a.grantee
          AND rolname IN ('nukhabapay_identity_reader','nukhabapay_identity_writer','nukhabapay_session_backend')))))
    THEN RAISE EXCEPTION 'Windows database identity or ACL mismatch'; END IF;
  IF (SELECT count(*) FROM pg_roles r WHERE rolname IN ('nukhabapay_migrator','nukhabapay_identity_reader','nukhabapay_identity_writer')
    AND NOT(rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication)
    AND (rolname='nukhabapay_migrator' OR rolcanlogin) AND NOT EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid))<>3
    THEN RAISE EXCEPTION 'Existing IAM workload or owner role mismatch'; END IF;`;
}

export function installedChecks(candidateHash,backupHash,issuer) {
  return `IF (SELECT count(*) FROM nukhabapay.windows_staff_schema_history)<>1 OR NOT EXISTS(
    SELECT FROM nukhabapay.windows_staff_schema_history WHERE version=1 AND candidate_sha256=${sqlString(candidateHash)}
      AND backup_sha256=${sqlString(backupHash)} AND issuer=${sqlString(issuer)})
    THEN RAISE EXCEPTION 'Existing staff installation differs'; END IF;
  IF NOT (SELECT count(*)=11 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='nukhabapay_migrator')
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND
      (n.nspname IN ('nukhbapay_sessions','nukhbapay_staff_workspace','nukhbapay_staff_departments') OR
       (n.nspname='nukhabapay' AND c.relname IN ('staff_memberships','tenant_role_grants','security_audit_events'))))
    THEN RAISE EXCEPTION 'Native staff table protection mismatch'; END IF;
  IF NOT EXISTS(SELECT FROM pg_roles r WHERE rolname='nukhabapay_session_backend' AND rolconnlimit=4
    AND NOT(rolsuper OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    AND NOT EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
    AND has_database_privilege(r.oid,current_database(),'CONNECT') AND NOT has_database_privilege(r.oid,current_database(),'CREATE,TEMP')
    AND NOT has_schema_privilege(r.oid,'nukhabapay','CREATE,USAGE'))
    THEN RAISE EXCEPTION 'Session role privileges differ'; END IF;`;
}

function checkedDdl(source) {
  // Query Tool normalizes file line endings. Hash the exact SQL sent to EXECUTE.
  const text=source.replaceAll('\r\n','\n');
  const digest=createHash('sha256').update(text).digest('hex');
  const tag='$ddl_'+digest.slice(0,16)+'$';
  if(text.includes(tag) || text.includes(blockTag))throw new Error('Unexpected migration delimiter');
  return `DECLARE reviewed_sql text:=${tag}${text}${tag};
    BEGIN
      IF encode(sha256(convert_to(reviewed_sql,'UTF8')),'hex')<>'${digest}' THEN RAISE EXCEPTION 'Reviewed DDL integrity mismatch'; END IF;
      EXECUTE reviewed_sql;
    END;`;
}

export function installationSql({pin,rehearsal=false,bundle,backupHash,issuer},lockId) {
  if(!/^[0-9a-f]{64}$/.test(backupHash) || !/^[0-9a-f]{64}$/.test(bundle.candidateHash) ||
    issuer!=='https://dev-whz1tr4aj20nxswq.us.auth0.com/' || !/^-?\d+$/.test(String(lockId)))throw new Error('Invalid schema candidate');
  return guardedBlock(`
  PERFORM set_config('lock_timeout','5s',true);
  IF NOT pg_try_advisory_xact_lock(${lockId}::bigint) THEN RAISE EXCEPTION 'Migration already running'; END IF;
  ${targetChecks(pin,rehearsal)}
  IF to_regclass('nukhabapay.windows_staff_schema_history') IS NULL THEN
    IF NOT (${bundle.empty.trim().replace(/;$/,'')}) OR to_regrole('nukhabapay_session_backend') IS NOT NULL
      THEN RAISE EXCEPTION 'Expected empty target and an unused session role'; END IF;
    CREATE ROLE nukhabapay_session_backend NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
    SET LOCAL ROLE nukhabapay_migrator;
    PERFORM set_config('nukhbapay.windows_oid',${sqlString(pin.databaseOid)},true),
            set_config('nukhbapay.windows_cluster',${sqlString(pin.systemIdentifier)},true),
            set_config('nukhbapay.windows_issuer',${sqlString(issuer)},true);
    ${[bundle.foundation,bundle.iam,bundle.portal].map(checkedDdl).join('\n    ')}
    INSERT INTO nukhabapay.windows_staff_schema_history(version,candidate_sha256,backup_sha256,issuer)
      VALUES(1,${sqlString(bundle.candidateHash)},${sqlString(backupHash)},${sqlString(issuer)});
    PERFORM set_config('nukhbapay.windows_install_result','installed',true);
  ELSE
    PERFORM set_config('nukhbapay.windows_install_result','previously-installed',true);
  END IF;
  ${installedChecks(bundle.candidateHash,backupHash,issuer)}`);
}
