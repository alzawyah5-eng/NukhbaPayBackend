import { formatAed, roundNonnegativeHalfUp } from './money.ts';

export const ACQUISITION_CALCULATOR_VERSION = 'aed-acquisition-v2';
export const LEGACY_ACQUISITION_CALCULATOR_VERSION = 'aed-acquisition-v1';
export const AED_RATE_DIRECTION = 'AED_PER_SOURCE_UNIT';

export function parseAcquisitionDecimal(value: string, maxScale: number, maxWholeDigits: number) {
  if (typeof value !== 'string' || value.length > maxWholeDigits + maxScale + 1 ||
      !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new RangeError('Invalid exact decimal');
  const [whole, fraction = ''] = value.split('.');
  if (whole!.length > maxWholeDigits || fraction.length > maxScale) throw new RangeError('Decimal precision exceeded');
  return { coefficient: BigInt(whole! + fraction), scale: fraction.length };
}

export interface AedAcquisitionCalculation {
  /** Unquantized AED decimal. Use this amount in Layer 2. */
  readonly amount: string;
  readonly currency: 'AED';
  readonly workingScale: number;
  readonly direction: typeof AED_RATE_DIRECTION;
  /** A two-decimal projection for display. It is not a provider debit or a pricing input. */
  readonly displayAmount: string;
  readonly displayScale: 2;
  readonly rounding: 'HALF_UP';
  readonly roundingBoundary: 'DISPLAY_ONLY';
  readonly calculatorVersion: typeof ACQUISITION_CALCULATOR_VERSION | typeof LEGACY_ACQUISITION_CALCULATOR_VERSION;
}

/** Multiply exactly. Apply rounding only to the two-decimal display projection. */
export function calculateAedAcquisitionCost(input: {
  amount: string; sourceScale: number; rate: string; rateScale: number;
  direction: typeof AED_RATE_DIRECTION; rounding: 'HALF_UP';
}): AedAcquisitionCalculation {
  const { sourceScale, rateScale } = input;
  if (!Number.isInteger(sourceScale) || sourceScale < 0 || sourceScale > 8 ||
      !Number.isInteger(rateScale) || rateScale < 0 || rateScale > 12 ||
      input.direction !== AED_RATE_DIRECTION || input.rounding !== 'HALF_UP') {
    throw new RangeError('Unsupported AED calculation policy');
  }
  const amount = parseAcquisitionDecimal(input.amount, sourceScale, 15);
  const rate = parseAcquisitionDecimal(input.rate, rateScale, 12);
  if (amount.coefficient === 0n || rate.coefficient === 0n) throw new RangeError('Cost and rate must be positive');
  const workingScale = amount.scale + rate.scale;
  const product = amount.coefficient * rate.coefficient;
  const divisor = 10n ** BigInt(workingScale);
  const digits = product.toString().padStart(workingScale + 1, '0');
  const exact = workingScale === 0 ? digits : digits.slice(0, -workingScale) + '.' + digits.slice(-workingScale);
  const displayFils = roundNonnegativeHalfUp(product * 100n, divisor);
  return Object.freeze({
    amount: exact, currency: 'AED', workingScale, direction: input.direction,
    displayAmount: formatAed(displayFils), displayScale: 2, rounding: input.rounding,
    roundingBoundary: 'DISPLAY_ONLY', calculatorVersion: ACQUISITION_CALCULATOR_VERSION,
  });
}
