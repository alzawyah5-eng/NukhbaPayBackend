import { readProviderBytes, withinCatalogueDeadline } from './catalogue-http.ts';
import type { IronGateAccountBinding } from './irongate-catalogue.ts';
import { identifier, IronGateTransactionError, unconfirmed } from './irongate-transaction-http.ts';

interface PaidInquiry extends IronGateAccountBinding {
  readonly inquiryId: string;
  readonly transactionReference: string;
  readonly status: 'PAID';
}

interface PostpaidReceiptOptions {
  readonly account: IronGateAccountBinding;
  readonly baseUrl: string;
  /** Read the paid state from the trusted local ledger for this exact account and inquiry. */
  readonly readPaidInquiry: (account: IronGateAccountBinding, inquiryId: string, signal: AbortSignal) => Promise<PaidInquiry | undefined>;
  readonly getUsername: (account: IronGateAccountBinding, signal: AbortSignal) => Promise<string>;
  /** Persist privately and return an opaque UUID. */
  readonly storeReceipt: (inquiry: PaidInquiry, pdf: Readonly<Uint8Array>, signal: AbortSignal) => Promise<string>;
  /** Must use the vendor-authorized egress for the postpaid account. */
  readonly transport: typeof fetch;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const inquiryPattern = /^[1-9][0-9]{0,29}$/;
const usernamePattern = /^[A-Za-z0-9][A-Za-z0-9_.+@-]{0,95}$/;

/** Retrieve the documented PDF form for an already-paid postpaid inquiry. */
export function createIronGatePostpaidReceiptReader(options: PostpaidReceiptOptions) {
  const { account, baseUrl, readPaidInquiry, getUsername, storeReceipt, transport } = options;
  let origin: string;
  let scope: IronGateAccountBinding;
  try {
    origin = new URL(baseUrl).origin;
    if (!origin.startsWith('https://') || ![origin, origin + '/'].includes(baseUrl) ||
        ![account.tenantId,account.providerAccountId].every(value => typeof value === 'string' && uuid.test(value)) ||
        [readPaidInquiry,getUsername,storeReceipt,transport].some(port => typeof port !== 'function')) throw new Error();
    scope = Object.freeze({ tenantId:account.tenantId,providerAccountId:account.providerAccountId });
  } catch { throw new IronGateTransactionError('INVALID_CONFIGURATION'); }

  return async function read(binding: IronGateAccountBinding, inquiryId: string, parent?: AbortSignal) {
    if (!binding || binding.tenantId !== scope.tenantId || binding.providerAccountId !== scope.providerAccountId)
      throw new IronGateTransactionError('SCOPE_DENIED');
    if (typeof inquiryId !== 'string' || !inquiryPattern.test(inquiryId)) throw new IronGateTransactionError('INVALID_REQUEST');
    const deadline = AbortSignal.timeout(10_000);
    const signal = parent ? AbortSignal.any([parent,deadline]) : deadline;
    let paid: PaidInquiry | undefined;
    try { paid = await withinCatalogueDeadline(() => readPaidInquiry(scope,inquiryId,signal),signal); }
    catch { throw new IronGateTransactionError('UNAVAILABLE'); }
    if (!paid || paid.status !== 'PAID' || paid.tenantId !== scope.tenantId || paid.providerAccountId !== scope.providerAccountId ||
        paid.inquiryId !== inquiryId || typeof paid.transactionReference !== 'string' || !identifier.test(paid.transactionReference))
      throw new IronGateTransactionError('SCOPE_DENIED');
    const receiptScope = Object.freeze({ ...scope, inquiryId, transactionReference:paid.transactionReference, status:'PAID' as const });
    try {
      const username = await withinCatalogueDeadline(() => getUsername(scope,signal),signal);
      if (typeof username !== 'string' || !usernamePattern.test(username)) throw new IronGateTransactionError('UNAVAILABLE');
      const url = `${origin}/api/v1/download/${inquiryId}/0/${encodeURIComponent(username)}`;
      const response = await withinCatalogueDeadline(() => transport(url,{ method:'GET',headers:{ Accept:'application/pdf' },
        redirect:'error',credentials:'omit',cache:'no-store',signal }),signal);
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url)) {
        void response.body?.cancel().catch(() => undefined);
        return unconfirmed;
      }
      const pdf = await readProviderBytes(response,signal,'application/pdf',() => new IronGateTransactionError('UNAVAILABLE'));
      if (!/^%PDF-[12]\.\d[\r\n]/.test(pdf.subarray(0,12).toString('latin1')) ||
          !/%%EOF[\t\n\r\f ]*$/.test(pdf.subarray(-1024).toString('latin1'))) return unconfirmed;
      const receipt = await withinCatalogueDeadline(() => storeReceipt(receiptScope,pdf,signal),signal);
      return typeof receipt === 'string' && uuid.test(receipt)
        ? Object.freeze({ outcome:'OBSERVED' as const,inquiryId,receipt }) : unconfirmed;
    } catch { return unconfirmed; }
  };
}
