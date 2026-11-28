import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { installLocalCatalogueMigrations, loadLocalCatalogueMigrations } from './local-catalogue-setup.mjs';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const tables = Object.freeze({
  provider_accounts: 'id status tenant_id provider_code external_account_key',
  catalogue_discoveries: 'id brand category currency delivery source_id tenant_id max_amount min_amount observed_at product_name denominations source_digest source_country provider_account_id source_country_label source_category_label',
  catalogue_discovery_scans: 'id tenant_id page_count scan_digest completed_at source_group product_count coverage_scope source_version source_observed_at provider_account_id',
  catalogue_discovery_scan_items: 'scan_id tenant_id discovery_id provider_account_id',
  catalogue_discovery_confirmations: 'run_id scan_id tenant_id observed_at confirmed_at provider_account_id',
  catalogue_discovery_coverage_corrections: 'reason scan_id tenant_id recorded_at recorded_by provider_account_id',
  finxplor_catalogue_artwork: 'image_url tenant_id observed_at discovery_id provider_account_id',
  finxplor_customer_fx_rates: 'slot_at tenant_id rate_source aed_per_unit refresh_kind retrieved_at usd_aed_rate source_currency usd_source_rate provider_account_id source_effective_at',
  finxplor_layer1_customer_prices: 'basis tenant_id fx_slot_at source_key discovery_id converted_aed source_amount fx_retrieved_at source_currency source_reference price_observed_at price_valid_until provider_account_id acquisition_cost_aed',
});

export async function readStagingCatalogueSnapshot(path, checksum) {
  const archive = await readFile(path);
  if (archive.length > 24_000_000 || createHash('sha256').update(archive).digest('base64') !== checksum) {
    throw new Error('Unexpected staging catalogue archive');
  }
  const json = gunzipSync(archive, { maxOutputLength: 128_000_000 }).toString('utf8').replace(/^\uFEFF/, '');
  // Preserve PostgreSQL NUMERIC tokens, including scale, for jsonb_populate_recordset.
  const snapshot = JSON.parse(json, (_key, value, context) =>
    typeof value === 'number' && !/^\d{1,9}$/.test(context.source) ? JSON.rawJSON(context.source) : value);
  if (snapshot.schemaVersion !== 1 || !uuid.test(snapshot.tenantId) ||
      !Array.isArray(snapshot.provider_accounts) || snapshot.provider_accounts.length !== 2) {
    throw new Error('Unexpected staging catalogue snapshot format');
  }
  const providers = new Map(snapshot.provider_accounts.map(row => [row.provider_code, row.id]));
  const finxplorAccount = providers.get('FINXPLOR');
  const ipayAccount = providers.get('IPAY');
  if (!uuid.test(finxplorAccount) || !uuid.test(ipayAccount) || finxplorAccount === ipayAccount ||
      snapshot.provider_accounts.some(row => row.status !== 'DISABLED')) {
    throw new Error('Unexpected staging provider accounts');
  }
  for (const [table, columns] of Object.entries(tables)) {
    const allowed = columns.split(' ');
    const rows = snapshot[table];
    if (!Array.isArray(rows) || rows.length > 250_000 || rows.some(row => {
      if (!row || row.tenant_id !== snapshot.tenantId || allowed.some(key => !Object.hasOwn(row, key))) return true;
      if (table === 'provider_accounts') return false;
      if (table.startsWith('finxplor_')) return row.provider_account_id !== finxplorAccount;
      return ![finxplorAccount, ipayAccount].includes(row.provider_account_id);
    })) throw new Error(`Unexpected staging rows in ${table}`);
  }
  if (snapshot.finxplor_layer1_customer_prices.some(row => row.acquisition_cost_aed !== null)) {
    throw new Error('Unexpected acquisition cost in the catalogue backup');
  }
  return { snapshot, finxplorAccount };
}

async function insertCatalogueRows(client, table, rows, columns = tables[table]) {
  // Column lists and relation names are fixed by this module. The data stays parameterized.
  const names = columns.replaceAll(' ', ',');
  for (let offset = 0; offset < rows.length; offset += 1500) {
    const batch = rows.slice(offset, offset + 1500);
    const result = await client.query(`INSERT INTO nukhabapay.${table} (${names})
      SELECT ${names} FROM jsonb_populate_recordset(NULL::nukhabapay.${table},$1::jsonb)`, [JSON.stringify(batch)]);
    if (result.rowCount !== batch.length) throw new Error(`Incomplete catalogue import for ${table}`);
  }
}

export async function importStagingCatalogue(client, { snapshot, finxplorAccount }, options = {}) {
  const migrations = await loadLocalCatalogueMigrations();
  const last = migrations.at(-1)?.name;
  if (last !== 'local_ipay_product_file_coverage_026') throw new Error('Review catalogue restore against the current migration baseline');
  const legacyScans = snapshot.catalogue_discovery_scans.filter(row => row.coverage_scope === null);
  const currentScans = snapshot.catalogue_discovery_scans.filter(row => row.coverage_scope !== null);
  const counts = Object.fromEntries(Object.keys(tables).map(table => [table,snapshot[table].length]));
  let foundationRestored = false;
  const applied = await installLocalCatalogueMigrations(client, migrations, {
    initialise: true,
    rehearse: options.rehearse,
    async afterMigration(database, name) {
      if (name === 'local_discovery_scans_009') {
        await database.query("SELECT set_config('nukhabapay.tenant_id',$1,true)", [snapshot.tenantId]);
        await database.query('INSERT INTO nukhabapay.tenants(id,tenant_key) VALUES($1,$2)', [snapshot.tenantId, `staging-${snapshot.tenantId}`]);
        await insertCatalogueRows(database, 'provider_accounts', snapshot.provider_accounts);
        // These scans predate coverage scopes. Apply them at their original schema boundary.
        await insertCatalogueRows(database, 'catalogue_discovery_scans', legacyScans, 'id tenant_id provider_account_id completed_at');
        foundationRestored = true;
      }
      if (name !== last) return;
      if (!foundationRestored) throw new Error('Expected a new staging catalogue schema');
      await database.query("SELECT set_config('nukhabapay.finxplor_price_account',$1,true)", [finxplorAccount]);
      await insertCatalogueRows(database, 'catalogue_discoveries', snapshot.catalogue_discoveries);
      await insertCatalogueRows(database, 'catalogue_discovery_scans', currentScans);
      for (const table of Object.keys(tables).slice(3)) {
        const finxplorTable = table.startsWith('finxplor_');
        if (finxplorTable) {
          // Historical fields are restored by the schema owner under tenant and account RLS.
          await database.query(`CREATE POLICY staging_catalogue_restore ON nukhabapay.${table} FOR INSERT
            TO nukhbapay_catalogue_migrator WITH CHECK (
              tenant_id::text=current_setting('nukhabapay.tenant_id',true)
              AND provider_account_id::text=current_setting('nukhabapay.finxplor_price_account',true))`);
        }
        await insertCatalogueRows(database, table, snapshot[table]);
        if (finxplorTable) await database.query(`DROP POLICY staging_catalogue_restore ON nukhabapay.${table}`);
      }
      // Run deferred scan and digest checks before reporting success.
      await database.query('SET CONSTRAINTS ALL IMMEDIATE');
    },
  });
  if (applied.length !== migrations.length && applied.length !== 0) throw new Error('Unexpected partially initialized catalogue');
  return { counts, migrated: applied.length };
}
