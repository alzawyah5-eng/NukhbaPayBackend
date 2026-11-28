import { Client, type ClientBase, type ClientConfig, type PoolConfig } from 'pg';

class AwsStagingPostgresClient extends Client {
  #receivedScramFinal = false;

  constructor(config?: ClientConfig) {
    // pg-pool passes the password as a non-enumerable property.
    super(config);
    // RDS can label the connection "md5" because of the HBA rule, even when PostgreSQL negotiates SCRAM.
    // pg verifies the SASL final response before the connection becomes available from the pool.
    this.connection.once('authenticationSASLFinal', () => { this.#receivedScramFinal = true; });
  }

  get authenticatedWithScram() { return this.#receivedScramFinal; }
}

export interface AwsStagingTarget {
  readonly host: string;
  readonly ssl: NonNullable<PoolConfig['ssl']>;
  readonly poolOptions: Readonly<Pick<PoolConfig,'ssl'|'Client'|'enableChannelBinding'>>;
}

export function awsStagingTarget(host: string | undefined, ca: string): AwsStagingTarget {
  if (!host || !/^nukhbapay-staging-postgres\.[a-z0-9]+\.eu-north-1\.rds\.amazonaws\.com$/.test(host) ||
      !ca.includes('-----BEGIN CERTIFICATE-----') || ca.length > 2_000_000) {
    throw new Error('Invalid AWS staging database target');
  }
  const ssl = Object.freeze({ ca, rejectUnauthorized:true });
  return Object.freeze({ host, ssl, poolOptions: Object.freeze({ ssl, Client: AwsStagingPostgresClient, enableChannelBinding:true }) });
}

/** The TLS connection pins the endpoint. Verify identity on every physical connection. */
export async function verifyAwsStagingConnection(client: Pick<ClientBase,'query'>, database:string, role:string) {
  const negotiatedScram = client instanceof AwsStagingPostgresClient && client.authenticatedWithScram;
  const { rows: [result] } = await client.query(`SELECT
    current_database()=$1 AND current_user=$2 AND (system_user='scram-sha-256:'||$2 OR ($3::boolean AND system_user='md5:'||$2))
    AND inet_server_port()=5432 AND current_setting('server_version_num')::int/10000=18
    AND (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid())
    AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolinherit OR r.rolreplication)
    AND NOT EXISTS (SELECT FROM pg_auth_members m WHERE m.member=r.oid OR (
      m.roleid=r.oid AND NOT (coalesce(m.member=to_regrole('stagingadmin'),false)
        AND m.admin_option AND NOT m.set_option AND NOT m.inherit_option)))
    AND NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP') AS verified
    FROM pg_roles r WHERE r.rolname=current_user`, [database,role,negotiatedScram]);
  if (result?.verified!==true) throw new Error('AWS staging database connection unavailable');
}
