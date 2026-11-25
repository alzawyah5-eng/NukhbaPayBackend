import { readCatalogueJson, wireNumber, withinCatalogueDeadline } from './catalogue-http.ts';

const origin = 'https://sandbox.finxplorconnect.com';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const reference = /^[A-Za-z0-9][A-Za-z0-9/_.:-]{0,127}$/;
const money = /^(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,18})?$/;
const exactFields = new Set(['minAmount', 'maxAmount', ...Array.from({ length: 128 }, (_, index) => String(index))]);
const unavailable = () => new Error('Finxplor catalogue read unavailable');
const maxCatalogueProducts = 1000;
const maxPageSize = 100;

export interface FinxplorAccount {
  readonly tenantId: string;
  readonly providerAccountId: string;
}

export interface FinxplorProduct {
  readonly sourceId: string;
  readonly name: string;
  readonly brand: string;
  readonly country: string;
  readonly currency: string;
  readonly category: string;
  readonly delivery: string;
  readonly denominations: readonly string[];
  readonly minAmount: string;
  readonly maxAmount: string;
}

interface Options {
  readonly account: FinxplorAccount;
  readonly credentialReference: string;
  readonly getApiKey: (account: FinxplorAccount, reference: string, signal: AbortSignal) => Promise<string>;
  readonly transport: typeof fetch;
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
};

function field(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw unavailable();
  return value.trim();
}

function amount(value: unknown): string {
  const exact = typeof value === 'string' ? value : wireNumber(value);
  if (!exact || !money.test(exact)) throw unavailable();
  return exact;
}

function product(value: unknown): FinxplorProduct {
  const row = object(value);
  const sourceId = field(row['productId'], 128);
  const country = field(row['countryCode'], 3);
  const currency = field(row['currency'], 3);
  const denominations = row['denominations'];
  if (!identifier.test(sourceId) || !/^[A-Z]{3}$/.test(country) || !/^[A-Z]{3}$/.test(currency) ||
      !Array.isArray(denominations) || denominations.length > 128) throw unavailable();
  return Object.freeze({
    sourceId, country, currency, name: field(row['productName'], 128), brand: field(row['brand'], 128),
    category: field(row['category'], 80), delivery: field(row['deliveryMethod'], 80),
    denominations: Object.freeze(denominations.map(amount)),
    minAmount: amount(row['minAmount']), maxAmount: amount(row['maxAmount']),
  });
}

/** Sandbox catalogue only. Source denominations are retained as decimal text without assigning cost or availability. */
export class FinxplorCatalogue {
  readonly #account: FinxplorAccount;
  readonly #reference: string;
  readonly #getApiKey: Options['getApiKey'];
  readonly #transport: typeof fetch;

  constructor(options: Options) {
    this.#account = Object.freeze({ ...options.account });
    if (!uuid.test(this.#account.tenantId) || !uuid.test(this.#account.providerAccountId) ||
        !reference.test(options.credentialReference) || typeof options.getApiKey !== 'function' ||
        typeof options.transport !== 'function') throw unavailable();
    this.#reference = options.credentialReference;
    this.#getApiKey = options.getApiKey;
    this.#transport = options.transport;
  }

  async page(account: FinxplorAccount, page: number, limit: number, parent?: AbortSignal) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > maxPageSize) throw unavailable();
    const url = new URL('/api/v1/products', origin);
    url.search = new URLSearchParams({ page: String(page), limit: String(limit) }).toString();
    return this.#read(account, url, parent, body => {
      const pagination = object(body['pagination']);
      const total = pagination['total'], totalPages = pagination['totalPages'];
      if (!Array.isArray(body['data']) || body['data'].length > limit ||
          pagination['page'] !== page || pagination['limit'] !== limit || typeof total !== 'number' ||
          !Number.isSafeInteger(total) || total < 0 || totalPages !== Math.ceil(total / limit) ||
          pagination['hasNextPage'] !== (page < totalPages) ||
          body['data'].length !== Math.max(0, Math.min(limit, total - (page - 1) * limit))) throw unavailable();
      const products = Object.freeze(body['data'].map(product));
      if (new Set(products.map(item => item.sourceId)).size !== products.length) throw unavailable();
      return Object.freeze({ products, total, totalPages, hasNextPage: page < totalPages });
    });
  }

  async detail(account: FinxplorAccount, sourceId: string, parent?: AbortSignal): Promise<FinxplorProduct> {
    if (typeof sourceId !== 'string' || !identifier.test(sourceId)) throw unavailable();
    const url = new URL('/api/v1/products/' + encodeURIComponent(sourceId), origin);
    return this.#read(account, url, parent, body => {
      const detail = product(object(body['data'])['product']);
      if (detail.sourceId !== sourceId) throw unavailable();
      return detail;
    });
  }

  async #read<T>(account: FinxplorAccount, url: URL, parent: AbortSignal | undefined,
    project: (body: Record<string, unknown>) => T): Promise<T> {
    if (account.tenantId !== this.#account.tenantId || account.providerAccountId !== this.#account.providerAccountId) throw unavailable();
    const deadline = AbortSignal.timeout(12_000);
    const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
    try {
      const key = await withinCatalogueDeadline(() => this.#getApiKey(this.#account, this.#reference, signal), signal);
      if (typeof key !== 'string' || !/^[!-~]{12,1024}$/.test(key) || key.includes('*')) throw unavailable();
      const response = await withinCatalogueDeadline(() => this.#transport(url.href, {
        method: 'GET', headers: { Accept: 'application/json', 'x-api-key': key }, signal,
        redirect: 'error', cache: 'no-store', credentials: 'omit',
      }), signal);
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url.href)) {
        void response.body?.cancel().catch(() => undefined);
        throw unavailable();
      }
      const body = object(await readCatalogueJson(response, signal, exactFields, unavailable));
      if (body['success'] !== true) throw unavailable();
      const result = project(body);
      signal.throwIfAborted();
      return result;
    } catch { throw unavailable(); }
  }

  async fullCatalogue(account: FinxplorAccount, signal?: AbortSignal) {
    const first = await this.page(account, 1, maxPageSize, signal);
    if (first.total < 1 || first.total > maxCatalogueProducts) throw unavailable();
    const products = new Map(first.products.map(item => [item.sourceId, item]));
    for (let page = 2; page <= first.totalPages; page++) {
      const next = await this.page(account, page, maxPageSize, signal);
      if (next.total !== first.total || next.totalPages !== first.totalPages) throw unavailable();
      for (const item of next.products) {
        if (products.has(item.sourceId)) throw unavailable();
        products.set(item.sourceId, item);
      }
    }
    if (products.size !== first.total) throw unavailable();
    return Object.freeze([...products.values()]);
  }
}
