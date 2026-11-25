import { createHash, timingSafeEqual } from 'node:crypto';
import { identifier, isRecord, unsignedInteger } from './irongate-transaction-http.ts';
import type { IronGateAccountBinding } from './irongate-catalogue.ts';

type IronGateCallbackScope = Readonly<IronGateAccountBinding & {
  version: 'v1' | 'v2'; reference: string; productCode: string; customerId: string; providerTransactionId: string;
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const credential = /^[!-~]{1,512}$/;
const decimal = /^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/;

/** Validate a callback against a trusted attempt. The signed reference is a hint to query status. */
export function checkIronGateCallback(body: unknown, scope: IronGateCallbackScope,
  credentials: Readonly<{ username: string; apiKey: string }>) {
  if (!scope || (scope.version !== 'v1' && scope.version !== 'v2') ||
      ![scope.tenantId, scope.providerAccountId].every(value => typeof value === 'string' && uuid.test(value)) ||
      typeof scope.reference !== 'string' || !identifier.test(scope.reference) ||
      typeof scope.providerTransactionId !== 'string' || !unsignedInteger.test(scope.providerTransactionId) ||
      typeof scope.productCode !== 'string' || !identifier.test(scope.productCode) ||
      typeof scope.customerId !== 'string' || !/^[A-Za-z0-9_.+-]{1,128}$/.test(scope.customerId) ||
      !credentials || ![credentials.username, credentials.apiKey].every(value => typeof value === 'string' && credential.test(value)) ||
      !isRecord(body) || !isRecord(body['data'])) return undefined;
  const data = body['data'];
  const [productKey, customerKey] = scope.version === 'v1' ? ['code', 'hp'] : ['product_code', 'customer_id'];
  const sign = data['sign'], status = data['status'];
  if (data['ref_id'] !== scope.reference || data['tr_id'] !== scope.providerTransactionId || data[productKey!] !== scope.productCode ||
      data[customerKey!] !== scope.customerId || typeof sign !== 'string' || !/^[a-fA-F0-9]{32}$/.test(sign) ||
      (status !== '0' && status !== '1' && status !== '2') || typeof data['rc'] !== 'string' || !identifier.test(data['rc']) ||
      typeof data['message'] !== 'string' || data['message'].length > 512 ||
      typeof data['price'] !== 'string' || !decimal.test(data['price']) ||
      typeof data['balance'] !== 'string' || !decimal.test(data['balance'])) return undefined;
  const expected = createHash('md5').update(credentials.username + credentials.apiKey + scope.reference).digest();
  if (!timingSafeEqual(expected, Buffer.from(sign, 'hex'))) return undefined;
  // The vendor signature covers only the reference. Mutable fields cannot authorize fulfilment.
  return Object.freeze({ outcome: 'STATUS_RECHECK_REQUIRED' as const, tenantId: scope.tenantId,
    providerAccountId: scope.providerAccountId, reference: scope.reference, providerTransactionId: scope.providerTransactionId });
}
