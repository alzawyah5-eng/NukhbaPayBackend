import assert from 'node:assert/strict';
import test from 'node:test';
import { SslWirelessBills, type SslBillBinding } from '../src/index.ts';

const scope = { tenantId: '00000000-0000-4000-8000-000000000001', providerAccountId: '00000000-0000-4000-8000-000000000002',
  billerId: 'fixture-biller' };
const origin = 'https://ssl-bills.fixture.invalid';
const transactionId = 'fixture-transaction-0001';
const credentials = { stkCode: 'fixture-merchant', authKey: 'fixture-auth', utilityAuthKey: 'fixture-biller-auth',
  utilitySecretKey: 'fixture-secret' };
const topUp = { operator_id: '6', recipient_msisdn: '8801000000000', amount: '123456789123456.7800', connection_type: 'prepaid' };
const meter = { meter_no: '0001234', mobile_no: '0005678', amount: '72.0300', convenience_fee: '3.10' };

test('SSL bill variants send their documented fields with exact numeric literals and a shared transaction reference', async () => {
  for (const [profile, operation, params, fields, response] of [
    ['mobile-top-up', 'info', topUp, { ...topUp, operator_id: 6, recipient_msisdn: 8801000000000, amount: 123456789123456.78 },
      { status: 'api_success', status_code: '000', transaction_id: transactionId, data: { total_amount: '123456789123456.7800' } }],
    ['mobile-top-up', 'payment', {}, {}, { status: 'payment_success', status_code: '111', data: { recharge_status: 200 } }],
    ['mobile-top-up', 'status', {}, {}, { status: 'success', status_code: '111', data: { recharge_status: 900 } }],
    ['utilities-common', 'status', {}, {}, { status: 'success', status_code: '111', data: { recharge_status: 201 } }],
    ['utilities-common', 'cancel', {}, {}, { status: 'payment_canceled', status_code: '113', data: null }],
    ['bpdb-prepaid', 'info', meter, { ...meter, bill_type: 'PREPAID', amount: 72.03, convenience_fee: 3.1 },
      { status: 'api_success', status_code: '000', transaction_id: transactionId, data: { total_amount: '75.1300' } }],
    ['bpdb-prepaid', 'payment', meter, { ...meter, bill_type: 'PREPAID', amount: 72.03, convenience_fee: 3.1 },
      { status: 'payment_success', status_code: '111', data: { vending_amount: '72.0300' } }],
    ['bpdb-prepaid', 'status', {}, {}, { status: 'payment_success', status_code: '111', data: { amount: '72.0300' } }],
    ['breb-prepaid', 'info', { ...meter, branchRoutingNo: '0006' },
      { ...meter, bill_type: 'PREPAID', amount: 72.03, convenience_fee: 3.1, branchRoutingNo: '0006' },
      { status: 'api_success', status_code: '000', transaction_id: transactionId, data: { total_amount: '75.1300' } }],
    ['breb-prepaid', 'payment', { core_transaction_id: '9007199254740999', commission_amount: '0.1000' },
      { core_transaction_id: 9007199254740999, commission_amount: 0.1, utility_bill_type: 'PREPAID' },
      { status: 'payment_success', status_code: '111', data: { vending_amount: '72.0300' } }],
    ['breb-prepaid', 'status', {}, {}, { status: 'payment_success', status_code: '111', data: { vending_amount: '72.0300' } }],
  ] as const) {
    const binding: SslBillBinding = { ...scope, profile };
    let requests = 0;
    const adapter = new SslWirelessBills({ binding, baseUrl: origin, allowedOperatorIds: ['6'],
      allowCancellation: operation === 'cancel', subChannelId: '01',
      getCredentials: async bound => { assert.deepEqual(bound, binding); return credentials; },
      transport: async (url, init) => {
        requests++;
        assert.equal(url, origin + '/api/bill-' + operation);
        assert.equal(init?.method, 'POST');
        assert.equal(init.redirect, 'error');
        assert.equal(init.credentials, 'omit');
        assert.equal(new Headers(init.headers).get('SUB-CHANNEL-ID'), '01');
        const body = String(init.body);
        if ('amount' in params) assert.ok(body.includes(`"amount":${params.amount}`));
        if ('core_transaction_id' in params) assert.ok(body.includes(`"core_transaction_id":${params.core_transaction_id}`));
        assert.deepEqual(JSON.parse(body), { ...fields, transaction_id: transactionId,
          utility_auth_key: credentials.utilityAuthKey, utility_secret_key: credentials.utilitySecretKey });
        return Response.json({ ...response, lid: 'fixture-LID', ...(response.data && {
          data: { ...response.data, tokens: 'secret-token-fixture', customer_name: 'private-fixture', action_url: 'https://ignored.invalid' },
        }) });
      },
    });
    const result = await adapter.execute(binding, operation, transactionId, params);
    assert.equal(result.outcome, 'OBSERVED');
    if (result.outcome !== 'OBSERVED') assert.fail('Expected provider observation');
    assert.equal(result.statusCode, response.status_code);
    if (response.data && 'total_amount' in response.data) assert.equal(result.monetaryFields['total_amount'], response.data.total_amount);
    if (response.data && 'recharge_status' in response.data) assert.equal(result.rechargeStatus, response.data.recharge_status);
    assert.doesNotMatch(JSON.stringify(result), /secret-token|private-fixture|ignored\.invalid|fixture-secret/);
    assert.equal(requests, 1);
  }
});

test('SSL bill transport denies altered tenant, biller, input and cancellation before credentials', async () => {
  const binding = { ...scope, profile: 'mobile-top-up' } as const;
  const forbidden = async () => assert.fail('Unexpected credentials or network access');
  const adapter = new SslWirelessBills({ binding, baseUrl: origin, allowedOperatorIds: ['6','13'],
    getCredentials: forbidden, transport: forbidden });
  const foreign = '00000000-0000-4000-8000-000000000003';
  for (const target of [{ ...binding, tenantId: foreign }, { ...binding, providerAccountId: foreign }, { ...binding, billerId: 'other' }]) {
    await assert.rejects(adapter.execute(target, 'payment', transactionId), { code: 'SCOPE_DENIED' });
  }
  await assert.rejects(adapter.execute(binding, 'cancel', transactionId), { code: 'SCOPE_DENIED' });
  await assert.rejects(adapter.execute(binding, 'info', transactionId, { ...topUp, operator_id: '13', connection_type: 'postpaid' }), { code: 'SCOPE_DENIED' });
  await assert.rejects(adapter.execute(binding, 'info', transactionId, { ...topUp, amount: '1e5' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(adapter.execute(binding, 'info', transactionId, { ...topUp, recipient_msisdn: '0880100' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(adapter.execute(binding, 'payment', transactionId, { utility_secret_key: 'forged' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(adapter.execute(binding, 'payment', 'short'), { code: 'INVALID_REQUEST' });
  const common = { ...scope, profile: 'utilities-common' } as const;
  const statusOnly = new SslWirelessBills({ binding: common, baseUrl: origin, getCredentials: forbidden, transport: forbidden });
  await assert.rejects(statusOnly.execute(common, 'cancel', transactionId), { code: 'SCOPE_DENIED' });
  await assert.rejects(statusOnly.execute(common, 'info', transactionId), { code: 'SCOPE_DENIED' });
});

test('SSL never repeats a timed out, redirected, rejected or malformed bill-payment attempt', async () => {
  const binding = { ...scope, profile: 'mobile-top-up' } as const;
  for (const [reply, expected] of [
    [async () => { throw new Error('private fixture diagnostic'); }, { outcome: 'UNCONFIRMED' }],
    [async () => new Response(null, { status: 503 }), { outcome: 'UNCONFIRMED' }],
    [async () => Response.redirect('https://other.invalid'), { outcome: 'UNCONFIRMED' }],
    [async () => Response.json({ status: 'error', status_code: '409', message: 'private fixture' }), { outcome: 'UNCONFIRMED', statusCode: '409' }],
    [async () => Response.json({ status: 'payment_success', status_code: '111', lid: 'fixture', data: { recharge_status: '900' } }), { outcome: 'UNCONFIRMED' }],
    [async () => Response.json({ status: 'payment_success', status_code: '111', lid: 'fixture', transaction_id: 'unrelated', data: { recharge_status: 900 } }), { outcome: 'UNCONFIRMED' }],
  ] as const) {
    let requests = 0;
    const adapter = new SslWirelessBills({ binding, baseUrl: origin, allowedOperatorIds: ['6'], getCredentials: async () => credentials,
      transport: async () => { requests++; return reply(); } });
    assert.deepEqual(await adapter.execute(binding, 'payment', transactionId), expected);
    assert.equal(requests, 1);
  }
});

test('SSL common DESCO and DPDC forms bind their real biller fields and encodings', async () => {
  const dpdc = { locationCodes: ['fixture-area'], billYears: ['2026'], billMonths: ['01'], accountNumberEncoding: 'numeric-text' } as const;
  const desco = { ...scope, profile: 'desco-postpaid' } as const;
  const dpdcBinding = { ...scope, billerId: 'fixture-dpdc', profile: 'dpdc-bill' } as const;
  const dpdcFields = { location_code: 'fixture-area', account_number: '000123', bill_years: '2026', bill_months: '01' };
  const cases = [
    [desco, undefined, 'info', { billno: 'AB0001' }, { billno: 'AB0001' }],
    [desco, undefined, 'payment', { remarks: 'Payment reference' }, { remarks: 'Payment reference', utility_bill_type: 'POSTPAID' }],
    [dpdcBinding, dpdc, 'info', dpdcFields, dpdcFields],
    [dpdcBinding, { ...dpdc, accountNumberEncoding: 'json-integer' }, 'info', { ...dpdcFields, account_number: '123' },
      { ...dpdcFields, account_number: 123 }],
    [dpdcBinding, dpdc, 'payment', {}, {}],
  ] as const;
  for (const [binding, profile, operation, fields, wire] of cases) {
    let calls = 0;
    const adapter = new SslWirelessBills({ binding, baseUrl: origin, ...(profile ? { dpdc: profile } : {}),
      getCredentials: async approved => { assert.deepEqual(approved, binding); return credentials; },
      transport: async (url, init) => {
        calls++;
        assert.equal(url, `${origin}/api/bill-${operation}`);
        assert.deepEqual(JSON.parse(String(init?.body)), { ...wire, transaction_id: transactionId,
          utility_auth_key: credentials.utilityAuthKey, utility_secret_key: credentials.utilitySecretKey });
        return Response.json({ status: operation === 'info' ? 'api_success' : 'payment_success',
          status_code: operation === 'info' ? '000' : '111', lid: 'fixture-lid', transaction_id: transactionId,
          data: operation === 'info' ? { total_amount: '75.1300', account_number: 'discarded' } : { trackingNo: 'fixture' } });
      },
    });
    assert.equal((await adapter.execute(binding, operation, transactionId, fields)).outcome, 'OBSERVED');
    assert.equal(calls, 1);
  }
  const forbidden = async () => assert.fail('Unexpected credentials or transport');
  const options = { binding: dpdcBinding, baseUrl: origin, getCredentials: forbidden, transport: forbidden };
  assert.throws(() => new SslWirelessBills(options), { code: 'INVALID_CONFIGURATION' });
  const locationCodes = ['fixture-area'];
  const dpdcAdapter = new SslWirelessBills({ ...options, dpdc: { ...dpdc, locationCodes } });
  locationCodes.push('foreign');
  await assert.rejects(dpdcAdapter.execute(dpdcBinding, 'info', transactionId, { ...dpdcFields, location_code: 'foreign' }), { code: 'SCOPE_DENIED' });
  const descoAdapter = new SslWirelessBills({ ...options, binding: desco });
  await assert.rejects(descoAdapter.execute(desco, 'payment', transactionId, { utility_bill_type: 'UNAPPROVED' }), { code: 'INVALID_REQUEST' });
});
