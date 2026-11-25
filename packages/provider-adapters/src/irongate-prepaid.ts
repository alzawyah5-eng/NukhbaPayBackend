import type { IronGateAccountBinding } from './irongate-catalogue.ts';
import { createIronGateTransactionTransport, exactNumeric, identifier, IronGateTransactionError, isRecord,
  unconfirmed, unsignedInteger, type IronGateTransactionOptions } from './irongate-transaction-http.ts';

const paths = { balance: '/api/check-balance', operator: '/api/check-operator', pln: '/api/inquiry-pln', ovo: '/api/inquiry-ovo',
  game: '/api/check-game-id', subscriber: '/api/check-number', packages: '/api/check-number-packages',
  topUp: '/api/top-up', status: '/api/check-status', activateEsim: '/api/esim/notification/activation' } as const;
const legacyCommands = { balance: 'balance', legacyPriceList: 'pricelist', pln: 'inquiry_pln', legacyGameFormat: 'game-format-id',
  legacyGameServers: 'game-server-list', topUp: 'topup', legacyAutoTopUp: 'topup', status: 'inquiry' } as const;
type Operation = keyof typeof paths | keyof typeof legacyCommands;
const noCode = new Set<Operation>(['balance', 'legacyPriceList']);
const denominations = new Set([5000, 10000, 20000, 25000, 30000, 50000, 100000, 150000, 200000, 300000, 500000, 1000000]
  .map(amount => `pulsa${amount}`));
type Operator = 'telkomsel' | 'smartfren';
type Currency = 'IDR' | 'USD';
type PrepaidRequest = Readonly<{ operation: 'balance' | 'legacyPriceList' } |
  { operation: 'operator' | 'pln' | 'ovo' | 'subscriber' | 'packages'; customerId: string } |
  { operation: 'game'; gameCode: string; gameId: string; gameServer?: string } |
  { operation: 'legacyGameFormat' | 'legacyGameServers'; gameCode: string } |
  { operation: 'activateEsim'; providerTransactionId: string; email: string } |
  { operation: 'topUp' | 'status' | 'legacyAutoTopUp'; reference: string; customerId: string; productCode: string }>;

export interface IronGatePrepaidOptions extends IronGateTransactionOptions {
  readonly version?: 'v2' | 'legacy-v1';
  readonly successCodes: Readonly<Partial<Record<Operation, string>>>;
  /** Legacy balance and price list have no success code in their documented envelope. */
  readonly legacyUncodedReads?: readonly ('balance' | 'legacyPriceList')[];
  readonly balanceCurrency?: Currency;
  /** Configure only for a confirmed IDSL-only account entitled to query the operator. */
  readonly subscriberOperator?: Operator;
}

const exactFields = new Set(['balance', 'price', 'tr_id', 'pulsa_price']);
const customer = /^[A-Za-z0-9_.+-]{1,128}$/;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
const validIdentifier = (value: unknown): value is string => typeof value === 'string' && identifier.test(value);

/** Account, customer and transaction reads and the documented v2 top-up wire contract. */
export class IronGatePrepaid {
  readonly #send: ReturnType<typeof createIronGateTransactionTransport>;
  readonly #codes: IronGatePrepaidOptions['successCodes'];
  readonly #currency: Currency | undefined;
  readonly #operator: Operator | undefined;
  readonly #legacy: boolean;
  readonly #uncoded: ReadonlySet<Operation>;

  constructor(options: IronGatePrepaidOptions) {
    const codes = Object.entries(options.successCodes ?? {});
    const legacy = options.version === 'legacy-v1';
    const uncoded = options.legacyUncodedReads ?? [];
    if (options.version !== undefined && options.version !== 'v2' && !legacy ||
        !Array.isArray(uncoded) || uncoded.some(operation => !legacy || !noCode.has(operation)) ||
        (!codes.length && !uncoded.length) || codes.some(([operation, value]) =>
          !Object.hasOwn(legacy ? legacyCommands : paths, operation) || (legacy && noCode.has(operation as Operation)) || !validIdentifier(value)) ||
        (codes.some(([operation]) => operation === 'balance') || uncoded.length || options.balanceCurrency !== undefined) &&
          options.balanceCurrency !== 'IDR' && options.balanceCurrency !== 'USD' ||
        (codes.some(([operation]) => operation === 'subscriber' || operation === 'packages') || options.subscriberOperator !== undefined) &&
          options.subscriberOperator !== 'telkomsel' && options.subscriberOperator !== 'smartfren')
      throw new IronGateTransactionError('INVALID_CONFIGURATION');
    this.#codes = Object.freeze(Object.fromEntries(codes));
    this.#currency = options.balanceCurrency;
    this.#operator = options.subscriberOperator;
    this.#legacy = legacy;
    this.#uncoded = new Set(uncoded);
    this.#send = createIronGateTransactionTransport(options, exactFields);
  }

  async execute(account: IronGateAccountBinding, request: PrepaidRequest, signal?: AbortSignal) {
    request = Object.freeze({ ...request });
    const operation = request?.operation;
    const uncoded = this.#uncoded.has(operation);
    if (!operation || (!uncoded && !Object.hasOwn(this.#codes, operation)))
      throw new IronGateTransactionError('SCOPE_DENIED');
    const { suffix, fields } = this.#wire(request);
    const path = this.#legacy ? '/v1/legacy/index' : paths[operation as keyof typeof paths];
    const params = this.#legacy ? { ...fields, commands: legacyCommands[operation as keyof typeof legacyCommands] } : fields;
    const data = await this.#send(account, path, suffix, params, signal);
    if (operation === 'legacyPriceList') return this.#legacyPrices(data);
    if (!isRecord(data) || (!uncoded && data['rc'] !== this.#codes[operation])) return unconfirmed;
    const result = this.#project(request, data);
    return result ? Object.freeze({ outcome: 'OBSERVED' as const, data: Object.freeze(result) }) : unconfirmed;
  }

  #wire(request: PrepaidRequest): { suffix: string; fields: Record<string, string> } {
    if (request.operation === 'balance') return { suffix: 'bl', fields: { currency: this.#currency! } };
    if (request.operation === 'legacyPriceList') return { suffix: 'pl', fields: { currency: this.#currency! } };
    if (request.operation === 'activateEsim') {
      const { email, providerTransactionId } = request;
      if (typeof providerTransactionId !== 'string' || !identifier.test(providerTransactionId) ||
          typeof email !== 'string' || email.length > 254 || !/^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(email))
        throw new IronGateTransactionError('INVALID_REQUEST');
      return { suffix: providerTransactionId, fields: { tr_id: providerTransactionId, email } };
    }
    if (request.operation === 'legacyGameFormat' || request.operation === 'legacyGameServers') {
      if (!validIdentifier(request.gameCode)) throw new IronGateTransactionError('INVALID_REQUEST');
      return { suffix: request.gameCode, fields: { game_code: request.gameCode } };
    }
    if (request.operation === 'game') {
      if (!validIdentifier(request.gameCode) || !validIdentifier(request.gameId) ||
          request.gameServer !== undefined && !validIdentifier(request.gameServer) ||
          request.gameCode === 'mlbb' && request.gameServer === undefined) throw new IronGateTransactionError('INVALID_REQUEST');
      return { suffix: request.gameCode, fields: { game_code: request.gameCode, game_id: request.gameId,
        ...(request.gameServer === undefined ? {} : { game_server: request.gameServer }) } };
    }
    const customerId = 'customerId' in request ? request.customerId : undefined;
    if (typeof customerId !== 'string' || !customer.test(customerId)) throw new IronGateTransactionError('INVALID_REQUEST');
    if (request.operation === 'topUp' || request.operation === 'status' || request.operation === 'legacyAutoTopUp') {
      if (!validIdentifier(request.reference) || !validIdentifier(request.productCode)) throw new IronGateTransactionError('INVALID_REQUEST');
      if (request.operation === 'legacyAutoTopUp' && (!denominations.has(request.productCode) || !/^\d{1,16}$/.test(customerId)))
        throw new IronGateTransactionError('INVALID_REQUEST');
      return { suffix: request.reference, fields: { ref_id: request.reference,
        ...(request.operation === 'status' ? {} : this.#legacy ? { hp: customerId, pulsa_code: request.productCode } :
          { customer_id: customerId, product_code: request.productCode }) } };
    }
    if (request.operation === 'subscriber' || request.operation === 'packages')
      return { suffix: 'cnp', fields: { customer_id: customerId, operator: this.#operator! } };
    return { suffix: request.operation === 'operator' ? 'op' : customerId, fields: this.#legacy ? { hp: customerId } : { customer_id: customerId } };
  }

  #project(request: PrepaidRequest, data: Record<string, unknown>): Readonly<Record<string, string | number | boolean>> | undefined {
    const { operation } = request;
    if (operation === 'balance') {
      const balance = exactNumeric(data['balance']);
      return balance !== undefined && data['currency'] === this.#currency ? { balance, currency: this.#currency! } : undefined;
    }
    if (operation === 'activateEsim') return data['tr_id'] === request.providerTransactionId && data['email'] === request.email
      ? { providerTransactionId: request.providerTransactionId } : undefined;
    if (operation === 'legacyPriceList') return undefined;
    if (operation === 'legacyGameFormat') return data['status'] === 1 && text(data['formatGameId']) ? { format: data['formatGameId'] } : undefined;
    if (operation === 'legacyGameServers') {
      const servers = data['servers'];
      return data['status'] === 1 && Array.isArray(servers) && servers.length <= 10_000 &&
        servers.every(item => isRecord(item) && text(item['name']) && text(item['value'])) ? { serverCount: servers.length } : undefined;
    }
    if (operation === 'operator') return text(data['operator']) ? { operator: data['operator'] } : undefined;
    if (operation === 'game') {
      const status = data['status'];
      return data['game_id'] === request.gameId && (request.gameServer === undefined || data['game_server'] === request.gameServer) &&
        typeof status === 'number' && Number.isSafeInteger(status) ? { status } : undefined;
    }
    if (!('customerId' in request) || data[this.#legacy ? 'hp' : 'customer_id'] !== request.customerId) return undefined;
    if (operation === 'pln' || operation === 'ovo') return text(data['status']) ? { providerStatus: data['status'] } : undefined;
    if (operation === 'subscriber' || operation === 'packages') {
      const { is_subscriber: subscriber, has_package: hasPackage, package_count: packageCount, cached } = data;
      if (data['operator'] !== this.#operator || typeof subscriber !== 'boolean' || typeof hasPackage !== 'boolean' ||
          typeof cached !== 'boolean' || typeof packageCount !== 'number' || !Number.isSafeInteger(packageCount) || packageCount < 0) return undefined;
      if (operation === 'subscriber') return { subscriber, hasPackage, packageCount, cached };
      const packages = data['packages'], truncated = data['truncated'];
      if (typeof truncated !== 'boolean' || !Array.isArray(packages) || packages.length > 10_000 || !packages.every(isRecord) ||
          (truncated ? packages.length > packageCount : packages.length !== packageCount)) return undefined;
      return { subscriber, hasPackage, packageCount, returnedPackageCount: packages.length, cached, truncated };
    }
    if (operation !== 'topUp' && operation !== 'status' && operation !== 'legacyAutoTopUp') return undefined;
    const status = data['status'];
    const id = exactNumeric(data['tr_id'], unsignedInteger);
    const price = exactNumeric(data['price']);
    return data['ref_id'] === request.reference && data[this.#legacy ? 'code' : 'product_code'] === request.productCode &&
      (status === 0 || status === 1 || status === 2) && id !== undefined && price !== undefined
      ? { providerTransactionId: id, reference: request.reference, status, price } : undefined;
  }

  #legacyPrices(data: unknown) {
    if (!Array.isArray(data) || data.length > 10_000) return unconfirmed;
    const products = [];
    const seen = new Set<string>();
    for (const item of data) {
      if (!isRecord(item) || item['currency'] !== this.#currency) return unconfirmed;
      const code = item['pulsa_code'], name = item['pulsa_details'], status = item['status'], price = exactNumeric(item['pulsa_price']);
      if (!validIdentifier(code) || seen.has(code) || !text(name) || !text(status) || price === undefined) return unconfirmed;
      seen.add(code);
      products.push(Object.freeze({ code, name, status, price }));
    }
    return Object.freeze({ outcome: 'OBSERVED' as const, data: Object.freeze({ currency: this.#currency!, products: Object.freeze(products) }) });
  }
}
