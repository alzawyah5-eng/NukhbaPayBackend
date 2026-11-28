export const AED_NORMALIZATION_UNAVAILABLE = 'AED_NORMALIZATION_UNAVAILABLE';

export class AedNormalizationUnavailableError extends Error {
  readonly code = AED_NORMALIZATION_UNAVAILABLE;

  constructor() {
    super('AED acquisition-cost normalization is unavailable during the Layer 1 rebuild.');
    this.name = 'AedNormalizationUnavailableError';
  }
}
