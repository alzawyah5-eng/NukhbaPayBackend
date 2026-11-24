import { createHash } from 'node:crypto';
import { readCatalogueJson, wireNumber, withinCatalogueDeadline } from './catalogue-http.ts';

const contract = 'irongate/prepaid-v2+postpaid/catalogue' as const;
const signatures = Object.freeze({ prepaid: 'pl', postpaid: 'pl', games: 'gc', esimIndonesia: 'esim', esimInternational: 'esim-inter' });
type Read = keyof typeof signatures;
type Currency = 'IDR' | 'USD';
type Failure = 'INVALID_CONFIGURATION' | 'SCOPE_DENIED' | 'UNAVAILABLE' | 'INVALID_RESPONSE';

export interface IronGateAccountBinding { readonly tenantId: string; readonly providerAccountId: string }
export interface IronGateCatalogueOptions {
  readonly account: IronGateAccountBinding;
  readonly baseUrl: string;
  /** Supply a confirmed wire success code for each approved operation. Entries also restrict account scope. */
  readonly successCodes: Readonly<Partial<Record<Read, string>>>;
  readonly prepaidCurrency?: Currency;
  readonly domesticEsimOperator?: string;
  readonly getCredentials: (account: IronGateAccountBinding, signal: AbortSignal) => Promise<{
    readonly username: string;
    readonly apiKey: string;
  }>;
  readonly fetch?: typeof fetch;
}

export class IronGateCatalogueError extends Error {
  readonly code: Failure;
  constructor(code: Failure) {
    super('IronGate catalogue request failed');
    this.name = 'IronGateCatalogueError';
    this.code = code;
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const selector = /^[A-Za-z0-9_-]{1,64}$/;
const credential = /^[!-~]{1,512}$/;
const exactFields = new Set(['product_price', 'fee', 'komisi', 'game_code']);
const invalid = () => new IronGateCatalogueError('INVALID_RESPONSE');

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

function rows(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 10_000) throw invalid();
  return value.map(record);
}

function text(value: unknown, max = 256, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  return value;
}

function decimal(value: unknown): string {
  const raw = wireNumber(value);
  if (raw === undefined || !/^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?(?:[eE][+-]?[0-9]{1,2})?$/.test(raw)) throw invalid();
  return raw;
}

function immutableRows<T>(items: readonly T[], sourceId: (item: T) => string): readonly Readonly<T>[] {
  if (new Set(items.map(sourceId)).size !== items.length) throw invalid();
  return Object.freeze(items.map(item => Object.freeze(item)));
}

/** Backend-only catalogue reads. Quoted values stay upstream observations until account semantics are approved. */
export class IronGateCatalogue {
  readonly #account: IronGateAccountBinding;
  readonly #origin: string;
  readonly #getCredentials: IronGateCatalogueOptions['getCredentials'];
  readonly #fetch: typeof fetch;
  readonly #successCodes: Readonly<Partial<Record<Read, string>>>;
  readonly #currency: Currency | undefined;
  readonly #domesticOperator: string | undefined;

  constructor(options: IronGateCatalogueOptions) {
    try {
      const base = new URL(options.baseUrl), codes = Object.entries(options.successCodes);
      const currency = options.prepaidCurrency, operator = options.domesticEsimOperator;
      if (base.protocol !== 'https:' || (options.baseUrl !== base.origin && options.baseUrl !== base.origin + '/') ||
          typeof options.account.tenantId !== 'string' || !uuid.test(options.account.tenantId) ||
          typeof options.account.providerAccountId !== 'string' || !uuid.test(options.account.providerAccountId) ||
          !codes.length || codes.some(([read, code]) => !Object.hasOwn(signatures, read) || typeof code !== 'string' || !selector.test(code)) ||
          (Object.hasOwn(options.successCodes, 'prepaid') || currency !== undefined) && currency !== 'IDR' && currency !== 'USD' ||
          (Object.hasOwn(options.successCodes, 'esimIndonesia') || operator !== undefined) && (typeof operator !== 'string' || !selector.test(operator)) ||
          typeof options.getCredentials !== 'function') throw invalid();
      this.#origin = base.origin;
      this.#account = Object.freeze({ tenantId: options.account.tenantId, providerAccountId: options.account.providerAccountId });
      this.#successCodes = Object.freeze(Object.assign(Object.create(null) as Partial<Record<Read, string>>, Object.fromEntries(codes)));
      this.#currency = currency;
      this.#domesticOperator = operator;
      this.#fetch = options.fetch ?? globalThis.fetch;
      this.#getCredentials = options.getCredentials;
    } catch { throw new IronGateCatalogueError('INVALID_CONFIGURATION'); }
  }

  async listPrepaidPrices(account: IronGateAccountBinding, signal?: AbortSignal) {
    const allowedCurrency = this.#currency;
    if (!allowedCurrency) throw new IronGateCatalogueError('SCOPE_DENIED');
    const data = await this.#read(account, 'prepaid', '/api/pricelist', { currency: allowedCurrency }, signal);
    const products = rows(data['pricelist']).map(item => {
      const currency = item['currency'];
      if (currency !== allowedCurrency) throw invalid();
      return { sourceId: text(item['product_code']), description: text(item['product_description']),
        nominal: text(item['product_nominal']), sourcePrice: decimal(item['product_price']), currency,
        productType: text(item['product_type']), category: text(item['product_category']), sourceStatus: text(item['status']),
        activePeriod: text(item['active_period'], 256, true) };
    });
    return this.#result(immutableRows(products, item => item.sourceId));
  }

  async listPostpaidPrices(account: IronGateAccountBinding, signal?: AbortSignal) {
    const data = await this.#read(account, 'postpaid', '/api/v1/bill/check', { commands: 'pricelist-pasca' }, signal);
    const products = rows(data['pasca']).map(item => {
      const status = item['status'];
      if (status !== 1 && status !== 4) throw invalid();
      return { sourceId: text(item['code']), name: text(item['name']), sourceStatus: status,
        sourceFee: decimal(item['fee']), sourceCommission: decimal(item['komisi']),
        productType: text(item['type']), category: text(item['category']),
        ...(item['province'] !== undefined ? { province: text(item['province'], 256, true) } : {}) };
    });
    return this.#result(immutableRows(products, item => item.sourceId));
  }

  async listGameCodes(account: IronGateAccountBinding, signal?: AbortSignal) {
    const data = await this.#read(account, 'games', '/api/gamelist', {}, signal);
    const games = rows(data['gamelist']).map(item => {
      const sourceId = wireNumber(item['game_code']);
      if (sourceId === undefined || !/^[0-9]{1,16}$/.test(sourceId)) throw invalid();
      return { sourceId, name: text(item['name']) };
    });
    return this.#result(immutableRows(games, item => item.sourceId));
  }

  async getIndonesiaEsimAvailability(account: IronGateAccountBinding, signal?: AbortSignal) {
    const operator = this.#domesticOperator;
    if (!operator) throw new IronGateCatalogueError('SCOPE_DENIED');
    const data = await this.#read(account, 'esimIndonesia', `/api/esimlist/${operator}`, {}, signal);
    const inventory = rows(data['esimlist']).map(item => text(item['number'], 64));
    if (new Set(inventory).size !== inventory.length) throw invalid();
    return this.#result(Object.freeze({ operator, country: 'ID' as const, observedCount: inventory.length }));
  }

  async listInternationalEsimCoverage(account: IronGateAccountBinding, signal?: AbortSignal) {
    const data = await this.#read(account, 'esimInternational', '/api/esiminternationallist', {}, signal);
    if (typeof data['status'] !== 'number' || !Number.isFinite(data['status'])) throw invalid();
    const coverage = rows(data['list']).map(item => ({ sourceId: text(item['slug']), name: text(item['name']),
      sourceType: text(item['type']), countries: immutableRows(rows(item['countries']).map(country => ({
        name: text(country['name']), sourceCode: text(country['code'], 16),
      })), country => country.sourceCode) }));
    return this.#result(immutableRows(coverage, item => item.sourceId));
  }

  #result<T>(data: T) { return Object.freeze({ account: this.#account, sourceVersion: contract, data }); }

  async #read(account: IronGateAccountBinding, read: Read, path: string, params: Record<string, string>, parent?: AbortSignal) {
    const successCode = this.#successCodes[read];
    if (!successCode || account?.tenantId !== this.#account.tenantId || account.providerAccountId !== this.#account.providerAccountId)
      throw new IronGateCatalogueError('SCOPE_DENIED');
    const deadline = AbortSignal.timeout(5000);
    const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
    try {
      const { username, apiKey } = await withinCatalogueDeadline(() => this.#getCredentials(this.#account, signal), signal);
      if (typeof username !== 'string' || !credential.test(username) || typeof apiKey !== 'string' || !credential.test(apiKey)) throw invalid();
      const sign = createHash('md5').update(username + apiKey + signatures[read]).digest('hex');
      const url = this.#origin + path;
      const response = await withinCatalogueDeadline(() => this.#fetch(url, { method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ ...params, username, sign }), signal, redirect: 'error', cache: 'no-store', credentials: 'omit' }), signal);
      if (response.status !== 200 || response.redirected || response.url && response.url !== url) {
        void response.body?.cancel().catch(() => undefined);
        throw new IronGateCatalogueError('UNAVAILABLE');
      }
      const envelope = record(await readCatalogueJson(response, signal, exactFields, invalid));
      signal.throwIfAborted();
      const data = record(envelope['data']);
      if (data['rc'] !== successCode) throw new IronGateCatalogueError('UNAVAILABLE');
      return data;
    } catch (error) {
      if (!signal.aborted && error instanceof IronGateCatalogueError && error.code === 'INVALID_RESPONSE') throw invalid();
      throw new IronGateCatalogueError('UNAVAILABLE');
    }
  }
}
