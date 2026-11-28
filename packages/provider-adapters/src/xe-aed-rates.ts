import { readCatalogueJson, wireNumber } from './catalogue-http.ts';

const endpoint = 'https://xecdapi.xe.com/v1/convert_from.json/';
const currencyCode = /^[A-Z]{3}$/;
const unavailable = () => new Error('XE rate unavailable');

export async function readXeAedRate(currency: string, apiKey: string, transport: typeof fetch = fetch) {
  if (!currencyCode.test(currency) || currency === 'AED' ||
      !/^xecd_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(apiKey) || apiKey.length > 1024) throw unavailable();
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ from: currency, to: 'AED', amount: '1' }).toString();
  const signal = AbortSignal.timeout(8_000);
  const response = await transport(url.href, { method: 'GET', redirect: 'error', signal, cache: 'no-store',
    headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' } });
  if (response.status !== 200 || response.redirected || (response.url && response.url !== url.href)) {
    void response.body?.cancel().catch(() => undefined);
    throw unavailable();
  }
  const body = await readCatalogueJson(response, signal, new Set(['mid']), unavailable) as {
    from?: unknown; amount?: unknown; timestamp?: unknown; to?: { quotecurrency?: unknown; mid?: unknown }[];
  };
  const quote = Array.isArray(body?.to) && body.to.length === 1 ? body.to[0] : undefined;
  const aedPerUnit = wireNumber(quote?.mid) ?? quote?.mid;
  const fetched = Date.now();
  const effective = typeof body?.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(body.timestamp)
    ? Date.parse(body.timestamp) : NaN;
  if (body?.from !== currency || body.amount !== 1 || quote?.quotecurrency !== 'AED' ||
      typeof aedPerUnit !== 'string' || !/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,12})?$/.test(aedPerUnit) ||
      !/[1-9]/.test(aedPerUnit) || !Number.isFinite(effective) || effective > fetched ||
      fetched - effective > 72 * 60 * 60 * 1000) throw unavailable();
  return Object.freeze({ currency, aedPerUnit, effectiveAt: new Date(effective).toISOString(),
    retrievedAt: new Date(fetched).toISOString() });
}
