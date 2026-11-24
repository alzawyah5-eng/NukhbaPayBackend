import { readCatalogueJson, wireNumber, withinCatalogueDeadline } from './catalogue-http.ts';

type SslWirelessContract = 'mobile-top-up/8.2.0' | 'utilities/1.6.1';

export interface SslWirelessAccountBinding {
  readonly tenantId: string;
  readonly providerAccountId: string;
}

export interface SslWirelessCatalogueOptions {
  readonly account: SslWirelessAccountBinding;
  readonly contract: SslWirelessContract;
  readonly baseUrl: string;
  /** Exact category_value values approved for the account. */
  readonly allowedCategories: readonly string[];
  /** Optional narrower Mobile Top-Up operator scope approved for this account. */
  readonly allowedOperatorIds?: readonly string[];
  /** Approved SUB-CHANNEL-ID header value when required by the provider account. */
  readonly subChannelId?: string;
  readonly getCredentials: (account: SslWirelessAccountBinding, signal: AbortSignal) => Promise<{
    readonly stkCode: string;
    readonly authKey: string;
  }>;
  readonly fetch?: typeof fetch;
}

type Failure = 'INVALID_CONFIGURATION' | 'SCOPE_DENIED' | 'UNAVAILABLE' | 'INVALID_RESPONSE';

export class SslWirelessCatalogueError extends Error {
  readonly code: Failure;
  constructor(code: Failure) {
    super('SSL Wireless catalogue request failed');
    this.name = 'SslWirelessCatalogueError';
    this.code = code;
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const header = /^[!-~]{1,512}$/;
const exactFields = new Set(['amount', 'operator_id']);
const operatorCode = /^[0-9]{1,16}$/;
const invalid = () => new SslWirelessCatalogueError('INVALID_RESPONSE');

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  return value;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) throw invalid();
  return value;
}

function parseServices(data: unknown, allowed: ReadonlySet<string>) {
  const categories = [];
  for (const raw of array(data)) {
    const category = object(raw);
    const sourceValue = text(category['category_value']);
    if (!allowed.has(sourceValue)) continue;
    const services = array(category['data']).map(item => {
      const service = object(item);
      const details = array(service['data']).map(entry => {
        const detail = object(entry);
        return Object.freeze({ billType: text(detail['utility_bill_type']), status: text(detail['biller_status']) });
      });
      // The vendor includes biller credentials and action URLs among these fields.
      return Object.freeze({ sourceValue: text(service['utility_value']), details: Object.freeze(details) });
    });
    categories.push(Object.freeze({ sourceValue, name: text(category['category_name']), services: Object.freeze(services) }));
  }
  return Object.freeze(categories);
}

function parsePackages(data: unknown, allowed: ReadonlySet<string> | undefined) {
  const result = object(data);
  const list = array(result['list']);
  if (result['count'] !== list.length) throw invalid();
  return Object.freeze(list.flatMap(raw => {
    const item = object(raw);
    const operatorId = wireNumber(item['operator_id']) ?? item['operator_id'];
    if (typeof operatorId !== 'string' || !operatorCode.test(operatorId)) throw invalid();
    if (allowed && !allowed.has(operatorId)) return [];
    const amount = wireNumber(item['amount']);
    const connectionType = item['connection_type'];
    if (typeof amount !== 'string' || !/^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?(?:[eE][+-]?\d{1,2})?$/.test(amount) ||
        !/[1-9]/.test(amount.split(/[eE]/, 1)[0]!) || (connectionType !== 'prepaid' && connectionType !== 'postpaid')) throw invalid();
    return [Object.freeze({ operatorId, operatorName: text(item['operator_name']), connectionType,
      rechargeAmount: amount, offerType: text(item['offer_type']), offerTitle: text(item['offer_title']) })];
  }));
}

/** Read-only SSL Wireless discovery. It has no fulfilment, inquiry or publication path. */
export class SslWirelessCatalogue {
  readonly #account: SslWirelessAccountBinding;
  readonly #contract: SslWirelessContract;
  readonly #origin: string;
  readonly #allowed: ReadonlySet<string>;
  readonly #operatorIds: ReadonlySet<string> | undefined;
  readonly #subChannelId: string | undefined;
  readonly #credentials: SslWirelessCatalogueOptions['getCredentials'];
  readonly #fetch: typeof fetch;

  constructor(options: SslWirelessCatalogueOptions) {
    try {
      const base = new URL(options.baseUrl);
      const operatorIds = options.allowedOperatorIds;
      const subChannelId = options.subChannelId;
      if (base.protocol !== 'https:' || base.href !== base.origin + '/' ||
          (options.baseUrl !== base.origin && options.baseUrl !== base.href) ||
          typeof options.account.tenantId !== 'string' || !uuid.test(options.account.tenantId) ||
          typeof options.account.providerAccountId !== 'string' || !uuid.test(options.account.providerAccountId) ||
          !['mobile-top-up/8.2.0', 'utilities/1.6.1'].includes(options.contract) ||
          !Array.isArray(options.allowedCategories) || options.allowedCategories.length < 1 || options.allowedCategories.length > 64 ||
          typeof options.getCredentials !== 'function') throw invalid();
      if (operatorIds !== undefined && (options.contract !== 'mobile-top-up/8.2.0' || !Array.isArray(operatorIds) ||
          operatorIds.length < 1 || operatorIds.length > 64 || Array.from(operatorIds).some(id => typeof id !== 'string' || !operatorCode.test(id)))) throw invalid();
      if (subChannelId !== undefined && (typeof subChannelId !== 'string' || !/^[0-9]{1,32}$/.test(subChannelId))) throw invalid();
      this.#origin = base.origin;
      this.#account = Object.freeze({ tenantId: options.account.tenantId, providerAccountId: options.account.providerAccountId });
      this.#contract = options.contract;
      this.#allowed = new Set(options.allowedCategories.map(text));
      this.#operatorIds = operatorIds ? new Set(operatorIds) : undefined;
      this.#subChannelId = subChannelId;
      this.#credentials = options.getCredentials;
      this.#fetch = options.fetch ?? globalThis.fetch;
    } catch { throw new SslWirelessCatalogueError('INVALID_CONFIGURATION'); }
  }

  async listServices(account: SslWirelessAccountBinding, signal?: AbortSignal) {
    const data = await this.#get(account, '/api/service-list', signal);
    return Object.freeze({ account: this.#account, sourceVersion: this.#contract, country: 'BD' as const, categories: parseServices(data, this.#allowed) });
  }

  async listTopUpPackages(account: SslWirelessAccountBinding, signal?: AbortSignal) {
    if (this.#contract !== 'mobile-top-up/8.2.0') throw new SslWirelessCatalogueError('SCOPE_DENIED');
    const data = await this.#get(account, '/api/vr/package-list', signal);
    return Object.freeze({ account: this.#account, sourceVersion: this.#contract, country: 'BD' as const, packages: parsePackages(data, this.#operatorIds) });
  }

  async #get(account: SslWirelessAccountBinding, route: '/api/service-list' | '/api/vr/package-list', parent?: AbortSignal) {
    if (account?.tenantId !== this.#account.tenantId || account.providerAccountId !== this.#account.providerAccountId)
      throw new SslWirelessCatalogueError('SCOPE_DENIED');
    const deadline = AbortSignal.timeout(5000);
    const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
    try {
      const credentials = await withinCatalogueDeadline(() => this.#credentials(this.#account, signal), signal);
      if (!credentials || typeof credentials.stkCode !== 'string' || typeof credentials.authKey !== 'string' ||
          !header.test(credentials.stkCode) || !header.test(credentials.authKey)) throw new SslWirelessCatalogueError('UNAVAILABLE');
      const url = this.#origin + route;
      const request = async () => {
        const response = await withinCatalogueDeadline(() => this.#fetch(url, { method: 'GET', headers: { Accept: 'application/json',
          'STK-CODE': credentials.stkCode, 'AUTH-KEY': credentials.authKey,
          ...(this.#subChannelId === undefined ? {} : { 'SUB-CHANNEL-ID': this.#subChannelId }) }, signal,
          redirect: 'error', cache: 'no-store', credentials: 'omit' }), signal);
        if (response.redirected || response.url && response.url !== url) {
          void response.body?.cancel().catch(() => undefined);
          throw new SslWirelessCatalogueError('UNAVAILABLE');
        }
        return response;
      };
      let response = await request();
      if ([502, 503, 504].includes(response.status)) {
        void response.body?.cancel().catch(() => undefined);
        response = await request();
      }
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        throw new SslWirelessCatalogueError('UNAVAILABLE');
      }
      const envelope = object(await readCatalogueJson(response, signal, exactFields, invalid));
      signal.throwIfAborted();
      if (envelope['status'] === 'error') throw new SslWirelessCatalogueError('UNAVAILABLE');
      if (envelope['status'] !== 'success') throw invalid();
      return envelope['data'];
    } catch (error) {
      if (!signal.aborted && error instanceof SslWirelessCatalogueError && error.code === 'INVALID_RESPONSE') throw invalid();
      throw new SslWirelessCatalogueError('UNAVAILABLE');
    }
  }
}
