import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Pool,type PoolClient} from 'pg';
import {generateDraftPublicationCandidate} from '@nukhbapay/application';
import {createCataloguePublicationDraftStore} from '../src/catalogue-publication-draft-store.js';

const role='nukh_publication_'+'b'.repeat(20),database='nukhabapay_b3b3_'+'a'.repeat(32);
const config={expectedRole:role,expectedDatabase:database,poolMax:1,
  connectionString:`postgresql://${role}:isolated-unit-test-secret-placeholder@127.0.0.1:5432/${database}`};
async function candidate() {
  const snapshotId=randomUUID(),providerAccountId=randomUUID();
  const product={canonicalProductId:'synthetic-gift-100',brand:'SYNTHETIC',redemptionCountry:'AE' as const,currency:'AED' as const,
    faceValueMinor:10000n,fulfillmentMethod:'DIGITAL_PIN' as const,termsVersion:'v1'};
  return generateDraftPublicationCandidate({tenantId:randomUUID(),productId:randomUUID(),product,
    sourceSnapshots:[{snapshotId,providerAccountId,snapshotKey:'synthetic',sourceVersion:'v1',observedAt:'2026-11-09T09:00:00Z',completedAt:'2026-11-09T09:05:00Z',status:'COMPLETE'}],
    offers:[{providerId:'synthetic-provider',offerId:'synthetic-offer',snapshotId,identity:product,mappingStatus:'APPROVED',providerDebitMinor:9700n,
      upfrontDiscountMinor:300n,additionalProviderFeeMinor:0n,available:true,eligible:true,observedAt:'2026-11-09T09:00:00Z',validUntil:'2026-11-09T11:00:00Z'}],
    evaluatedAt:'2026-11-09T10:00:00Z',expectedPreviousVersion:0,idempotencyKey:randomUUID(),
    pricingPolicy:{version:'v1',serviceFeeMinor:200n,maximumServiceFeeMinor:200n,taxAmountMinor:0n,paymentFeeBasisPoints:150,paymentFixedFeeMinor:20n,
      agentCommissionMinor:50n,minimumContributionMinor:100n,maximumOfferAgeMs:86400000}});
}

// Controlled pg client transcripts only; no database connection or migration.
test('publication rollback failures discard clients once; successful rollback permits clean release and close is idempotent',async()=>{
  const originalConnect=Pool.prototype.connect,originalEnd=Pool.prototype.end;
  try {
    for(const rollbackFails of [false,true]) {
      let checkouts=0,ends=0;const releases:unknown[]=[],queries:string[]=[];
      const probe={query:async(sql:string)=>({rows:[sql.includes('current_database()')?
        {database,role,host:'127.0.0.1',port:5432,unsafe:false,membership:false}:
        {forced:4,required:true,excess:false,iam_access:false,audit_access:false,source_views:true,source_table_access:false}]}),release:()=>undefined};
      const client={query:async(sql:string)=>{queries.push(sql);if(sql==='ROLLBACK'&&!rollbackFails)return {};throw new Error('controlled query failure');},release:(value:unknown)=>releases.push(value)};
      Pool.prototype.connect=(async()=>++checkouts===1?probe as unknown as PoolClient:client as unknown as PoolClient) as typeof Pool.prototype.connect;
      Pool.prototype.end=(async()=>{ends++;}) as typeof Pool.prototype.end;
      const store=await createCataloguePublicationDraftStore(config);
      await assert.rejects(()=>store.save(candidateValue),{message:'controlled query failure'});
      assert.deepEqual(queries,['BEGIN ISOLATION LEVEL READ COMMITTED','ROLLBACK']);assert.deepEqual(releases,[rollbackFails]);
      await store.close();await store.close();assert.equal(ends,1);
      await assert.rejects(()=>store.save(candidateValue),{message:'Publication draft store unavailable'});
    }
  }finally{Pool.prototype.connect=originalConnect;Pool.prototype.end=originalEnd;}
});
const candidateValue=await candidate();

test('publication startup connection failure closes its pool without exposing the driver error',async()=>{
  const originalConnect=Pool.prototype.connect,originalEnd=Pool.prototype.end;let ends=0;
  try {
    Pool.prototype.connect=(async()=>{throw new Error('private connection detail');}) as typeof Pool.prototype.connect;
    Pool.prototype.end=(async()=>{ends++;}) as typeof Pool.prototype.end;
    await assert.rejects(()=>createCataloguePublicationDraftStore(config),{message:'Publication draft store unavailable'});
    assert.equal(ends,1);
  }finally{Pool.prototype.connect=originalConnect;Pool.prototype.end=originalEnd;}
});
