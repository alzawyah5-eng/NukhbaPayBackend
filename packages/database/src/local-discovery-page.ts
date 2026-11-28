import type { PoolClient } from 'pg';
import type { StaffCatalogueSnapshot, StaffDiscoveryPageRequest } from '@nukhbapay/application';

const discoveryType = `CASE lower(btrim(d.category))
  WHEN 'gift card' THEN 'Gift cards' WHEN 'gift cards' THEN 'Gift cards' WHEN 'giftcard' THEN 'Gift cards'
  WHEN 'mobile & telecom' THEN 'Mobile recharge' WHEN 'mobile recharge' THEN 'Mobile recharge'
  WHEN 'mobile top-up' THEN 'Mobile recharge' WHEN 'mobile top up' THEN 'Mobile recharge'
  ELSE d.category END`;
const source = `FROM nukhabapay.observed_catalogue_discoveries d
  JOIN nukhabapay.provider_accounts a ON (a.tenant_id,a.id)=(d.tenant_id,d.provider_account_id)
  WHERE d.tenant_id=$1 AND ($2::text IS NULL OR a.provider_code=$2)`;
const filter = `AND ($3::text IS NULL OR d.source_country=$3)
  AND ($4::text[] IS NULL OR (d.source_country::text=ANY($4))<>$5::boolean)
  AND ($6::text IS NULL OR (${discoveryType})=$6)
  AND ($7::text IS NULL OR ($7='finxplore' AND a.provider_code='FINXPLOR') OR EXISTS (
    SELECT FROM unnest(ARRAY[d.product_name,d.brand,d.source_id,a.provider_code,d.source_country::text,
      d.currency::text,d.category,d.delivery]) searchable(value)
    WHERE strpos(lower(normalize(searchable.value,NFKC)),$7)>0))
  AND ($8::uuid IS NULL OR d.id=$8)`;
type Discovery = NonNullable<StaffCatalogueSnapshot['discoveries']>[number];

export async function readLocalDiscoveryPage(client: Pick<PoolClient, 'query'>, tenantId: string, request: StaffDiscoveryPageRequest) {
  const scope = [tenantId, request.provider ?? null];
  const filtered = [...scope, request.country ?? null, request.region ?? null, request.excludeRegion,
    request.productType ?? null, request.search ?? null, request.discoveryId ?? null];
  const revision = await client.query<{ value: string }>(`SELECT concat_ws('|',
    (SELECT max(completed_at)::text FROM nukhabapay.catalogue_discovery_scans WHERE tenant_id=$1),
    (SELECT max(confirmed_at)::text FROM nukhabapay.catalogue_discovery_confirmations WHERE tenant_id=$1),
    (SELECT max(observed_at)::text FROM nukhabapay.catalogue_discoveries WHERE tenant_id=$1)) AS value`, [tenantId]);
  const { rows: [facets] } = await client.query<{ countries: string[]; types: string[]; partial: boolean }>(`SELECT
    array_agg(DISTINCT d.source_country::text) AS countries,
    array_agg(DISTINCT ${discoveryType}) AS types,
    bool_or(d.coverage_scope='PARTIAL_ALL_COUNTRIES') AS partial ${source}`, scope);
  const { rows: [count] } = await client.query<{ count: string }>(`SELECT count(*)::text AS count ${source} ${filter}`, filtered);
  const order = request.reverse ? 'DESC' : 'ASC';
  const comparison = request.reverse ? '<' : '>';
  const name = 'lower(normalize(d.product_name,NFKC)) COLLATE "C"';
  const anchor = request.sortByName
    ? `(${name},d.id)${comparison}(SELECT lower(normalize(k.product_name,NFKC)) COLLATE "C",k.id
      FROM nukhabapay.catalogue_discoveries k WHERE k.tenant_id=$1 AND k.id=$9)`
    : `d.id${comparison}$9`;
  const { rows } = await client.query<Discovery>(`SELECT d.id,a.provider_code AS "providerId",d.source_id AS "sourceId",
    d.product_name AS name,d.brand,d.source_country AS "sourceCountry",d.currency,d.category,d.delivery,
    to_char(d.last_verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt",
    d.denominations,d.min_amount AS "minAmount",d.max_amount AS "maxAmount",d.review_reason AS "reviewReason",
    d.coverage_scope AS "coverageScope",
    (SELECT artwork.image_url FROM nukhabapay.finxplor_catalogue_artwork artwork
      WHERE (artwork.tenant_id,artwork.provider_account_id,artwork.discovery_id)=(d.tenant_id,d.provider_account_id,d.id)) AS "imageUrl",
    (SELECT m.status FROM nukhabapay.staff_discovery_mapping_status m
      WHERE (m.tenant_id,m.provider_account_id,m.discovery_id)=(d.tenant_id,d.provider_account_id,d.id)) AS "mappingStatus"
    ${source} ${filter} AND ($9::uuid IS NULL OR ${anchor})
    ORDER BY ${request.sortByName ? name + ' ' + order + ',' : ''} d.id ${order} LIMIT $10`,
  [...filtered, request.anchor ?? null, request.limit + 1]);
  const page = rows.slice(0, request.limit);
  return { discoveries: request.reverse ? page.reverse() : page, discoveryPage: {
    count: Number(count?.count), countries: facets?.countries ?? [], types: facets?.types ?? [],
    partial: facets?.partial===true, more: rows.length > request.limit,
  }, revisionSeed: revision.rows[0]?.value };
}
