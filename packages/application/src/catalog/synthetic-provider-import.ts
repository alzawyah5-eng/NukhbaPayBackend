import type { CatalogProvider, ProviderOffer } from "../../../provider-contracts/src/index.js";

export interface CatalogImportCounts {
  readonly products: number;
  readonly mappings: number;
  readonly offers: number;
}

export interface CatalogImportResult {
  readonly tenantId: string;
  readonly providerAccountId: string;
  readonly snapshotId: string;
  readonly snapshotKey: string;
  readonly sourceVersion: string;
  readonly status: "COMPLETE";
  readonly created: boolean;
  readonly counts: CatalogImportCounts;
  readonly acceptedAt: string;
}

export interface CatalogSnapshotReadResult {
  readonly snapshot: {
    readonly id: string;
    readonly tenantId: string;
    readonly providerAccountId: string;
    readonly snapshotKey: string;
    readonly sourceVersion: string;
    readonly observedAt: string;
    readonly effectiveAt: string | null;
    readonly status: "COMPLETE" | "IN_PROGRESS" | "FAILED";
    readonly rowCount: number | null;
    readonly startedAt: string;
    readonly completedAt: string | null;
  };
  readonly offers: readonly {
    readonly id: string;
    readonly providerOfferKey: string;
    readonly providerDebitMinor: bigint;
    readonly additionalProviderFeeMinor: bigint | null;
    readonly upfrontDiscountMinor: bigint | null;
    readonly available: boolean;
    readonly observedAt: string;
    readonly validUntil: string;
    readonly productId: string;
    readonly faceValueMinor: bigint;
    readonly productMappingId: string;
  }[];
}

export interface CatalogImportRepository {
  readonly importSyntheticSnapshot: (
    context: {
      readonly tenantId: string;
      readonly providerAccountId: string;
      readonly snapshotKey: string;
      readonly sourceVersion: string;
      readonly observedAt: string;
      readonly effectiveAt?: string | null;
    },
    offers: readonly ProviderOffer[],
  ) => Promise<CatalogImportResult>;
  readonly readSnapshot: (
    tenantId: string,
    providerAccountId: string,
    snapshotKey: string,
  ) => Promise<CatalogSnapshotReadResult | null>;
}

export interface SyntheticImportRequest {
  readonly tenantId: string;
  readonly providerAccountId: string;
  readonly snapshotKey: string;
  readonly sourceVersion: string;
  readonly observedAt: string;
  readonly effectiveAt?: string | null;
  readonly offers: readonly ProviderOffer[];
}

export type SyntheticImportResult = CatalogImportResult;

export async function importSyntheticProviderSnapshot(
  repository: CatalogImportRepository,
  request: SyntheticImportRequest,
): Promise<SyntheticImportResult> {
  return repository.importSyntheticSnapshot({
    tenantId: request.tenantId,
    providerAccountId: request.providerAccountId,
    snapshotKey: request.snapshotKey,
    sourceVersion: request.sourceVersion,
    observedAt: request.observedAt,
    effectiveAt: request.effectiveAt ?? null,
  }, request.offers);
}

export async function readSyntheticProviderSnapshot(
  repository: CatalogImportRepository,
  tenantId: string,
  providerAccountId: string,
  snapshotKey: string,
): Promise<CatalogSnapshotReadResult | null> {
  return repository.readSnapshot(tenantId, providerAccountId, snapshotKey);
}

export async function importSyntheticCatalogProvider(
  repository: CatalogImportRepository,
  tenantId: string,
  providerAccountId: string,
  provider: CatalogProvider,
  snapshotKey: string,
  sourceVersion: string,
  observedAt: string,
  effectiveAt?: string | null,
): Promise<SyntheticImportResult> {
  const offers = await provider.fetchCatalog();
  return importSyntheticProviderSnapshot(repository, {
    tenantId,
    providerAccountId,
    snapshotKey,
    sourceVersion,
    observedAt,
    effectiveAt: effectiveAt ?? null,
    offers,
  });
}
