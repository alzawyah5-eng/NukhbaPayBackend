import { providerJsonNumber, readCatalogueJson, wireNumber, withinCatalogueDeadline } from './catalogue-http.ts';
import type { SslWirelessAccountBinding } from './ssl-wireless-catalogue.ts';

type Profile = 'mobile-top-up' | 'utilities-common' | 'bpdb-prepaid' | 'breb-prepaid' | 'desco-postpaid' | 'dpdc-bill';
type Operation = 'info' | 'payment' | 'status' | 'cancel';
type FieldRule = 'amount' | 'nonnegative' | 'integer' | 'digits' | 'connection' | 'bill-number' | 'text' | 'account-number';
type Fields = Readonly<Partial<Record<string, FieldRule>>>;
type RequestSchema = Readonly<{ required?: Fields; optional?: Fields; constants?: Readonly<Record<string, string>> }>;

export interface SslBillBinding extends SslWirelessAccountBinding {
  readonly billerId: string;
  readonly profile: Profile;
}

export interface SslWirelessBillsOptions {
  readonly binding: SslBillBinding;
  readonly baseUrl: string;
  readonly allowedOperatorIds?: readonly string[];
  readonly allowCancellation?: boolean;
  /** The assigned DPDC biller supplies the current selectors and account number encoding. */
  readonly dpdc?: Readonly<{ locationCodes: readonly string[]; billYears: readonly string[]; billMonths: readonly string[];
    accountNumberEncoding: 'numeric-text' | 'json-integer' }>;
  readonly subChannelId?: string;
  readonly getCredentials: (binding: SslBillBinding, signal: AbortSignal) => Promise<Readonly<{
    stkCode: string; authKey: string; utilityAuthKey: string; utilitySecretKey: string;
  }>>;
  /** Required injection. Transaction transport is composed separately from catalogue discovery. */
  readonly transport: typeof fetch;
}

type BillOutcome = Readonly<{ outcome: 'OBSERVED'; statusCode: string; lid?: string; billerTransactionId?: string;
  rechargeStatus?: number; monetaryFields: Readonly<Record<string, string>> } |
  { outcome: 'UNCONFIRMED'; statusCode?: string }>;

export class SslWirelessBillError extends Error {
  readonly code: 'INVALID_CONFIGURATION' | 'SCOPE_DENIED' | 'INVALID_REQUEST' | 'UNAVAILABLE';
  constructor(code: SslWirelessBillError['code']) {
    super('SSL Wireless bill operation stopped');
    this.name = 'SslWirelessBillError';
    this.code = code;
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reference = /^[A-Za-z0-9_-]{1,128}$/;
const transaction = /^[A-Za-z0-9_-]{15,50}$/;
const credential = /^[!-~]{1,512}$/;
const decimal = /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/;
const integer = /^(?:0|[1-9][0-9]{0,29})$/;
const digits = /^[0-9]{1,32}$/;
const prepaidMeter: RequestSchema = { required: { meter_no: 'digits', mobile_no: 'digits', amount: 'amount' },
  optional: { convenience_fee: 'nonnegative' }, constants: { bill_type: 'PREPAID' } };
const schemas: Readonly<Record<Profile, Readonly<Partial<Record<Operation, RequestSchema>>>>> = {
  'mobile-top-up': { info: { required: { operator_id: 'integer', recipient_msisdn: 'integer',
    amount: 'amount', connection_type: 'connection' } }, payment: {}, status: {} },
  'utilities-common': { status: {}, cancel: {} },
  'bpdb-prepaid': { info: prepaidMeter, payment: prepaidMeter, status: {} },
  'breb-prepaid': { info: { ...prepaidMeter, optional: { ...prepaidMeter.optional, branchRoutingNo: 'digits' } },
    payment: { optional: { core_transaction_id: 'integer', convenience_fee: 'nonnegative', commission_amount: 'nonnegative' },
      constants: { utility_bill_type: 'PREPAID' } }, status: {} },
  'desco-postpaid': { info: { required: { billno: 'bill-number' } },
    payment: { optional: { remarks: 'text' }, constants: { utility_bill_type: 'POSTPAID' } } },
  'dpdc-bill': { info: { required: { location_code: 'text', account_number: 'account-number', bill_years: 'text', bill_months: 'text' } },
    payment: {} },
};
const paths = { info: '/api/bill-info', payment: '/api/bill-payment', status: '/api/bill-status', cancel: '/api/bill-cancel' } as const;
const moneyNames = ['amount', 'bill_amount', 'total_amount', 'vat_amount', 'commission_amount', 'convenience_fee',
  'vending_amount', 'arrear_amount', 'energy_amount', 'fee_amount'] as const;
const exact = new Set<string>(moneyNames);
const unconfirmed = Object.freeze({ outcome: 'UNCONFIRMED' as const });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= 50 && !/[\x00-\x1f\x7f]/.test(value);

function field(rule: FieldRule, value: unknown, encodeAccount = false): string | object {
  if (typeof value === 'string') {
    if (rule === 'digits' && digits.test(value) || rule === 'connection' && (value === 'prepaid' || value === 'postpaid')) return value;
    if (rule === 'bill-number' && /^[A-Za-z0-9]{1,50}$/.test(value) || rule === 'text' && isText(value)) return value;
    if (rule === 'account-number' && /^\d{1,50}$/.test(value)) {
      if (!encodeAccount) return value;
      if (/^(?:0|[1-9]\d{0,49})$/.test(value)) return providerJsonNumber(value);
    }
    const validNumber = rule === 'integer' ? integer.test(value) :
      (rule === 'amount' || rule === 'nonnegative') && decimal.test(value) && (rule === 'nonnegative' || /[1-9]/.test(value));
    if (validNumber) return providerJsonNumber(value);
  }
  throw new SslWirelessBillError('INVALID_REQUEST');
}

function encodeFields(input: Readonly<Record<string, string>>, { required = {}, optional = {}, constants = {} }: RequestSchema,
  encodeAccount: boolean) {
  if (!record(input) || Object.keys(input).some(key => !Object.hasOwn(required, key) && !Object.hasOwn(optional, key)))
    throw new SslWirelessBillError('INVALID_REQUEST');
  const entries = Object.entries(required).map(([key, rule]) => [key, field(rule!, Object.hasOwn(input, key) ? input[key] : undefined, encodeAccount)]);
  for (const [key, rule] of Object.entries(optional)) {
    if (Object.hasOwn(input, key)) entries.push([key, field(rule!, input[key])]);
  }
  return { ...Object.fromEntries(entries), ...constants };
}

function observation(response: unknown, profile: Profile, operation: Operation, transactionId: string): BillOutcome {
  if (!record(response)) return unconfirmed;
  const statusCode = response['status_code'];
  const status = response['status'];
  const data = response['data'];
  if (typeof statusCode !== 'string' || !/^\d{3}$/.test(statusCode) ||
      (response['transaction_id'] !== undefined && response['transaction_id'] !== transactionId)) return unconfirmed;
  if (status === 'error') return Object.freeze({ outcome: 'UNCONFIRMED', statusCode });
  const topUpStatus = operation === 'status' && (profile === 'mobile-top-up' || profile === 'utilities-common');
  const expected = operation === 'info' ? ['api_success', '000'] : operation === 'cancel' ? ['payment_canceled', '113'] :
    [topUpStatus ? 'success' : 'payment_success', '111'];
  if (status !== expected[0] || statusCode !== expected[1] || (operation === 'cancel' ? data !== null : !record(data))) return unconfirmed;
  const lid = response['lid'];
  const billerTransactionId = response['biller_trx_id'];
  if (typeof lid !== 'string' || !reference.test(lid) ||
      (billerTransactionId !== undefined && (typeof billerTransactionId !== 'string' || !reference.test(billerTransactionId)))) return unconfirmed;
  const rechargeStatus = record(data) ? data['recharge_status'] : undefined;
  if ((topUpStatus || (profile === 'mobile-top-up' && operation === 'payment')) &&
      (typeof rechargeStatus !== 'number' || !Number.isInteger(rechargeStatus) || rechargeStatus < 100 || rechargeStatus > 999)) return unconfirmed;
  const monetaryFields: Record<string, string> = {};
  if (record(data)) {
    for (const name of moneyNames) {
      if (!Object.hasOwn(data, name)) continue;
      const value = wireNumber(data[name]) ?? data[name];
      if (typeof value !== 'string' || !decimal.test(value)) return unconfirmed;
      monetaryFields[name] = value;
    }
  }
  if (operation === 'info' && monetaryFields['total_amount'] === undefined) return unconfirmed;
  return Object.freeze({ outcome: 'OBSERVED', statusCode, lid,
    ...(billerTransactionId === undefined ? {} : { billerTransactionId }),
    ...(typeof rechargeStatus === 'number' ? { rechargeStatus } : {}), monetaryFields: Object.freeze(monetaryFields) });
}

/** One provider attempt. The caller owns durable authorization, attempt state and reconciliation. */
export class SslWirelessBills {
  readonly #binding: SslBillBinding;
  readonly #origin: string;
  readonly #options: Readonly<SslWirelessBillsOptions>;
  readonly #operators: ReadonlySet<string>;
  readonly #dpdc: SslWirelessBillsOptions['dpdc'];

  constructor(options: SslWirelessBillsOptions) {
    try {
      const origin = new URL(options.baseUrl).origin;
      const { tenantId, providerAccountId, billerId, profile } = options.binding;
      const operators = options.allowedOperatorIds ?? [];
      const dpdc = options.dpdc;
      const validSelectors = (values: readonly string[]) => Array.isArray(values) && values.length > 0 && values.length <= 100 &&
        Array.from(values).every(isText) && new Set(values).size === values.length;
      if (!origin.startsWith('https://') || ![origin, origin + '/'].includes(options.baseUrl) ||
          ![tenantId, providerAccountId].every(value => typeof value === 'string' && uuid.test(value)) ||
          typeof billerId !== 'string' || !reference.test(billerId) || !Object.hasOwn(schemas, profile) ||
          typeof options.getCredentials !== 'function' || typeof options.transport !== 'function' ||
          options.subChannelId !== undefined && (typeof options.subChannelId !== 'string' || !digits.test(options.subChannelId)) ||
          !Array.isArray(operators) || operators.some(value => typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) ||
          (profile === 'mobile-top-up' && operators.length === 0) ||
          (options.allowCancellation === true && profile !== 'utilities-common') ||
          (profile === 'dpdc-bill' ? !dpdc || !validSelectors(dpdc.locationCodes) || !validSelectors(dpdc.billYears) ||
            !validSelectors(dpdc.billMonths) || !['numeric-text', 'json-integer'].includes(dpdc.accountNumberEncoding) : dpdc !== undefined))
        throw new Error();
      this.#binding = Object.freeze({ tenantId, providerAccountId, billerId, profile });
      this.#origin = origin;
      this.#options = Object.freeze({ ...options });
      this.#operators = new Set(operators);
      this.#dpdc = dpdc ? Object.freeze({ accountNumberEncoding: dpdc.accountNumberEncoding,
        locationCodes: Object.freeze([...dpdc.locationCodes]), billYears: Object.freeze([...dpdc.billYears]),
        billMonths: Object.freeze([...dpdc.billMonths]) }) : undefined;
    } catch { throw new SslWirelessBillError('INVALID_CONFIGURATION'); }
  }

  async execute(binding: SslBillBinding, operation: Operation, transactionId: string,
    fields: Readonly<Record<string, string>> = {}, parent?: AbortSignal): Promise<BillOutcome> {
    const { profile } = this.#binding;
    const operationSchemas = schemas[profile];
    if (!binding || binding.tenantId !== this.#binding.tenantId || binding.providerAccountId !== this.#binding.providerAccountId ||
        binding.billerId !== this.#binding.billerId || binding.profile !== profile || !Object.hasOwn(operationSchemas, operation) ||
        (operation === 'cancel' && this.#options.allowCancellation !== true)) throw new SslWirelessBillError('SCOPE_DENIED');
    if (typeof transactionId !== 'string' || !transaction.test(transactionId)) throw new SslWirelessBillError('INVALID_REQUEST');
    if ((profile === 'dpdc-bill' || (profile === 'desco-postpaid' && operation === 'payment')) && transactionId.length < 16)
      throw new SslWirelessBillError('INVALID_REQUEST');
    const params = encodeFields(fields, operationSchemas[operation]!, this.#dpdc?.accountNumberEncoding === 'json-integer');
    if (operation === 'info' && this.#dpdc && (!this.#dpdc.locationCodes.includes(fields['location_code']!) ||
        !this.#dpdc.billYears.includes(fields['bill_years']!) || !this.#dpdc.billMonths.includes(fields['bill_months']!)))
      throw new SslWirelessBillError('SCOPE_DENIED');
    if (profile === 'mobile-top-up' && operation === 'info' && (!this.#operators.has(fields['operator_id']!) ||
        (fields['operator_id'] === '13' && fields['connection_type'] !== 'prepaid'))) throw new SslWirelessBillError('SCOPE_DENIED');
    const deadline = AbortSignal.timeout(operation === 'payment' && (profile === 'bpdb-prepaid' || profile === 'breb-prepaid') ? 180_000 : 30_000);
    const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
    let credentials: Awaited<ReturnType<SslWirelessBillsOptions['getCredentials']>>;
    try {
      credentials = await withinCatalogueDeadline(() => this.#options.getCredentials(this.#binding, signal), signal);
      const { stkCode, authKey, utilityAuthKey, utilitySecretKey } = credentials;
      if (![stkCode, authKey, utilityAuthKey, utilitySecretKey].every(value => typeof value === 'string' && credential.test(value))) throw new Error();
      signal.throwIfAborted();
    } catch { throw new SslWirelessBillError('UNAVAILABLE'); }
    const url = this.#origin + paths[operation];
    const body = JSON.stringify({ ...params, transaction_id: transactionId,
      utility_auth_key: credentials.utilityAuthKey, utility_secret_key: credentials.utilitySecretKey });
    try {
      const response = await withinCatalogueDeadline(() => this.#options.transport(url, { method: 'POST', body, signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json',
          'Content-Type': 'application/json', 'STK-CODE': credentials.stkCode, 'AUTH-KEY': credentials.authKey,
          ...(this.#options.subChannelId ? { 'SUB-CHANNEL-ID': this.#options.subChannelId } : {}) } }), signal);
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url)) {
        void response.body?.cancel().catch(() => undefined);
        return unconfirmed;
      }
      const value = await readCatalogueJson(response, signal, exact, () => new Error('Invalid bill response'));
      signal.throwIfAborted();
      return observation(value, profile, operation, transactionId);
    } catch { return unconfirmed; }
  }
}
