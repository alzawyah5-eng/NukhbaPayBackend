import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { calculateAedAcquisitionCost } from '../../domain/src/acquisition-cost.js';
import { AcquisitionNormalization, awaitAcquisitionDependency, prepareNormalization } from '../src/fx/normalization.js';
import type {
  AcquisitionCostSnapshot, AcquisitionPolicy, AcquisitionResultStore, FxSnapshot, VerifiedAcquisitionCost,
} from '../src/fx/contracts.js';

const now = new Date('2026-11-27T12:00:00.000Z');
const scope = { tenantId: randomUUID(), providerAccountId: randomUUID() };
const use = 'LAYER_2_PRICING';
const policy: AcquisitionPolicy = {
  version:'fx-1', revision:1, provenance:'SYNTHETIC', effectiveFrom:'2026-11-27T10:00:00Z',
  validUntil:'2026-11-27T14:00:00Z', approvedCostSource:'fixture-quotes', approvedFxSource:'fixture-rates',
  maxRateAgeMs:600000, maxCostAgeMs:600000, currencyScales:{AED:2,USD:2,JPY:0,BHD:3},
  rateScale:12, rounding:'HALF_UP', permittedUses:[use], refreshIntervalMs:120000,
};
const cost: VerifiedAcquisitionCost = {
  ...scope, offerKey:'fixture-offer', offerVersionId:randomUUID(),
  catalogue:{snapshotId:randomUUID(),sourceVersion:'v3',completeness:'PARTIAL'},
  costSnapshotId:randomUUID(), source:policy.approvedCostSource, provenance:'SYNTHETIC',
  observedAt:'2026-11-27T11:58:00Z', retrievedAt:'2026-11-27T11:58:01Z',validUntil:'2026-11-27T12:12:00Z',
  basis:'VERIFIED_ACCOUNT_QUOTE', sourceReference:'fixture-quote',
  acquisition:{amount:'11.63',currency:'USD'},faceValue:{amount:'50.00',currency:'AED'},
  retail:{amount:'53.00',currency:'AED'},settlement:{amount:'13.00',currency:'USD'},
};
const fx: FxSnapshot = {
  ...scope,id:randomUUID(),basis:'APPROVED_DIRECT',direction:'AED_PER_SOURCE_UNIT',rate:'3.672500000000',
  sourceCurrency:'USD',targetCurrency:'AED',source:'fixture-rates',sourceReference:'fixture-rate',
  approvalReference:'fixture-approval',effectiveAt:'2026-11-27T11:57:00Z',retrievedAt:'2026-11-27T11:58:00Z',
  validUntil:'2026-11-27T12:10:00Z',policyVersion:policy.version,provenance:'SYNTHETIC',
};

test('exact multiplication retains working precision and applies one half-up boundary', () => {
  const params = {sourceScale:8, rateScale:12, direction:'AED_PER_SOURCE_UNIT', rounding:'HALF_UP'} as const;
  const tie = calculateAedAcquisitionCost({...params,amount:'1.00500000',rate:'1.000000000000'});
  assert.equal(tie.amount,'1.00500000000000000000');
  assert.equal(tie.displayAmount,'1.01');
  assert.equal(tie.roundingBoundary,'DISPLAY_ONLY');
  const below = calculateAedAcquisitionCost({...params,amount:'1.00500000',rate:'0.999999999999'});
  assert.equal(below.amount,'1.00499999999899500000');
  assert.equal(below.displayAmount,'1.00');
  assert.equal(below.workingScale,20);
  const subFil = calculateAedAcquisitionCost({...params,amount:'0.004',rate:'1'});
  assert.equal(subFil.amount,'0.004');
  assert.equal(subFil.displayAmount,'0.00');
  for (const amount of ['1e2','01.01','1.000000001','1000000000000000','1000001','-0.01','1\n'])
    assert.throws(()=>calculateAedAcquisitionCost({...params,amount,rate:'1'}));
});

test('uses acquisition, preserves other monetary fields and limits expiry by age', () => {
  const result = prepareNormalization(cost,fx,policy,use,now.toISOString());
  assert.equal(result.calculation.amount,'42.71117500000000');
  assert.equal(result.calculation.displayAmount,'42.71');
  assert.deepEqual(result.cost.faceValue,cost.faceValue);
  assert.deepEqual(result.cost.settlement,cost.settlement);
  assert.deepEqual(result.cost.retail,cost.retail);
  assert.equal(result.validUntil,'2026-11-27T12:07:00.000Z');
  assert.equal(result.cost.catalogue.completeness,'PARTIAL');
  const identity = prepareNormalization({...cost,acquisition:{amount:'9.37',currency:'AED'}},null,policy,use,now.toISOString());
  assert.equal(identity.fx.basis,'AED_IDENTITY');
  assert.equal(identity.fx.rate,'1');
  assert.equal(identity.calculation.amount,'9.37');
  const billed = { amount:'42.73',currency:'AED',sourceReference:'synthetic-debit-reference' } as const;
  const separatelyBilled = prepareNormalization({...cost,billedAedDebit:billed},fx,policy,use,now.toISOString());
  assert.deepEqual(separatelyBilled.cost.billedAedDebit,billed);
  assert.equal(separatelyBilled.calculation.amount,result.calculation.amount);
});

test('blocks wrong scope, rate direction, source, expiry, precision and unauthorized use', () => {
  for (const change of [
    {providerAccountId:randomUUID()}, {tenantId:randomUUID()}, {source:'not-approved'},
    {direction:'SOURCE_PER_AED' as FxSnapshot['direction']}, {validUntil:now.toISOString()},
    {effectiveAt:'2026-11-27T10:00:00Z'}, {retrievedAt:'2026-11-27T12:01:00Z'},
    {rate:'3.6725000000001'}, {rate:'0'}, {provenance:'LIVE' as const}, {sourceCurrency:'JPY'},
  ]) assert.throws(()=>prepareNormalization(cost,{...fx,...change},policy,use,now.toISOString()));
  assert.throws(()=>prepareNormalization(cost,null,policy,use,now.toISOString()),/APPROVED_RATE_MISSING/);
  assert.throws(()=>prepareNormalization({...cost,validUntil:now.toISOString()},fx,policy,use,now.toISOString()),/COST_STALE/);
  assert.throws(()=>prepareNormalization(cost,fx,policy,'INTERNAL_REVIEW',now.toISOString()),/VALUATION_USE_DENIED/);
});

test('service quotes, blocks, or retries without persisting invented acquisition amounts', async () => {
  const store: AcquisitionResultStore = {
    save: async()=>assert.fail('No blocked offer should be saved'),
    readCurrent:async()=>null,readResult:async()=>null,
  };
  const signal = new AbortController().signal;
  const attempt = (evidence: AcquisitionCostSnapshot, configured: AcquisitionPolicy | null, rate: () => Promise<FxSnapshot | null>) =>
    new AcquisitionNormalization({
      scopes:[scope],readPolicy:async()=>configured,costSource:{source:policy.approvedCostSource,readCost:async()=>evidence},
      fxSources:new Map([[fx.source,{source:fx.source,readApprovedRate:rate}]]),store,now:()=>now,
    }).normalize(cost,use,'fixture-test',signal);
  const {acquisition:_acquisition,faceValue:_face,settlement:_settlement,retail:_retail,...reference} = cost;
  assert.equal((await attempt({...reference,basis:'QUOTE_REQUIRED'},policy,async()=>null)).status,'QUOTE_REQUIRED');
  assert.equal((await attempt({...reference,basis:'COST_UNCONFIRMED'},policy,async()=>null)).status,'COST_UNCONFIRMED');
  assert.deepEqual(await attempt(cost,null,async()=>null),{status:'BLOCKED',reason:'COMMERCIAL_POLICY_MISSING'});
  assert.deepEqual(await attempt(cost,policy,async()=>null),{status:'BLOCKED',reason:'APPROVED_RATE_MISSING'});
  assert.equal((await attempt(cost,policy,async()=>{throw new Error('fixture upstream timeout');})).status,'RETRY_PENDING');
});

test('a cancelled dependency cannot hold a worker batch open', async () => {
  const controller = new AbortController();
  const stalled = awaitAcquisitionDependency(() => new Promise<never>(()=>{}), controller.signal);
  const reason = new Error('fixture timeout');
  controller.abort(reason);
  await assert.rejects(stalled, reason);
});
