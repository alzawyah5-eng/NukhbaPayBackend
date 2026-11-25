import { withinCatalogueDeadline } from './catalogue-http.ts';
import { decodeIpayProductFile, isIpayProductFileBinding, takeIpayIssuedPin, type IpayIssuedPin } from './ipay-soap.ts';
export { createIpaySoapProcess } from './ipay-soap.ts';

export interface IpayAccount {
  readonly tenantId: string;
  readonly providerAccountId: string;
}

const operations = { version: 'Version', balance: 'GetBalanceSt', query: 'Query', pinAvailability: 'PinAvlb', productFile: 'FileDownload',
  lastTransaction: 'GetLastTrans', pinPurchase: 'PinRequest', pinRefund: 'PinlessRequest',
  pinlessStart: 'PinlessRequest', pinlessConfirm: 'PinlessRequest2ndStep',
  ecashTransfer: 'PinlessRequest', ecashTransferConfirm: 'PinlessRequest2ndStep',
  ecashCashCollection: 'PinlessRequest', ecashCashCollectionConfirm: 'PinlessRequest2ndStep',
  ecashChequeCollection: 'PinlessRequest', ecashChequeCollectionConfirm: 'PinlessRequest2ndStep' } as const;
type Operation = keyof typeof operations;
type FinancialScope = Readonly<{ receiptNumber: string; reference: string; clerkId?: string }>;
type Pinless = Readonly<{ productCode: string; accountNumber: string; amount: string }>;
type EcashTransfer = Readonly<{ recipientMerchantId: string; amount: string }>;
type EcashCollection = Readonly<{ payerMerchantId: string; amount: string; collectionDescription: string }>;
type ChequeCollection = EcashCollection & Readonly<{ chequeNumber: string; chequeDate: string; chequeBankName: string }>;
type FinancialRequest = FinancialScope & Readonly<
  { operation: 'pinPurchase'; productCode: string; valueCode: string } |
  { operation: 'pinRefund'; originalTransactionNumber: string } |
  ({ operation: 'pinlessStart' } & Pinless) |
  ({ operation: 'pinlessConfirm'; firstTransactionNumber: string } & Pinless) |
  ({ operation: 'ecashTransfer' } & EcashTransfer) |
  ({ operation: 'ecashTransferConfirm'; firstTransactionNumber: string } & EcashTransfer) |
  ({ operation: 'ecashCashCollection' } & EcashCollection) |
  ({ operation: 'ecashCashCollectionConfirm'; firstTransactionNumber: string } & EcashCollection) |
  ({ operation: 'ecashChequeCollection' } & ChequeCollection) |
  ({ operation: 'ecashChequeCollectionConfirm'; firstTransactionNumber: string } & ChequeCollection)>;
interface MutationIntent {
  readonly operation: FinancialRequest['operation'];
  readonly fields: Readonly<Record<string, string>>;
  readonly firstTransactionNumber?: string;
  readonly cheque?: Readonly<{ ChequeNo: string; ChequeDate: string; ChequeBankName: string }>;
}
type Request = Readonly<{ operation: 'version' } | { operation: 'balance' } |
  { operation: 'query'; originalReference: string; productCode: string; transactionNumber: string } |
  { operation: 'pinAvailability'; productCode: string; amount: string } | { operation: 'productFile' } |
  { operation: 'lastTransaction' }> | FinancialRequest;
type CollectionProfile = Readonly<{ productCode: string; requestType: 'PinlessRequest' | 'Pinlessrequest' }>;
interface Options {
  readonly account: IpayAccount;
  readonly allowedOperations: readonly Operation[];
  readonly language?: string;
  /** The SDK table and its worked request differ in case. Supply the selector verified for this account. */
  readonly pinAvailabilityType?: 'PinAvlb' | 'pinavlb';
  readonly productFile?: Readonly<{ rootElement: string; groupNumber: string }>;
  readonly pinlessProducts?: readonly string[];
  /** Exact transfer code authorized by the vendor for this terminal. The SDK table and example differ. */
  readonly ecashTransferProduct?: 'EFRDEP' | 'EFECSH';
  /** Exact product and case-sensitive initial selector assigned for cash collection. */
  readonly ecashCashCollection?: CollectionProfile;
  /** Exact product and case-sensitive initial selector assigned for cheque collection. */
  readonly ecashChequeCollection?: CollectionProfile;
  /** Atomically reserve the exact operation and reference. Confirmation requires the matching persisted first-step observation. */
  readonly reserveMutation?: (account: IpayAccount, mutation: MutationIntent, signal: AbortSignal) => Promise<boolean>;
  /** Persist issued secrets in the protected fulfilment store and return its UUID receipt. */
  readonly storeIssuedPin?: (account: IpayAccount, reference: string, transactionNumber: string, pin: IpayIssuedPin,
    signal: AbortSignal) => Promise<string>;
  readonly getCredentials: (account: IpayAccount, signal: AbortSignal) => Promise<Readonly<{ terminalId: string; password: string }>>;
  /** The approved SOAP Process binding supplies a bounded, securely decoded inner response. */
  readonly processXml: (requestXml: string, signal: AbortSignal) => Promise<unknown>;
}

export class IpaySdkError extends Error {
  readonly code: 'INVALID_CONFIGURATION' | 'INVALID_REQUEST' | 'SCOPE_DENIED' | 'UNAVAILABLE';
  constructor(code: IpaySdkError['code']) {
    super('iPay SDK operation stopped');
    this.name = 'IpaySdkError';
    this.code = code;
  }
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const identifier = /^[A-Za-z0-9_.-]{1,100}$/;
const fixedAmount = /^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/;
const unavailable = Object.freeze({ outcome: 'UNCONFIRMED' as const });
const safeId = (value: unknown): value is string => typeof value === 'string' && identifier.test(value);
const safeAmount = (value: unknown): value is string => typeof value === 'string' && fixedAmount.test(value);
const supplierProduct = /^[A-Za-z0-9]{6}$/;
const vendorReference = /^[A-Za-z0-9_.-]{1,20}$/;
const transactionNumberPattern = /^[A-Za-z0-9_.-]{1,13}$/;
const transferOperations = new Set<Operation>(['ecashTransfer','ecashTransferConfirm']);
const cashOperations = new Set<Operation>(['ecashCashCollection','ecashCashCollectionConfirm']);
const chequeOperations = new Set<Operation>(['ecashChequeCollection','ecashChequeCollectionConfirm']);
const collectionOperations = new Set<Operation>([...cashOperations,...chequeOperations]);
const financialOperations = new Set<Operation>(['pinPurchase','pinRefund','pinlessStart','pinlessConfirm', ...transferOperations, ...collectionOperations]);
const confirmationStarts = new Set<Operation>(['pinlessStart','ecashTransfer','ecashCashCollection','ecashChequeCollection']);
const reservedProducts = new Set(['REFUND','EFRDEP','EFECSH','TSTECA','TSTECC']);
const validString = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);

function moneyField(value: unknown, wholeDigits: number): value is string {
  return safeAmount(value) && !value.startsWith('-') && /[1-9]/.test(value) &&
    value.split('.', 1)[0]!.length <= wholeDigits && (value.split('.')[1]?.length ?? 0) <= 2;
}

function validCollection(profile: CollectionProfile, otherExample: string): boolean {
  return Boolean(profile && validString(profile.productCode,supplierProduct) &&
    !['REFUND','EFRDEP','EFECSH',otherExample].includes(profile.productCode.toUpperCase()) &&
    (profile.requestType === 'PinlessRequest' || profile.requestType === 'Pinlessrequest'));
}

function validChequeDate(value: unknown): value is string {
  if (!validString(value,/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0,10) === value;
}

function prepareMutation(request: FinancialRequest, pinlessProducts: ReadonlySet<string>,
  transferProduct: Options['ecashTransferProduct'], cashCollection: CollectionProfile | undefined,
  chequeCollection: CollectionProfile | undefined): MutationIntent {
  const { operation, receiptNumber, reference, clerkId } = request;
  const invalid = () => new IpaySdkError('INVALID_REQUEST');
  if (!validString(receiptNumber,/^[A-Za-z0-9]{1,5}$/) || !validString(reference,vendorReference) ||
      (clerkId !== undefined && !validString(clerkId,collectionOperations.has(operation) ? /^[A-Za-z0-9_.-]{1,13}$/ : /^[A-Za-z0-9_.-]{1,10}$/)))
    throw invalid();
  const fields: Record<string,string> = { ReceiptNo: receiptNumber, RefNo: reference };
  let cheque: MutationIntent['cheque'];
  if (clerkId !== undefined) fields['ClerkId'] = clerkId;
  if (operation === 'pinPurchase') {
    if (!validString(request.productCode,supplierProduct) || reservedProducts.has(request.productCode.toUpperCase()) ||
        cashCollection?.productCode.toUpperCase() === request.productCode.toUpperCase() ||
        chequeCollection?.productCode.toUpperCase() === request.productCode.toUpperCase() ||
        !moneyField(request.valueCode, 6)) throw invalid();
    fields['ProdCode'] = request.productCode;
    fields['ValueCode'] = request.valueCode;
  } else if (operation === 'pinRefund') {
    if (!validString(request.originalTransactionNumber,transactionNumberPattern)) throw invalid();
    fields['CardData'] = request.originalTransactionNumber;
    fields['Amount'] = '0';
    fields['ProdCode'] = 'REFUND';
  } else if (operation === 'pinlessStart' || operation === 'pinlessConfirm') {
    if (!validString(request.productCode,supplierProduct) || !pinlessProducts.has(request.productCode))
      throw new IpaySdkError('SCOPE_DENIED');
    if (!validString(request.accountNumber,/^[A-Za-z0-9_.+@-]{1,255}$/) || !moneyField(request.amount, 8)) throw invalid();
    fields['ProdCode'] = request.productCode;
    fields['AccountNo'] = request.accountNumber;
    fields['Amount'] = request.amount;
  } else if (operation === 'ecashTransfer' || operation === 'ecashTransferConfirm') {
    if (!transferProduct || !validString(request.recipientMerchantId,vendorReference) || !moneyField(request.amount,8)) throw invalid();
    fields['ProdCode'] = transferProduct;
    fields['TransRef'] = request.recipientMerchantId;
    fields['Amount'] = request.amount;
  } else {
    const profile = chequeOperations.has(operation) ? chequeCollection : cashCollection;
    if (!profile || !validString(request.payerMerchantId,vendorReference) || !moneyField(request.amount,6) ||
        typeof request.collectionDescription !== 'string' || !request.collectionDescription.trim() ||
        !/^[\x20-\x7e]{1,80}$/.test(request.collectionDescription)) throw invalid();
    fields['ProdCode'] = profile.productCode;
    fields['TransRef'] = request.payerMerchantId;
    fields['TerminalParameter'] = request.collectionDescription;
    fields['Amount'] = request.amount;
    if (operation === 'ecashChequeCollection' || operation === 'ecashChequeCollectionConfirm') {
      if (!validString(request.chequeNumber,/^[0-9]{1,32}$/) || !validChequeDate(request.chequeDate) ||
          typeof request.chequeBankName !== 'string' || !request.chequeBankName.trim() || request.chequeBankName.length > 80 ||
          /[\x00-\x1f\x7f]/.test(request.chequeBankName)) throw invalid();
      cheque = Object.freeze({ ChequeNo:request.chequeNumber, ChequeDate:request.chequeDate, ChequeBankName:request.chequeBankName });
    }
  }
  const prepared = { operation, fields: Object.freeze(fields), ...(cheque ? { cheque } : {}) };
  if (operation === 'pinlessConfirm' || operation === 'ecashTransferConfirm' || operation === 'ecashCashCollectionConfirm' ||
      operation === 'ecashChequeCollectionConfirm') {
    if (!validString(request.firstTransactionNumber,transactionNumberPattern)) throw invalid();
    return Object.freeze({ ...prepared, firstTransactionNumber: request.firstTransactionNumber });
  }
  return Object.freeze(prepared);
}

function encodeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export class IpaySdk {
  readonly #scope: IpayAccount;
  readonly #allowed: ReadonlySet<Operation>;
  readonly #language: Options['language'];
  readonly #pinAvailabilityType: Options['pinAvailabilityType'];
  readonly #productFile: Options['productFile'];
  readonly #pinlessProducts: ReadonlySet<string>;
  readonly #transferProduct: Options['ecashTransferProduct'];
  readonly #cashCollection: Options['ecashCashCollection'];
  readonly #chequeCollection: Options['ecashChequeCollection'];
  readonly #reserveMutation: Options['reserveMutation'];
  readonly #storeIssuedPin: Options['storeIssuedPin'];
  readonly #credentials: Options['getCredentials'];
  readonly #processXml: Options['processXml'];

  constructor(options: Options) {
    const { account, allowedOperations, language, pinAvailabilityType, productFile, pinlessProducts, ecashTransferProduct,
      ecashCashCollection, ecashChequeCollection, reserveMutation, storeIssuedPin, getCredentials, processXml } = options;
    if (!account || ![account.tenantId, account.providerAccountId].every(id => typeof id === 'string' && uuid.test(id)) ||
        !Array.isArray(allowedOperations) || !allowedOperations.length || allowedOperations.some(operation => !Object.hasOwn(operations, operation)) ||
        typeof getCredentials !== 'function' || typeof processXml !== 'function' ||
        (language !== undefined && (typeof language !== 'string' || !/^[A-Za-z0-9-]{1,12}$/.test(language))) ||
        (allowedOperations.includes('pinAvailability') && pinAvailabilityType === undefined) ||
        (pinAvailabilityType !== undefined && pinAvailabilityType !== 'PinAvlb' && pinAvailabilityType !== 'pinavlb') ||
        (allowedOperations.includes('productFile') && !productFile) || (productFile && !isIpayProductFileBinding(productFile)) ||
        (allowedOperations.some(operation => financialOperations.has(operation)) && typeof reserveMutation !== 'function') ||
        (allowedOperations.includes('pinPurchase') && typeof storeIssuedPin !== 'function') ||
        (allowedOperations.some(operation => transferOperations.has(operation)) && ecashTransferProduct === undefined) ||
        (ecashTransferProduct !== undefined && ecashTransferProduct !== 'EFRDEP' && ecashTransferProduct !== 'EFECSH') ||
        (allowedOperations.some(operation => cashOperations.has(operation)) && !ecashCashCollection) ||
        (allowedOperations.some(operation => chequeOperations.has(operation)) && !ecashChequeCollection) ||
        (ecashCashCollection !== undefined && !validCollection(ecashCashCollection,'TSTECC')) ||
        (ecashChequeCollection !== undefined && !validCollection(ecashChequeCollection,'TSTECA')) ||
        (ecashCashCollection && ecashChequeCollection && ecashCashCollection.productCode.toUpperCase() === ecashChequeCollection.productCode.toUpperCase()) ||
        ((allowedOperations.includes('pinlessStart') || allowedOperations.includes('pinlessConfirm')) && !pinlessProducts?.length) ||
        (pinlessProducts !== undefined && (!Array.isArray(pinlessProducts) || pinlessProducts.length > 500 ||
          Array.from(pinlessProducts).some(code => !validString(code,supplierProduct) || reservedProducts.has(code.toUpperCase()) ||
            code.toUpperCase() === ecashCashCollection?.productCode.toUpperCase() ||
            code.toUpperCase() === ecashChequeCollection?.productCode.toUpperCase()))))
      throw new IpaySdkError('INVALID_CONFIGURATION');
    this.#scope = Object.freeze({ tenantId: account.tenantId, providerAccountId: account.providerAccountId });
    this.#allowed = new Set(allowedOperations);
    this.#language = language;
    this.#pinAvailabilityType = pinAvailabilityType;
    this.#productFile = productFile ? Object.freeze({ ...productFile }) : undefined;
    this.#pinlessProducts = new Set(pinlessProducts);
    this.#transferProduct = ecashTransferProduct;
    this.#cashCollection = ecashCashCollection ? Object.freeze({ ...ecashCashCollection }) : undefined;
    this.#chequeCollection = ecashChequeCollection ? Object.freeze({ ...ecashChequeCollection }) : undefined;
    this.#reserveMutation = reserveMutation;
    this.#storeIssuedPin = storeIssuedPin;
    this.#credentials = getCredentials;
    this.#processXml = processXml;
  }

  async execute(account: IpayAccount, request: Request, parent?: AbortSignal) {
    if (!account || account.tenantId !== this.#scope.tenantId || account.providerAccountId !== this.#scope.providerAccountId ||
        !request || !this.#allowed.has(request.operation)) throw new IpaySdkError('SCOPE_DENIED');
    request = Object.freeze({ ...request });
    if (request.operation === 'query' && (!safeId(request.originalReference) || !safeId(request.productCode) ||
        !safeId(request.transactionNumber))) throw new IpaySdkError('INVALID_REQUEST');
    if (request.operation === 'pinAvailability' && (typeof request.productCode !== 'string' || !/^[A-Za-z0-9]{1,6}$/.test(request.productCode) ||
        typeof request.amount !== 'string' || !/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,4})?$/.test(request.amount) ||
        !/[1-9]/.test(request.amount))) throw new IpaySdkError('INVALID_REQUEST');
    const deadline = AbortSignal.timeout(15_000);
    const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
    const mutation = financialOperations.has(request.operation)
      ? prepareMutation(request as FinancialRequest, this.#pinlessProducts, this.#transferProduct, this.#cashCollection, this.#chequeCollection) : undefined;
    if (mutation) {
      let admitted: boolean;
      try { admitted = await withinCatalogueDeadline(() => this.#reserveMutation!(this.#scope,mutation,signal),signal); }
      catch { throw new IpaySdkError('UNAVAILABLE'); }
      if (admitted !== true) throw new IpaySdkError('SCOPE_DENIED');
    }
    const fields: Record<string, string> = { Type: operations[request.operation] };
    if (request.operation === 'pinAvailability') fields['Type'] = this.#pinAvailabilityType!;
    if (request.operation === 'ecashCashCollection') fields['Type'] = this.#cashCollection!.requestType;
    if (request.operation === 'ecashChequeCollection') fields['Type'] = this.#chequeCollection!.requestType;
    if (request.operation !== 'version') {
      try {
        const { terminalId, password } = await withinCatalogueDeadline(() => this.#credentials(this.#scope, signal), signal);
        if (!safeId(terminalId) || typeof password !== 'string' || !/^[!-~]{1,512}$/.test(password)) throw new Error();
        fields['TerminalId'] = terminalId;
        fields['Password'] = password;
        if (this.#language !== undefined) fields['Language'] = this.#language;
      } catch { throw new IpaySdkError('UNAVAILABLE'); }
    }
    if (request.operation === 'query') fields['OriginalRefNo'] = request.originalReference;
    if (mutation) Object.assign(fields, mutation.fields);
    if (request.operation === 'productFile') fields['FileType'] = '1';
    if (request.operation === 'pinAvailability') {
      fields['ProdCode'] = request.productCode;
      fields['Amount'] = request.amount;
    }
    const cheque = mutation?.cheque;
    const wireCheque = cheque ? '<ChequeInfo>' + Object.entries(cheque).map(([tag,value]) => `<${tag}>${encodeText(value)}</${tag}>`).join('') + '</ChequeInfo>' : '';
    const body = '<RequestXml>' + Object.entries(fields).map(([tag, value]) => `<${tag}>${encodeText(value)}</${tag}>`).join('') + wireCheque + '</RequestXml>';
    try {
      const decoded = await withinCatalogueDeadline(() => this.#processXml(body, signal), signal);
      signal.throwIfAborted();
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return unavailable;
      const response = decoded as Record<string, unknown>;
      if (request.operation === 'version') {
        const version = response['Version'];
        return safeId(version) ? Object.freeze({ outcome: 'OBSERVED' as const, version }) : unavailable;
      }
      if (response['StatusCode'] !== '0') return unavailable;
      if (mutation) return await this.#observeMutation(mutation,response,signal);
      if (request.operation === 'balance') {
        const balance = response['Balance'];
        return safeAmount(balance) ? Object.freeze({ outcome: 'OBSERVED' as const, balance }) : unavailable;
      }
      if (request.operation === 'pinAvailability') {
        return response['StatusDescription'] === 'Pin is available'
          ? Object.freeze({ outcome: 'OBSERVED' as const, available: true }) : unavailable;
      }
      if (request.operation === 'productFile') {
        if (!this.#productFile) return unavailable;
        const catalogue = decodeIpayProductFile(response['FileData'], this.#productFile, response['ProductVer']);
        return Object.freeze({ outcome: 'OBSERVED' as const, catalogue });
      }
      if (request.operation === 'lastTransaction') {
        const product = response['ProductCode'], amount = response['Amount'];
        if (!safeId(product) || !safeAmount(amount)) return unavailable;
        const status = response['QortexStatus'];
        return Object.freeze({ outcome: 'OBSERVED' as const, productCode: product, amount,
          ...(validString(status,/^[A-Z0-9]$/) ? { providerStatus: status } : {}) });
      }
      if (request.operation !== 'query') return unavailable;
      const transactionNumber = response['TransNo'];
      if (response['ProductCode'] !== request.productCode || request.transactionNumber !== transactionNumber) return unavailable;
      const amount = response['Amount'];
      if (!safeAmount(amount)) return unavailable;
      return Object.freeze({ outcome: 'OBSERVED' as const, transactionNumber, amount });
    } catch { return unavailable; }
  }

  async #observeMutation(mutation: MutationIntent, response: Record<string,unknown>, signal: AbortSignal) {
    const transactionNumber = response['TransNo'];
    const echoedReference = response['RefNo'];
    const reference = mutation.fields['RefNo']!;
    if (!validString(transactionNumber,transactionNumberPattern) ||
        (echoedReference !== undefined && echoedReference !== reference)) return unavailable;
    if (mutation.operation === 'pinPurchase') {
      const pin = takeIpayIssuedPin(response);
      if (!pin) return unavailable;
      const receipt = await withinCatalogueDeadline(() => this.#storeIssuedPin!(this.#scope,reference,transactionNumber,pin,signal),signal);
      if (!validString(receipt,uuid)) return unavailable;
      return Object.freeze({ outcome: 'OBSERVED' as const, phase: 'PIN_STORED' as const, reference, transactionNumber, receipt });
    }
    const authorization = response['AuthorizationCode'];
    if (typeof authorization !== 'string' || authorization.length > 50 || /[\x00-\x1f\x7f]/.test(authorization)) return unavailable;
    if (mutation.operation === 'pinRefund' && !authorization.trim()) return unavailable;
    const phase = confirmationStarts.has(mutation.operation) && !authorization.trim() ? 'CONFIRMATION_REQUIRED' : 'ACKNOWLEDGED';
    return Object.freeze({ outcome: 'OBSERVED' as const, phase, reference, transactionNumber });
  }
}
