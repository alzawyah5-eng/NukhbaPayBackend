import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  AcquisitionBlocked, ACQUISITION_CALCULATOR_VERSION, LEGACY_ACQUISITION_CALCULATOR_VERSION,
  calculateAedAcquisitionCost, acquisitionScopeKey, assertPreparedNormalization,
  type AcquisitionNormalizedEvent, type AcquisitionOutbox, type AcquisitionResultStore,
  type AcquisitionScope, type NormalizedAcquisitionCost, type PreparedNormalization, type ValuationUse,
} from '@nukhbapay/application';

const scopeParams = (scope: AcquisitionScope) => [scope.tenantId, scope.providerAccountId];
const filter = 'r.tenant_id=$1 AND r.provider_account_id=$2';
const joins = `FROM nukhabapay.layer1_results r
 JOIN nukhabapay.layer1_cost_snapshots c
   ON (c.tenant_id,c.provider_account_id,c.id)=(r.tenant_id,r.provider_account_id,r.cost_snapshot_id)
 JOIN nukhabapay.layer1_fx_snapshots f ON (f.tenant_id,f.provider_account_id,f.id,f.policy_version)=
   (r.tenant_id,r.provider_account_id,r.fx_snapshot_id,r.policy_version)
 JOIN nukhabapay.layer1_policies p ON (p.tenant_id,p.provider_account_id,p.version)=
   (r.tenant_id,r.provider_account_id,r.policy_version)`;
const projection = `r.id AS "resultId",c.evidence AS cost,f.evidence AS fx,p.policy,r.calculation,
 r.normalized_at AS "normalizedAt",r.valid_until AS "validUntil"`;
export interface AcquisitionStoreScope extends AcquisitionScope {
  readonly provenance: 'LIVE' | 'SYNTHETIC';
}
// The established aed_amount column and calculation.amount JSON slot are the staff display projection.
type ResultRow = Omit<NormalizedAcquisitionCost, 'normalizedAt' | 'validUntil' | 'calculation'> & {
  normalizedAt: Date; validUntil: Date;
  calculation: { amount: string; exactAmount?: string; displayAmount?: string; calculatorVersion: string };
};

function resultFrom(row: ResultRow): NormalizedAcquisitionCost {
  const version = row.calculation.calculatorVersion;
  if (version !== ACQUISITION_CALCULATOR_VERSION && version !== LEGACY_ACQUISITION_CALCULATOR_VERSION)
    throw new Error('Unsupported Layer 1 calculator evidence');
  const calculated = calculateAedAcquisitionCost({
    amount: row.cost.acquisition.amount, sourceScale: row.policy.currencyScales[row.cost.acquisition.currency]!,
    rate: row.fx.rate, rateScale: row.policy.rateScale, direction: row.fx.direction, rounding: row.policy.rounding,
  });
  if (calculated.displayAmount !== row.calculation.amount ||
      (version === ACQUISITION_CALCULATOR_VERSION &&
        (calculated.amount !== row.calculation.exactAmount || calculated.displayAmount !== row.calculation.displayAmount))) {
    throw new Error('Layer 1 calculation evidence mismatch');
  }
  const calculation = Object.freeze({ ...calculated, calculatorVersion: version });
  return { ...row, calculation, normalizedAt: row.normalizedAt.toISOString(), validUntil: row.validUntil.toISOString() };
}

async function readResult(client: PoolClient, scope: AcquisitionScope, resultId: string, provenance: AcquisitionStoreScope['provenance']) {
  const { rows: [row] } = await client.query<ResultRow>(
    `SELECT ${projection} ${joins} WHERE ${filter} AND r.id=$3 AND p.policy->>'provenance'=$4`, [...scopeParams(scope), resultId, provenance]);
  return row ? resultFrom(row) : null;
}

async function readCurrent(client: PoolClient, scope: AcquisitionScope, offerKey: string, use: ValuationUse,
  provenance: AcquisitionStoreScope['provenance']) {
  const { rows: [row] } = await client.query<ResultRow>(`SELECT * FROM (
    SELECT ${projection} ${joins} WHERE ${filter} AND c.offer_key=$3 AND p.policy->>'provenance'=$5
    AND c.offer_version_id=(SELECT CASE WHEN o.available AND o.valid_until>clock_timestamp() THEN o.id END
      FROM nukhabapay.layer1_source_offers o
      WHERE (o.tenant_id,o.provider_account_id,o.provider_offer_key)=(c.tenant_id,c.provider_account_id,c.offer_key)
      ORDER BY o.observed_at DESC,o.id DESC LIMIT 1)
    ORDER BY c.observed_at DESC,c.retrieved_at DESC,c.id DESC,p.revision DESC,
      f.effective_at DESC,f.retrieved_at DESC,f.id DESC,r.calculator_version DESC,r.id DESC LIMIT 1
  ) latest WHERE "validUntil">clock_timestamp() AND latest.policy->'permittedUses' ? $4`,
  [...scopeParams(scope), offerKey, use, provenance]);
  return row ? resultFrom(row) : null;
}

function lockOffer(client: PoolClient, scope: AcquisitionScope, offerKey: string) {
  const key = JSON.stringify(['layer1-offer', ...scopeParams(scope), offerKey]);
  return client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
}

async function persistEvidence(client: PoolClient, value: PreparedNormalization) {
  const { cost, fx, policy } = value;
  const scope = scopeParams(cost);
  const { rowCount: validSource } = await client.query(`SELECT 1
    FROM nukhabapay.layer1_source_offers o
    WHERE o.tenant_id=$1 AND o.provider_account_id=$2 AND o.provider_snapshot_id=$3 AND o.source_version=$4
      AND ($5<>'COMPLETE' OR o.catalogue_status='COMPLETE') AND o.id=$6 AND o.provider_offer_key=$7
      AND o.available AND o.valid_until>clock_timestamp() AND o.valid_until>=$8`,
  [...scope, cost.catalogue.snapshotId, cost.catalogue.sourceVersion, cost.catalogue.completeness,
    cost.offerVersionId, cost.offerKey, value.validUntil]);
  if (validSource !== 1) throw new AcquisitionBlocked('SOURCE_OFFER_UNAVAILABLE');

  await client.query(`INSERT INTO nukhabapay.layer1_cost_snapshots
   (tenant_id,provider_account_id,id,offer_version_id,catalogue_id,offer_key,observed_at,retrieved_at,valid_until,acquisition_amount,face_amount,evidence)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11::numeric,$12) ON CONFLICT DO NOTHING`,
  [...scope, cost.costSnapshotId, cost.offerVersionId, cost.catalogue.snapshotId, cost.offerKey, cost.observedAt,
    cost.retrievedAt, cost.validUntil, cost.acquisition.amount, cost.faceValue.amount, JSON.stringify(cost)]);
  await client.query(`INSERT INTO nukhabapay.layer1_policies (tenant_id,provider_account_id,version,revision,policy)
   VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [...scope, policy.version, policy.revision, JSON.stringify(policy)]);
  await client.query(`INSERT INTO nukhabapay.layer1_fx_snapshots
   (tenant_id,provider_account_id,id,policy_version,effective_at,retrieved_at,valid_until,rate,evidence)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9) ON CONFLICT DO NOTHING`,
  [...scope, fx.id, policy.version, fx.effectiveAt, fx.retrievedAt, fx.validUntil, fx.rate, JSON.stringify(fx)]);
  const { rows: [match] } = await client.query<{ matches: boolean }>(`SELECT EXISTS(
    SELECT FROM nukhabapay.layer1_cost_snapshots c,nukhabapay.layer1_policies p,nukhabapay.layer1_fx_snapshots f
    WHERE (c.tenant_id,c.provider_account_id,c.id)=($1,$2,$3)
      AND (p.tenant_id,p.provider_account_id,p.version)=($1,$2,$4)
      AND (f.tenant_id,f.provider_account_id,f.id,f.policy_version)=($1,$2,$5,$4)
      AND c.evidence=$6::jsonb AND p.policy=$7::jsonb AND f.evidence=$8::jsonb
   ) AS matches`, [...scope, cost.costSnapshotId, policy.version, fx.id, JSON.stringify(cost), JSON.stringify(policy), JSON.stringify(fx)]);
  if (!match?.matches) throw new AcquisitionBlocked('IMMUTABLE_EVIDENCE_CONFLICT');
}

function createEvent(resultId: string, value: PreparedNormalization, correlationId: string): AcquisitionNormalizedEvent {
  return {
    schema_version: 1, type: 'provider.acquisition-cost.normalized.v1', origin: 'nukhbapay.layer1', provenance: value.policy.provenance,
    event_id: randomUUID(), tenant_id: value.cost.tenantId, provider_account_id: value.cost.providerAccountId,
    correlation_id: correlationId, result_id: resultId, offer_version_id: value.cost.offerVersionId,
    permitted_uses: value.policy.permittedUses, occurred_at: value.normalizedAt,
  };
}

export interface PostgresAcquisitionStore extends AcquisitionResultStore, AcquisitionOutbox {
  /** Only database effects on this transaction are eligible for atomic inbox deduplication. */
  consume(event: AcquisitionNormalizedEvent, consumer: string, use: ValuationUse,
    effect: (transaction: PoolClient, result: NormalizedAcquisitionCost) => Promise<void>):
    Promise<'APPLIED' | 'ALREADY_CONSUMED' | 'STALE'>;
}

export function createPostgresAcquisitionStore(pool: Pool, scopes: readonly AcquisitionStoreScope[]): PostgresAcquisitionStore {
  const allowed = new Map(scopes.map(scope => [acquisitionScopeKey(scope), scope.provenance] as const));
  if (!allowed.size || allowed.size > 100 || allowed.size !== scopes.length ||
      scopes.some(scope => !['LIVE','SYNTHETIC'].includes(scope.provenance))) throw new Error('Invalid Layer 1 scope configuration');
  function mode(scope: AcquisitionScope) {
    const provenance = allowed.get(acquisitionScopeKey(scope));
    if (!provenance) throw new AcquisitionBlocked('SCOPE_DENIED');
    return provenance;
  }

  async function tx<T>(scope: AcquisitionScope, work: (client: PoolClient) => Promise<T>): Promise<T> {
    mode(scope);
    const client = await pool.connect();
    let discard = false, committing = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='3s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='10s'");
      await client.query("SELECT set_config('nukhabapay.tenant_id',$1,true),set_config('nukhabapay.layer1_account_id',$2,true)", scopeParams(scope));
      const { rows: [access] } = await client.query<{ allowed: boolean }>(`SELECT
        row_security_active('nukhabapay.layer1_results') AND
        EXISTS(SELECT FROM nukhabapay.layer1_account_grants WHERE login_role=current_user AND tenant_id=$1 AND provider_account_id=$2)
        AND EXISTS(SELECT FROM nukhabapay.layer1_active_accounts WHERE tenant_id=$1 AND provider_account_id=$2) AS allowed`, scopeParams(scope));
      if (!access?.allowed) throw new AcquisitionBlocked('SCOPE_DENIED');
      const result = await work(client);
      committing = true;
      if ((await client.query('COMMIT')).command !== 'COMMIT') throw new Error('Layer 1 commit not confirmed');
      return result;
    } catch (error) {
      discard = committing;
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      if (error instanceof AcquisitionBlocked) throw error;
      if (error && typeof error === 'object' && 'code' in error && ['23503','23505','23514'].includes(String(error.code)))
        throw new AcquisitionBlocked('LAYER1_EVIDENCE_REJECTED');
      throw new Error('Layer 1 storage unavailable');
    } finally {
      client.release(discard);
    }
  }

  return {
    async save(value, correlationId) {
      assertPreparedNormalization(value);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(correlationId)) throw new AcquisitionBlocked('INVALID_CORRELATION_ID');
      const { cost, fx, policy, calculation } = value;
      if (mode(cost) !== policy.provenance) throw new AcquisitionBlocked('PROVENANCE_DENIED');
      return tx(cost, async client => {
        await lockOffer(client, cost, cost.offerKey);
        await persistEvidence(client, value);
        const key = [...scopeParams(cost), cost.costSnapshotId, fx.id, policy.version, calculation.calculatorVersion];
        const id = randomUUID();
        const storedCalculation = { ...calculation, amount: calculation.displayAmount, exactAmount: calculation.amount };
        const { rowCount } = await client.query(`INSERT INTO nukhabapay.layer1_results
          (tenant_id,provider_account_id,cost_snapshot_id,fx_snapshot_id,policy_version,calculator_version,id,normalized_at,valid_until,aed_amount,calculation)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11 WHERE $9::timestamptz>clock_timestamp()
          ON CONFLICT DO NOTHING`, [...key, id, value.normalizedAt, value.validUntil, calculation.displayAmount, JSON.stringify(storedCalculation)]);
        if (rowCount !== 1) {
          const { rows: [replay] } = await client.query<ResultRow>(
            `SELECT ${projection} ${joins} WHERE ${filter} AND r.cost_snapshot_id=$3 AND r.fx_snapshot_id=$4
            AND r.policy_version=$5 AND r.calculator_version=$6`, key);
          if (!replay) throw new AcquisitionBlocked('NORMALIZATION_EXPIRED');
          return { status: 'ALREADY_PROCESSED', result: resultFrom(replay) };
        }
        const event = createEvent(id, value, correlationId);
        await client.query(`INSERT INTO nukhabapay.layer1_outbox (tenant_id,provider_account_id,event_id,result_id,envelope)
          VALUES ($1,$2,$3,$4,$5)`, [...scopeParams(cost), event.event_id, id, JSON.stringify(event)]);
        return { status: 'NORMALIZED', result: { ...value, resultId: id } };
      });
    },
    readResult(scope, resultId, use) {
      return tx(scope, async client => {
        const result = await readResult(client, scope, resultId, mode(scope));
        return result?.policy.permittedUses.includes(use) ? result : null;
      });
    },
    readCurrent(scope, offerKey, use) { return tx(scope, client => readCurrent(client, scope, offerKey, use, mode(scope))); },
    claim(scope, leaseMs) {
      if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) throw new Error('Invalid Layer 1 lease');
      const lease = randomUUID();
      return tx(scope, async client => {
        const { rows: [row] } = await client.query<{ envelope: AcquisitionNormalizedEvent }>(`WITH due AS (
          SELECT event_id FROM nukhabapay.layer1_outbox WHERE tenant_id=$1 AND provider_account_id=$2
            AND delivered_at IS NULL AND envelope->>'provenance'=$5 AND next_attempt_at<=clock_timestamp()
            AND (lease_until IS NULL OR lease_until<=clock_timestamp())
          ORDER BY next_attempt_at,event_id LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        UPDATE nukhabapay.layer1_outbox q SET lease=$3,lease_until=clock_timestamp()+$4::int*interval '1 millisecond',
          attempt=LEAST(attempt,29)+1 FROM due WHERE q.tenant_id=$1 AND q.provider_account_id=$2 AND q.event_id=due.event_id
        RETURNING q.envelope`, [...scopeParams(scope), lease, leaseMs, mode(scope)]);
        return row ? { event: row.envelope, lease } : null;
      });
    },
    settle(delivery, delivered) {
      const { event, lease } = delivery;
      const scope = { tenantId: event.tenant_id, providerAccountId: event.provider_account_id };
      return tx(scope, async client => {
        const result = await client.query(`UPDATE nukhabapay.layer1_outbox
          SET lease=NULL,lease_until=NULL,delivered_at=CASE WHEN $5 THEN clock_timestamp() ELSE NULL END,
            next_attempt_at=clock_timestamp()+LEAST(300,1 << LEAST(attempt,9))*interval '1 second'
          WHERE tenant_id=$1 AND provider_account_id=$2 AND event_id=$3 AND lease=$4
            AND delivered_at IS NULL AND lease_until>clock_timestamp() AND envelope->>'provenance'=$6`,
        [...scopeParams(scope), event.event_id, lease, delivered, mode(scope)]);
        return result.rowCount === 1;
      });
    },
    consume(event, consumer, use, effect) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(consumer)) throw new Error('Invalid Layer 1 consumer');
      const scope = { tenantId: event.tenant_id, providerAccountId: event.provider_account_id };
      return tx(scope, async client => {
        const key = [...scopeParams(scope), event.event_id, consumer];
        const { rowCount } = await client.query(`SELECT 1 FROM nukhabapay.layer1_outbox
          WHERE tenant_id=$1 AND provider_account_id=$2 AND event_id=$3 AND envelope=$4::jsonb`,
        [...scopeParams(scope), event.event_id, JSON.stringify(event)]);
        if (rowCount !== 1) throw new AcquisitionBlocked('UNVERIFIED_NORMALIZATION_EVENT');
        const result = await readResult(client, scope, event.result_id, mode(scope));
        if (!result?.policy.permittedUses.includes(use)) throw new AcquisitionBlocked('VALUATION_USE_DENIED');
        await lockOffer(client, scope, result.cost.offerKey);
        const inserted = await client.query(`INSERT INTO nukhabapay.layer1_inbox (tenant_id,provider_account_id,event_id,consumer)
          VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, key);
        if (inserted.rowCount !== 1) return 'ALREADY_CONSUMED';
        const current = await readCurrent(client, scope, result.cost.offerKey, use, mode(scope));
        if (current?.resultId !== result.resultId) return 'STALE';
        await effect(client, result);
        return 'APPLIED';
      });
    },
  };
}
