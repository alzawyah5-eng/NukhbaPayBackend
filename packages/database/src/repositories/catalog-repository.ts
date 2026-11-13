import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export interface ProviderProductIdentity {
  readonly canonicalProductId: string;
  readonly brand: string;
  readonly redemptionCountry: "AE";
  readonly currency: "AED";
  readonly faceValueMinor: bigint;
  readonly fulfillmentMethod: "DIGITAL_PIN";
  readonly termsVersion: string;
}

export interface ProviderOffer {
  readonly providerId: string;
  readonly offerId: string;
  readonly snapshotId: string;
  readonly identity: ProviderProductIdentity;
  readonly mappingStatus: "APPROVED" | "REVIEW_REQUIRED";
  readonly providerDebitMinor: bigint;
  readonly upfrontDiscountMinor: bigint;
  readonly additionalProviderFeeMinor: bigint;
  readonly available: boolean;
  readonly eligible: boolean;
  readonly observedAt: string;
  readonly validUntil: string;
}

export interface CatalogImportContext {
  readonly tenantId: string;
  readonly providerAccountId: string;
  readonly snapshotKey: string;
  readonly sourceVersion: string;
  readonly observedAt: string;
  readonly effectiveAt?: string | null;
}

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

export interface CatalogOfferRead {
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
  readonly offers: readonly CatalogOfferRead[];
}

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

export class CatalogImportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogImportConflictError";
  }
}

function assertIdentifier(value: string | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CatalogValidationError(`${label} is required`);
  }
  return value.trim();
}

function canonicalTimestamp(value: unknown, label: string): string {
  const date = value instanceof Date
    ? value
    : typeof value === "string"
      ? new Date(value)
      : null;
  if (!date || !Number.isFinite(date.getTime())) {
    throw new CatalogValidationError(`${label} must be a valid timestamp`);
  }
  return date.toISOString();
}

function readTimestamp(row: Record<string, unknown>, key: string): string {
  return canonicalTimestamp(row[key], key);
}

function normalizeOfferKey(offer: ProviderOffer): string {
  return JSON.stringify({
    providerId: offer.providerId,
    offerId: offer.offerId,
    snapshotId: offer.snapshotId,
    identity: {
      canonicalProductId: offer.identity.canonicalProductId,
      brand: offer.identity.brand,
      redemptionCountry: offer.identity.redemptionCountry,
      currency: offer.identity.currency,
      faceValueMinor: offer.identity.faceValueMinor.toString(),
      fulfillmentMethod: offer.identity.fulfillmentMethod,
      termsVersion: offer.identity.termsVersion,
    },
    mappingStatus: offer.mappingStatus,
    providerDebitMinor: offer.providerDebitMinor.toString(),
    upfrontDiscountMinor: offer.upfrontDiscountMinor.toString(),
    additionalProviderFeeMinor: offer.additionalProviderFeeMinor.toString(),
    available: offer.available,
    eligible: offer.eligible,
    observedAt: canonicalTimestamp(offer.observedAt, "offer.observedAt"),
    validUntil: canonicalTimestamp(offer.validUntil, "offer.validUntil"),
  });
}

function normalizeImportContent(
  snapshot: {
    readonly sourceVersion: string;
    readonly observedAt: unknown;
    readonly effectiveAt: unknown;
  },
  offers: readonly ProviderOffer[],
): string {
  return JSON.stringify({
    sourceVersion: snapshot.sourceVersion,
    observedAt: canonicalTimestamp(snapshot.observedAt, "snapshot.observedAt"),
    effectiveAt: snapshot.effectiveAt == null
      ? null
      : canonicalTimestamp(snapshot.effectiveAt, "snapshot.effectiveAt"),
    offers: offers.map(normalizeOfferKey).sort(),
  });
}

function toCanonicalOfferMap(offers: readonly ProviderOffer[]): Map<string, ProviderOffer> {
  const byOfferKey = new Map<string, ProviderOffer>();
  for (const offer of offers) {
    const key = `${offer.providerId}:${offer.offerId}`;
    if (byOfferKey.has(key)) {
      throw new CatalogValidationError(`Duplicate provider offer identity in snapshot: ${key}`);
    }
    byOfferKey.set(key, offer);
  }
  return byOfferKey;
}

function rowCountNumber(value: unknown): number {
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber) || asNumber < 0) {
    throw new CatalogValidationError("Unexpected non-numeric row count");
  }
  return asNumber;
}

function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" && value !== null && value !== undefined) {
    return String(value);
  }
  if (value == null || value === "") {
    throw new CatalogValidationError(`${key} is missing from database row`);
  }
  return String(value);
}

function readBigInt(row: Record<string, unknown>, key: string): bigint {
  const value = row[key];
  if (value === null || value === undefined) {
    throw new CatalogValidationError(`${key} is missing from database row`);
  }
  return BigInt(value.toString());
}

export class CatalogPostgresRepository {
  constructor(private readonly pool: Pool) {}

  async readSnapshot(
    tenantId: string,
    providerAccountId: string,
    snapshotKey: string,
  ): Promise<CatalogSnapshotReadResult | null> {
    const client = await this.pool.connect();
    try {
      return await this.readSnapshotUsingClient(client, tenantId, providerAccountId, snapshotKey);
    } finally {
      client.release();
    }
  }

  private async readSnapshotUsingClient(
    client: PoolClient,
    tenantId: string,
    providerAccountId: string,
    snapshotKey: string,
  ): Promise<CatalogSnapshotReadResult | null> {
      const snapshotResult = await client.query<Record<string, unknown>>(
        `SELECT id, tenant_id, provider_account_id, snapshot_key, source_version, observed_at, effective_at, status, row_count, started_at, completed_at
         FROM nukhabapay.provider_snapshots
         WHERE tenant_id = $1 AND provider_account_id = $2 AND snapshot_key = $3
         ORDER BY started_at DESC, completed_at DESC NULLS LAST
         LIMIT 1`,
        [tenantId, providerAccountId, snapshotKey],
      );

      if (snapshotResult.rowCount == null || snapshotResult.rowCount === 0) {
        return null;
      }

      const snapshotRow = snapshotResult.rows[0] as Record<string, unknown>;
      const offersResult = await client.query<Record<string, unknown>>(
        `SELECT id, provider_offer_key, provider_debit_minor, additional_provider_fee_minor, upfront_discount_minor, available, observed_at, valid_until, product_id, face_value_minor, product_mapping_id
         FROM nukhabapay.provider_offers
         WHERE tenant_id = $1 AND provider_account_id = $2 AND provider_snapshot_id = $3
         ORDER BY observed_at, provider_offer_key`,
        [tenantId, providerAccountId, readString(snapshotRow, "id")],
      );

      return {
        snapshot: {
          id: readString(snapshotRow, "id"),
          tenantId: readString(snapshotRow, "tenant_id"),
          providerAccountId: readString(snapshotRow, "provider_account_id"),
          snapshotKey: readString(snapshotRow, "snapshot_key"),
          sourceVersion: readString(snapshotRow, "source_version"),
          observedAt: readTimestamp(snapshotRow, "observed_at"),
          effectiveAt: snapshotRow["effective_at"] == null ? null : readTimestamp(snapshotRow, "effective_at"),
          status: String(snapshotRow["status"]) as "COMPLETE" | "IN_PROGRESS" | "FAILED",
          rowCount: snapshotRow["row_count"] == null ? null : rowCountNumber(snapshotRow["row_count"]),
          startedAt: readTimestamp(snapshotRow, "started_at"),
          completedAt: snapshotRow["completed_at"] == null ? null : readTimestamp(snapshotRow, "completed_at"),
        },
        offers: offersResult.rows.map((row) => ({
          id: readString(row as Record<string, unknown>, "id"),
          providerOfferKey: readString(row as Record<string, unknown>, "provider_offer_key"),
          providerDebitMinor: readBigInt(row as Record<string, unknown>, "provider_debit_minor"),
          additionalProviderFeeMinor: (row as Record<string, unknown>)["additional_provider_fee_minor"] == null ? null : readBigInt(row as Record<string, unknown>, "additional_provider_fee_minor"),
          upfrontDiscountMinor: (row as Record<string, unknown>)["upfront_discount_minor"] == null ? null : readBigInt(row as Record<string, unknown>, "upfront_discount_minor"),
          available: Boolean((row as Record<string, unknown>)["available"]),
          observedAt: readTimestamp(row as Record<string, unknown>, "observed_at"),
          validUntil: readTimestamp(row as Record<string, unknown>, "valid_until"),
          productId: readString(row as Record<string, unknown>, "product_id"),
          faceValueMinor: readBigInt(row as Record<string, unknown>, "face_value_minor"),
          productMappingId: readString(row as Record<string, unknown>, "product_mapping_id"),
        })),
      };
  }

  async importSyntheticSnapshot(
    context: CatalogImportContext,
    offers: readonly ProviderOffer[],
  ): Promise<CatalogImportResult> {
    const tenantId = assertIdentifier(context.tenantId, "tenantId");
    const providerAccountId = assertIdentifier(context.providerAccountId, "providerAccountId");
    const snapshotKey = assertIdentifier(context.snapshotKey, "snapshotKey");
    const sourceVersion = assertIdentifier(context.sourceVersion, "sourceVersion");
    const observedAt = canonicalTimestamp(context.observedAt, "observedAt");
    const effectiveAt = context.effectiveAt == null
      ? null
      : canonicalTimestamp(context.effectiveAt, "effectiveAt");
    const normalizedOffers = [...offers];

    if (normalizedOffers.length === 0) {
      throw new CatalogValidationError("Synthetic provider snapshot requires at least one offer");
    }

    const byOfferKey = toCanonicalOfferMap(normalizedOffers);
    for (const offer of byOfferKey.values()) {
      if (offer.mappingStatus !== "APPROVED") {
        throw new CatalogValidationError(`Offer ${offer.offerId} is not approved for import`);
      }
      if (offer.snapshotId !== snapshotKey) {
        throw new CatalogValidationError(`Offer snapshot mismatch: expected ${snapshotKey} but saw ${offer.snapshotId}`);
      }
      if (!offer.identity || typeof offer.identity !== "object") {
        throw new CatalogValidationError(`Offer ${offer.offerId} is missing normalized product identity`);
      }
      if (offer.eligible !== true) {
        throw new CatalogValidationError(`Offer ${offer.offerId} is not eligible for import`);
      }
      if (
        typeof offer.available !== "boolean" ||
        offer.identity.faceValueMinor <= 0n ||
        offer.providerDebitMinor <= 0n ||
        offer.additionalProviderFeeMinor < 0n ||
        offer.upfrontDiscountMinor < 0n
      ) {
        throw new CatalogValidationError(`Offer ${offer.offerId} has invalid financial or availability data`);
      }
      canonicalTimestamp(offer.observedAt, `Offer ${offer.offerId} observedAt`);
      canonicalTimestamp(offer.validUntil, `Offer ${offer.offerId} validUntil`);
    }

    const client = await this.pool.connect();
    let clientReleased = false;
    try {
      await client.query("BEGIN");
      const accountResult = await client.query<Record<string, unknown>>(
        `SELECT id, tenant_id, provider_code, status
         FROM nukhabapay.provider_accounts
         WHERE id = $1
         LIMIT 1`,
        [providerAccountId],
      );

      if (accountResult.rowCount == null || accountResult.rowCount === 0) {
        throw new CatalogValidationError(`Provider account ${providerAccountId} does not exist`);
      }

      const accountRow = accountResult.rows[0] as Record<string, unknown>;
      if (readString(accountRow, "tenant_id") !== tenantId) {
        throw new CatalogValidationError("Provider account is not owned by the supplied tenant");
      }

      const providerCode = readString(accountRow, "provider_code");
      for (const offer of normalizedOffers) {
        if (offer.providerId !== providerCode) {
          throw new CatalogValidationError(`Offer provider ${offer.providerId} does not match provider account ${providerCode}`);
        }
      }

      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${tenantId}:${providerAccountId}:${snapshotKey}`],
      );

      const existingSnapshot = await client.query<Record<string, unknown>>(
        `SELECT id, tenant_id, provider_account_id, snapshot_key, source_version, observed_at, effective_at, status, row_count, started_at, completed_at
         FROM nukhabapay.provider_snapshots
         WHERE tenant_id = $1 AND provider_account_id = $2 AND snapshot_key = $3
         ORDER BY started_at DESC, completed_at DESC NULLS LAST
         LIMIT 1`,
        [tenantId, providerAccountId, snapshotKey],
      );

      if (existingSnapshot.rowCount != null && existingSnapshot.rowCount > 0) {
        const snapshotRow = existingSnapshot.rows[0] as Record<string, unknown>;
        const existingOffers = await client.query<Record<string, unknown>>(
          `SELECT o.provider_offer_key,
                  p.canonical_product_key,
                  p.brand,
                  p.redemption_country,
                  p.currency,
                  p.face_value_minor,
                  p.fulfillment_method,
                  p.terms_version,
                  o.provider_debit_minor,
                  o.additional_provider_fee_minor,
                  o.upfront_discount_minor,
                  o.available,
                  o.observed_at,
                  o.valid_until
           FROM nukhabapay.provider_offers o
           JOIN nukhabapay.products p ON p.id = o.product_id
           WHERE o.tenant_id = $1 AND o.provider_account_id = $2 AND o.provider_snapshot_id = $3
           ORDER BY o.provider_offer_key`,
          [tenantId, providerAccountId, readString(snapshotRow, "id")],
        );
        const current = normalizeImportContent(
          { sourceVersion, observedAt, effectiveAt },
          normalizedOffers,
        );
        const previous = normalizeImportContent(
          {
            sourceVersion: readString(snapshotRow, "source_version"),
            observedAt: snapshotRow["observed_at"],
            effectiveAt: snapshotRow["effective_at"],
          },
          existingOffers.rows.map((row) => {
            const record = row as Record<string, unknown>;
            return {
              providerId: providerCode,
              offerId: readString(record, "provider_offer_key"),
              snapshotId: snapshotKey,
              identity: {
                canonicalProductId: readString(record, "canonical_product_key"),
                brand: readString(record, "brand"),
                redemptionCountry: String(record["redemption_country"]) as "AE",
                currency: String(record["currency"]) as "AED",
                faceValueMinor: readBigInt(record, "face_value_minor"),
                fulfillmentMethod: String(record["fulfillment_method"]) as "DIGITAL_PIN",
                termsVersion: readString(record, "terms_version"),
              },
              mappingStatus: "APPROVED" as const,
              providerDebitMinor: readBigInt(record, "provider_debit_minor"),
              upfrontDiscountMinor: record["upfront_discount_minor"] == null ? 0n : readBigInt(record, "upfront_discount_minor"),
              additionalProviderFeeMinor: record["additional_provider_fee_minor"] == null ? 0n : readBigInt(record, "additional_provider_fee_minor"),
              available: Boolean(record["available"]),
              eligible: true,
              observedAt: readTimestamp(record, "observed_at"),
              validUntil: readTimestamp(record, "valid_until"),
            } satisfies ProviderOffer;
          }),
        );

        if (readString(snapshotRow, "status") === "COMPLETE" && current === previous) {
          const accepted = await this.readSnapshotUsingClient(client, tenantId, providerAccountId, snapshotKey);
          if (!accepted) {
            throw new CatalogValidationError("Accepted snapshot is missing after duplicate detection");
          }
          await client.query("COMMIT");
          return {
            tenantId,
            providerAccountId,
            snapshotId: accepted.snapshot.id,
            snapshotKey,
            sourceVersion: accepted.snapshot.sourceVersion,
            status: "COMPLETE",
            created: false,
            counts: {
              products: new Set(accepted.offers.map((offer) => offer.productId)).size,
              mappings: new Set(accepted.offers.map((offer) => offer.productMappingId)).size,
              offers: accepted.offers.length,
            },
            acceptedAt: accepted.snapshot.completedAt ?? accepted.snapshot.startedAt,
          } satisfies CatalogImportResult;
        }

        throw new CatalogImportConflictError(
          `Snapshot ${snapshotKey} already exists for this provider account with different content`,
        );
      }

      const snapshotId = randomUUID();
      await client.query(
        `INSERT INTO nukhabapay.provider_snapshots (
          id, tenant_id, provider_account_id, snapshot_key, source_version, observed_at, effective_at, status, started_at, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'IN_PROGRESS', NOW(), NULL)`,
        [snapshotId, tenantId, providerAccountId, snapshotKey, sourceVersion, observedAt, effectiveAt],
      );

      const seenProducts = new Map<string, string>();
      const seenMappings = new Map<string, { id: string; version: number; productId: string }>();

      for (const offer of normalizedOffers) {
        const productKey = offer.identity.canonicalProductId;
        let productId = seenProducts.get(productKey);

        if (productId === undefined) {
          const productResult = await client.query<Record<string, unknown>>(
            `SELECT id, brand, redemption_country, currency, face_value_minor, fulfillment_method, terms_version
             FROM nukhabapay.products
             WHERE canonical_product_key = $1
             LIMIT 1`,
            [productKey],
          );

          if (productResult.rowCount != null && productResult.rowCount > 0) {
            const product = productResult.rows[0] as Record<string, unknown>;
            productId = readString(product, "id");
            if (
              readString(product, "brand") !== offer.identity.brand ||
              readString(product, "redemption_country") !== offer.identity.redemptionCountry ||
              readString(product, "currency") !== offer.identity.currency ||
              readBigInt(product, "face_value_minor") !== offer.identity.faceValueMinor ||
              readString(product, "fulfillment_method") !== offer.identity.fulfillmentMethod ||
              readString(product, "terms_version") !== offer.identity.termsVersion
            ) {
              throw new CatalogValidationError(`Offer ${offer.offerId} conflicts with canonical product identity`);
            }
          } else {
            throw new CatalogValidationError(`Canonical product ${productKey} is not registered`);
          }
          seenProducts.set(productKey, productId);
        }

        const mappingKey = `${providerAccountId}:${offer.offerId}`;
        let mappingState = seenMappings.get(mappingKey);
        if (mappingState === undefined) {
          const mappingResult = await client.query<Record<string, unknown>>(
            `SELECT id, product_id, mapping_version, status
             FROM nukhabapay.product_mappings
             WHERE tenant_id = $1 AND provider_account_id = $2 AND provider_sku = $3
             ORDER BY mapping_version DESC, created_at DESC
             LIMIT 1`,
            [tenantId, providerAccountId, offer.offerId],
          );

          if (mappingResult.rowCount == null || mappingResult.rowCount === 0) {
            throw new CatalogValidationError(`Offer ${offer.offerId} has no approved product mapping`);
          }
          const existingMapping = mappingResult.rows[0] as Record<string, unknown>;
          if (readString(existingMapping, "status") !== "APPROVED") {
            throw new CatalogValidationError(`Offer ${offer.offerId} has a non-approved mapping in review or rejected state`);
          }
          if (readString(existingMapping, "product_id") !== productId) {
            throw new CatalogValidationError(`Offer ${offer.offerId} resolves to a conflicting product mapping`);
          }
          mappingState = {
            id: readString(existingMapping, "id"),
            version: rowCountNumber(existingMapping["mapping_version"]),
            productId: readString(existingMapping, "product_id"),
          };
          seenMappings.set(mappingKey, mappingState);
        }

        const existingOffer = await client.query<Record<string, unknown>>(
          `SELECT id
           FROM nukhabapay.provider_offers
           WHERE tenant_id = $1 AND provider_account_id = $2 AND provider_snapshot_id = $3 AND provider_offer_key = $4
           LIMIT 1`,
          [tenantId, providerAccountId, snapshotId, offer.offerId],
        );

        if (existingOffer.rowCount === 0) {
          await client.query(
            `INSERT INTO nukhabapay.provider_offers (
              id, tenant_id, provider_account_id, provider_snapshot_id, product_mapping_id, product_mapping_version, product_id,
              face_value_minor, provider_offer_key, provider_debit_minor, additional_provider_fee_minor, upfront_discount_minor,
              available, observed_at, valid_until, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())`,
            [
              randomUUID(),
              tenantId,
              providerAccountId,
              snapshotId,
              mappingState.id,
              mappingState.version,
              productId,
              offer.identity.faceValueMinor,
              offer.offerId,
              offer.providerDebitMinor,
              offer.additionalProviderFeeMinor,
              offer.upfrontDiscountMinor,
              offer.available,
              offer.observedAt,
              offer.validUntil,
            ],
          );
        }
      }

      const offerCountResult = await client.query<Record<string, unknown>>(
        `SELECT COUNT(*)::int AS total
         FROM nukhabapay.provider_offers
         WHERE tenant_id = $1 AND provider_account_id = $2 AND provider_snapshot_id = $3`,
        [tenantId, providerAccountId, snapshotId],
      );
      const finalOfferCount = rowCountNumber((offerCountResult.rows[0] as Record<string, unknown>)["total"]);

      await client.query(
        `UPDATE nukhabapay.provider_snapshots
         SET status = 'COMPLETE', row_count = $1, completed_at = NOW()
         WHERE id = $2`,
        [finalOfferCount, snapshotId],
      );

      await client.query("COMMIT");
      const accepted = await this.readSnapshotUsingClient(client, tenantId, providerAccountId, snapshotKey);
      if (!accepted) {
        throw new CatalogValidationError("Accepted snapshot was not persisted");
      }

      return {
        tenantId,
        providerAccountId,
        snapshotId: accepted.snapshot.id,
        snapshotKey,
        sourceVersion: accepted.snapshot.sourceVersion,
        status: "COMPLETE",
        created: true,
        counts: {
          products: new Set(seenProducts.values()).size,
          mappings: new Set([...seenMappings.values()].map((mapping) => mapping.id)).size,
          offers: finalOfferCount,
        },
        acceptedAt: accepted.snapshot.completedAt ?? accepted.snapshot.startedAt,
      } satisfies CatalogImportResult;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        client.release(rollbackError instanceof Error ? rollbackError : new Error("Transaction rollback failed"));
        clientReleased = true;
        throw new AggregateError([error, rollbackError], "Catalog import failed and rollback could not complete");
      }

      if (error instanceof CatalogImportConflictError) {
        throw error;
      }

      const detail = error instanceof Error ? error : new Error("Unknown catalog import failure");
      throw detail;
    } finally {
      if (!clientReleased) {
        client.release();
      }
    }
  }
}
