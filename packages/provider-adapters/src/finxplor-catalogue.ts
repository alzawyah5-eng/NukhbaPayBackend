import type { ProviderCostEvidence } from '../../provider-contracts/src/acquisition-cost.ts';
import { SOURCE_GEOGRAPHY } from '../../domain/src/source-geography.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { readCatalogueJson, wireNumber, withinCatalogueDeadline } from './catalogue-http.ts';

const origin = 'https://sandbox.finxplorconnect.com';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const reference = /^[A-Za-z0-9][A-Za-z0-9/_.:-]{0,127}$/;
const money = /^(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,18})?$/;
export const finxplorExactFields: ReadonlySet<string> = new Set([
  'minAmount', 'maxAmount', ...Array.from({ length: 128 }, (_, index) => String(index)),
]);
const unavailable = () => new Error('Finxplor catalogue read unavailable');
const maxCatalogueProducts = 1000;
const maxPageSize = 100;
const maxScopedPages = 40;
const scopeId = 'ARE_GIFT_CARD';

export interface FinxplorCoverage {
  readonly scope: typeof scopeId;
  readonly pages: number;
  readonly rows: readonly FinxplorProduct[];
  readonly observedAt: string;
}
export interface FinxplorReadProgress {
  readonly pagesRetrieved:number;
  readonly requests:number;
  readonly products:number;
  readonly rejected:number;
}

export class FinxplorCatalogueChanged extends Error {
  constructor() { super('Finxplor catalogue changed during verification'); }
}

export interface FinxplorGlobalCheckpoint {
  readonly observedAt: string;
  readonly pages: readonly (readonly FinxplorProduct[])[];
  readonly confirmations: readonly (readonly string[])[];
  readonly differences?: readonly FinxplorProduct[];
  savePage(page: number, rows: readonly FinxplorProduct[]): Promise<void>;
  saveConfirmation(page: number, ids: readonly string[], differences?: readonly FinxplorProduct[]): Promise<void>;
}

class FinxplorPageRejected extends Error {}

class FinxplorReadFailure extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs = 0) {
    super('Finxplor catalogue read unavailable');
    this.retryAfterMs = retryAfterMs;
  }
}

export interface FinxplorAccount {
  readonly tenantId: string;
  readonly providerAccountId: string;
}

export interface FinxplorCatalogueFilter {
  readonly country?: string;
  readonly category?: string;
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
  readonly sourceCountryLabel?: string;
  readonly sourceCategoryLabel?: string;
  readonly usage?: string;
  readonly imageUrl?: string;
}

/** The catalogue contract supplies denominations, but no guaranteed acquisition debit. */
export function finxplorCatalogueCostEvidence(product: FinxplorProduct): ProviderCostEvidence {
  if (!identifier.test(product.sourceId)) throw unavailable();
  return Object.freeze({ basis: 'QUOTE_REQUIRED', sourceReference: product.sourceId });
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

function displayField(value: unknown, maximum: number): string {
  return field(typeof value==='string' ? value.replace(/[\t\r\n]+/g,' ') : value,maximum);
}

function amount(value: unknown): string {
  const exact = typeof value === 'string' ? value : wireNumber(value);
  if (!exact || !money.test(exact)) throw unavailable();
  return exact;
}

const countryByAlpha2 = new Map(Object.entries(SOURCE_GEOGRAPHY).map(([alpha3,[alpha2]])=>[alpha2,alpha3]));
const providerCountryAliases = new Map([['LO','LAO']]);
const sourceCountry = (value: string) => countryByAlpha2.get(value) ?? providerCountryAliases.get(value) ??
  (/^[A-Z]{2}$/.test(value) ? 'X'+value : value);

export function normalizeFinxplorProduct(value: unknown, scope?: typeof scopeId, detail = false): FinxplorProduct {
  const row = object(value);
  const sourceId = field(row['productId'], 128);
  const rawCountry = field(row['countryCode'], 3);
  const country = sourceCountry(rawCountry);
  const rawCategory = field(row['category'], 80);
  const usage = detail ? row['usage'] ?? row['usageType'] : undefined;
  const category = scope === scopeId && (rawCategory === 'Gift Card' || (detail && rawCategory === 'Gift Cards'))
    ? 'Gift Card' : rawCategory;
  const currency = field(row['currency'], 3);
  const denominations = row['denominations'];
  const image = row['imageUrl'];
  const imageUrl = typeof image === 'string' && image.length <= 2048 &&
    /^https:\/\/finxplorconnect[.]com\/api\/v1\/media\/[A-Za-z0-9_+\/=-]+$/.test(image) ? image : undefined;
  if (!identifier.test(sourceId) || !/^[A-Z]{3}$/.test(country) || !/^[A-Z]{3}$/.test(currency) ||
      !Array.isArray(denominations) || denominations.length > 128) throw unavailable();
  return Object.freeze({
    sourceId, country, currency, name: displayField(row['productName'],128), brand: displayField(row['brand'],128),
    category, delivery: field(row['deliveryMethod'], 80),
    denominations: Object.freeze(denominations.map(amount)),
    minAmount: amount(row['minAmount']), maxAmount: amount(row['maxAmount']),
    ...(scope && { sourceCountryLabel: rawCountry, sourceCategoryLabel: rawCategory }),
    ...(usage !== undefined && { usage: field(usage, 80) }),
    ...(imageUrl && {imageUrl}),
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

  async page(account: FinxplorAccount, page: number, limit: number, parent?: AbortSignal, filter?: FinxplorCatalogueFilter) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > maxPageSize) throw unavailable();
    const url = new URL('/api/v1/products', origin);
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (filter?.country !== undefined) {
      if (!/^[A-Z]{2,3}$/.test(filter.country)) throw unavailable();
      query.set('country', filter.country);
    }
    if (filter?.category !== undefined) query.set('category', field(filter.category, 80));
    url.search = query.toString();
    return this.#read(account, url, parent, body => {
      const pagination = object(body['pagination']);
      const total = pagination['total'], totalPages = pagination['totalPages'];
      if (!Array.isArray(body['data']) || body['data'].length > limit ||
          pagination['page'] !== page || pagination['limit'] !== limit || typeof total !== 'number' ||
          !Number.isSafeInteger(total) || total < 0 || totalPages !== Math.ceil(total / limit) ||
          pagination['hasNextPage'] !== (page < totalPages) ||
          body['data'].length !== Math.max(0, Math.min(limit, total - (page - 1) * limit))) throw unavailable();
      const products = Object.freeze(body['data'].map(row => normalizeFinxplorProduct(row)));
      if (new Set(products.map(item => item.sourceId)).size !== products.length) throw unavailable();
      return Object.freeze({ products, total, totalPages, hasNextPage: page < totalPages });
    });
  }

  async detail(account: FinxplorAccount, sourceId: string, parent?: AbortSignal, scope?: typeof scopeId): Promise<FinxplorProduct> {
    if (typeof sourceId !== 'string' || !identifier.test(sourceId)) throw unavailable();
    const url = new URL('/api/v1/products/' + encodeURIComponent(sourceId), origin);
    return this.#read(account, url, parent, body => {
      const detail = normalizeFinxplorProduct(object(body['data'])['product'], scope, scope !== undefined);
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
        if (response.status === 429 || [408, 500, 502, 503, 504].includes(response.status)) {
          const retry = response.headers.get('retry-after');
          const waitMs = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 0;
          throw new FinxplorReadFailure(Number.isFinite(waitMs) ? Math.max(0, waitMs) : Infinity);
        }
        throw unavailable();
      }
      const body = object(await readCatalogueJson(response, signal, finxplorExactFields, unavailable));
      if (body['success'] !== true) throw unavailable();
      const result = project(body);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (error instanceof FinxplorReadFailure) throw error;
      if (deadline.aborted && !parent?.aborted || error instanceof TypeError && error.message === 'fetch failed') {
        throw new FinxplorReadFailure();
      }
      throw unavailable();
    }
  }

  /** The verified sandbox case reports per-page totals. Check this contract on
   * every page, then require a second identical walk including the empty page. */
  async scopedCatalogue(account: FinxplorAccount, scope: typeof scopeId, parent?: AbortSignal,
    observe?: (value: FinxplorReadProgress) => void): Promise<FinxplorCoverage> {
    if (scope !== scopeId) throw unavailable();
    const deadline = AbortSignal.timeout(145_000);
    const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
    const observedAt = new Date().toISOString();
    let nextRequest = 0;
    let pagesRetrieved = 0, requests = 0, staged = 0, rejected = 0;
    const notify = () => observe?.({ pagesRetrieved, requests, products: staged, rejected });
    const rejectRow = () => { rejected++; notify(); throw unavailable(); };
    const walk = async (confirmation:boolean) => {
      const seen = new Set<string>(), rows: FinxplorProduct[] = [];
      let short = false, terminalPage: number | undefined;
      for (let page = 1; page <= maxScopedPages + 1; page++) {
        if (signal.aborted) throw unavailable();
        const url = new URL('/api/v1/products', origin);
        url.search = new URLSearchParams({ page: String(page), limit: String(maxPageSize), country: 'ARE', category: 'Gift Card' }).toString();
        let products: FinxplorProduct[] | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          const pause = nextRequest - Date.now();
          if (pause > 0) await sleep(pause, undefined, { signal });
          nextRequest = Date.now() + 1_250;
          requests++; notify();
          try {
            products = await this.#read(account, url, signal, body => {
              const p = object(body['pagination']), data = body['data'];
              pagesRetrieved++; notify();
              if (!Array.isArray(data) || data.length > maxPageSize || p['page'] !== page || p['limit'] !== maxPageSize ||
                  p['total'] !== data.length || p['totalPages'] !== Number(data.length > 0) || p['hasNextPage'] !== false) throw unavailable();
              return data.map(row => {
                try { return normalizeFinxplorProduct(row, scope); }
                catch { return rejectRow(); }
              });
            });
            break;
          } catch (error) {
            if (!(error instanceof FinxplorReadFailure) || error.retryAfterMs > 15_000 ||
                signal.aborted || attempt === 2) throw error;
            nextRequest = Math.max(nextRequest, Date.now() + Math.max(error.retryAfterMs, 1000 * 2 ** attempt));
          }
        }
        if (!products) throw unavailable();
        if (!products.length) {
          if (!rows.length) throw unavailable();
          if (terminalPage !== undefined) return { rows, pages: terminalPage };
          terminalPage = page;
          continue;
        }
        if (short || terminalPage !== undefined || page >= maxScopedPages) throw unavailable();
        short = products.length < maxPageSize;
        for (const product of products) {
          if (product.country !== 'ARE' || product.category !== 'Gift Card' || seen.has(product.sourceId)) rejectRow();
          seen.add(product.sourceId);
          rows.push(product);
        }
        if (!confirmation) { staged = rows.length; notify(); }
      }
      throw unavailable();
    };
    const result = await walk(false), confirmation = await walk(true);
    if (result.pages !== confirmation.pages || JSON.stringify(result.rows) !== JSON.stringify(confirmation.rows)) throw unavailable();
    return Object.freeze({ scope, pages: result.pages, rows: Object.freeze(result.rows), observedAt });
  }

  /** The sandbox only reports the number of items returned on a page. */
  async unfilteredPage(account: FinxplorAccount, page: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(page) || page<1 || page>1000) throw unavailable();
    const url = new URL('/api/v1/products', origin);
    url.search = new URLSearchParams({page:String(page),limit:'100'}).toString();
    return this.#read(account,url,signal,body=>{
      const pagination = object(body['pagination']), data = body['data'];
      if (!Array.isArray(data) || data.length>100 || pagination['page']!==page || pagination['limit']!==100) throw unavailable();
      return data.map(row=>normalizeFinxplorProduct(row,scopeId));
    });
  }

  /** Resume approved pages after transient upstream errors. Full coverage requires an
   * empty final page and a second independent traversal with the same product data. */
  async globalCatalogue(account: FinxplorAccount, parent?: AbortSignal, observe?: (value:FinxplorReadProgress)=>void,
    checkpoint?: FinxplorGlobalCheckpoint) {
    if (account.tenantId!==this.#account.tenantId || account.providerAccountId!==this.#account.providerAccountId) throw unavailable();
    const signal = parent ? AbortSignal.any([parent,AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000);
    let requests=0, pagesRetrieved=0;
    const pages = [...checkpoint?.pages ?? []];
    const productEvidence = ({imageUrl:_imageUrl,...product}:FinxplorProduct) => JSON.stringify(product);
    const rows: FinxplorProduct[] = [];
    const seen = new Map<string,string>();
    const add = (products: readonly FinxplorProduct[]) => {
      for (const product of products) {
        const evidence = productEvidence(product);
        const previous = seen.get(product.sourceId);
        if (previous!==undefined && previous!==evidence) throw new FinxplorCatalogueChanged();
        if (previous===undefined) {
          seen.set(product.sourceId,evidence);
          rows.push(product);
        }
      }
    };
    for (const page of pages) add(page);
    const observedAt = checkpoint?.observedAt ?? new Date().toISOString();
    const notify = () => observe?.({requests,pagesRetrieved,products:rows.length,rejected:0});
    const readPage = async (page:number) => {
      for (let attempt=0; ;attempt++) {
        try {
          requests++;
          notify();
          const products = await this.unfilteredPage(account,page,signal);
          pagesRetrieved++;
          notify();
          return products;
        } catch (error) {
          if (!(error instanceof FinxplorReadFailure)) throw new FinxplorPageRejected();
          if (attempt===2 || error.retryAfterMs>15_000 || signal.aborted) throw error;
          await sleep(Math.max(error.retryAfterMs,2_000*2**attempt),undefined,{signal});
        }
      }
    };
    let nextPage = pages.length+1;
    const updates = new Map(checkpoint?.differences?.map(product=>[product.sourceId,product]));
    const partial = (verifying: boolean, verificationMismatch = false) => {
      const merged = rows.map(product=>updates.get(product.sourceId)??product);
      for (const [id,product] of updates) if (!seen.has(id)) merged.push(product);
      return {rows:merged,pages:Math.max(pages.filter(page=>page.length>0).length,Math.ceil(merged.length/100)),
        scope:'PARTIAL_ALL_COUNTRIES' as const,observedAt,nextPage,verificationPending:verifying,verificationMismatch};
    };
    try {
      if (pages.at(-1)?.length!==0) {
        for (let page=nextPage;page<=1000;page++) {
          nextPage=page;
          const products = await readPage(page);
          if (!products.length && !rows.length) throw unavailable();
          add(products);
          await checkpoint?.savePage(page,products);
          pages.push(products);
          notify();
          if (!products.length) {
            if (checkpoint) {
              nextPage=1;
              return partial(true);
            }
            break;
          }
          await sleep(1_250,undefined,{signal});
        }
      }
      if (pages.at(-1)?.length!==0) throw unavailable();

      const confirmations = [...checkpoint?.confirmations ?? []];
      const verified = new Set(confirmations.flat());
      if ([...verified].some(id=>!seen.has(id) && !updates.has(id))) throw new FinxplorCatalogueChanged();
      if (confirmations.at(-1)?.length!==0) {
        for (let page=confirmations.length+1;page<=1000;page++) {
          nextPage=page;
          const products=await readPage(page);
          const differences: FinxplorProduct[] = [];
          for (const product of products) {
            if (seen.get(product.sourceId)!==productEvidence(product)) {
              if (!checkpoint) throw new FinxplorCatalogueChanged();
              updates.set(product.sourceId,product);
              differences.push(product);
            }
            verified.add(product.sourceId);
          }
          const ids=products.map(product=>product.sourceId);
          await checkpoint?.saveConfirmation(page,ids,differences);
          confirmations.push(ids);
          if (!products.length) break;
          await sleep(1_250,undefined,{signal});
        }
      }
      if (confirmations.at(-1)?.length!==0) throw unavailable();
      if (updates.size || verified.size!==seen.size) {
        if (!checkpoint) throw new FinxplorCatalogueChanged();
        nextPage=1;
        return partial(false,true);
      }
      return {rows,pages:pages.length,scope:'ALL_COUNTRIES' as const,observedAt};
    } catch (error) {
      if (checkpoint && rows.length && (error instanceof FinxplorReadFailure || error instanceof FinxplorPageRejected || signal.aborted)) {
        return partial(pages.at(-1)?.length===0);
      }
      throw error;
    }
  }

  async fullCatalogue(account: FinxplorAccount, signal?: AbortSignal, filter?: FinxplorCatalogueFilter) {
    const first = await this.page(account, 1, maxPageSize, signal, filter);
    if (first.total < 1 || first.total > maxCatalogueProducts) throw unavailable();
    const products = new Map(first.products.map(item => [item.sourceId, item]));
    for (let page = 2; page <= first.totalPages; page++) {
      const next = await this.page(account, page, maxPageSize, signal, filter);
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
