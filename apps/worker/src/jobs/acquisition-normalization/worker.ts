import {
  acquisitionReference, acquisitionScopeKey, awaitAcquisitionDependency, nextAcquisitionRefreshAt,
  type AcquisitionCostReference, type AcquisitionPolicy, type AcquisitionNormalizedEvent, type AcquisitionNormalization,
  type AcquisitionOutbox, type AcquisitionScope, type NormalizationOutcome, type SourceCatalogueEvidence, type ValuationUse,
} from '@nukhbapay/application';

export interface AcquisitionBatch {
  readonly scope: AcquisitionScope;
  readonly runId: string;
  readonly sourceCatalogue: SourceCatalogueEvidence;
  readonly offers: readonly AcquisitionCostReference[];
  readonly use: ValuationUse;
}

export interface AcquisitionRunReport {
  readonly runId: string;
  readonly sourceCatalogue: SourceCatalogueEvidence;
  readonly counts: Readonly<Record<NormalizationOutcome['status'], number>>;
  readonly offers: readonly { offerVersionId: string; status: NormalizationOutcome['status']; reason?: string }[];
  readonly retryPending: readonly AcquisitionCostReference[];
}

export interface AcquisitionEventPublisher {
  /** Resolve only after the durable recipient acknowledges the exact event ID. */
  publish(event: AcquisitionNormalizedEvent, signal: AbortSignal): Promise<void>;
}

export class AcquisitionNormalizationWorker {
  constructor(private readonly deps: {
    normalization: Pick<AcquisitionNormalization, 'normalize'>;
    outbox: AcquisitionOutbox;
    publisher: AcquisitionEventPublisher;
    batchLimit: number;
    normalizationTimeoutMs: number;
    deliveryTimeoutMs: number;
  }) {
    if (!Number.isInteger(deps.batchLimit) || deps.batchLimit < 1 || deps.batchLimit > 100 ||
        !Number.isInteger(deps.normalizationTimeoutMs) || deps.normalizationTimeoutMs < 100 || deps.normalizationTimeoutMs > 60000 ||
        !Number.isInteger(deps.deliveryTimeoutMs) || deps.deliveryTimeoutMs < 100 || deps.deliveryTimeoutMs > 60000)
      throw new RangeError('Invalid Layer 1 worker limits');
  }

  /** Invoked by a trusted scheduler or retry job. Reports contain references and outcome codes only. */
  async runBatch(input: AcquisitionBatch, signal: AbortSignal): Promise<AcquisitionRunReport> {
    if (!Array.isArray(input.offers) || input.offers.length > this.deps.batchLimit) throw new Error('Invalid Layer 1 batch size');
    const batch = {
      scope: { tenantId: input.scope.tenantId, providerAccountId: input.scope.providerAccountId },
      runId: input.runId, use: input.use,
      sourceCatalogue: {
        snapshotId: input.sourceCatalogue.snapshotId, sourceVersion: input.sourceCatalogue.sourceVersion,
        completeness: input.sourceCatalogue.completeness,
      },
      offers: input.offers.map(acquisitionReference),
    };
    const scope = acquisitionScopeKey(batch.scope);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(batch.runId) ||
        new Set(batch.offers.map(offer => offer.offerVersionId)).size !== batch.offers.length ||
        batch.offers.some(offer => acquisitionScopeKey(offer) !== scope ||
          offer.catalogue.snapshotId !== batch.sourceCatalogue.snapshotId ||
          offer.catalogue.sourceVersion !== batch.sourceCatalogue.sourceVersion ||
          offer.catalogue.completeness !== batch.sourceCatalogue.completeness)) throw new Error('Invalid Layer 1 batch');
    const counts = { NORMALIZED: 0, ALREADY_PROCESSED: 0, QUOTE_REQUIRED: 0, COST_UNCONFIRMED: 0, BLOCKED: 0, RETRY_PENDING: 0 };
    const offers: AcquisitionRunReport['offers'][number][] = [];
    const retryPending: AcquisitionCostReference[] = [];
    for (const offer of batch.offers) {
      const outcome: NormalizationOutcome = signal.aborted ? { status: 'RETRY_PENDING', reason: 'RUN_CANCELLED' } :
        await this.deps.normalization.normalize(offer, batch.use, batch.runId,
          AbortSignal.any([signal, AbortSignal.timeout(this.deps.normalizationTimeoutMs)]));
      counts[outcome.status]++;
      offers.push({
        offerVersionId: offer.offerVersionId, status: outcome.status,
        ...('reason' in outcome ? { reason: outcome.reason } : {}),
      });
      if (outcome.status === 'RETRY_PENDING') retryPending.push(offer);
    }
    return { runId: batch.runId, sourceCatalogue: batch.sourceCatalogue, counts, offers, retryPending };
  }

  async runScheduledBatch(input: AcquisitionBatch, policy: AcquisitionPolicy, slotAt: string, signal: AbortSignal) {
    const nextDueAt = nextAcquisitionRefreshAt(policy, slotAt);
    return { report: await this.runBatch(input, signal), nextDueAt };
  }

  async deliverOnce(scope: AcquisitionScope, signal: AbortSignal): Promise<'IDLE' | 'DELIVERED' | 'RETRY_PENDING'> {
    signal.throwIfAborted();
    const delivery = await this.deps.outbox.claim(scope, this.deps.deliveryTimeoutMs + 5000);
    if (!delivery) return 'IDLE';
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.deps.deliveryTimeoutMs)]);
    try {
      await awaitAcquisitionDependency(() => this.deps.publisher.publish(delivery.event, deadline), deadline);
      deadline.throwIfAborted();
    } catch {
      await this.deps.outbox.settle(delivery, false);
      return 'RETRY_PENDING';
    }
    return await this.deps.outbox.settle(delivery, true) ? 'DELIVERED' : 'RETRY_PENDING';
  }
}
