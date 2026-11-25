import type { IronGateAccountBinding } from './irongate-catalogue.ts';
import { providerJsonNumber } from './catalogue-http.ts';
import { createIronGateTransactionTransport, exactNumeric, identifier, IronGateTransactionError, isRecord,
  unconfirmed, unsignedInteger, type IronGateTransactionOptions } from './irongate-transaction-http.ts';

const profiles = {
  'bpjs-kesehatan': 'month', 'bpjs-employment-bpu': 'month', 'bpjs-employment-pu': 'none',
  'church-member': 'amount', 'church-non-member': 'amount', 'custom-denomination': 'amount',
  'e-samsat': 'identity-number', insurance: 'none', 'telkom-internet': 'none', 'non-telkom-internet': 'none',
  multifinance: 'none', pbb: 'year', pgas: 'none', 'pln-non-taglist': 'none', telco: 'none',
  'tv-telkomvision': 'none', 'tv-non-telkomvision': 'none',
} as const;
type Profile = keyof typeof profiles;
type Operation = 'inquiry' | 'payment' | 'status';

export interface IronGatePostpaidOptions extends IronGateTransactionOptions {
  readonly profile: Profile;
  /** Exact product code assigned to this account and profile. */
  readonly productCode: string;
  readonly successCodes: Readonly<Partial<Record<Operation, string>>>;
  /** The table and published example differ. Supply the form verified for this account. */
  readonly transactionIdEncoding?: 'json-integer' | 'json-string';
}

type PostpaidRequest = Readonly<{ operation: 'inquiry'; reference: string; customerId: string; profileValue?: string } |
  { operation: 'payment'; reference: string; providerTransactionId: string } |
  { operation: 'status'; reference: string }>;
const commands = { inquiry: 'inq-pasca', payment: 'pay-pasca', status: 'checkstatus' } as const;
const amountFields = ['nominal', 'admin', 'platform_fee', 'price', 'selling_price'] as const;
const exactFields = new Set<string>(['tr_id', ...amountFields]);
const privateId = /^[A-Za-z0-9_.-]{1,128}$/;

function profileFields(profile: Profile, value: unknown): Record<string, unknown> {
  const field = profiles[profile];
  if (field === 'none' && value === undefined) return {};
  if (typeof value === 'string') {
    if (field === 'identity-number' && /^\d{1,32}$/.test(value)) return { nomor_identitas: value };
    if (field === 'year' && /^[1-9]\d{3}$/.test(value)) return { year: value };
    if (/^[1-9][0-9]{0,29}$/.test(value)) {
      if (field === 'month') return { month: providerJsonNumber(value) };
      if (field === 'amount') return { desc: { amount: providerJsonNumber(value) } };
    }
  }
  throw new IronGateTransactionError('INVALID_REQUEST');
}

/** Fixed postpaid inquiry, payment and reconciliation forms. Durable admission belongs to the caller. */
export class IronGatePostpaid {
  readonly #profile: Profile;
  readonly #code: string;
  readonly #successCodes: IronGatePostpaidOptions['successCodes'];
  readonly #encoding: IronGatePostpaidOptions['transactionIdEncoding'];
  readonly #send: ReturnType<typeof createIronGateTransactionTransport>;

  constructor(options: IronGatePostpaidOptions) {
    const codes = Object.entries(options.successCodes ?? {});
    if (!Object.hasOwn(profiles, options.profile) || typeof options.productCode !== 'string' || !identifier.test(options.productCode) ||
        !codes.length || codes.some(([name, value]) => !Object.hasOwn(commands, name) || typeof value !== 'string' || !identifier.test(value)) ||
        ((codes.some(([name]) => name === 'payment') || options.transactionIdEncoding !== undefined) &&
          options.transactionIdEncoding !== 'json-integer' && options.transactionIdEncoding !== 'json-string'))
      throw new IronGateTransactionError('INVALID_CONFIGURATION');
    this.#profile = options.profile;
    this.#code = options.productCode;
    this.#successCodes = Object.freeze(Object.fromEntries(codes));
    this.#encoding = options.transactionIdEncoding;
    this.#send = createIronGateTransactionTransport(options, exactFields);
  }

  async execute(account: IronGateAccountBinding, request: PostpaidRequest, signal?: AbortSignal) {
    request = Object.freeze({ ...request });
    if (!request || !Object.hasOwn(commands, request.operation) || !Object.hasOwn(this.#successCodes, request.operation))
      throw new IronGateTransactionError('SCOPE_DENIED');
    const { operation, reference } = request;
    if (typeof reference !== 'string' || !identifier.test(reference)) throw new IronGateTransactionError('INVALID_REQUEST');
    let params: Record<string, unknown>, suffix = reference;
    if (operation === 'inquiry') {
      const customerId = request.customerId;
      if (typeof customerId !== 'string' || !privateId.test(customerId)) throw new IronGateTransactionError('INVALID_REQUEST');
      params = { code: this.#code, hp: customerId, ref_id: reference, ...profileFields(this.#profile, request.profileValue) };
    } else if (operation === 'payment') {
      const transactionId = request.providerTransactionId;
      if (typeof transactionId !== 'string' || !/^[1-9][0-9]{0,29}$/.test(transactionId))
        throw new IronGateTransactionError('INVALID_REQUEST');
      suffix = transactionId;
      params = { tr_id: this.#encoding === 'json-integer' ? providerJsonNumber(transactionId) : transactionId };
    } else {
      suffix = 'cs';
      params = { ref_id: reference };
    }
    const response = await this.#send(account, '/api/v1/bill/check', suffix, { commands: commands[operation], ...params }, signal);
    if (!isRecord(response) || response['response_code'] !== this.#successCodes[operation] ||
        response['code'] !== this.#code || response['ref_id'] !== reference ||
        (operation === 'inquiry' && response['hp'] !== request.customerId)) return unconfirmed;
    const providerTransactionId = exactNumeric(response['tr_id'], unsignedInteger);
    if (!providerTransactionId || providerTransactionId === '0' ||
        (operation === 'payment' && providerTransactionId !== request.providerTransactionId)) return unconfirmed;
    const details = response['desc'];
    if (!isRecord(details) && !(operation === 'status' && typeof details === 'string' && details.length <= 4096) &&
        !(this.#profile === 'pgas' && Array.isArray(details) && details.length <= 10_000 && details.every(isRecord))) return unconfirmed;
    const amounts: Record<string, string> = {};
    for (const name of amountFields) {
      const value = exactNumeric(response[name]);
      if (value === undefined) return unconfirmed;
      amounts[name] = value;
    }
    const status = response['status'];
    if (operation === 'status' && (typeof status !== 'number' || !Number.isSafeInteger(status))) return unconfirmed;
    return Object.freeze({ outcome: 'OBSERVED' as const, providerTransactionId, reference,
      status: typeof status === 'number' && Number.isSafeInteger(status) ? status : undefined, amounts: Object.freeze(amounts) });
  }
}
