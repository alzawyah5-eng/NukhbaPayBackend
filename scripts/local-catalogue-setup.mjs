import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const { Client } = createRequire(new URL('packages/database/package.json', root))('pg');
const database = 'nukhbapay_catalogue';
const reader = 'nukhbapay_catalogue_reader';
const runtime = 'nukhbapay_catalogue_runtime';
const migrator = 'nukhbapay_catalogue_migrator';
const roles = [reader, runtime, migrator];
const coreMigrations = ['001_catalog', '002_import_role_privileges', '003_import_role_read_access'];
const foundationCount = coreMigrations.length + 1;
const localSources = new URL('packages/database/local-catalogue/', root);
const reusableSources = new Set([
  '012_catalogue_refresh_R2_PROPOSAL.sql', '012_catalogue_refresh_write_fence_PROPOSAL.sql',
  '012_catalogue_refresh_reconciliation.sql', '012_catalogue_refresh_disposition.sql',
  '013_catalogue_publication_outbox.sql', '013_catalogue_publication_delivery_fence.sql',
]);
const pendingSources = new URL('packages/database/pending-migrations/', root);
const tables = ['tenants', 'products', 'provider_accounts', 'provider_snapshots', 'product_mappings', 'provider_offers'];
class LocalCatalogueError extends Error {}
const reject = (condition, message) => { if (condition) throw new LocalCatalogueError(message); };

export async function loadLocalCatalogueMigrations() {
  const manifest = JSON.parse(await readFile(new URL('packages/database/migration-manifest.json', root), 'utf8'));
  process.env.DB_RUNTIME_ROLE = reader;
  process.env.DB_IMPORT_ROLE = runtime;
  const migrations = [];
  for (const name of coreMigrations) {
    const file = `packages/database/migrations/${name}.ts`;
    const source = await readFile(new URL(file, root));
    const digest = createHash('sha256').update(source).digest('hex');
    reject(digest !== manifest.files[file] && createHash('sha256').update(source.toString().replace(/\r\n/g, '\n')).digest('hex') !== manifest.files[file], 'Registered catalogue source does not match its manifest.');
    const migration = await import(new URL(file, root));
    const statements = [];
    migration.up({ sql: statement => statements.push(statement) });
    migrations.push({ name, digest: manifest.files[file], statements });
  }
  const local = JSON.parse(await readFile(new URL('manifest.json', localSources), 'utf8'));
  reject(!Array.isArray(local) || local[0]?.name !== 'local_isolation_001' || local[0].file !== '001_isolation.sql',
    'The local catalogue foundation is missing from its manifest.');
  const names = new Set(coreMigrations);
  for (const [index, entry] of local.entries()) {
    const sequence = String(index + 1).padStart(3, '0');
    reject(!entry || typeof entry.name !== 'string' || !/^[a-z][a-z0-9_]{0,95}$/.test(entry.name) || names.has(entry.name) ||
      !new RegExp(`^${sequence}_[a-z][a-z0-9_]*\\.sql$`).test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256),
    'The local catalogue migration manifest is invalid.');
    const statement = await readFile(new URL(entry.file, localSources), 'utf8');
    const digest = createHash('sha256').update(statement.replace(/\r\n/g, '\n')).digest('hex');
    reject(digest !== entry.sha256, 'Local catalogue source does not match its manifest.');
    const references = entry.before ?? [];
    reject(!Array.isArray(references) || new Set(references.map(source => source?.file)).size !== references.length,
      'Local catalogue source references are invalid.');
    const statements = [];
    const pins = [];
    for (const source of references) {
      reject(!source || !reusableSources.has(source.file) || !/^[a-f0-9]{64}$/.test(source.sha256),
        'A catalogue source reference is outside the supported schema package.');
      const sql = await readFile(new URL(source.file, pendingSources), 'utf8');
      reject(createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex') !== source.sha256,
        'Referenced catalogue source does not match its manifest.');
      statements.push(sql);
      pins.push([source.file, source.sha256]);
    }
    const historyDigest = pins.length ? createHash('sha256').update(JSON.stringify([digest, pins])).digest('hex') : digest;
    migrations.push({ name: entry.name, digest: historyDigest, statements: [...statements, statement] });
    names.add(entry.name);
  }
  const registered = new Set(local.map(entry => entry.file));
  const files = await readdir(localSources);
  reject(files.some(file => /\.sql$/i.test(file) && !registered.has(file)), 'A local catalogue SQL migration is missing from its manifest.');
  return migrations;
}

function open(user, password, name) {
  return new Client({ host: '127.0.0.1', port: 5432, database: name, user, password, ssl: false,
    connectionTimeoutMillis: 5000, query_timeout: 75000,
    options: '-c search_path=pg_catalog -c statement_timeout=12000 -c lock_timeout=5000',
    application_name: 'nukhbapay-catalogue-local-setup' });
}

async function useClient(user, password, name, work) {
  const client = open(user, password, name);
  try { await client.connect(); return await work(client); }
  finally { await client.end().catch(() => undefined); }
}

function scram(password) {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const client = createHmac('sha256', salted).update('Client Key').digest();
  const stored = createHash('sha256').update(client).digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  salted.fill(0);
  client.fill(0);
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}

async function requireTarget(client, expectedDatabase, expectedRole, expectedSystem, marker) {
  const { rows: [row] } = await client.query(`SELECT current_database() AS database, current_user AS role,
    system_user AS authenticated, host(inet_server_addr()) AS address, inet_server_port() AS port,
    current_setting('server_version_num')::int / 10000 AS major, d.oid::text AS oid,
    pg_get_userbyid(d.datdba) AS owner, shobj_description(d.oid,'pg_database') AS marker,
    NOT (r.rolsuper OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT has_database_privilege(current_user,'nukhbapay_staff','CONNECT') AS restricted,
    CASE WHEN current_user='postgres' THEN (SELECT system_identifier::text FROM pg_control_system()) END AS system
    FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`);
  reject(row?.database !== expectedDatabase || row.role !== expectedRole || row.authenticated !== `scram-sha-256:${expectedRole}` ||
    row.address !== '127.0.0.1' || row.port !== 5432 || row.major !== 18 ||
    (expectedDatabase === database && (row.owner !== migrator || row.marker !== marker)) ||
    (expectedRole !== 'postgres' && !row.restricted) ||
    (expectedRole === 'postgres' && row.system !== expectedSystem), 'Unexpected PostgreSQL target or login.');
  return row.oid;
}

async function provision(admin, passwords, marker, expectedSystem, checkpoint) {
  await requireTarget(admin, 'postgres', 'postgres', expectedSystem);
  await admin.query('SELECT pg_advisory_lock(8074652183940113::bigint)');
  const { rows: [staff] } = await admin.query(`SELECT NOT EXISTS (
    SELECT FROM aclexplode(coalesce(datacl,acldefault('d',datdba)))
    WHERE grantee=0 AND privilege_type='CONNECT') AS private FROM pg_database WHERE datname='nukhbapay_staff'`);
  reject(staff?.private !== true, 'The existing staff database does not have a private CONNECT ACL.');
  const { rows: found } = await admin.query(`SELECT rolname, shobj_description(oid,'pg_authid') AS marker,
    rolcanlogin AND NOT (rolsuper OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS restricted,
    NOT EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS standalone
    FROM pg_roles r WHERE rolname=ANY($1::text[])`, [roles]);
  const { rows: [existing] } = await admin.query(`SELECT oid::text AS oid, datallowconn AS online,
    pg_get_userbyid(datdba) AS owner, shobj_description(oid,'pg_database') AS marker
    FROM pg_database WHERE datname=$1`, [database]);
  reject(found.length > 0 && (found.length !== roles.length || found.some(role =>
    role.marker !== marker || !role.restricted || !role.standalone)), 'Catalogue role name collision.');
  reject(existing && (existing.marker !== marker || existing.owner !== migrator || found.length !== roles.length), 'Catalogue database name collision.');
  if (!found.length) {
    checkpoint('provisioning the restricted roles');
    await admin.query('BEGIN');
    try {
      for (const role of roles) {
        await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${scram(passwords[role])}'`);
        await admin.query(`COMMENT ON ROLE ${role} IS '${marker}'`);
      }
      await admin.query('COMMIT');
    } catch (error) { await admin.query('ROLLBACK'); throw error; }
  }
  if (!existing) {
    checkpoint('creating the new database');
    await admin.query("SET statement_timeout='60s'");
    await admin.query(`CREATE DATABASE ${database} OWNER ${migrator} TEMPLATE template0 ALLOW_CONNECTIONS false`);
    await admin.query(`COMMENT ON DATABASE ${database} IS '${marker}'`);
    await admin.query("SET statement_timeout='12s'");
  }
  checkpoint('validating database CONNECT ACLs');
  await admin.query('BEGIN');
  try {
    await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
      GRANT CONNECT ON DATABASE ${database} TO ${reader}, ${runtime};
      ALTER DATABASE ${database} ALLOW_CONNECTIONS true`);
    const { rows: [acl] } = await admin.query(`SELECT NOT EXISTS (
      SELECT FROM aclexplode(datacl) a WHERE a.grantee<>datdba AND (
        a.privilege_type<>'CONNECT' OR a.is_grantable OR a.grantee NOT IN ($2::regrole,$3::regrole))) AS exact,
      NOT has_database_privilege($2,'nukhbapay_staff','CONNECT')
        AND NOT has_database_privilege($3,'nukhbapay_staff','CONNECT')
        AND NOT has_database_privilege($4,'nukhbapay_staff','CONNECT') AS staff_private
      FROM pg_database WHERE datname=$1`, [database, reader, runtime, migrator]);
    reject(!acl?.exact || !acl.staff_private, 'Unexpected database CONNECT privileges.');
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}

export async function installLocalCatalogueMigrations(client, migrations, { initialise = false, check = false, rehearse } = {}) {
  await client.query(check ? 'BEGIN READ ONLY' : 'BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(8074652183940113::bigint)');
    const { rows: [state] } = await client.query(`SELECT to_regnamespace('nukhabapay') IS NOT NULL AS present`);
    if (!state.present) {
      reject(!initialise || check, 'The catalogue database needs first-time setup.');
      await client.query('CREATE SCHEMA nukhabapay');
      await client.query(`CREATE TABLE nukhabapay.local_catalogue_schema_history (
        name text PRIMARY KEY, source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT transaction_timestamp())`);
    }
    const { rows } = await client.query('SELECT name,source_sha256 FROM nukhabapay.local_catalogue_schema_history');
    const applied = new Map(rows.map(row => [row.name, row.source_sha256]));
    reject(rows.length !== applied.size || rows.length > migrations.length ||
      (state.present && rows.length < foundationCount) ||
      migrations.slice(0, rows.length).some(({ name, digest }) => applied.get(name) !== digest),
    'Catalogue schema history does not match the reviewed migration sequence.');
    const pending = migrations.slice(rows.length);
    reject(check && pending.length > 0, 'Pending catalogue migrations need the normal startup command.');
    for (const { name, digest, statements } of pending) {
      for (const statement of statements) await client.query(statement);
      await client.query('INSERT INTO nukhabapay.local_catalogue_schema_history(name,source_sha256) VALUES($1,$2)', [name, digest]);
    }
    if (rehearse) {
      await rehearse(client);
      await client.query('ROLLBACK');
      return pending.map(({ name }) => name);
    }
    const committed = await client.query('COMMIT');
    reject(committed.command !== 'COMMIT', 'Catalogue migration transaction did not commit.');
    return pending.map(({ name }) => name);
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
}

async function verifyRole(client, role) {
  const { rows: [check] } = await client.query(`SELECT NOT (rolsuper OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    AND NOT EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
    AND NOT has_database_privilege(current_user,'nukhbapay_staff','CONNECT')
    AND NOT has_schema_privilege(current_user,'nukhabapay','CREATE')
    AND NOT has_column_privilege(current_user,'nukhabapay.provider_accounts','credential_reference','SELECT')
    AND NOT has_table_privilege(current_user,'nukhabapay.local_catalogue_schema_history','SELECT') AS restricted,
    has_table_privilege(current_user,'nukhabapay.provider_snapshots','INSERT') AS snapshot_write,
    has_table_privilege(current_user,'nukhabapay.provider_offers','INSERT') AS offer_write,
    NOT has_table_privilege(current_user,'nukhabapay.provider_offers','UPDATE,DELETE,TRUNCATE') AS offers_protected,
    NOT has_table_privilege(current_user,'nukhabapay.product_mappings','INSERT,UPDATE,DELETE,TRUNCATE') AS approval_protected,
    NOT has_any_column_privilege(current_user,'nukhabapay.products','INSERT,UPDATE') AS products_protected,
    (SELECT count(*)=6 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)=$2)
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='nukhabapay' AND c.relname=ANY($1::text[])) AS forced_rls
    FROM pg_roles r WHERE r.rolname=current_user`, [tables, migrator]);
  reject(!check?.restricted || !check.offers_protected || !check.approval_protected || !check.products_protected || !check.forced_rls ||
    check.snapshot_write !== (role === runtime) || check.offer_write !== (role === runtime), 'Catalogue role or RLS verification failed.');
  const { rows: [visibility] } = await client.query('SELECT count(*)::int AS visible FROM nukhabapay.products');
  reject(visibility?.visible !== 0, 'Missing tenant context exposed product rows.');
}

async function testTenantIsolation(admin) {
  const tenants = [randomUUID(), randomUUID()];
  const products = [randomUUID(), randomUUID()];
  const accounts = [randomUUID(), randomUUID()];
  const tenant = id => admin.query("SELECT set_config('nukhabapay.tenant_id',$1,true)", [id]);
  await admin.query('BEGIN');
  try {
    await admin.query(`SET LOCAL ROLE ${migrator}`);
    for (let index = 0; index < 2; index++) {
      await tenant(tenants[index]);
      await admin.query('INSERT INTO nukhabapay.tenants(id,tenant_key) VALUES ($1,$2)', [tenants[index], `qualification-${tenants[index]}`]);
      await admin.query(`INSERT INTO nukhabapay.products(id,canonical_product_key,brand,redemption_country,currency,face_value_minor,fulfillment_method,terms_version)
        VALUES($1,$2,'Qualification','AE','AED',100,'DIGITAL_PIN','qualification')`, [products[index], `qualification-${products[index]}`]);
      await admin.query(`INSERT INTO nukhabapay.provider_accounts(id,tenant_id,provider_code,external_account_key,status)
        VALUES($1,$2,'LOCAL_QUALIFICATION',$3,'ACTIVE')`, [accounts[index], tenants[index], accounts[index]]);
      await admin.query(`INSERT INTO nukhabapay.product_mappings(id,tenant_id,provider_account_id,provider_sku,product_id,mapping_version,status,provenance_kind,provenance)
        VALUES(gen_random_uuid(),$1,$2,'QUALIFICATION',$3,1,'APPROVED','MANUAL','{"local_qualification":true}')`,
        [tenants[index], accounts[index], products[index]]);
    }
    await admin.query(`SET LOCAL ROLE ${reader}`);
    for (let index = 0; index < 2; index++) {
      await tenant(tenants[index]);
      const { rows } = await admin.query('SELECT id FROM nukhabapay.products WHERE id=ANY($1::uuid[])', [products]);
      reject(rows.length !== 1 || rows[0].id !== products[index], 'Catalogue tenant isolation failed.');
    }
    await tenant('');
    const { rows } = await admin.query('SELECT id FROM nukhabapay.products WHERE id=ANY($1::uuid[])', [products]);
    reject(rows.length > 0, 'Missing tenant scope exposed catalogue data.');
    await admin.query(`SET LOCAL ROLE ${runtime}`);
    await tenant(tenants[0]);
    const insert = `INSERT INTO nukhabapay.provider_snapshots(id,tenant_id,provider_account_id,snapshot_key,source_version,observed_at,status)
      VALUES($1,$2,$3,$4,'qualification',clock_timestamp(),'IN_PROGRESS')`;
    await admin.query(insert, [randomUUID(), tenants[0], accounts[0], 'qualification-allowed']);
    await admin.query('SAVEPOINT cross_tenant_check');
    let denied = false;
    try { await admin.query(insert, [randomUUID(), tenants[1], accounts[1], 'qualification-denied']); }
    catch (error) { denied = error.code === '42501'; }
    await admin.query('ROLLBACK TO SAVEPOINT cross_tenant_check');
    reject(!denied, 'Cross-tenant snapshot write was not denied.');
  } finally { await admin.query('ROLLBACK'); }
}

async function verifyBackendReader(setupId, databaseOid, password) {
  const { createLocalCatalogueStorage } = await import(new URL('packages/database/dist/database/src/local-catalogue-storage.js', root));
  const storage = await createLocalCatalogueStorage({ setupId, databaseOid, password }, new Map());
  try { reject(!await storage.checkReadiness(), 'Backend catalogue connection unavailable.'); }
  finally { await storage.close(); }
}

async function main() {
  const mode = process.argv[2];
  reject(process.argv.length > 3 || (mode !== undefined && !['--sources-only', '--migrate', '--check', '--rehearse'].includes(mode)),
    'Unexpected catalogue setup invocation.');
  const migrations = await loadLocalCatalogueMigrations();
  if (mode === '--sources-only') {
    console.log(`Verified ${migrations.length} registered local catalogue migration sources.`);
    return;
  }
  reject(process.platform !== 'win32', 'Unexpected catalogue setup invocation.');
  const config = JSON.parse(await readFile(new URL('.local/windows-staff-inspection.json', root), 'utf8'));
  reject(config.targetVerified !== true || !/^[1-9][0-9]{15,19}$/.test(config.systemIdentifier), 'Missing verified Windows PostgreSQL cluster binding.');
  const id = process.env.NUKHBAPAY_CATALOGUE_SETUP_ID;
  const adminPassword = process.env.NUKHBAPAY_CATALOGUE_LOCAL_ADMIN;
  const suppliedRoles = mode ? [reader, migrator] : roles;
  const passwords = Object.fromEntries(suppliedRoles.map(role => [role, process.env[role.toUpperCase() + '_PASSWORD']]));
  reject(!/^[a-f0-9]{32}$/.test(id ?? '') || (mode ? adminPassword !== undefined : !adminPassword) || suppliedRoles.some(role =>
    !/^[a-f0-9]{64}$/.test(passwords[role] ?? '')) || new Set(Object.values(passwords)).size !== suppliedRoles.length,
  'Incomplete private catalogue configuration.');
  const marker = `nukhbapay-catalogue-local:${id}`;
  if (mode) {
    const rehearse = mode === '--rehearse'
      ? (await import('./test/local-catalogue-schema-qualification.mjs')).rehearseLocalCatalogueSchema : undefined;
    const result = await useClient(migrator, passwords[migrator], database, async client => {
      const oid = await requireTarget(client, database, migrator, config.systemIdentifier, marker);
      const applied = await installLocalCatalogueMigrations(client, migrations, { check: mode === '--check', rehearse });
      return { oid, applied };
    });
    if (rehearse) {
      console.log(`Rehearsal passed. Rolled back ${result.applied.length} staged catalogue migrations and qualification rows.`);
      return;
    }
    await verifyBackendReader(id, result.oid, passwords[reader]);
    console.log(result.applied.length ? `Applied ${result.applied.length} local catalogue migrations.` : 'Local catalogue schema is up to date.');
    return;
  }
  const report = { status: 'started', databaseVerified: false, foundationInstalled: false,
    restrictedRolesVerified: false, tenantIsolationVerified: false, backendReaderVerified: false };
  let stage = 'verifying the administrator login and catalog collisions';
  const checkpoint = entry => { stage = entry; };
  const evidencePath = new URL('.local/windows-catalogue-result.json', root);
  try {
    await useClient('postgres', adminPassword, 'postgres', client =>
      provision(client, passwords, marker, config.systemIdentifier, checkpoint));
    report.databaseVerified = true;
    console.log('Dedicated local catalogue database and three roles verified.');
    checkpoint('installing the catalogue foundation as the migrator');
    const oid = await useClient(migrator, passwords[migrator], database, async client => {
      const targetOid = await requireTarget(client, database, migrator, config.systemIdentifier, marker);
      await installLocalCatalogueMigrations(client, migrations, { initialise: true });
      return targetOid;
    });
    report.foundationInstalled = true;
    console.log('Catalogue foundation migrations and forced row-level security installed.');
    checkpoint('checking the reader and runtime logins');
    for (const role of [reader, runtime]) {
      await useClient(role, passwords[role], database, async client => {
        reject(await requireTarget(client, database, role, config.systemIdentifier, marker) !== oid, 'Catalogue database identity changed.');
        await verifyRole(client, role);
      });
    }
    report.restrictedRolesVerified = true;
    checkpoint('qualifying tenant isolation with rolled-back fixture data');
    await useClient('postgres', adminPassword, database, async client => {
      reject(await requireTarget(client, database, 'postgres', config.systemIdentifier, marker) !== oid, 'Catalogue database identity changed.');
      await testTenantIsolation(client);
    });
    report.tenantIsolationVerified = true;
    console.log('Verified restricted role logins, no cross-database staff access, tenant reads and runtime writes. Qualification data rolled back.');
    checkpoint('connecting the backend catalogue reader');
    await verifyBackendReader(id, oid, passwords[reader]);
    report.backendReaderVerified = true;
    report.status = 'verified';
    console.log('Backend catalogue reader connected through the restricted catalogue role.');
  } catch (error) {
    report.status = 'stopped';
    report.stage = stage;
    if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) report.sqlstate = error.code;
    const code = report.sqlstate ? ` (${report.sqlstate})` : '';
    console.error('Catalogue setup stopped while ' + stage + code + '.');
    process.exitCode = 1;
  } finally { await writeFile(evidencePath, JSON.stringify(report, null, 2)); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof LocalCatalogueError ? error.message : 'Local catalogue setup failed.');
    process.exitCode = 1;
  });
}
