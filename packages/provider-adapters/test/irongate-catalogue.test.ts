import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import test from 'node:test';
import { IronGateCatalogue, qualifyIronGateCatalogueRead, type IronGateCatalogueOptions } from '../src/index.ts';

const account = { tenantId: '00000000-0000-4000-8000-000000000001', providerAccountId: '00000000-0000-4000-8000-000000000002' };
const other = '00000000-0000-4000-8000-000000000003';
const origin = 'https://irongate-catalogue.fixture.invalid';
const fixtureSuccess = 'fixture-ok';
const fixtureCredentials = { username: 'example-account', apiKey: 'synthetic-not-a-provider-key' };
const options: IronGateCatalogueOptions = {
  account, baseUrl: origin, prepaidCurrency: 'IDR', domesticEsimOperator: 'test-operator',
  successCodes: { prepaid: fixtureSuccess, postpaid: fixtureSuccess, games: fixtureSuccess,
    esimIndonesia: fixtureSuccess, esimInternational: fixtureSuccess },
  getCredentials: async () => fixtureCredentials,
};

const replies = new Map([
  ['/api/pricelist', `{ "data": {"rc":"${fixtureSuccess}","pricelist":[{"product_code":"SKU-1","product_description":"Prepaid pack", "product_nominal":"10000", "product_price":9007199254740993.01, "currency":"IDR", "product_type":"data", "product_category":"mobile", "status":"active", "active_period":"30 days", "icon_url":"drop.me"}]}}`],
  ['/api/v1/bill/check', `{ "data": {"rc":"${fixtureSuccess}","pasca":[{"code":"BILL-1","name":"Example Biller","status":1,"fee":100.0500,"komisi":0.004,"type":"utilities","category":"energy"}]}}`],
  ['/api/gamelist', JSON.stringify({ data: { rc: fixtureSuccess, gamelist: [{ game_code: 19, name: 'Game' }] } })],
  ['/api/esimlist/test-operator', JSON.stringify({ data: { rc: fixtureSuccess, esimlist: [{ number: 'synthetic-unassigned-inventory' }] } })],
  ['/api/esiminternationallist', JSON.stringify({ data: { rc: fixtureSuccess, status: 1, list: [{ name: 'Regional', slug: 'region', type: 'regional',
    icon_url: 'drop.me', countries: [{ name: 'Indonesia', code: 'ID', icon_url: 'drop.me' }] }] } })],
]);

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

test('IronGate catalogue pack 1.3 reads use only the five approved POST bodies and paths', async () => {
  const seen = new Map<string, unknown>();
  const server = createServer((request, response) => {
    void requestBody(request).then(body => {
      seen.set(`${request.method} ${request.url}`, body);
      const reply = replies.get(request.url ?? '');
      response.writeHead(reply ? 200 : 404, { 'content-type': 'application/json' }).end(reply ?? '{}');
    }).catch(() => response.writeHead(400).end());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const client = new IronGateCatalogue({ ...options, fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, origin);
      assert.equal(url.search, '');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.credentials, 'omit');
      const response = await fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
      return new Response(response.body, response);
    } });
    const [prepaid, postpaid, games, esimId, esimWorld] = await Promise.all([
      client.listPrepaidPrices(account), client.listPostpaidPrices(account), client.listGameCodes(account),
      client.getIndonesiaEsimAvailability(account), client.listInternationalEsimCoverage(account),
    ]);
    assert.deepEqual(prepaid.account, account);
    assert.equal(prepaid.data[0]?.sourcePrice, '9007199254740993.01');
    assert.equal(prepaid.data[0]?.currency, 'IDR');
    assert.ok(Object.isFrozen(prepaid.data[0]));
    assert.equal(postpaid.data[0]?.sourceFee, '100.0500');
    assert.equal(postpaid.data[0]?.sourceCommission, '0.004');
    assert.deepEqual(games.data, [{ sourceId: '19', name: 'Game' }]);
    assert.deepEqual(esimId.data, { operator: 'test-operator', country: 'ID', observedCount: 1 });
    assert.deepEqual(esimWorld.data[0]?.countries, [{ name: 'Indonesia', sourceCode: 'ID' }]);
    assert.equal(JSON.stringify([prepaid, postpaid, games, esimId, esimWorld]).includes('drop.me'), false);
    assert.equal(seen.size, 5);
    for (const [path, suffix, extra] of [
      ['/api/pricelist', 'pl', { currency: 'IDR' }], ['/api/v1/bill/check', 'pl', { commands: 'pricelist-pasca' }],
      ['/api/gamelist', 'gc', {}], ['/api/esimlist/test-operator', 'esim', {}], ['/api/esiminternationallist', 'esim-inter', {}],
    ] as const) {
      const sign = createHash('md5').update(fixtureCredentials.username + fixtureCredentials.apiKey + suffix).digest('hex');
      assert.deepEqual(seen.get(`POST ${path}`), { ...extra, username: fixtureCredentials.username, sign });
    }
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});

test('IronGate denies foreign accounts, disabled reads and untrusted origin or path configuration', async () => {
  let resolves = 0;
  const client = new IronGateCatalogue({ ...options, successCodes: { games: fixtureSuccess },
    getCredentials: async () => { resolves++; return fixtureCredentials; } });
  await assert.rejects(client.listGameCodes({ ...account, tenantId: other }), { code: 'SCOPE_DENIED' });
  await assert.rejects(client.listGameCodes({ ...account, providerAccountId: other }), { code: 'SCOPE_DENIED' });
  await assert.rejects(client.listPrepaidPrices(account), { code: 'SCOPE_DENIED' });
  await assert.rejects(client.listGameCodes(account, AbortSignal.abort()), { code: 'UNAVAILABLE' });
  assert.equal(resolves, 0);
  for (const baseUrl of ['http://example.invalid', `${origin}/api`, `${origin}?test=true`]) {
    assert.throws(() => new IronGateCatalogue({ ...options, baseUrl }), { code: 'INVALID_CONFIGURATION' });
  }
  assert.throws(() => new IronGateCatalogue({ ...options, domesticEsimOperator: '../top-up' }), { code: 'INVALID_CONFIGURATION' });
});

test('IronGate rejects wrong success code, currency, repeated IDs and nonnumeric prices without a retry', async () => {
  const good = replies.get('/api/pricelist')!;
  let requests = 0, body = good, status = 200;
  const client = new IronGateCatalogue({ ...options, fetch: async () => {
    requests++;
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  } });
  for (const [bad, code] of [
    [good.replace(fixtureSuccess, 'denied'), 'UNAVAILABLE'],
    [good.replace('"IDR"', '"USD"'), 'INVALID_RESPONSE'],
    [good.replace('9007199254740993.01', '"1000.0"'), 'INVALID_RESPONSE'],
    [good.replace(/\[(\{.*\})\]/, '[$1,$1]'), 'INVALID_RESPONSE'],
  ]) {
    body = bad!;
    await assert.rejects(client.listPrepaidPrices(account), { code });
  }
  status = 503;
  await assert.rejects(client.listPrepaidPrices(account), { code: 'UNAVAILABLE' });
  assert.equal(requests, 5);
});

test('IronGate game metadata requires success status and typed fields, ignores extra fields and rejects duplicate server IDs', async () => {
  let response: Record<string, unknown> = {};
  const client = new IronGateCatalogue({ ...options, gameCode: '0067', successCodes: { gameFormat: fixtureSuccess, gameServers: fixtureSuccess },
    fetch: async () => Response.json({ data: { rc: fixtureSuccess, status: 1, message: 'Fixture', ...response } }) });
  await assert.rejects(client.getGameFormat({ ...account, tenantId: other }), { code: 'SCOPE_DENIED' });
  response = { formatGameId: 'ID then server', rawVendorText: 'ignored' };
  assert.deepEqual((await client.getGameFormat(account)).data, { format: 'ID then server' });
  response = { status: 2, formatGameId: 'ID then server' };
  await assert.rejects(client.getGameFormat(account), { code: 'UNAVAILABLE' });
  response = { formatGameId: 12 };
  await assert.rejects(client.getGameFormat(account), { code: 'INVALID_RESPONSE' });
  const server = { name: 'First', value: '001' };
  response = { servers: [server, { name: 'Duplicate', value: '001' }] };
  await assert.rejects(client.listGameServers(account), { code: 'INVALID_RESPONSE' });
  response = { servers: [{ ...server, url: 'discarded' }] };
  assert.deepEqual((await client.listGameServers(account)).data, [server]);
});

test('IronGate game metadata denies a changed game code before credentials or transport', async () => {
  const config = { account, baseUrl: origin, gameCode: '0067', successCodes: { gameFormat: fixtureSuccess } };
  const result = await qualifyIronGateCatalogueRead('gameFormat', config, {
    ...account, environment: 'SANDBOX', provider: 'IRONGATE', origin, credentialReference: 'fixture/game',
    method: 'POST', path: '/api/game/format', requestBudget: 1, contract: 'irongate/prepaid-v2+postpaid/catalogue',
    gameCode: '0068', successCode: fixtureSuccess,
  }, async () => assert.fail('Unexpected credential access'), async () => assert.fail('Unexpected transport'));
  assert.deepEqual(result, { outcome: 'SCOPE_DENIED', requests: 0 });
});
