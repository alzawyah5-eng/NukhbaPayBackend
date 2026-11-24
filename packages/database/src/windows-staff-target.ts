import type { ClientBase } from 'pg';

export const windowsStaffDatabase = 'nukhbapay_staff';
export const windowsSessionRole = 'nukhabapay_session_backend';
const roles = ['nukhabapay_identity_reader', 'nukhabapay_identity_writer', windowsSessionRole] as const;
export interface WindowsStaffTarget {
  readonly databaseOid: string;
  readonly systemIdentifier: string;
}

const denied = () => new Error('Windows staff database connection unavailable');

export function windowsStaffTarget(databaseOid?: string, systemIdentifier?: string): WindowsStaffTarget {
  if (typeof databaseOid!=='string' || !/^[1-9]\d{0,9}$/.test(databaseOid) || BigInt(databaseOid) > 4294967295n ||
      typeof systemIdentifier!=='string' || !/^[1-9]\d{15,19}$/.test(systemIdentifier) || BigInt(systemIdentifier) > 18446744073709551615n) throw denied();
  return Object.freeze({databaseOid, systemIdentifier});
}

/** Used by each new physical connection, before it can serve an application query. */
export async function verifyWindowsStaffConnection(client: Pick<ClientBase,'query'>, target: WindowsStaffTarget, role: string) {
  if (!roles.some(candidate => candidate === role)) throw denied();
  const result = await client.query(`
    SELECT current_database() = $1 AND d.oid::text = $2
      AND (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) = $3
      AND current_user::text = $4 AND session_user = current_user
      AND system_user = ('scram-sha-256:' || current_user::text)
      AND pg_catalog.host(pg_catalog.inet_server_addr()) = '127.0.0.1' AND pg_catalog.inet_server_port() = 5432
      AND pg_catalog.current_setting('server_version_num')::int / 10000 = 18 AND NOT pg_catalog.pg_is_in_recovery()
      AND pg_catalog.pg_get_userbyid(d.datdba) = 'nukhabapay_migrator'
      AND pg_catalog.shobj_description(d.oid,'pg_database') = 'NukhbaPay Windows staff development v1'
      AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolinherit OR r.rolbypassrls)
      AND NOT EXISTS (SELECT FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS (SELECT FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass
        AND refobjid=r.oid AND deptype='o')
      AND NOT pg_catalog.has_database_privilege(r.oid,d.oid,'CREATE,TEMP')
      AND NOT EXISTS (SELECT FROM pg_catalog.aclexplode(coalesce(d.datacl,pg_catalog.acldefault('d',d.datdba))) a
        WHERE a.grantee=0 OR (a.grantee=r.oid AND a.is_grantable))
      AND NOT EXISTS (SELECT FROM pg_catalog.pg_namespace s WHERE pg_catalog.has_schema_privilege(r.oid,s.oid,'CREATE'))
      AND NOT EXISTS (SELECT FROM pg_catalog.pg_namespace s
        CROSS JOIN LATERAL pg_catalog.aclexplode(s.nspacl) g
        WHERE s.nspname IN ('nukhabapay','nukhbapay_sessions','nukhbapay_staff_workspace','nukhbapay_staff_departments') AND g.grantee=0)
      AS verified
    FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.rolname=current_user
    WHERE d.datname=current_database()`, [windowsStaffDatabase,target.databaseOid,target.systemIdentifier,role]);
  if (result.rows.length !== 1 || result.rows[0]?.verified !== true) throw denied();
}
