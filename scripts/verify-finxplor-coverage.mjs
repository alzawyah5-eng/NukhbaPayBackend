import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readLocalDiscoveryPage } from '../packages/database/dist/database/src/local-discovery-page.js';

export async function verifyFinxplorCoverage(client, { tenantId, providerAccountId }, productId) {
  const { rows: [access] } = await client.query(`SELECT
    current_user='nukhbapay_catalogue_reader' AND current_setting('transaction_read_only')='on' AS "staffReadOnly",
    NOT has_column_privilege(current_user,'nukhabapay.product_mappings','provider_sku','SELECT')
      AND NOT has_column_privilege(current_user,'nukhabapay.product_mappings','mapping_version','SELECT')
      AND NOT has_column_privilege(current_user,'nukhabapay.product_mappings','provenance','SELECT') AS "rawMappingsRestricted"`);
  assert.deepEqual(access,{staffReadOnly:true,rawMappingsRestricted:true});
  const account = [tenantId, providerAccountId];
  const { rows: [scan] } = await client.query(`SELECT page_count AS pages,product_count AS products,
    scan_digest AS "scanDigest",source_observed_at AS "observedAt",completed_at AS "completedAt"
    FROM nukhabapay.catalogue_discovery_scans WHERE tenant_id=$1 AND provider_account_id=$2
      AND coverage_scope='ARE_GIFT_CARD' ORDER BY completed_at DESC,id DESC LIMIT 1`, account);
  const { rows: [current] } = await client.query(`SELECT count(*) FILTER(WHERE coverage_scope='ARE_GIFT_CARD')::int AS scoped,
      count(*) FILTER(WHERE coverage_scope='ARE_GIFT_CARD' AND currency='AED')::int AS aed,
      count(*) FILTER(WHERE coverage_scope IS NULL)::int AS legacy
    FROM nukhabapay.current_catalogue_discoveries WHERE tenant_id=$1 AND provider_account_id=$2`, account);
  const { rows: [legacy] } = await client.query(`SELECT count(s.id)::int AS scans,count(c.scan_id)::int AS corrections
    FROM nukhabapay.catalogue_discovery_scans s LEFT JOIN nukhabapay.catalogue_discovery_coverage_corrections c
      ON (c.tenant_id,c.provider_account_id,c.scan_id)=(s.tenant_id,s.provider_account_id,s.id)
    WHERE s.tenant_id=$1 AND s.provider_account_id=$2 AND s.coverage_scope IS NULL`, account);
  assert.equal(legacy.scans, legacy.corrections);
  assert.equal(scan?.products, current.scoped);
  const { rows: [target] } = await client.query(`SELECT source_id AS "sourceId",source_country AS country,currency,category,
      source_country_label AS "countryLabel",source_category_label AS "categoryLabel",denominations
    FROM nukhabapay.current_catalogue_discoveries WHERE tenant_id=$1 AND provider_account_id=$2 AND source_id=$3
      AND coverage_scope='ARE_GIFT_CARD'`, [...account, productId]);
  assert.equal(target?.sourceId, productId);
  const input = { provider: 'FINXPLOR', country: 'ARE', productType: 'Gift cards', limit: 20, excludeRegion: false,
    reverse: false, sortByName: true };
  const first = await readLocalDiscoveryPage(client, tenantId, input);
  assert.equal(first.discoveryPage.count, current.scoped);
  assert.equal(first.discoveries.length, 20);
  const next = await readLocalDiscoveryPage(client, tenantId, { ...input, anchor: first.discoveries.at(-1).id });
  assert.equal(next.discoveries.some(row => first.discoveries.some(a => a.id === row.id)), false);
  const previous = await readLocalDiscoveryPage(client, tenantId, { ...input, anchor: next.discoveries[0].id, reverse: true });
  assert.deepEqual(previous.discoveries.map(row => row.id), first.discoveries.map(row => row.id));
  const searched = await readLocalDiscoveryPage(client, tenantId, { ...input, search: productId });
  assert.equal(searched.discoveries.some(row => row.sourceId === productId), true);
  await client.query("SELECT set_config('nukhabapay.tenant_id',$1,true)", [randomUUID()]);
  const denied = await readLocalDiscoveryPage(client, tenantId, input);
  assert.equal(denied.discoveryPage.count, 0);
  assert.equal(denied.discoveries.length, 0);
  return { result: 'SCOPED_COVERAGE_VERIFIED', scope: 'ARE_GIFT_CARD', scan, current, legacy, target, access,
    pagination: { forward: true, reverse: true, skuSearch: true, crossTenantDenied: true,
      pageSize: input.limit, total: first.discoveryPage.count } };
}
