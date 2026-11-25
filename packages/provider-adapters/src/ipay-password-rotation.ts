import { withinCatalogueDeadline } from './catalogue-http.ts';
import { IpaySdkError, type IpayAccount } from './ipay-sdk.ts';
import { encodeIpayXmlText } from './ipay-soap.ts';

interface ReservedRotation extends IpayAccount {
  readonly rotationId: string;
  readonly terminalId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

interface Options {
  readonly account: IpayAccount;
  /** Atomically claim an approved change and return the two protected secret versions. */
  readonly reserveRotation: (account: IpayAccount, rotationId: string, signal: AbortSignal) => Promise<ReservedRotation | undefined>;
  /** Activate the prepared secret version only after an acknowledged response for this reservation. */
  readonly recordAcknowledgement: (account: IpayAccount, rotationId: string, signal: AbortSignal) => Promise<boolean>;
  readonly processXml: (requestXml: string, signal: AbortSignal) => Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unconfirmed = Object.freeze({ outcome:'UNCONFIRMED' as const });

/** The local secret store owns reservation and reconciliation. This adapter sends one SOAP attempt. */
export function createIpayPasswordRotation(options: Options) {
  const { account, reserveRotation, recordAcknowledgement, processXml } = options;
  if (!account || ![account.tenantId,account.providerAccountId].every(value => typeof value === 'string' && uuid.test(value)) ||
      [reserveRotation,recordAcknowledgement,processXml].some(port => typeof port !== 'function')) throw new IpaySdkError('INVALID_CONFIGURATION');
  const scope = Object.freeze({ tenantId:account.tenantId,providerAccountId:account.providerAccountId });

  return async function rotate(binding: IpayAccount, rotationId: string, parent?: AbortSignal) {
    if (!binding || binding.tenantId !== scope.tenantId || binding.providerAccountId !== scope.providerAccountId)
      throw new IpaySdkError('SCOPE_DENIED');
    if (typeof rotationId !== 'string' || !uuid.test(rotationId)) throw new IpaySdkError('INVALID_REQUEST');
    const deadline = AbortSignal.timeout(15_000);
    const signal = parent ? AbortSignal.any([parent,deadline]) : deadline;
    let rotation: ReservedRotation | undefined;
    try { rotation = await withinCatalogueDeadline(() => reserveRotation(scope,rotationId,signal),signal); }
    catch { throw new IpaySdkError('UNAVAILABLE'); }
    if (!rotation || rotation.tenantId !== scope.tenantId || rotation.providerAccountId !== scope.providerAccountId || rotation.rotationId !== rotationId)
      throw new IpaySdkError('SCOPE_DENIED');
    const {terminalId,currentPassword,newPassword} = rotation;
    if (typeof terminalId !== 'string' || !/^[A-Za-z0-9_.-]{1,20}$/.test(terminalId) ||
        typeof currentPassword !== 'string' || !/^[!-~]{1,512}$/.test(currentPassword) ||
        typeof newPassword !== 'string' || !/^[0-9]{4,20}$/.test(newPassword) || currentPassword === newPassword)
      throw new IpaySdkError('INVALID_REQUEST');
    const request = `<RequestXml><Type>ChangeStPass</Type><TerminalId>${encodeIpayXmlText(terminalId)}</TerminalId>` +
      `<Password>${encodeIpayXmlText(currentPassword)}</Password><NewPassword>${newPassword}</NewPassword></RequestXml>`;
    try {
      const reply = await withinCatalogueDeadline(() => processXml(request,signal),signal);
      if (!reply || typeof reply !== 'object' || !Object.hasOwn(reply,'StatusCode') || (reply as Record<string,unknown>)['StatusCode'] !== '0')
        return unconfirmed;
      const recorded = await withinCatalogueDeadline(() => recordAcknowledgement(scope,rotationId,signal),signal);
      return recorded === true ? Object.freeze({ outcome:'RECORDED' as const,rotationId }) : unconfirmed;
    } catch { return unconfirmed; }
  };
}
