import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { SslWirelessCatalogue, type SslWirelessCatalogueOptions } from '../src/index.ts';

const account = { tenantId: '00000000-0000-4000-8000-000000000001', providerAccountId: '00000000-0000-4000-8000-000000000002' };
const other = '00000000-0000-4000-8000-000000000003';
const baseUrl = 'https://ssl-catalogue.fixture.invalid';
const fixtureMarker = 'synthetic-catalogue-only';
const options: SslWirelessCatalogueOptions = {
  account, baseUrl, contract: 'mobile-top-up/8.2.0', allowedCategories: ['Mobile Operators'],
  getCredentials: async () => ({ stkCode: fixtureMarker, authKey: fixtureMarker }),
};

const service = (category: string, value: string) => ({ category_name: category, category_value: category,
  category_image: fixtureMarker, data: [{ utility_value: value, utility_code: fixtureMarker,
    data: [{ utility_bill_type: 'Prepaid', biller_status: 'Online', utility_secret_key: fixtureMarker,
      bill_payment: { action_url: fixtureMarker }, bill_info: { auth_key: fixtureMarker } }] }] });
const packages = `{"status":"success","data":{"count":2,"list":[
  {"operator_id":1,"operator_name":"Grameenphone","amount":100.0500,"connection_type":"prepaid","offer_type":"internet","offer_title":"Data"},
  {"operator_id":"6","operator_name":"Airtel","amount":9007199254740993.01,"connection_type":"postpaid","offer_type":"voice","offer_title":"Voice"}
]}}`;

function json(response: ServerResponse, value: unknown, code = 200): void {
  response.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

async function withServer(handler: (request: IncomingMessage, response: ServerResponse) => void,
  work: (fetcher: typeof fetch) => Promise<void>) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const fetcher: typeof fetch = (request, init) => {
      const url = new URL(String(request));
      assert.equal(url.origin, baseUrl);
      assert.equal(url.search, '');
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.body, undefined);
      return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init)
        .then(response => new Response(response.body, response));
    };
    await work(fetcher);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

test('SSL Common API 8.2.0 and 1.6.1 Service List projects only approved metadata', async () => {
  let requests = 0;
  await withServer((request, response) => {
    requests++;
    assert.equal(request.url, '/api/service-list');
    assert.equal(request.headers['stk-code'] === fixtureMarker, true);
    assert.equal(request.headers['auth-key'] === fixtureMarker, true);
    json(response, { status: 'success', data: [service('Mobile Operators', 'Airtel'), service('Utility Service', 'BREB'), service('Insurance Service', 'Other')] });
  }, async fetch => {
    for (const [contract, category, value] of [
      ['mobile-top-up/8.2.0', 'Mobile Operators', 'Airtel'], ['utilities/1.6.1', 'Utility Service', 'BREB'],
    ] as const) {
      const client = new SslWirelessCatalogue({ ...options, contract, allowedCategories: [category], fetch });
      const result = await client.listServices(account);
      assert.equal(result.sourceVersion, contract);
      assert.equal(result.country, 'BD');
      assert.deepEqual(result.account, account);
      assert.deepEqual(result.categories, [{ sourceValue: category, name: category,
        services: [{ sourceValue: value, details: [{ billType: 'Prepaid', status: 'Online' }] }] }]);
      assert.equal(JSON.stringify(result).includes(fixtureMarker), false);
      assert.ok(Object.isFrozen(result.categories[0]?.services[0]?.details));
    }
  });
  assert.equal(requests, 2);
});

test('SSL Mobile Top-Up 8.2.0 Package List keeps upstream IDs and exact wire amounts', async () => {
  await withServer((request, response) => {
    assert.equal(request.url, '/api/vr/package-list');
    response.writeHead(200, { 'content-type': 'application/json' }).end(packages);
  }, async fetch => {
    const client = new SslWirelessCatalogue({ ...options, fetch });
    const result = await client.listTopUpPackages(account);
    assert.equal(result.sourceVersion, 'mobile-top-up/8.2.0');
    assert.deepEqual(result.packages, [
      { operatorId: '1', operatorName: 'Grameenphone', connectionType: 'prepaid', rechargeAmount: '100.0500', offerType: 'internet', offerTitle: 'Data' },
      { operatorId: '6', operatorName: 'Airtel', connectionType: 'postpaid', rechargeAmount: '9007199254740993.01', offerType: 'voice', offerTitle: 'Voice' },
    ]);
    assert.ok(Object.isFrozen(result.packages[0]));
  });
});

test('SSL Mobile Top-Up pins approved operators and sub-channel and rejects non-integer source IDs', async () => {
  let body = packages;
  await withServer((request, response) => {
    assert.equal(request.headers['sub-channel-id'], '007');
    response.writeHead(200, { 'content-type': 'application/json' }).end(body);
  }, async fetch => {
    assert.throws(() => new SslWirelessCatalogue({ ...options, subChannelId: '7\r\n' }), { code: 'INVALID_CONFIGURATION' });
    const client = new SslWirelessCatalogue({ ...options, allowedOperatorIds: ['6'], subChannelId: '007', fetch });
    const result = await client.listTopUpPackages(account);
    assert.equal(result.country, 'BD');
    assert.deepEqual(result.packages.map(item => item.operatorId), ['6']);
    body = packages.replace('"operator_id":1', '"operator_id":1.0000000000000001');
    await assert.rejects(client.listTopUpPackages(account), { code: 'INVALID_RESPONSE' });
  });
});

test('SSL rejects final URL substitution and abandons a stalled response body', async () => {
  const redirected = new Response('{}', { headers: { 'content-type': 'application/json' } });
  Object.defineProperty(redirected, 'url', { value: 'https://unexpected.fixture.invalid/api/service-list' });
  const first = new SslWirelessCatalogue({ ...options, fetch: async () => redirected });
  await assert.rejects(first.listServices(account), { code: 'UNAVAILABLE' });

  let requests = 0;
  const wrongOrigin = new Response('{}', { status: 503 });
  Object.defineProperty(wrongOrigin, 'url', { value: redirected.url });
  const retry = new SslWirelessCatalogue({ ...options, fetch: async () => { requests++; return wrongOrigin; } });
  await assert.rejects(retry.listServices(account), { code: 'UNAVAILABLE' });
  assert.equal(requests, 1);
  assert.equal(wrongOrigin.bodyUsed, true);

  const controller = new AbortController(), entered = Promise.withResolvers<void>();
  const second = new SslWirelessCatalogue({ ...options, fetch: async () => new Response(new ReadableStream<Uint8Array>({
    pull() { entered.resolve(); return new Promise<void>(() => {}); },
  }), { headers: { 'content-type': 'application/json' } }) });
  const result = second.listServices(account, controller.signal);
  await entered.promise;
  controller.abort();
  await assert.rejects(result, { code: 'UNAVAILABLE' });
});

test('SSL discovery denies account, tenant and contract substitutions before resolving credentials', async () => {
  let resolved = 0;
  const getCredentials = async () => { resolved++; return options.getCredentials(account, new AbortController().signal); };
  await withServer((_request, response) => { response.writeHead(500).end(); }, async fetch => {
    const client = new SslWirelessCatalogue({ ...options, fetch, getCredentials, contract: 'utilities/1.6.1' });
    await assert.rejects(client.listServices({ ...account, tenantId: other }), { code: 'SCOPE_DENIED' });
    await assert.rejects(client.listServices({ ...account, providerAccountId: other }), { code: 'SCOPE_DENIED' });
    await assert.rejects(client.listTopUpPackages(account), { code: 'SCOPE_DENIED' });
    await assert.rejects(client.listServices(account, AbortSignal.abort()), { code: 'UNAVAILABLE' });
    assert.throws(() => new SslWirelessCatalogue({ ...options, baseUrl: 'http://127.0.0.1' }), { code: 'INVALID_CONFIGURATION' });
    assert.throws(() => new SslWirelessCatalogue({ ...options, baseUrl: baseUrl + '?route=other' }), { code: 'INVALID_CONFIGURATION' });
  });
  assert.equal(resolved, 0);
});

test('SSL catalogue dismisses late credentials after cancellation without starting transport', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<Awaited<ReturnType<SslWirelessCatalogueOptions['getCredentials']>>>();
  let requests = 0;
  const client = new SslWirelessCatalogue({ ...options,
    getCredentials: async () => { started.resolve(); return pending.promise; },
    fetch: async () => { requests++; return new Response(); },
  });
  const result = client.listServices(account, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(result, { code: 'UNAVAILABLE' });
  pending.resolve({ stkCode: fixtureMarker, authKey: fixtureMarker });
  assert.equal(requests, 0);
});

test('SSL read retries one transient HTTP failure and keeps provider errors out of diagnostics', async () => {
  let requests = 0, status = 503;
  await withServer((_request, response) => {
    requests++;
    if (requests === 2) return json(response, { status: 'success', data: [] });
    json(response, { status: 'error', message: fixtureMarker, data: null }, status);
  }, async fetch => {
    const client = new SslWirelessCatalogue({ ...options, fetch });
    assert.deepEqual((await client.listServices(account)).categories, []);
    assert.equal(requests, 2);
    status = 429;
    await assert.rejects(client.listServices(account), { code: 'UNAVAILABLE', message: 'SSL Wireless catalogue request failed' });
    assert.equal(requests, 3);
    status = 200;
    await assert.rejects(client.listServices(account), { code: 'UNAVAILABLE', message: 'SSL Wireless catalogue request failed' });
    assert.equal(requests, 4);
  });
});

test('SSL catalogue rejects malformed amounts, partial package counts and invalid service metadata', async () => {
  let contentType = 'application/json', body = packages;
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': contentType }).end(body);
  }, async fetch => {
    const client = new SslWirelessCatalogue({ ...options, fetch });
    for (const invalid of ['"100.0500"', '-1', '0', '{}']) {
      body = packages.replace('100.0500', invalid);
      await assert.rejects(client.listTopUpPackages(account), { code: 'INVALID_RESPONSE' });
    }
    body = packages.replace('"count":2', '"count":5');
    await assert.rejects(client.listTopUpPackages(account), { code: 'INVALID_RESPONSE' });
    body = JSON.stringify({ status: 'success', data: [{ category_value: 'Mobile Operators', data: null }] });
    await assert.rejects(client.listServices(account), { code: 'INVALID_RESPONSE' });
    contentType = 'text/html';
    await assert.rejects(client.listServices(account), { code: 'INVALID_RESPONSE' });
  });
});
