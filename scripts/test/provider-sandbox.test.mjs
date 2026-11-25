import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseEnv } from 'node:util';
import { prepareProviderSandbox } from '../provider-sandbox.mjs';

const tenantId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const origin = 'https://provider.fixture.test';
const approved = { NUKHBAPAY_PROVIDER_SANDBOX_TENANT_ID: tenantId, NUKHBAPAY_PROVIDER_SANDBOX_ENABLED: 'true' };
const family = prefix => Object.fromEntries(Object.entries({ BASE_URL: origin, PROVIDER_ACCOUNT_ID: accountId,
  CREDENTIAL_REFERENCE: 'test/catalogue', USERNAME: 'fixture-user', API_KEY: 'fixture-key', STK_CODE: 'fixture-store',
  AUTH_KEY: 'fixture-auth', ALLOWED_CATEGORIES: 'Mobile Operators, Utility Service',
  ALLOWED_OPERATOR_IDS: '6', SUB_CHANNEL_ID: '101', SUCCESS_CODE: 'fixture-ok' }).map(([key,value]) => [`NUKHBAPAY_${prefix}_${key}`,value]));
const scopeDenied = { outcome: 'SCOPE_DENIED', requests: 0 };
const unexpected = () => assert.fail('Unexpected account or network access');

test('the provider template contains every required configuration key without credentials', async () => {
  const template = parseEnv(await readFile(new URL('../../.env.example', import.meta.url), 'utf8'));
  assert.equal(template.NUKHBAPAY_PROVIDER_SANDBOX_ENABLED, 'false');
  for (const [provider, operation] of [['ssl-topup','service-list'], ['ssl-topup','package-list'], ['ssl-utilities','service-list'],
    ['irongate','prepaid'], ['irongate','postpaid'], ['irongate','games'], ['irongate','game-format'], ['irongate','game-servers'],
    ['irongate','esim-indonesia'], ['irongate','esim-international']]) {
    const { result } = prepareProviderSandbox(provider, operation, template);
    assert.equal(result.outcome, 'CONFIGURATION_REQUIRED');
    assert.deepEqual(result.invalid, []);
    assert.ok(result.missing.every(key => Object.hasOwn(template, key) && template[key] === ''));
  }
});

test('IronGate game metadata sends only the account-pinned game code and returns counts', async () => {
  const env = { ...approved, ...family('IRONGATE_PREPAID'), NUKHBAPAY_IRONGATE_PREPAID_GAME_CODE: '0067',
    NUKHBAPAY_IRONGATE_PREPAID_GAME_FORMAT_SUCCESS_CODE: 'fixture-ok',
    NUKHBAPAY_IRONGATE_PREPAID_GAME_SERVERS_SUCCESS_CODE: 'fixture-ok' };
  for (const [operation, path, data, records] of [
    ['game-format', '/api/game/format', { formatGameId: 'User ID and server' }, 1],
    ['game-servers', '/api/inquiry-game-server', { servers: [{ name: 'First server', value: '001' }, { name: 'Second server', value: '002' }] }, 2],
  ]) {
    const prepared = prepareProviderSandbox('irongate', operation, env);
    assert.deepEqual(await prepared.run(async () => false, unexpected), scopeDenied);
    const transport = async (url, init) => {
      assert.equal(url, origin + path);
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { game_code: '0067', username: 'fixture-user',
        sign: createHash('md5').update('fixture-userfixture-key0067').digest('hex') });
      return Response.json({ data: { rc: 'fixture-ok', status: 1, message: 'Fixture', ...data } });
    };
    assert.deepEqual(await prepared.run(async (tenant, account, provider) => {
      assert.deepEqual([tenant, account, provider], [tenantId, accountId, 'IRONGATE']);
      return true;
    }, transport), { outcome: 'SCHEMA_ACCEPTED', records, requests: 1 });
  }
  const invalid = prepareProviderSandbox('irongate', 'game-format', { ...env, NUKHBAPAY_IRONGATE_PREPAID_GAME_CODE: 'path/escape' });
  assert.deepEqual(invalid.result.invalid, ['NUKHBAPAY_IRONGATE_PREPAID_GAME_CODE']);
  assert.equal(invalid.run, undefined);
});

test('pending vendors and financial or out-of-scope routes have no callable sandbox operation', () => {
  for (const provider of ['finxplor','ipay']) {
    assert.deepEqual(prepareProviderSandbox(provider, 'documentation', approved), {
      result: { outcome: 'CONTRACT_REQUIRED', requests: 0 },
    });
  }
  for (const [provider, operation] of [['ssl-utilities','package-list'],['ssl-topup','bill-payment'],['irongate','purchase'],['unknown','games']]) {
    assert.deepEqual(prepareProviderSandbox(provider, operation, approved), { result: scopeDenied });
  }
});

test('SSL refuses disabled, inactive, and incorrect account bindings before making a request', async () => {
  const env = { ...approved, ...family('SSL_TOPUP') };
  const disabled = prepareProviderSandbox('ssl-topup', 'service-list', { ...env, NUKHBAPAY_PROVIDER_SANDBOX_ENABLED: 'false' });
  assert.deepEqual(await disabled.run(unexpected, unexpected), scopeDenied);
  const enabled = prepareProviderSandbox('ssl-topup', 'service-list', env);
  assert.deepEqual(await enabled.run(async (tenant, account, provider) => {
    assert.deepEqual([tenant,account,provider],[tenantId,accountId,'SSL_WIRELESS']);
    return false;
  }, unexpected), scopeDenied);
  const rejected = prepareProviderSandbox('ssl-topup', 'service-list', { ...env, NUKHBAPAY_SSL_TOPUP_BASE_URL: 'https://127.0.0.1/' });
  assert.deepEqual(rejected.result.invalid, ['NUKHBAPAY_SSL_TOPUP_BASE_URL']);
  assert.equal(rejected.run, undefined);
});

test('SSL Mobile Top-Up and Utilities use distinct account settings and return count-only results', async () => {
  const env = { ...approved, ...family('SSL_TOPUP'), ...family('SSL_UTILITIES') };
  for (const provider of ['ssl-topup','ssl-utilities']) {
    const request = prepareProviderSandbox(provider, 'service-list', env);
    const result = await request.run(async () => true, async (url, init) => {
      assert.equal(url, origin + '/api/service-list');
      assert.equal(init.method, 'GET');
      assert.equal(init.headers['STK-CODE'], 'fixture-store');
      assert.equal(init.redirect, 'error');
      return Response.json({ status: 'success', data: [{ category_value: 'Utility Service', category_name: 'Utility',
        data: [{ utility_value: 'fixture-only', data: [{ utility_bill_type: 'water', biller_status: 'active', secret: 'private fixture' }] }] }] });
    });
    assert.deepEqual(result, { outcome: 'SCHEMA_ACCEPTED', records: 1, requests: 1 });
  }
});

test('IronGate sends the approved prepaid status, postpaid province and international language only on their read operations', async () => {
  const env = { ...approved, ...family('IRONGATE_PREPAID'), ...family('IRONGATE_POSTPAID'),
    NUKHBAPAY_IRONGATE_PREPAID_CURRENCY: 'IDR', NUKHBAPAY_IRONGATE_PREPAID_STATUS: 'non active',
    NUKHBAPAY_IRONGATE_POSTPAID_STATUS: 'non-active', NUKHBAPAY_IRONGATE_POSTPAID_PROVINCE: 'Fixture Province',
    NUKHBAPAY_IRONGATE_PREPAID_ESIM_LANGUAGE: 'id', NUKHBAPAY_IRONGATE_PREPAID_ESIM_INTERNATIONAL_SUCCESS_CODE: 'fixture-ok' };
  for (const [operation, path, fields, response] of [
    ['prepaid','/api/pricelist',{currency:'IDR',status:'non active'},{pricelist:[]}],
    ['postpaid','/api/v1/bill/check',{commands:'pricelist-pasca',status:'non-active',province:'Fixture Province'},{pasca:[]}],
    ['esim-international','/api/esiminternationallist',{lang:'id'},{status:200,list:[]}],
  ]) {
    const request = prepareProviderSandbox('irongate', operation, env);
    const result = await request.run(async (tenant, account, provider) => {
      assert.deepEqual([tenant,account,provider],[tenantId,accountId,'IRONGATE']);
      return true;
    }, async (url, init) => {
      assert.equal(url, origin + path);
      assert.equal(init.method, 'POST');
      const { username, sign, ...selectors } = JSON.parse(init.body);
      assert.equal(username, 'fixture-user');
      assert.match(sign, /^[a-f0-9]{32}$/);
      assert.deepEqual(selectors, fields);
      return Response.json({ data: { rc: 'fixture-ok', ...response } });
    });
    assert.deepEqual(result, { outcome: 'SCHEMA_ACCEPTED', records: 0, requests: 1 });
  }
});
