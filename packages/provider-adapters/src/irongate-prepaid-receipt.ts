import { readCatalogueJson, withinCatalogueDeadline } from './catalogue-http.ts';
import type { IronGateAccountBinding } from './irongate-catalogue.ts';
import { exactNumeric, identifier, IronGateTransactionError, isRecord, unconfirmed, unsignedInteger } from './irongate-transaction-http.ts';

interface ReceiptAttempt extends IronGateAccountBinding {
  readonly providerTransactionId: string;
  readonly transactionReference: string;
  readonly productCode: string;
  readonly customerId: string;
}

interface ReceiptOptions {
  readonly account: IronGateAccountBinding;
  readonly baseUrl: string;
  readonly successCode: string;
  /** Must use the vendor-approved account egress. The receipt contract has no signed request body. */
  readonly transport: typeof fetch;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const id = /^[1-9]\d{0,29}$/;
const decimal = /^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/;
const exactFields = new Set(['tr_id', 'price', 'admin_fee']);

/** Retrieves a minimal receipt projection for a previously recorded v2 prepaid attempt. */
export function createIronGatePrepaidReceiptReader(options: ReceiptOptions) {
  const { account, baseUrl, successCode, transport } = options;
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
    if (!origin.startsWith('https://') || ![origin, origin + '/'].includes(baseUrl) || typeof transport !== 'function' ||
        ![account.tenantId, account.providerAccountId].every(value => typeof value === 'string' && uuid.test(value)) ||
        typeof successCode !== 'string' || !identifier.test(successCode)) throw new Error();
  } catch { throw new IronGateTransactionError('INVALID_CONFIGURATION'); }
  const { tenantId, providerAccountId } = account;

  return async function read(attempt: ReceiptAttempt, parent?: AbortSignal) {
    if (!attempt || attempt.tenantId !== tenantId || attempt.providerAccountId !== providerAccountId)
      throw new IronGateTransactionError('SCOPE_DENIED');
    const { providerTransactionId, transactionReference, customerId, productCode } = attempt;
    if (![transactionReference, productCode].every(value => typeof value === 'string' && identifier.test(value)) ||
        typeof providerTransactionId !== 'string' || !id.test(providerTransactionId) ||
        typeof customerId !== 'string' || !/^[A-Za-z0-9_.+-]{1,128}$/.test(customerId))
      throw new IronGateTransactionError('INVALID_REQUEST');
    const deadline = AbortSignal.timeout(10_000);
    const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
    const url = `${origin}/api/download/${providerTransactionId}/1`;
    try {
      const response = await withinCatalogueDeadline(() => transport(url, { method: 'GET', headers: { Accept: 'application/json' },
        signal, redirect: 'error', cache: 'no-store', credentials: 'omit' }), signal);
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url)) {
        void response.body?.cancel().catch(() => undefined);
        return unconfirmed;
      }
      const envelope = await readCatalogueJson(response, signal, exactFields, () => new Error('Invalid receipt'));
      signal.throwIfAborted();
      if (!isRecord(envelope) || !isRecord(envelope['data'])) return unconfirmed;
      const data = envelope['data'];
      if (data['rc'] !== successCode || exactNumeric(data['tr_id'], unsignedInteger) !== providerTransactionId ||
          data['ref_id'] !== transactionReference || data['customer_id'] !== customerId || data['product_code'] !== productCode ||
          typeof data['status'] !== 'number' || !Number.isSafeInteger(data['status'])) return unconfirmed;
      const amount = (value: unknown) => typeof value === 'string' && decimal.test(value) ? value : exactNumeric(value, decimal);
      const price = amount(data['price']), adminFee = amount(data['admin_fee']);
      if (price === undefined || adminFee === undefined) return unconfirmed;
      return Object.freeze({ outcome: 'OBSERVED' as const, providerTransactionId, transactionReference, status: data['status'], price, adminFee });
    } catch { return unconfirmed; }
  };
}
