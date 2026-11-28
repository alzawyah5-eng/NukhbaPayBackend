import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FinxplorCatalogue } from '../../packages/provider-adapters/src/finxplor-catalogue.ts';

// Replay authorized provider bytes in memory. Only protocol fields and ordering
// change in the failure cases. This transport has no network or database access.
export async function qualifyFinxplorPagination(account, credentialReference, pages, verified) {
  const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const parse = page => JSON.parse(new TextDecoder().decode(pages.get(page)));
  const replay = page => {
    assert.ok(pages.has(page));
    return new Response(pages.get(page), { headers: { 'content-type': 'application/json' } });
  };
  const read = (change, signal) => {
    let attempt = 0;
    const catalogue = new FinxplorCatalogue({ account, credentialReference,
      getApiKey: async () => 'IN_MEMORY_READ_ONLY_PROTOCOL',
      transport: (url, options) => {
        const params = new URL(url).searchParams;
        assert.equal(params.get('country'), 'ARE');
        assert.equal(params.get('category'), 'Gift Card');
        const page = Number(params.get('page'));
        return Promise.resolve(change(page, ++attempt, options) ?? replay(page));
      } });
    return catalogue.scopedCatalogue(account, verified.scope, signal);
  };
  const duplicatePage = page => {
    if (page !== 2) return;
    const body = parse(1);
    body.pagination.page = 2;
    return json(body);
  };
  const duplicateSku = page => {
    if (page !== 1) return;
    const body = parse(1);
    body.data[1] = body.data[0];
    return json(body);
  };
  const prematureEmpty = page => {
    if (page !== 1) return;
    const body = parse(verified.pages);
    body.pagination.page = 1;
    return json(body);
  };
  const incorrectMetadata = page => {
    if (page !== 1) return;
    const body = parse(1);
    body.pagination.total++;
    return json(body);
  };
  const changedSecondPass = (page, attempt) => {
    if (page !== 1 || attempt !== verified.pages+2) return;
    const body = parse(1);
    body.data.reverse();
    return json(body);
  };
  const nonemptyPastTerminal = page => {
    if (page !== verified.pages+1) return;
    const body = parse(1);
    body.pagination.page = page;
    return json(body);
  };
  let retrySucceeded = false;
  const checks = [
    ...[duplicatePage, duplicateSku, prematureEmpty, incorrectMetadata, changedSecondPass, nonemptyPastTerminal]
      .map(change => assert.rejects(read(change))),
    assert.rejects(read(() => new Promise(() => {}), AbortSignal.timeout(60))),
    assert.rejects(read(() => new Response(null, { status: 429, headers: { 'retry-after': '60' } }))),
    (async () => {
      const recovered = await read((_page, attempt) => {
        if (attempt === 1) return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
        if (attempt === 2) retrySucceeded = true;
      });
      assert.ok(retrySucceeded);
      assert.deepEqual(recovered.rows, verified.rows);
      assert.equal(recovered.pages, verified.pages);
    })(),
  ];
  const results = await Promise.allSettled(checks);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return results.length;
}

export async function qualifyPartialFinxplorRollback(client, account, previousScan, coverage, scanDigest) {
  const proposed = randomUUID();
  const scope = [account.tenantId,account.providerAccountId,proposed];
  await client.query('SAVEPOINT live_partial_import');
  try {
    await client.query(`INSERT INTO nukhabapay.catalogue_discovery_scans
      (tenant_id,provider_account_id,id,coverage_scope,page_count,product_count,source_observed_at,scan_digest)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [...scope,coverage.scope,coverage.pages,coverage.rows.length,coverage.observedAt,scanDigest]);
    const staged=await client.query(`INSERT INTO nukhabapay.catalogue_discovery_scan_items
      (tenant_id,provider_account_id,scan_id,discovery_id)
      SELECT $1,$2,$3,discovery_id FROM nukhabapay.catalogue_discovery_scan_items
      WHERE tenant_id=$1 AND provider_account_id=$2 AND scan_id=$4 ORDER BY discovery_id LIMIT $5`,
    [...scope,previousScan,coverage.rows.length-1]);
    assert.equal(staged.rowCount,coverage.rows.length-1);
    await assert.rejects(client.query('SET CONSTRAINTS nukhabapay.local_discovery_coverage_at_commit IMMEDIATE'), { code:'23514' });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT live_partial_import');
    await client.query('RELEASE SAVEPOINT live_partial_import');
  }
  const removed=await client.query('SELECT 1 FROM nukhabapay.catalogue_discovery_scans WHERE tenant_id=$1 AND provider_account_id=$2 AND id=$3',scope);
  assert.equal(removed.rowCount,0);
}
