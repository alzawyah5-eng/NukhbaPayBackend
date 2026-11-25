import { createHash } from 'node:crypto';
import { readCatalogueJson, wireNumber, withinCatalogueDeadline } from './catalogue-http.ts';
import type { IronGateAccountBinding } from './irongate-catalogue.ts';

export interface IronGateTransactionOptions {
  readonly account: IronGateAccountBinding;
  readonly baseUrl: string;
  readonly getCredentials: (account: IronGateAccountBinding, signal: AbortSignal) => Promise<Readonly<{ username: string; apiKey: string }>>;
  /** A separately authorized backend transaction runtime must supply the transport. */
  readonly transport: typeof fetch;
}

export class IronGateTransactionError extends Error {
  readonly code: 'INVALID_CONFIGURATION' | 'SCOPE_DENIED' | 'INVALID_REQUEST' | 'UNAVAILABLE';
  constructor(code: IronGateTransactionError['code']) {
    super('IronGate operation stopped');
    this.name = 'IronGateTransactionError';
    this.code = code;
  }
}

export const identifier = /^[A-Za-z0-9_-]{1,64}$/;
export const unsignedInteger = /^(?:0|[1-9][0-9]{0,29})$/;
const decimal = /^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?(?:[eE][+-]?[0-9]{1,2})?$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const credential = /^[!-~]{1,512}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function exactNumeric(value: unknown, pattern: RegExp = decimal): string | undefined {
  const raw = wireNumber(value);
  return raw !== undefined && pattern.test(raw) ? raw : undefined;
}

export const unconfirmed = Object.freeze({ outcome: 'UNCONFIRMED' as const });

export function createIronGateTransactionTransport(options: IronGateTransactionOptions, exactFields: ReadonlySet<string>) {
  let origin: string;
  let account: Readonly<IronGateAccountBinding>;
  const { getCredentials, transport } = options;
  try {
    origin = new URL(options.baseUrl).origin;
    const { tenantId, providerAccountId } = options.account;
    if (!origin.startsWith('https://') || ![origin, origin + '/'].includes(options.baseUrl) ||
        ![tenantId, providerAccountId].every(value => typeof value === 'string' && uuid.test(value)) ||
        typeof getCredentials !== 'function' || typeof transport !== 'function') throw new Error();
    account = Object.freeze({ tenantId, providerAccountId });
  } catch { throw new IronGateTransactionError('INVALID_CONFIGURATION'); }

  async function send(binding: IronGateAccountBinding, path: string, suffix: string,
    body: Readonly<Record<string, unknown>>, parent?: AbortSignal): Promise<unknown> {
    if (!binding || binding.tenantId !== account.tenantId || binding.providerAccountId !== account.providerAccountId)
      throw new IronGateTransactionError('SCOPE_DENIED');
    const deadline = AbortSignal.timeout(30_000);
    const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
    let username: string, sign: string;
    try {
      const credentials = await withinCatalogueDeadline(() => getCredentials(account, signal), signal);
      username = credentials.username;
      if (typeof username !== 'string' || !credential.test(username) || typeof credentials.apiKey !== 'string' || !credential.test(credentials.apiKey))
        throw new Error();
      sign = createHash('md5').update(username + credentials.apiKey + suffix).digest('hex');
      signal.throwIfAborted();
    } catch { throw new IronGateTransactionError('UNAVAILABLE'); }
    const url = origin + path;
    try {
      const response = await withinCatalogueDeadline(() => transport(url, { method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, username, sign }), signal, redirect: 'error', cache: 'no-store', credentials: 'omit' }), signal);
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url)) {
        void response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const envelope = await readCatalogueJson(response, signal, exactFields, () => new Error('Invalid IronGate response'));
      signal.throwIfAborted();
      return isRecord(envelope) ? envelope['data'] : undefined;
    } catch { return undefined; }
  }

  return send;
}
