// Previous Layer 1 implementation — disabled while rebuilding according to the new approved architecture.
// import { formatAed, parseAed } from '../../../domain/src/money.js';
//
// const scale = 1_000_000n;
//
// function scaledDecimal(value: unknown): bigint {
//   if (typeof value !== 'string' || value.length > 14 || !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/.test(value)) {
//     throw new TypeError('Enter a nonnegative decimal with up to six decimal places');
//   }
//   const [whole, fraction = ''] = value.split('.');
//   return BigInt(whole!) * scale + BigInt(fraction.padEnd(6, '0'));
// }
//
// export interface LocalPricePreviewBasis {
//   readonly senderCurrency: string;
//   readonly senderAmount: string;
//   readonly demoAedRate: string;
//   readonly platformFeeAed: string;
//   readonly commissionAed: string;
// }
//
// /** Estimates from server-held sender cost and a labelled demo conversion rate. */
// export function calculateAedPricePreview(basis: LocalPricePreviewBasis) {
//   if (typeof basis.senderCurrency!=='string' || !/^[A-Z]{3}$/.test(basis.senderCurrency)) {
//     throw new TypeError('Invalid pricing scenario');
//   }
//   const cost = scaledDecimal(basis.senderAmount);
//   const rate = scaledDecimal(basis.demoAedRate);
//   if (cost === 0n || rate === 0n || (basis.senderCurrency === 'AED' && rate !== scale)) {
//     throw new RangeError('Invalid sender cost or exchange rate');
//   }
//   const scaleSquared = scale * scale;
//   const estimatedCostMinor = (cost * rate * 100n + scaleSquared / 2n) / scaleSquared;
//   if (estimatedCostMinor === 0n) throw new RangeError('The converted cost is below one AED minor unit');
//   const platformFeeMinor = parseAed(basis.platformFeeAed);
//   const commissionMinor = parseAed(basis.commissionAed);
//   return Object.freeze({
//     currency: 'AED' as const,
//     basis: 'OBSERVED_SENDER_COST_DEMO_FX' as const,
//     senderAmount: basis.senderAmount,
//     senderCurrency: basis.senderCurrency,
//     demoAedRate: basis.demoAedRate,
//     estimatedCost: formatAed(estimatedCostMinor),
//     platformFee: formatAed(platformFeeMinor),
//     commission: formatAed(commissionMinor),
//     indicativePrice: formatAed(estimatedCostMinor + platformFeeMinor + commissionMinor),
//   });
// }
//
// export type LocalPricePreview = ReturnType<typeof calculateAedPricePreview>;
//
// export interface LocalPricePreviewBook {
//   readonly tenantId: string;
//   readonly prices: ReadonlyMap<string, LocalPricePreview>;
// }
//
// const discoveryUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// const invalidBook = () => new TypeError('Invalid local price previews');
//
// function record(value: unknown): Record<string, unknown> {
//   if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidBook();
//   return value as Record<string, unknown>;
// }
//
// /** Bind local observations to the current tenant and database installation before accepting any prices. */
// export function readLocalPricePreviewBook(value: unknown, tenantId: string, setupId: string): LocalPricePreviewBook {
//   const config = record(value);
//   const { tenantId: scope, setupId: target, version, platformFeeAed, commissionAed } = config;
//   if (scope !== tenantId || target !== setupId || typeof platformFeeAed !== 'string' || typeof commissionAed !== 'string') {
//     throw invalidBook();
//   }
//
//   const entries = version === 1 ? [config] : config['entries'];
//   if (version !== 1 && version !== 2) throw invalidBook();
//   if (!Array.isArray(entries) || entries.length === 0 || entries.length > 10_000) throw invalidBook();
//
//   const prices = new Map<string, LocalPricePreview>();
//   for (const value of entries) {
//     const { discoveryId, senderCurrency, senderAmount, demoAedRate } = record(value);
//     if (typeof discoveryId !== 'string' || !discoveryUuid.test(discoveryId) || prices.has(discoveryId) ||
//         typeof senderCurrency !== 'string' || typeof senderAmount !== 'string' || typeof demoAedRate !== 'string') {
//       throw invalidBook();
//     }
//     prices.set(discoveryId, calculateAedPricePreview({ senderCurrency, senderAmount, demoAedRate, platformFeeAed, commissionAed }));
//   }
//   return Object.freeze({ tenantId, prices });
// }
