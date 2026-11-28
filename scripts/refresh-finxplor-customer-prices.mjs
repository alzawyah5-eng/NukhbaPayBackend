import { lstat, readFile } from 'node:fs/promises';
import { readCurrencyApiAedRates } from '../packages/provider-adapters/src/currency-api-aed-rates.ts';

const slotMs = 12 * 60 * 60 * 1000;
const dubaiOffset = 4 * 60 * 60 * 1000;
const exactPrice = /^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,8})?$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const priceSlot = now => new Date(Math.floor((now + dubaiOffset) / slotMs) * slotMs - dubaiOffset).toISOString();

async function readReviewedPrices(account) {
  const url = new URL('../.local/finxplor-customer-prices.json', import.meta.url);
  const info = await lstat(url).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink() || info.size > 524288) throw new Error('Invalid reviewed price file');
  const feed = JSON.parse((await readFile(url,'utf8')).replace(/^\uFEFF/,''));
  if (feed.version !== 1 || feed.tenantId !== account.tenantId || feed.providerAccountId !== account.providerAccountId ||
      !Array.isArray(feed.prices) || feed.prices.length > 1000) throw new Error('Reviewed price scope or batch invalid');
  const seen = new Set();
  return feed.prices.map(row => {
    const key = row?.discoveryId + ':' + row?.priceKey;
    const observed = Date.parse(row?.observedAt), expires = Date.parse(row?.validUntil);
    if (!uuid.test(row?.discoveryId ?? '') || !identifier.test(row?.sourceId ?? '') ||
        !identifier.test(row?.priceKey ?? '') || !identifier.test(row?.sourceReference ?? '') ||
        !/^[A-Z]{3}$/.test(row?.currency ?? '') || typeof row?.amount !== 'string' || !exactPrice.test(row.amount) ||
        !/[1-9]/.test(row.amount) || !Number.isFinite(observed) || !Number.isFinite(expires) ||
        observed > Date.now() || expires <= observed || seen.has(key)) throw new Error('Invalid reviewed customer price');
    seen.add(key);
    return { discovery_id:row.discoveryId,source_id:row.sourceId,source_key:row.priceKey,source_reference:row.sourceReference,
      currency:row.currency,amount:row.amount,observed_at:new Date(observed).toISOString(),valid_until:new Date(expires).toISOString() };
  });
}

const sourceRows = `
WITH current AS MATERIALIZED (
  SELECT * FROM nukhabapay.observed_catalogue_discoveries
  WHERE tenant_id=$1 AND provider_account_id=$2
), catalogue_rows AS (
  SELECT d.id AS discovery_id,'DENOMINATION' AS basis,
    'denomination:'||x.amount AS source_key,d.source_id AS source_reference,d.currency::text AS currency,
    x.amount,d.observed_at,NULL::timestamptz AS valid_until
  FROM current d CROSS JOIN LATERAL (SELECT DISTINCT value AS amount
    FROM jsonb_array_elements_text(d.denominations) AS a(value)) x
  UNION ALL
  SELECT d.id, bounds.basis,lower(bounds.basis),d.source_id,d.currency::text,bounds.amount,d.observed_at,NULL
  FROM current d CROSS JOIN LATERAL (VALUES ('FACE_MIN',d.min_amount),('FACE_MAX',d.max_amount)) bounds(basis,amount)
  WHERE jsonb_array_length(d.denominations)=0 AND (bounds.basis='FACE_MIN' OR d.min_amount<>d.max_amount)
), reviewed AS (
  SELECT d.id,'CUSTOMER_PRICE',r.source_key,r.source_reference,r.currency,r.amount,r.observed_at,r.valid_until
  FROM jsonb_to_recordset($3::jsonb) AS r(discovery_id uuid,source_id text,source_key text,source_reference text,currency text,
    amount text,observed_at timestamptz,valid_until timestamptz)
  JOIN current d ON d.id=r.discovery_id AND d.source_id=r.source_id
  WHERE r.valid_until>transaction_timestamp()
), source AS MATERIALIZED (
  SELECT discovery_id,basis,source_key,source_reference,currency,amount::numeric AS amount,observed_at,valid_until
  FROM (SELECT * FROM catalogue_rows UNION ALL SELECT * FROM reviewed) raw
  WHERE CASE WHEN amount ~ '^(0|[1-9][0-9]{0,14})([.][0-9]{1,8})?$' THEN amount::numeric>0 ELSE false END
)
`;

export async function refreshFinxplorPrices(client, account, apiKey, {
  loadReviewed = readReviewedPrices, getRates = readCurrencyApiAedRates, manual = false,
} = {}) {
  if (manual && !apiKey) return {result:'FX_NOT_CONFIGURED'};
  const scope = [account.tenantId,account.providerAccountId];
  const setScope = () => client.query("SELECT set_config('nukhabapay.tenant_id',$1,true),set_config('nukhabapay.finxplor_price_account',$2,true)",scope);
  const {rows:[lock]} = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',
    ['finxplor-customer-prices:'+scope.join(':')]);
  if (!lock?.acquired) return {result:'ALREADY_RUNNING'};
  try {
    const slot = priceSlot(Date.now());
    const reviewed = JSON.stringify(await loadReviewed(account));
    const args = [...scope,reviewed,slot];
    await client.query('BEGIN READ ONLY');
    await setScope();
    const {rows:needed} = await client.query(sourceRows+`
      SELECT DISTINCT s.currency FROM source s WHERE s.currency<>'AED' AND ($5::boolean OR NOT EXISTS (
        SELECT FROM nukhabapay.finxplor_customer_fx_rates x WHERE (x.tenant_id,x.provider_account_id,x.source_currency,x.slot_at)=
          ($1,$2,s.currency,$4::timestamptz) AND x.refresh_kind='SCHEDULED' AND x.rate_source='CURRENCY_API')) ORDER BY s.currency LIMIT 251`,[...args,manual]);
    await client.query('COMMIT');
    if (needed.length > 250) throw new Error('Currency scope exceeds the ISO code batch limit');
    const currencies = needed.map(({currency})=>currency);
    let rates = [];
    if (apiKey && currencies.length) {
      const received = await getRates(currencies,apiKey).catch(()=>[]);
      rates = received.filter(rate=>priceSlot(Date.parse(rate.retrievedAt))===slot);
    }
    const failedCurrencies = apiKey ? currencies.length-rates.length : 0;
    if (priceSlot(Date.now()) !== slot) throw new Error('Refresh crossed the FX cycle boundary');
    await client.query('BEGIN');
    await setScope();
    const inserted = await client.query(`INSERT INTO nukhabapay.finxplor_customer_fx_rates
      (tenant_id,provider_account_id,slot_at,source_currency,aed_per_unit,source_effective_at,retrieved_at,refresh_kind,rate_source,usd_aed_rate,usd_source_rate)
      SELECT $1,$2,$3,currency,"aedPerUnit"::numeric,"effectiveAt","retrievedAt",$5,
        'CURRENCY_API',"usdAedRate"::numeric,"usdSourceRate"::numeric
      FROM jsonb_to_recordset($4::jsonb) AS x(currency text,"aedPerUnit" text,"effectiveAt" timestamptz,"retrievedAt" timestamptz,
        "usdAedRate" text,"usdSourceRate" text)
      ON CONFLICT DO NOTHING`,[...scope,slot,JSON.stringify(rates),manual ? 'MANUAL' : 'SCHEDULED']);
    await client.query(sourceRows+`
      INSERT INTO nukhabapay.finxplor_layer1_customer_prices AS saved
      (tenant_id,provider_account_id,discovery_id,basis,source_key,source_reference,source_currency,
       source_amount,price_observed_at,price_valid_until,converted_aed,fx_slot_at,fx_retrieved_at)
      SELECT $1,$2,s.discovery_id,s.basis,s.source_key,s.source_reference,s.currency,s.amount,s.observed_at,s.valid_until,
        CASE WHEN s.currency='AED' THEN s.amount ELSE s.amount*x.aed_per_unit END,x.slot_at,x.retrieved_at
      FROM source s LEFT JOIN LATERAL (
        SELECT r.aed_per_unit,r.slot_at,r.retrieved_at FROM nukhabapay.finxplor_customer_fx_rates r
        WHERE (r.tenant_id,r.provider_account_id,r.source_currency,r.slot_at)=($1,$2,s.currency,$4::timestamptz)
          AND r.rate_source='CURRENCY_API'
        ORDER BY r.retrieved_at DESC LIMIT 1
      ) x ON true
      ON CONFLICT (tenant_id,provider_account_id,discovery_id,basis,source_key) DO UPDATE SET
        source_reference=excluded.source_reference,source_currency=excluded.source_currency,
        source_amount=excluded.source_amount,price_observed_at=excluded.price_observed_at,
        price_valid_until=excluded.price_valid_until,converted_aed=excluded.converted_aed,
        fx_slot_at=excluded.fx_slot_at,fx_retrieved_at=excluded.fx_retrieved_at
      WHERE excluded.price_observed_at>=saved.price_observed_at`,args);
    const {rows:[counts]} = await client.query(`SELECT count(*)::int AS rows,
      count(*) FILTER(WHERE c.basis='CUSTOMER_PRICE')::int AS customer_prices,
      count(*) FILTER(WHERE c.source_currency='AED')::int AS aed_identity,
      count(*) FILTER(WHERE c.fx_slot_at=$3)::int AS fx_converted,
      count(*) FILTER(WHERE c.source_currency<>'AED' AND c.fx_slot_at IS DISTINCT FROM $3::timestamptz)::int AS awaiting_fx,
      count(*) FILTER(WHERE c.acquisition_cost_aed IS NOT NULL)::int AS filled_acquisition_costs
      FROM nukhabapay.finxplor_layer1_customer_prices c JOIN nukhabapay.observed_catalogue_discoveries d
        ON (d.tenant_id,d.provider_account_id,d.id)=(c.tenant_id,c.provider_account_id,c.discovery_id)
      WHERE c.tenant_id=$1 AND c.provider_account_id=$2
        AND (c.price_valid_until IS NULL OR c.price_valid_until>transaction_timestamp())`,[...scope,slot]);
    if ((await client.query('COMMIT')).command !== 'COMMIT') throw new Error('Price storage commit unconfirmed');
    return {result:'STORED',slot,currencyApiConfigured:Boolean(apiKey),rateRows:inserted.rowCount,failedCurrencies, ...counts};
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>undefined);
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['finxplor-customer-prices:'+scope.join(':')]).catch(()=>undefined);
  }
}
