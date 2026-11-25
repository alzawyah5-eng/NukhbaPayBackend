import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { checkIronGateCallback, IronGatePostpaid, IronGatePrepaid, type IronGatePostpaidOptions } from '../src/index.ts';
import { providerJsonNumber } from '../src/catalogue-http.ts';

const account = { tenantId: '00000000-0000-4000-8000-000000000001', providerAccountId: '00000000-0000-4000-8000-000000000002' };
const origin = 'https://irongate-transactions.fixture.invalid';
const username = 'fixture-user', apiKey = 'fixture-key';
const success = '00';
const getCredentials = async () => ({ username, apiKey });
const proof = (suffix: string) => ({ username, sign: createHash('md5').update(username + apiKey + suffix).digest('hex') });
const productCode = 'approved-fixture-product';
const reference = 'ref-fixture-01';
const customerId = '0005721';
const providerTransactionId = '90071992547409993';

const cases: ReadonlyArray<readonly [IronGatePostpaidOptions['profile'], string | undefined, object]> = [
  ['bpjs-kesehatan', '3', { month: 3 }], ['bpjs-employment-bpu', '3', { month: 3 }], ['bpjs-employment-pu', undefined, {}],
  ['church-member', '25100', { desc: { amount: 25100 } }], ['church-non-member', '25100', { desc: { amount: 25100 } }],
  ['custom-denomination', '25100', { desc: { amount: 25100 } }], ['e-samsat', '000724', { nomor_identitas: '000724' }],
  ['insurance', undefined, {}], ['telkom-internet', undefined, {}], ['non-telkom-internet', undefined, {}],
  ['multifinance', undefined, {}], ['pbb', '2024', { year: '2024' }], ['pgas', undefined, {}], ['pln-non-taglist', undefined, {}],
  ['telco', undefined, {}], ['tv-telkomvision', undefined, {}], ['tv-non-telkomvision', undefined, {}],
];

function postpaidResponse(extra: Record<string, unknown> = {}) {
  return Response.json({ data: { code: productCode, ref_id: reference, hp: customerId, response_code: success,
    tr_id: providerJsonNumber(providerTransactionId), nominal: 70, admin: 4, platform_fee: providerJsonNumber('0.01500'),
    price: providerJsonNumber('9007199254740993.49'), selling_price: 76, desc: { tokens: 'private-test-token' }, ...extra } });
}

test('IronGate prepares inquiry and payment for all 17 documented postpaid product profiles', async () => {
  for (const [profile, profileValue, fields] of cases) {
    const posts: string[] = [];
    const client = new IronGatePostpaid({ account, baseUrl: origin, profile, productCode, getCredentials,
      successCodes: { inquiry: success, payment: success, status: success }, transactionIdEncoding: 'json-integer',
      transport: async (url, init) => {
        assert.equal(url, origin + '/api/v1/bill/check');
        assert.equal(init?.method, 'POST');
        assert.equal(init.redirect, 'error');
        posts.push(String(init.body));
        return postpaidResponse(profile === 'pgas' ? { desc: [{}], status: 0 } : { status: 0 });
      },
    });
    const inquiry = await client.execute(account, { operation: 'inquiry', reference, customerId,
      ...(profileValue === undefined ? {} : { profileValue }) });
    assert.equal(inquiry.outcome, 'OBSERVED');
    if (inquiry.outcome !== 'OBSERVED') assert.fail(profile);
    assert.equal(inquiry.amounts.price, '9007199254740993.49');
    assert.equal(inquiry.amounts.platform_fee, '0.01500');
    assert.equal(inquiry.providerTransactionId, providerTransactionId);
    assert.doesNotMatch(JSON.stringify(inquiry), /0005721|private-test-token/);
    const payment = await client.execute(account, { operation: 'payment', reference, providerTransactionId });
    assert.equal(payment.outcome, 'OBSERVED');
    const state = await client.execute(account, { operation: 'status', reference });
    assert.equal(state.outcome, 'OBSERVED');
    assert.deepEqual(JSON.parse(posts[0]!), { commands: 'inq-pasca', code: productCode, hp: customerId, ref_id: reference, ...fields, ...proof(reference) });
    assert.ok(posts[1]!.includes(`"tr_id":${providerTransactionId}`));
    assert.deepEqual(JSON.parse(posts[1]!), { commands: 'pay-pasca', tr_id: Number(providerTransactionId), ...proof(providerTransactionId) });
    assert.deepEqual(JSON.parse(posts[2]!), { commands: 'checkstatus', ref_id: reference, ...proof('cs') });
    assert.equal(posts.length, 3);
  }
});

test('IronGate postpaid validates permission, product scope, exact response reference and uncertain payments', async () => {
  let calls = 0, reply = async () => postpaidResponse({ ref_id: 'other-transaction' });
  const client = new IronGatePostpaid({ account, baseUrl: origin, profile: 'pbb', productCode, getCredentials,
    successCodes: { payment: success, inquiry: success }, transactionIdEncoding: 'json-string',
    transport: async (_url, init) => {
      calls++;
      assert.deepEqual(JSON.parse(String(init?.body)), { commands: 'pay-pasca', tr_id: providerTransactionId, ...proof(providerTransactionId) });
      return reply();
    },
  });
  const pay = { operation: 'payment', reference, providerTransactionId } as const;
  await assert.rejects(client.execute({ ...account, tenantId: account.providerAccountId }, pay), { code: 'SCOPE_DENIED' });
  await assert.rejects(client.execute(account, { ...pay, providerTransactionId: '00' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(client.execute(account, { operation: 'status', reference }), { code: 'SCOPE_DENIED' });
  await assert.rejects(client.execute(account, { operation: 'inquiry', reference, customerId, profileValue: '2' }), { code: 'INVALID_REQUEST' });
  assert.equal(calls, 0);
  assert.deepEqual(await client.execute(account, pay), { outcome: 'UNCONFIRMED' });
  reply = async () => postpaidResponse({ tr_id: 100 });
  assert.deepEqual(await client.execute(account, pay), { outcome: 'UNCONFIRMED' });
  reply = async () => new Response(null, { status: 503 });
  assert.deepEqual(await client.execute(account, pay), { outcome: 'UNCONFIRMED' });
  assert.equal(calls, 3);
});

test('IronGate prepaid inquiry and top-up forms use fixed path, fields and signature formulas', async () => {
  type Request = Parameters<IronGatePrepaid['execute']>[1];
  const subscriber = { customer_id: customerId, operator: 'telkomsel', is_subscriber: true, has_package: true, package_count: 1, cached: false };
  const purchase = { customer_id: customerId, ref_id: reference, product_code: productCode, status: 0,
    price: providerJsonNumber('9007199254740993.49'), tr_id: providerJsonNumber(providerTransactionId), pin: 'private-fixture-pin' };
  const cases: ReadonlyArray<readonly [Request, string, string, object, object]> = [
    [{ operation: 'balance' }, '/api/check-balance', 'bl', { currency: 'IDR' }, { currency: 'IDR', balance: 7.5 }],
    [{ operation: 'operator', customerId }, '/api/check-operator', 'op', { customer_id: customerId }, { operator: 'telkomsel' }],
    [{ operation: 'pln', customerId }, '/api/inquiry-pln', customerId, { customer_id: customerId }, { customer_id: customerId, status: 'fixture' }],
    [{ operation: 'ovo', customerId }, '/api/inquiry-ovo', customerId, { customer_id: customerId }, { customer_id: customerId, status: 'fixture' }],
    [{ operation: 'game', gameCode: 'mlbb', gameId: customerId, gameServer: '005' }, '/api/check-game-id', 'mlbb',
      { game_code: 'mlbb', game_id: customerId, game_server: '005' }, { game_id: customerId, game_server: '005', status: 1 }],
    [{ operation: 'subscriber', customerId }, '/api/check-number', 'cnp', { customer_id: customerId, operator: 'telkomsel' }, subscriber],
    [{ operation: 'packages', customerId }, '/api/check-number-packages', 'cnp', { customer_id: customerId, operator: 'telkomsel' },
      { ...subscriber, packages: [{ name: 'fixture plan' }], truncated: false }],
    [{ operation: 'topUp', customerId, reference, productCode }, '/api/top-up', reference,
      { customer_id: customerId, ref_id: reference, product_code: productCode }, purchase],
    [{ operation: 'status', customerId, reference, productCode }, '/api/check-status', reference, { ref_id: reference }, purchase],
  ];
  for (const [request, path, suffix, params, data] of cases) {
    let calls = 0;
    const client = new IronGatePrepaid({ account, baseUrl: origin, balanceCurrency: 'IDR', subscriberOperator: 'telkomsel', getCredentials,
      successCodes: { [request.operation]: success }, transport: async (url, init) => {
        calls++;
        assert.equal(url, origin + path);
        assert.equal(init?.credentials, 'omit');
        assert.deepEqual(JSON.parse(String(init.body)), { ...params, ...proof(suffix) });
        return Response.json({ data: { rc: success, ...data } });
      },
    });
    const outcome = await client.execute(account, request);
    assert.equal(outcome.outcome, 'OBSERVED');
    if (outcome.outcome !== 'OBSERVED') assert.fail('Expected provider observation');
    assert.doesNotMatch(JSON.stringify(outcome), /private-fixture-pin|0005721|fixture-key/);
    if (request.operation === 'topUp') {
      assert.ok('status' in outcome.data && 'price' in outcome.data);
      assert.equal(outcome.data.status, 0);
      assert.equal(outcome.data.price, '9007199254740993.49');
    }
    assert.equal(calls, 1);
  }
});

test('IronGate prepaid leaves unrecognized responses unconfirmed and keeps operation scope closed', async () => {
  let calls = 0;
  const client = new IronGatePrepaid({ account, baseUrl: origin, getCredentials, successCodes: { topUp: success },
    transport: async () => { calls++; return Response.json({ data: { ref_id: 'another-reference', status: 1, rc: success } }); },
  });
  const topUp = { operation: 'topUp', customerId, reference, productCode } as const;
  await assert.rejects(client.execute(account, { ...topUp, operation: 'status' }), { code: 'SCOPE_DENIED' });
  await assert.rejects(client.execute(account, { ...topUp, productCode: '../unapproved' }), { code: 'INVALID_REQUEST' });
  assert.equal(calls, 0);
  assert.deepEqual(await client.execute(account, topUp), { outcome: 'UNCONFIRMED' });
  assert.equal(calls, 1);
});

test('IronGate v1 and v2 callbacks can request only a status recheck for the signed, correlated transaction', () => {
  for (const version of ['v1','v2'] as const) {
    const identity = version === 'v1' ? { code: productCode, hp: customerId } : { product_code: productCode, customer_id: customerId };
    const scope = { ...account, version, reference, productCode, customerId, providerTransactionId };
    const keys = { username, apiKey };
    const data = { ref_id: reference, tr_id: providerTransactionId, rc: success, status: '0', price: '12.34', balance: '3100.12',
      message: 'Fixture', pin: 'private fixture', sign: proof(reference).sign, ...identity };
    const expected = { ...account, outcome: 'STATUS_RECHECK_REQUIRED', reference, providerTransactionId };
    assert.deepEqual(checkIronGateCallback({ data }, scope, keys), expected);
    assert.deepEqual(checkIronGateCallback({ data: { ...data, status: '1', price: '9999.99' } }, scope, keys), expected);
    assert.equal(checkIronGateCallback({ data: { ...data, tr_id: '123' } }, scope, keys), undefined);
    assert.equal(checkIronGateCallback({ data: { ...data, ref_id: 'other-ref' } }, scope, keys), undefined);
    assert.equal(checkIronGateCallback({ data: { ...data, status: 1 } }, scope, keys), undefined);
    assert.equal(checkIronGateCallback({ data }, { ...scope, version: version === 'v1' ? 'v2' : 'v1' }, keys), undefined);
    assert.equal(checkIronGateCallback({ data }, scope, { ...keys, apiKey: 'wrong-key' }), undefined);
    assert.equal(checkIronGateCallback({ data }, { ...scope, customerId: 'other-fixture-customer' }, keys), undefined);
  }
});

test('IronGate legacy forms honor the v1 account grant and map its distinct wire fields', async () => {
  type Request = Parameters<IronGatePrepaid['execute']>[1];
  const purchase = { hp: customerId, ref_id: reference, code: productCode, status: 0, price: providerJsonNumber('12.3400'), tr_id: 9001 };
  const cases: ReadonlyArray<readonly [Request, string, string, object, unknown]> = [
    [{ operation: 'balance' }, 'balance', 'bl', { currency: 'IDR' }, { currency: 'IDR', balance: 10 }],
    [{ operation: 'legacyPriceList' }, 'pricelist', 'pl', { currency: 'IDR' },
      [{ pulsa_code: 'test-plan', pulsa_details: 'Plan', pulsa_price: providerJsonNumber('1200.0100'), status: 'active', currency: 'IDR' }]],
    [{ operation: 'pln', customerId }, 'inquiry_pln', customerId, { hp: customerId }, { rc: success, hp: customerId, status: 'valid' }],
    [{ operation: 'legacyGameFormat', gameCode: '007' }, 'game-format-id', '007', { game_code: '007' },
      { rc: success, status: 1, formatGameId: 'fixture format' }],
    [{ operation: 'legacyGameServers', gameCode: '007' }, 'game-server-list', '007', { game_code: '007' },
      { rc: success, status: 1, servers: [{ name: 'Test', value: '001' }] }],
    [{ operation: 'topUp', reference, customerId, productCode }, 'topup', reference,
      { ref_id: reference, hp: customerId, pulsa_code: productCode }, { rc: success, ...purchase }],
    [{ operation: 'legacyAutoTopUp', reference, customerId, productCode: 'pulsa5000' }, 'topup', reference,
      { ref_id: reference, hp: customerId, pulsa_code: 'pulsa5000' }, { rc: success, ...purchase, code: 'pulsa5000' }],
    [{ operation: 'status', reference, customerId, productCode }, 'inquiry', reference, { ref_id: reference }, { rc: success, ...purchase }],
  ];
  for (const [request, commands, suffix, fields, data] of cases) {
    const uncoded = request.operation === 'balance' || request.operation === 'legacyPriceList';
    let requests = 0;
    const adapter = new IronGatePrepaid({ account, version: 'legacy-v1', baseUrl: origin, getCredentials, balanceCurrency: 'IDR',
      successCodes: uncoded ? {} : { [request.operation]: success }, legacyUncodedReads: uncoded ? [request.operation] : [],
      transport: async (url, init) => {
        requests++;
        assert.equal(url, origin + '/v1/legacy/index');
        assert.deepEqual(JSON.parse(String(init?.body)), { commands, ...fields, ...proof(suffix) });
        return Response.json({ data });
      },
    });
    assert.equal((await adapter.execute(account, request)).outcome, 'OBSERVED');
    assert.equal(requests, 1);
  }
  assert.throws(() => new IronGatePrepaid({ account, baseUrl: origin, getCredentials,
    successCodes: { legacyAutoTopUp: success }, transport: async () => assert.fail() }), { code: 'INVALID_CONFIGURATION' });
});

test('IronGate eSIM activation transport sends one scoped notification request and strips recipient data', async () => {
  const email = 'fixture@example.invalid';
  let calls = 0;
  const adapter = new IronGatePrepaid({ account, baseUrl: origin, getCredentials, successCodes: { activateEsim: success },
    transport: async (url, init) => {
      calls++;
      assert.equal(url, origin + '/api/esim/notification/activation');
      assert.deepEqual(JSON.parse(String(init?.body)), { tr_id: providerTransactionId, email, ...proof(providerTransactionId) });
      return Response.json({ data: { tr_id: providerTransactionId, email, rc: success, message: 'fixture' } });
    },
  });
  await assert.rejects(adapter.execute(account, { operation: 'activateEsim', email: 'not-an-email', providerTransactionId }), { code: 'INVALID_REQUEST' });
  assert.deepEqual(await adapter.execute(account, { operation: 'activateEsim', email, providerTransactionId }),
    { outcome: 'OBSERVED', data: { providerTransactionId } });
  assert.equal(calls, 1);
});
