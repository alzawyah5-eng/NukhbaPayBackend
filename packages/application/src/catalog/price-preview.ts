import { formatAed } from '../../../domain/src/money.js';

const scale = 1_000_000n;
const platformFeeMinor = 200n;
const commissionMinor = 50n;

function scaledDecimal(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 14 || !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/.test(value)) {
    throw new TypeError('Enter a nonnegative decimal with up to six decimal places');
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * scale + BigInt(fraction.padEnd(6, '0'));
}

export interface LocalPricePreviewBasis {
  readonly senderCurrency: string;
  readonly senderAmount: string;
  readonly demoAedRate: string;
}

/** Estimates from server-held sender cost and a labelled demo conversion rate. */
export function calculateAedPricePreview(basis: LocalPricePreviewBasis) {
  if (typeof basis.senderCurrency!=='string' || !/^[A-Z]{3}$/.test(basis.senderCurrency)) {
    throw new TypeError('Invalid pricing scenario');
  }
  const cost = scaledDecimal(basis.senderAmount);
  const rate = scaledDecimal(basis.demoAedRate);
  if (cost === 0n || rate === 0n || (basis.senderCurrency === 'AED' && rate !== scale)) {
    throw new RangeError('Invalid sender cost or exchange rate');
  }
  const scaleSquared = scale * scale;
  const estimatedCostMinor = (cost * rate * 100n + scaleSquared / 2n) / scaleSquared;
  if (estimatedCostMinor === 0n) throw new RangeError('The converted cost is below one AED minor unit');
  return Object.freeze({
    currency: 'AED' as const,
    basis: 'OBSERVED_SENDER_COST_DEMO_FX' as const,
    senderAmount: basis.senderAmount,
    senderCurrency: basis.senderCurrency,
    demoAedRate: basis.demoAedRate,
    estimatedCost: formatAed(estimatedCostMinor),
    platformFee: formatAed(platformFeeMinor),
    commission: formatAed(commissionMinor),
    indicativePrice: formatAed(estimatedCostMinor + platformFeeMinor + commissionMinor),
  });
}
