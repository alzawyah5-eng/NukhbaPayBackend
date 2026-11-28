import { parseAcquisitionDecimal } from '../../domain/src/acquisition-cost.ts';
import { roundNonnegativeHalfUp } from '../../domain/src/money.ts';
import { readCatalogueJson, wireNumber } from './catalogue-http.ts';

const endpoint = 'https://currencyapi.net/api/v2/rates';
const maxAgeMs = 72 * 60 * 60 * 1000;
const rateScale = 12;
const unavailable = () => new Error('Currency API rates unavailable');

function readLeg(value: unknown) {
  const amount = wireNumber(value) ?? (typeof value === 'string' ? value : undefined);
  if (amount === undefined) throw unavailable();
  const decimal = parseAcquisitionDecimal(amount, 24, 15);
  if (decimal.coefficient===0n) throw unavailable();
  return {...decimal, amount};
}

/** The USD-base table gives units of each currency per USD. Divide the two
 * exact legs once, and quantize only the derived AED-per-unit rate. */
export async function readCurrencyApiAedRates(currencies: readonly string[], apiKey: string, transport: typeof fetch = fetch) {
  if (!/^[A-Za-z0-9_-]{36}$/.test(apiKey)) throw unavailable();
  const url = new URL(endpoint);
  url.search = new URLSearchParams({key:apiKey, output:'JSON'}).toString();
  const signal = AbortSignal.timeout(8_000);
  let response: Response;
  try {
    response = await transport(url.href, {method:'GET', redirect:'error', signal, cache:'no-store',
      headers:{Accept:'application/json'}});
  } catch { throw unavailable(); }
  if (response.status!==200 || response.redirected || (response.url && response.url!==url.href)) {
    void response.body?.cancel().catch(()=>undefined);
    throw unavailable();
  }
  const body = await readCatalogueJson(response,signal,new Set([...currencies,'AED']),unavailable) as {
    valid?:unknown; base?:unknown; updated?:unknown; rates?:Record<string,unknown>;
  };
  const retrieved = Date.now();
  const effective = typeof body?.updated==='number' && Number.isSafeInteger(body.updated) ? body.updated*1000 : NaN;
  if (body?.valid!==true || body.base!=='USD' || !body.rates || typeof body.rates!=='object' || Array.isArray(body.rates) ||
      !Number.isFinite(effective) || effective>retrieved || retrieved-effective>maxAgeMs) throw unavailable();

  const aed = readLeg(body.rates.AED);
  const effectiveAt = new Date(effective).toISOString();
  const retrievedAt = new Date(retrieved).toISOString();
  return [...new Set(currencies)].flatMap(currency => {
    if (currency==='AED' || !/^[A-Z]{3}$/.test(currency)) return [];
    try {
      const source = readLeg(currency==='USD' ? '1' : body.rates![currency]);
      const rate = roundNonnegativeHalfUp(
        aed.coefficient * 10n ** BigInt(source.scale+rateScale),
        source.coefficient * 10n ** BigInt(aed.scale),
      );
      if (rate===0n || rate>=10n ** BigInt(12+rateScale)) return [];
      const digits = rate.toString().padStart(rateScale+1,'0');
      const aedPerUnit = digits.slice(0,-rateScale)+'.'+digits.slice(-rateScale);
      return [{currency,aedPerUnit,effectiveAt,retrievedAt,usdAedRate:aed.amount,usdSourceRate:source.amount}];
    } catch { return []; }
  });
}
