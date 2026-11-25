import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { qualifyIronGateCatalogueRead, qualifySslCatalogueRead } from '../packages/provider-adapters/src/sandbox-catalogue-qualification.ts';

const contract = 'irongate/prepaid-v2+postpaid/catalogue';
const tenantKey = 'NUKHBAPAY_PROVIDER_SANDBOX_TENANT_ID';
const enabledKey = 'NUKHBAPAY_PROVIDER_SANDBOX_ENABLED';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const visible = /^[!-~]{1,512}$/;
const selector = /^[A-Za-z0-9_-]{1,64}$/;
const reference = /^[A-Za-z0-9._:/-]{1,200}$/;
const sslContracts = { 'ssl-topup': 'mobile-top-up/8.2.0', 'ssl-utilities': 'utilities/1.6.1' };
const ironGateReads = {
  prepaid: { read: 'prepaid', path: '/api/pricelist', code: 'SUCCESS_CODE' },
  postpaid: { read: 'postpaid', path: '/api/v1/bill/check', code: 'SUCCESS_CODE' },
  games: { read: 'games', path: '/api/gamelist', code: 'GAMES_SUCCESS_CODE' },
  'game-format': { read: 'gameFormat', path: '/api/game/format', code: 'GAME_FORMAT_SUCCESS_CODE' },
  'game-servers': { read: 'gameServers', path: '/api/inquiry-game-server', code: 'GAME_SERVERS_SUCCESS_CODE' },
  'esim-indonesia': { read: 'esimIndonesia', code: 'ESIM_INDONESIA_SUCCESS_CODE' },
  'esim-international': { read: 'esimInternational', path: '/api/esiminternationallist', code: 'ESIM_INTERNATIONAL_SUCCESS_CODE' },
};

function approvedOrigin(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return url.protocol === 'https:' && (value === url.origin || value === url.origin + '/') &&
      !isIP(host) && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) && !/\.(?:local|localhost|internal|invalid)$/.test(host);
  } catch { return false; }
}

function splitList(value, validate) {
  const items = value.split(',').map(item => item.trim());
  return items.length <= 64 && items.every(validate) && new Set(items).size === items.length ? items : null;
}

export function prepareProviderSandbox(provider, operation, env) {
  if (provider === 'finxplor' || provider === 'ipay') return { result: { outcome: 'CONTRACT_REQUIRED', requests: 0 } };
  const ssl = Object.hasOwn(sslContracts, provider);
  const iron = provider === 'irongate' && Object.hasOwn(ironGateReads, operation) ? ironGateReads[operation] : undefined;
  if ((ssl && !(operation === 'service-list' || (provider === 'ssl-topup' && operation === 'package-list'))) || (!ssl && !iron)) {
    return { result: { outcome: 'SCOPE_DENIED', requests: 0 } };
  }
  const prefix = `NUKHBAPAY_${ssl ? (provider === 'ssl-topup' ? 'SSL_TOPUP' : 'SSL_UTILITIES') :
    (operation === 'postpaid' ? 'IRONGATE_POSTPAID' : 'IRONGATE_PREPAID')}_`;
  const missing = [], invalid = [];
  function read(key, valid, required = true) {
    const value = env[key];
    if (value === undefined || value === '') { if (required) missing.push(key); return undefined; }
    if (typeof value !== 'string' || !valid(value)) { invalid.push(key); return undefined; }
    return value;
  }
  const get = (key, valid, required) => read(prefix + key, valid, required);
  const account = {
    tenantId: read(tenantKey, value => uuid.test(value)),
    providerAccountId: get('PROVIDER_ACCOUNT_ID', value => uuid.test(value)),
  };
  const baseUrl = get('BASE_URL', approvedOrigin);
  const credentialReference = get('CREDENTIAL_REFERENCE', value => reference.test(value));
  const enabled = read(enabledKey, value => value === 'true' || value === 'false', false) === 'true';
  const credentials = ssl ? { stkCode: get('STK_CODE', value => visible.test(value)), authKey: get('AUTH_KEY', value => visible.test(value)) }
    : { username: get('USERNAME', value => visible.test(value)), apiKey: get('API_KEY', value => visible.test(value)) };
  const config = { account, baseUrl };
  let method, path, qualifier, readName, providerCode;
  if (ssl) {
    const categories = get('ALLOWED_CATEGORIES', value => Boolean(splitList(value, item => Boolean(item) && item.length <= 256 && !/[\x00-\x1f\x7f]/.test(item))));
    const operators = provider === 'ssl-topup' ? get('ALLOWED_OPERATOR_IDS', value => Boolean(splitList(value, item => /^\d{1,16}$/.test(item))), operation === 'package-list') : undefined;
    const subChannelId = get('SUB_CHANNEL_ID', value => /^\d{1,32}$/.test(value), false);
    Object.assign(config, { contract: sslContracts[provider], allowedCategories: categories?.split(',').map(item => item.trim()),
      allowedOperatorIds: operators?.split(',').map(item => item.trim()), subChannelId });
    method = 'GET'; path = operation === 'service-list' ? '/api/service-list' : '/api/vr/package-list';
    qualifier = qualifySslCatalogueRead; readName = operation; providerCode = 'SSL_WIRELESS';
  } else {
    const code = get(iron.code, value => selector.test(value));
    Object.assign(config, { successCodes: { [iron.read]: code } });
    if (operation === 'prepaid') {
      config.prepaidCurrency = get('CURRENCY', value => ['IDR', 'USD'].includes(value));
      config.prepaidStatus = get('STATUS', value => ['all', 'active', 'non active'].includes(value), false);
    }
    if (operation === 'postpaid') {
      config.postpaidStatus = get('STATUS', value => ['all', 'active', 'non-active'].includes(value), false);
      config.postpaidProvince = get('PROVINCE', value => /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(value) && value === value.trim(), false);
    }
    if (operation === 'game-format' || operation === 'game-servers') config.gameCode = get('GAME_CODE', value => selector.test(value));
    if (operation === 'esim-indonesia') config.domesticEsimOperator = get('ESIM_OPERATOR', value => selector.test(value));
    if (operation === 'esim-international') config.internationalEsimLanguage = get('ESIM_LANGUAGE', value => ['en', 'id'].includes(value), false);
    method = 'POST'; path = iron.path ?? `/api/esimlist/${config.domesticEsimOperator}`;
    qualifier = qualifyIronGateCatalogueRead; readName = iron.read; providerCode = 'IRONGATE';
  }
  if (missing.length || invalid.length) return { result: { outcome: 'CONFIGURATION_REQUIRED', missing, invalid, requests: 0 } };
  const approval = Object.freeze({ environment: 'SANDBOX', provider: providerCode, origin: new URL(baseUrl).origin,
    ...account, credentialReference, method, path, requestBudget: 1,
    ...(ssl ? { country: 'BD', contract: config.contract, categories: config.allowedCategories, operators: config.allowedOperatorIds,
      subChannelId: config.subChannelId } : { contract, successCode: config.successCodes[readName],
      prepaidCurrency: config.prepaidCurrency, prepaidStatus: config.prepaidStatus, postpaidStatus: config.postpaidStatus,
      postpaidProvince: config.postpaidProvince, gameCode: config.gameCode, domesticEsimOperator: config.domesticEsimOperator,
      internationalEsimLanguage: config.internationalEsimLanguage }),
  });
  return {
    result: { outcome: 'CONFIGURATION_READY', enabled, requests: 0 },
    async run(hasActiveAccount, fetcher) {
      if (!enabled || typeof hasActiveAccount !== 'function' || !await hasActiveAccount(account.tenantId, account.providerAccountId, providerCode)) {
        return { outcome: 'SCOPE_DENIED', requests: 0 };
      }
      return qualifier(readName, config, approval, async (ref, requested, signal) => {
        signal.throwIfAborted();
        if (ref !== credentialReference || requested.tenantId !== account.tenantId || requested.providerAccountId !== account.providerAccountId) throw new Error('Account denied');
        return credentials;
      }, fetcher);
    },
  };
}

async function main() {
  const [provider, operation, mode, ...extra] = process.argv.slice(2);
  if (!provider || !operation || !['--check', '--read'].includes(mode) || extra.length) throw new Error('Invalid arguments');
  const environment = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
  const prepared = prepareProviderSandbox(provider, operation, environment);
  let result = prepared.result;
  if (mode === '--read' && result.enabled) {
    const { createLocalCatalogueStorage } = await import('../packages/database/dist/database/src/local-catalogue-storage.js');
    const storage = await createLocalCatalogueStorage({ setupId: process.env.NUKHBAPAY_LOCAL_CATALOGUE_SETUP_ID,
      password: process.env.DB_LOCAL_CATALOGUE_READER_PASSWORD }, new Map());
    try { result = await prepared.run(storage.hasActiveProviderAccount); }
    finally { await storage.close(); }
  } else if (mode === '--read' && result.outcome === 'CONFIGURATION_READY') {
    result = { outcome: 'SCOPE_DENIED', requests: 0 };
  }
  console.log(JSON.stringify(result));
  if (result.outcome !== (mode === '--check' ? 'CONFIGURATION_READY' : 'SCHEMA_ACCEPTED')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => { console.error('Provider sandbox check or read failed.'); process.exitCode = 1; });
}
