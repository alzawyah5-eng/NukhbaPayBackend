/** Prototype limit: AED 1,000,000.00. A product-specific limit belongs in policy. */
export const MAX_AMOUNT_MINOR = 100_000_000n;
const MAX_AED_INPUT_LENGTH = (MAX_AMOUNT_MINOR / 100n).toString().length + 3;

export function assertMinorAmount(value: unknown, name: string): asserts value is bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_AMOUNT_MINOR) {
    throw new TypeError(`${name} must be a nonnegative bigint within the prototype amount limit`);
  }
}

/** Accept canonical AED decimal strings only; never parse money using Number. */
export function parseAed(value: string): bigint {
  return parseTwoDecimalAmount(value, "AED");
}

/** Both currently supported settlement currencies use two decimal places. */
export function parseTwoDecimalAmount(value: string, currency: "AED" | "USD"): bigint {
  if (typeof value !== "string") {
    throw new TypeError(`${currency} input must be a decimal string`);
  }
  // Bound work before regex matching and BigInt conversion of external input.
  if (value.length > MAX_AED_INPUT_LENGTH) {
    throw new RangeError(`${currency} input must be at most ${MAX_AED_INPUT_LENGTH} characters`);
  }
  if (!/^(0|[1-9]\d*)\.\d{2}$/.test(value)) {
    throw new TypeError(`${currency} input must be a canonical decimal string with exactly two decimal places`);
  }
  const [whole, fraction] = value.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction!);
  assertMinorAmount(minor, `${currency} amount`);
  return minor;
}

export function formatAed(value: bigint): string {
  assertMinorAmount(value, "AED amount");
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

/** Explicit half-up rounding for nonnegative amounts; provider contracts may require other rules. */
export function percentageFeeMinor(amountMinor: bigint, basisPoints: number): bigint {
  assertMinorAmount(amountMinor, "percentage fee base");
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new TypeError("basisPoints must be an integer between 0 and 10000");
  }
  return roundNonnegativeHalfUp(amountMinor * BigInt(basisPoints), 10_000n);
}

/** Shared exact rounding for nonnegative ratios. */
export function roundNonnegativeHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new RangeError("Invalid rounding operands");
  return (numerator + denominator / 2n) / denominator;
}
