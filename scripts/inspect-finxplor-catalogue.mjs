import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { FinxplorCatalogue, finxplorExactFields, normalizeFinxplorProduct } from '../packages/provider-adapters/src/finxplor-catalogue.ts';
import { readCatalogueJson, readProviderBytes, wireNumber } from '../packages/provider-adapters/src/catalogue-http.ts';

export async function inspectFinxplorDatabase(client, { tenantId, providerAccountId }, productId) {
  const scope = [tenantId, providerAccountId, productId];
  const { rows: scans } = await client.query(`WITH recent AS (
      SELECT id, completed_at FROM nukhabapay.catalogue_discovery_scans
      WHERE tenant_id=$1 AND provider_account_id=$2 ORDER BY completed_at DESC,id DESC LIMIT 5
    ) SELECT s.completed_at AS "completedAt", count(d.id)::int AS products,
      array_agg(d.source_id) FILTER (WHERE d.source_id IS NOT NULL) AS "sourceIds",
      count(DISTINCT d.source_id)::int AS "distinctProductIds",
      count(d.id) FILTER (WHERE d.source_country IN ('ARE','AE'))::int AS uae,
      count(d.id) FILTER (WHERE d.source_country IN ('ARE','AE') AND d.currency='AED')::int AS "uaeAed",
      count(d.id) FILTER (WHERE d.currency='AED')::int AS aed,
      count(d.id) FILTER (WHERE d.source_id=$3)::int AS "targetOccurrences"
    FROM recent s
    LEFT JOIN nukhabapay.catalogue_discovery_scan_items i ON (i.tenant_id,i.provider_account_id,i.scan_id)=($1,$2,s.id)
    LEFT JOIN nukhabapay.catalogue_discoveries d
      ON (d.tenant_id,d.provider_account_id,d.id)=(i.tenant_id,i.provider_account_id,i.discovery_id)
    GROUP BY s.id,s.completed_at ORDER BY s.completed_at DESC,s.id DESC`, scope);
  const { rows: [history] } = await client.query(`
    SELECT count(*) FILTER (WHERE source_id=$3)::int AS "targetObservations",
      count(DISTINCT source_id) FILTER (WHERE source_country='ARE')::int AS "areProductIds",
      count(DISTINCT source_id) FILTER (WHERE source_country='AE')::int AS "aeProductIds",
      count(DISTINCT source_id)::int AS "allProductIds"
    FROM nukhabapay.catalogue_discoveries
    WHERE tenant_id=$1 AND provider_account_id=$2`, scope);
  const { rows: [connection] } = await client.query(`
    SELECT current_setting('transaction_read_only')='on' AS "readOnly",
      row_security_active('nukhabapay.catalogue_discovery_scans') AND
      row_security_active('nukhabapay.catalogue_discovery_scan_items') AS "scanIsolation"`);
  if (!connection?.readOnly || !connection.scanIsolation) throw new Error('Catalogue inspection is outside its read scope');
  return {
    latestProductSetDigest: scans[0] && productSetDigest(scans[0].sourceIds ?? []),
    scans: scans.map(({ sourceIds, ...summary }) => summary),
    history,
  };
}

const productSetDigest = ids => createHash('sha256').update(JSON.stringify([...new Set(ids)].sort())).digest('hex');
const asInteger = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const asCode = value => typeof value === 'string' && /^[A-Z]{2,3}$/.test(value) ? value : undefined;
const asLabel = value => typeof value === 'string' && /^[a-zA-Z0-9_ &-]{1,80}$/.test(value) ? value : undefined;
function asAmount(value) {
  const amount = typeof value === 'string' ? value : wireNumber(value);
  return amount && /^(?:0|[1-9]\d{0,23})(?:\.\d{1,18})?$/.test(amount) ? amount : undefined;
}

function targetFields(product, apiKey) {
  if (!product) return undefined;
  const safeLabel = value => typeof value === 'string' && !value.includes(apiKey) ? asLabel(value) : undefined;
  return {
    countryCode: asCode(product.countryCode), currency: asCode(product.currency),
    category: safeLabel(product.category), usage: safeLabel(product.usage) ?? safeLabel(product.usageType),
    denominations: Array.isArray(product.denominations) ? product.denominations.slice(0, 128).map(asAmount) : undefined,
    minAmount: asAmount(product.minAmount), maxAmount: asAmount(product.maxAmount),
  };
}

export async function inspectFinxplorFeed({ origin, account, reference, productId, apiKey }) {
  if (origin !== 'https://sandbox.finxplorconnect.com' || typeof apiKey !== 'string' ||
      !/^[!-~]{12,1024}$/.test(apiKey) || apiKey.includes('*')) throw new Error('Invalid Finxplor inspection scope');
  const deadline = AbortSignal.timeout(140_000);
  const unreachable = () => new Error('Finxplor inspection response unavailable');
  let lastReadAt = 0;
  let rateLimited = false;
  async function read(pathname, params) {
    if (rateLimited || deadline.aborted) return { responseUnavailable: true };
    const url = new URL(pathname, origin);
    if (params) url.search = new URLSearchParams(params).toString();
    let status;
    try {
      const delay = lastReadAt + 1_250 - Date.now();
      if (delay > 0) await sleep(delay, undefined, { signal: deadline });
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(12_000)]);
      lastReadAt = Date.now();
      const response = await fetch(url.href, { method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit',
        headers: { Accept: 'application/json', 'x-api-key': apiKey }, signal });
      status = response.status;
      if (status === 429) rateLimited = true;
      if (status !== 200 || response.redirected || response.url !== url.href) {
        void response.body?.cancel().catch(() => undefined);
        return { status };
      }
      const contentType = response.headers.get('content-type');
      const bytes = await readProviderBytes(response, signal, 'application/json', unreachable);
      const replay = () => new Response(bytes, { headers: { 'content-type': contentType } });
      const body = await readCatalogueJson(replay(), signal, finxplorExactFields, unreachable);
      const adapter = new FinxplorCatalogue({ account, credentialReference: reference, getApiKey: async () => apiKey,
        transport: async () => replay() });
      return { status, body, adapter };
    } catch {
      return { status, responseUnavailable: true };
    }
  }

  const detailRead = await read('/api/v1/products/' + encodeURIComponent(productId));
  const detailProduct = detailRead.body?.data?.product;
  const acceptedDetail = await detailRead.adapter?.detail(account, productId, deadline).catch(() => undefined);
  const detail = { status: detailRead.status, responseUnavailable: detailRead.responseUnavailable,
    targetInResponse: detailProduct?.productId === productId, adapterAccepted: Boolean(acceptedDetail),
    raw: detailProduct?.productId === productId ? targetFields(detailProduct, apiKey) : undefined,
    normalizedDenominations: acceptedDetail?.denominations };

  async function listing({ country, category, limit = 100, maxPages = 10, probeSecondPage = false,
    walkPastReportedEnd = false, firstPageProductSet = false } = {}) {
    const pages = [], ids = new Set();
    let duplicates = 0, uaeAed = 0, aed = 0, returnedAre = 0, returnedAe = 0, giftCards = 0;
    let firstTarget, totalPages, firstPageProductSetDigest;
    for (let page = 1; page <= maxPages; page++) {
      if (deadline.aborted) break;
      const filter = { country, category };
      const result = await read('/api/v1/products', { page, limit, ...(country && { country }),
        ...(category && { category }) });
      const { body, status } = result;
      const validList = body?.success === true && Array.isArray(body.data);
      const rows = validList ? body.data : [];
      const metadata = body?.pagination;
      const target = rows.find(row => row?.productId === productId);
      if (target && !firstTarget) firstTarget = { page, ...targetFields(target, apiKey) };
      let rejectedRows = 0;
      for (const row of rows) {
        try { normalizeFinxplorProduct(row); }
        catch { rejectedRows++; }
        if (typeof row?.productId !== 'string') continue;
        if (ids.has(row.productId)) duplicates++;
        ids.add(row.productId);
        if (row.countryCode === 'ARE') returnedAre++;
        if (row.countryCode === 'AE') returnedAe++;
        if (row.currency === 'AED') {
          aed++;
          if (row.countryCode === 'ARE' || row.countryCode === 'AE') uaeAed++;
        }
        if (typeof row.category === 'string' && /^gift[ _-]?cards?$/i.test(row.category.trim())) giftCards++;
      }
      if (firstPageProductSet && page === 1 && validList) firstPageProductSetDigest = productSetDigest(ids);
      const adapterPage = await result.adapter?.page(account, page, limit, deadline, filter).catch(() => undefined);
      pages.push({ page, status, responseUnavailable: result.responseUnavailable, validList, count: rows.length, rejectedRows,
        reportedPage: asInteger(metadata?.page), reportedLimit: asInteger(metadata?.limit),
        total: asInteger(metadata?.total), totalPages: asInteger(metadata?.totalPages),
        hasNextPage: typeof metadata?.hasNextPage === 'boolean' ? metadata.hasNextPage : undefined,
        adapterAccepted: Boolean(adapterPage) });
      if (page === 1) totalPages = asInteger(metadata?.totalPages);
      if (!metadata || status !== 200 || !validList) break;
      if (walkPastReportedEnd) {
        if (rows.length === 0 || duplicates !== 0 || asInteger(metadata.page) !== page || asInteger(metadata.limit) !== limit) break;
      } else if ((!totalPages || page >= totalPages) && !(probeSecondPage && page === 1)) break;
    }
    const reportedTotal = pages[0]?.total;
    const matchesReportedPagination = reportedTotal !== undefined && ids.size === reportedTotal && duplicates === 0 &&
      pages.length === Math.max(1, totalPages ?? 0) &&
      pages.every(page => page.adapterAccepted && page.total === reportedTotal && page.totalPages === totalPages);
    const last = pages.at(-1);
    const reachedEmptyPage = walkPastReportedEnd && last?.status === 200 && last.reportedPage === last.page &&
      last.reportedLimit === limit && last.validList && last.count === 0 && last.hasNextPage === false && duplicates === 0;
    return { country: country ?? null, category, limit, matchesReportedPagination, reachedEmptyPage,
      uniqueProductIds: ids.size, duplicates, returnedAre, returnedAe, aed, uaeAed, giftCards, target: firstTarget ?? null,
      firstPageProductSetDigest, pages };
  }

  const unfiltered = await listing({ firstPageProductSet: true });
  const isoAlpha3 = deadline.aborted ? undefined : await listing({ country: 'ARE' });
  const isoAlpha2 = deadline.aborted ? undefined : await listing({ country: 'AE' });
  const pagination = deadline.aborted ? undefined : {
    unfiltered: await listing({ limit: 20, maxPages: 6, probeSecondPage: true }),
    are: await listing({ country: 'ARE', limit: 20, maxPages: 6, probeSecondPage: true }),
    areGiftCard: await listing({ country: 'ARE', category: 'Gift Card', maxPages: 2 }),
    areGiftCards: await listing({ country: 'ARE', category: 'Gift Cards', maxPages: 2 }),
  };
  const diagnosticWalks = deadline.aborted ? undefined : {
    areGiftCard: await listing({ country: 'ARE', category: 'Gift Card', maxPages: 15, walkPastReportedEnd: true }),
    unfiltered: await listing({ maxPages: 12, walkPastReportedEnd: true }),
  };
  return { origin, productId, detail, unfiltered, isoAlpha3, isoAlpha2, pagination, diagnosticWalks };
}
