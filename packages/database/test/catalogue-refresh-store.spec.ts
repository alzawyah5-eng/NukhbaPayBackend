import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {createCatalogueRefreshStore} from '../src/catalogue-refresh-store.js';

// Controlled client transcripts only; no network or PostgreSQL acceptance.
function fixture(fail:string|null=null){let checkouts=0,ends=0;const releases:boolean[]=[],queries:{sql:string;values:unknown}[]=[];
 const client={query:async(sql:string,values:unknown)=>{queries.push({sql,values});if(sql===fail)throw new Error('PRIVATE database details');return {rows:[],rowCount:0};},release:(broken:boolean)=>releases.push(broken)} as unknown as PoolClient;
 const pool={connect:async()=>{checkouts++;return client;},end:async()=>{ends++;}} as unknown as Pool;
 return {pool,queries,releases,checkouts:()=>checkouts,ends:()=>ends};}
test('store construction has no connection and tenant-scoped read releases exactly once',async()=>{
 const f=fixture(),tenant=randomUUID(),store=createCatalogueRefreshStore(f.pool,[tenant]);assert.equal(f.checkouts(),0);
 assert.equal(await store.find(randomUUID()),null);assert.equal(f.checkouts(),1);assert.deepEqual(f.releases,[false]);
 assert.equal(f.queries[1]?.sql,"SELECT set_config('nukhabapay.refresh_tenant_id',$1,true)");assert.deepEqual(f.queries[1]?.values,[tenant]);
 await store.close();assert.equal(f.ends(),0);await assert.rejects(store.find(randomUUID()));
});
test('commit acknowledgement failure discards its client and exposes only a fixed uncertain error',async()=>{
 const f=fixture('COMMIT'),store=createCatalogueRefreshStore(f.pool,[randomUUID()],true);
 await assert.rejects(store.find(randomUUID()),{message:'Refresh transaction unresolved; reconcile before retry'});assert.deepEqual(f.releases,[true]);
 assert.equal(f.queries.at(-1)?.sql,'ROLLBACK');await store.close();await store.close();assert.equal(f.ends(),1);
});
test('fenced settlement rejects stale claims, rolls back and cannot append a success audit',async()=>{
 const f=fixture(),tenant=randomUUID(),store=createCatalogueRefreshStore(f.pool,[tenant]);
 await assert.rejects(store.settle({tenantId:tenant,scheduleId:randomUUID(),version:'1',slotAtMs:0,token:randomUUID(),attempt:1,leaseUntilMs:2000},
 {state:'SUCCEEDED',reason:'NONE',nextAttemptAtMs:null},1000));
 assert.equal(f.queries.at(-1)?.sql,'ROLLBACK');assert.equal(f.queries.some(q=>q.sql.includes('INSERT INTO nukhabapay.catalogue_refresh_audit')),false);assert.deepEqual(f.releases,[false]);
});
test('invalid tenants and unsafe retry input deny before pool checkout',async()=>{
 const f=fixture(),tenant=randomUUID();assert.throws(()=>createCatalogueRefreshStore(f.pool,['untrusted']));const store=createCatalogueRefreshStore(f.pool,[tenant]);
 await assert.rejects(store.claim(0,999999));assert.equal(f.checkouts(),0);
});


test('invalid terminal state, retry reason and foreign tenant fail before checkout', async () => {
  const f = fixture(), tenant = randomUUID();
  const store = createCatalogueRefreshStore(f.pool, [tenant]);
  const claim = { tenantId: tenant, scheduleId: randomUUID(), version: 'r1', slotAtMs: 10,
    token: randomUUID(), attempt: 1, leaseUntilMs: 7010 };
  await assert.rejects(store.settle(claim, {
    state: 'FAILED', reason: 'PROVIDER_READ_UNAVAILABLE', nextAttemptAtMs: null,
  }, 0), /Invalid refresh settlement/);
  await assert.rejects(store.settle(claim, {
    state: 'RETRY_WAIT', reason: 'OUTCOME_UNCERTAIN', nextAttemptAtMs: 100,
  }, 0), /Invalid refresh settlement/);
  await assert.rejects(store.renew!({ ...claim, tenantId: randomUUID() }, 1010), /store unavailable/);
  assert.equal(f.checkouts(), 0);
});

test('a stale reservation cannot renew or settle; database time and all claim keys fence mutations', async () => {
  const f = fixture(), tenant = randomUUID();
  const store = createCatalogueRefreshStore(f.pool, [tenant]);
  const claim = { tenantId: tenant, scheduleId: randomUUID(), version: 'r1', slotAtMs: 50,
    token: randomUUID(), attempt: 2, leaseUntilMs: 7010 };
  assert.equal(await store.checkLease!(claim), false);
  await assert.rejects(store.renew!(claim, 2000));
  await assert.rejects(store.settle(claim, { state: 'SUCCEEDED', reason: 'NONE', nextAttemptAtMs: null }, -99));
  await store.expire(Number.MAX_SAFE_INTEGER);
  const fences = f.queries.filter(q => q.sql.includes('lease_until_ms'));
  assert.equal(fences.length, 4);
  assert.ok(fences.every(q => q.sql.includes('clock_timestamp()')));
  for (const q of fences.slice(0,3)) {
    assert.match(q.sql, /token=\$5 AND attempt=\$6/);
    assert.deepEqual((q.values as unknown[]).slice(0, 6),
      [tenant, claim.scheduleId, 'r1', 50, claim.token, 2]);
  }
  assert.deepEqual(fences[3]!.values, [tenant]);
});

test('two simultaneous claims serialize in the tenant schedule namespace and use exact account binding', async () => {
  const tenant = randomUUID(), schedule = randomUUID();
  let locked = false, inserts = 0, entered = 0;
  let enteredBoth!: () => void;
  const concurrent = new Promise<void>(resolve => { enteredBoth = resolve; });
  const pool = {
    connect: async () => {
      let ownsLock = false;
      return {
        query: async (sql: string, args: unknown[] = []) => {
          if (sql.includes('SELECT s.id')) {
            assert.match(sql, /a.tenant_id=s.tenant_id AND a.id=s.provider_account_id/);
            assert.deepEqual(args, [tenant]);
            if (++entered === 2) enteredBoth();
            await concurrent;
            return { rows: [{ id: schedule }] };
          }
          if (sql.includes('pg_try_advisory_xact_lock')) {
            assert.deepEqual(args, [tenant, schedule]);
            if (locked) return { rows: [{ locked: false }] };
            locked = ownsLock = true;
            return { rows: [{ locked: true }] };
          }
          if (sql.includes('SELECT s.version')) return { rows: [{ version: 'r1', slot: '100' }] };
          if (sql.includes('INSERT INTO nukhabapay.catalogue_refresh_jobs')) {
            inserts++;
            return { rows: [{ tenant_id: tenant, schedule_id: schedule, version: 'r1',
              slot_at_ms: '100', token: args[4], attempt: 1, lease_until_ms: '7100' }] };
          }
          return { rows: [] };
        },
        release: () => { if (ownsLock) locked = false; },
      };
    },
  } as unknown as Pool;
  const store = createCatalogueRefreshStore(pool, [tenant]);
  const results = await Promise.all([store.claim(0, 7000), store.claim(Number.MAX_SAFE_INTEGER, 7000)]);
  assert.equal(inserts, 1);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.find(Boolean)?.slotAtMs, 100);
});
