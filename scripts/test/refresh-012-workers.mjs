import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createRefreshFencedDraftWriter } from '../../packages/database/dist/database/src/catalogue-publication-draft-store.js';
import { generateDraftPublicationCandidate } from '../../packages/application/dist/application/src/catalog/publication-candidate.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createCatalogueRefreshReconciler, createRefreshQuarantineDisposition } from '../../packages/database/dist/database/src/catalogue-refresh-reconciliation.js';
import { armCatalogueRefreshWrite } from '../../packages/database/dist/database/src/catalogue-refresh-write-fence.js';
import { CatalogueRefreshHost } from '../../apps/worker/dist/jobs/catalogue-refresh-host.js';
import { createCatalogueRefreshStore, createReconciledCatalogueRefreshStore } from '../../packages/database/dist/database/src/catalogue-refresh-store.js';

import { createStaffCatalogueReader } from '../../packages/database/dist/database/src/staff-catalogue-reader.js';
import { StaffCatalogueService } from '../../packages/application/dist/application/src/catalog/staff-catalogue.js';

const { Client, Pool } = createRequire(new URL('../../packages/database/package.json',import.meta.url))('pg');

// Fixture-only loopback proxy. PostgreSQL commits before emitting CommandComplete.
async function hideCommitResponse(target) {
  assert.equal(target.hostname,'127.0.0.1');
  assert.ok(Number(target.port)>1024 && !['5432','55437'].includes(target.port));
  const sockets=new Set();
  let armed=false,dropped=false;
  const server=createServer(front=>{
    const back=createConnection({host:'127.0.0.1',port:Number(target.port)});
    sockets.add(front);sockets.add(back);
    function end(){front.destroy();back.destroy();sockets.delete(front);sockets.delete(back);}
    front.on('error',end).on('close',end);
    back.on('error',end).on('close',end);
    front.pipe(back);
    let buffered=Buffer.alloc(0);
    back.on('data',data=>{
      buffered=Buffer.concat([buffered,data]);
      while (buffered.length>=5) {
        const length=buffered.readUInt32BE(1)+1;
        if (length<5 || length>1048576) {end();return;}
        if (buffered.length<length) return;
        const frame=buffered.subarray(0,length);
        buffered=buffered.subarray(length);
        if (armed && frame[0]===0x43 && frame.subarray(5).equals(Buffer.from('COMMIT\0'))) {
          dropped=true;end();return;
        }
        front.write(frame);
      }
    });
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const proxy=new URL(target);proxy.port=String(server.address().port);
  return {url:proxy.href,arm:()=>{armed=true;},dropped:()=>dropped,close:async()=>{
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve=>server.close(resolve));
  }};
}

test('012 R2 on private PostgreSQL', async t => {
  const { NUKHBA_DISPOSABLE_PG: origin, NUKHBA_DISPOSABLE_PG_DIRECTORY: directory } = process.env;
  if (!origin || !directory) throw new Error('Run through the disposable PostgreSQL harness');
  const target=new URL(origin);
  assert.equal(target.hostname,'127.0.0.1');
  assert.equal(target.username,'nukh_fixture');
  assert.equal(target.pathname,'/postgres');
  assert.ok(Number(target.port)>1024 && target.port!=='5432' && target.port!=='55437');
  const owner=new Client({connectionString:origin});
  await owner.connect();
  const pools=[];
  try{
    const path=(await owner.query('SHOW data_directory')).rows[0].data_directory;
    assert.equal(path.replaceAll('\\','/').toLowerCase(),directory.replaceAll('\\','/').toLowerCase());
    await owner.query(`CREATE SCHEMA nukhabapay;
      CREATE TABLE nukhabapay.provider_accounts (tenant_id uuid NOT NULL,id uuid NOT NULL,provider_code text,status text,UNIQUE(tenant_id,id))`);
    await owner.query(readFileSync(new URL('../../packages/database/pending-migrations/012_catalogue_refresh_R2_PROPOSAL.sql',import.meta.url),'utf8'));
    await owner.query(readFileSync(new URL('../../packages/database/pending-migrations/012_catalogue_refresh_write_fence_PROPOSAL.sql',import.meta.url),'utf8'));
    await owner.query(readFileSync(new URL('../../packages/database/pending-migrations/012_catalogue_refresh_reconciliation.sql',import.meta.url),'utf8'));
    await owner.query(readFileSync(new URL('../../packages/database/pending-migrations/012_catalogue_refresh_disposition.sql',import.meta.url),'utf8'));
    await owner.query(`CREATE TABLE nukhabapay.refresh_fixture_writes(
        id uuid PRIMARY KEY, tenant_id uuid NOT NULL, schedule_id uuid NOT NULL UNIQUE);
      CREATE ROLE refresh_worker LOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA nukhabapay TO refresh_worker;
      GRANT SELECT ON nukhabapay.provider_accounts,nukhabapay.catalogue_refresh_schedules,nukhabapay.catalogue_refresh_jobs,nukhabapay.catalogue_refresh_dispositions TO refresh_worker;
      GRANT INSERT,UPDATE ON nukhabapay.catalogue_refresh_jobs TO refresh_worker;
      GRANT INSERT ON nukhabapay.catalogue_refresh_audit,nukhabapay.catalogue_refresh_write_evidence,
        nukhabapay.refresh_fixture_writes TO refresh_worker;
      GRANT USAGE ON SEQUENCE nukhabapay.catalogue_refresh_audit_id_seq TO refresh_worker`);
    target.username='refresh_worker';
    function connections() {
      const pool=new Pool({connectionString:target.href,max:2,connectionTimeoutMillis:3000});
      pools.push(pool);
      return pool;
    }
    function db(tenant) { return createCatalogueRefreshStore(connections(),[tenant]); }
    async function readyStore(tenant) {
      const pool=connections();
      await pool.query('SELECT 1');
      return createCatalogueRefreshStore(pool,[tenant]);
    }
    function openFence(client, claim, account) {
      return armCatalogueRefreshWrite(client,claim,{tenantId:claim.tenantId,providerAccountId:account,
        purpose:'IMPORT',resourceKey:'synthetic-'+claim.scheduleId});
    }
    async function writeProbe(client, claim) {
      await client.query('INSERT INTO nukhabapay.refresh_fixture_writes VALUES($1,$2,$3)',
        [randomUUID(),claim.tenantId,claim.scheduleId]);
    }
    async function evidence(id) {
      const result = await owner.query(`SELECT
        (SELECT count(*)::int FROM nukhabapay.refresh_fixture_writes WHERE schedule_id=$1) AS writes,
        (SELECT count(*)::int FROM nukhabapay.catalogue_refresh_write_evidence WHERE schedule_id=$1) AS fences`,[id]);
      return result.rows[0];
    }
    const success = {state:'SUCCEEDED',reason:'NONE',nextAttemptAtMs:null};
    async function schedule() {
      const tenant=randomUUID(),account=randomUUID(),id=randomUUID();
      await owner.query("INSERT INTO nukhabapay.provider_accounts VALUES($1,$2,'synthetic','ACTIVE')",[tenant,account]);
      await owner.query(`INSERT INTO nukhabapay.catalogue_refresh_schedules VALUES
        ($1,$2,$3,'v1','v1',TRUE,floor(extract(epoch FROM clock_timestamp())*1000)::bigint-500,86400000)`,
      [id,tenant,account]);
      return {tenant,id, account};
    }
    async function row(id){
      return (await owner.query('SELECT state,reason,token,attempt,updated_at_ms,next_attempt_at_ms FROM nukhabapay.catalogue_refresh_jobs WHERE schedule_id=$1',[id])).rows[0];
    }

    await t.test('competing connections reserve one job and enqueue no duplicate after success',async()=>{
      const f=await schedule(),a=await readyStore(f.tenant),b=await readyStore(f.tenant);
      const claims=await Promise.all([a.claim(1,15000),b.claim(Number.MAX_SAFE_INTEGER,15000)]);
      assert.equal(claims.filter(Boolean).length,1);
      const lease=claims.find(Boolean);
      const holder=claims[0]?a:b;
      await assert.rejects(db(randomUUID()).settle(lease,{state:'SUCCEEDED',reason:'NONE',nextAttemptAtMs:null},0));
      assert.equal(await holder.checkLease(lease),true);
      await holder.settle(lease,{state:'SUCCEEDED',reason:'NONE',nextAttemptAtMs:null},0);
      assert.equal(await a.claim(0,15000),null);
      assert.equal((await row(f.id)).state,'SUCCEEDED');
      assert.equal(Number((await owner.query('SELECT count(*) FROM nukhabapay.catalogue_refresh_audit WHERE schedule_id=$1',[f.id])).rows[0].count),2);
    });
    await t.test('database retry rotates the token and old or forged fences cannot renew or settle',async()=>{
      const f=await schedule(),a=await readyStore(f.tenant),b=await readyStore(f.tenant);
      const first=await a.claim(0,12000);
      assert.ok(first);
      await a.settle(first,{state:'RETRY_WAIT',reason:'PROVIDER_READ_UNAVAILABLE',nextAttemptAtMs:0},0);
      const retry=await row(f.id);
      assert.equal(Number(retry.next_attempt_at_ms)-Number(retry.updated_at_ms),1000);
      let next=await b.claim(0,12000);
      if (!next) {
        await owner.query('SELECT pg_sleep(greatest(0,$1::double precision / 1000 - extract(epoch FROM clock_timestamp()))+0.01)',
          [retry.next_attempt_at_ms]);
        next=await b.claim(0,12000);
      }
      assert.ok(next);
      assert.ok(Number((await row(f.id)).updated_at_ms)>=Number(retry.next_attempt_at_ms));
      assert.equal(next.attempt,2);assert.notEqual(next.token,first.token);
      assert.equal(await a.checkLease(first),false);
      await assert.rejects(a.renew(first,20000));
      await assert.rejects(a.settle({...next,token:randomUUID()},{state:'SUCCEEDED',reason:'NONE',nextAttemptAtMs:null},0));
      const renewed=await b.renew(next,20000);
      assert.equal(renewed.token,next.token);assert.ok(renewed.leaseUntilMs>next.leaseUntilMs);
      await assert.rejects(b.settle(renewed,{state:'FAILED',reason:'PROVIDER_READ_UNAVAILABLE',nextAttemptAtMs:null},0),/Invalid refresh settlement/);
      await b.settle(renewed,{state:'SUCCEEDED',reason:'NONE',nextAttemptAtMs:null},0);
    });
    await t.test('expired claims are fenced and quarantined without falling back to local time',async()=>{
      const f=await schedule(),a=await readyStore(f.tenant),b=await readyStore(f.tenant);
      const expired=await a.claim(Number.MAX_SAFE_INTEGER,1010);
      assert.ok(expired);
      await owner.query('SELECT pg_sleep(1.1)');
      assert.equal(await b.checkLease(expired),false);
      await assert.rejects(b.renew(expired,20000));
      await assert.rejects(a.settle(expired,{state:'SUCCEEDED',reason:'NONE',nextAttemptAtMs:null},0));
      await b.expire(0);
      assert.equal((await row(f.id)).reason,'LEASE_EXPIRED');
      assert.equal(await a.claim(0,12000),null);
    });
    await t.test('host shutdown aborts and joins work before a durable uncertain settlement',async()=>{
      const f=await schedule(),store=db(f.tenant);
      let entered,joined=false;
      const started=new Promise(resolve=>{entered=resolve});
      const supervisor=new AbortController();
      const host=new CatalogueRefreshHost({store,now:()=>new Date(1),options:{concurrency:1,pollMs:10,
        timeoutMs:15000,leaseMs:18000,ownsStore:false},refresh:{runDue:async(_id,signal,pin)=>{
        entered();
        assert.equal(await pin.checkLease(),true);
        if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
        joined=true;
        throw new Error('Stopped fixture');
      }}});
      const operation=host.pollOnce(supervisor.signal);
      try{
        await Promise.race([started,operation.then(()=>{throw new Error('No work started')})]);
        await host.stop();
        assert.equal(joined,true);
        assert.equal((await row(f.id)).reason,'CANCELLED_OR_TIMED_OUT');
        assert.equal(await store.claim(0,12000),null);
      }finally{supervisor.abort();await operation;}
    });
    await t.test('fenced writes roll back with expired leases and lost database sessions',async()=>{
      for (const scenario of ['expire','rollback','disconnect','commit']) {
        const f=await schedule(),a=db(f.tenant),pool=connections();
        const lease=await a.claim(0,scenario==='expire'?1200:12000);
        assert.ok(lease);
        const client=await pool.connect();
        let broken=false;
        try {
          await client.query('BEGIN');
          await assert.rejects(openFence(client,lease,randomUUID()),{code:'42501'});
          await client.query('ROLLBACK');
          await client.query('BEGIN');
          await openFence(client,lease,f.account);
          await writeProbe(client,lease);
          if (scenario==='expire') {
            await owner.query('SELECT pg_sleep(1.3)');
            await assert.rejects(client.query('COMMIT'),{code:'42501'});
            await a.expire(0);
            assert.equal((await row(f.id)).state,'UNCERTAIN');
          } else if (scenario==='rollback') {
            await client.query('ROLLBACK');
          } else if (scenario==='disconnect') {
            const {rows:[{pid}]}=await client.query('SELECT pg_backend_pid() AS pid');
            client.on('error',()=>{});
            await owner.query('SELECT pg_terminate_backend($1,5000)',[pid]);
            await assert.rejects(client.query('COMMIT'));
            broken=true;
            const fresh=await pool.connect();
            try { assert.notEqual((await fresh.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,pid); }
            finally { fresh.release(); }
          } else {
            const contender=db(f.tenant);
            await assert.rejects(contender.settle(lease,success,0));
            assert.equal((await client.query('COMMIT')).command,'COMMIT');
            await contender.settle(lease,success,0);
          }
        } finally {client.release(broken);}
        const committed=Number(scenario==='commit');
        assert.deepEqual(await evidence(f.id),{writes:committed,fences:committed});
      }
    });

    await t.test('new token can persist after pre-write retry and cross-tenant or superseded evidence is refused',async()=>{
      const f=await schedule(),foreign=await schedule(),a=db(f.tenant);
      const lease=await a.claim(0,12000);
      assert.ok(lease);
      await a.settle(lease,{state:'RETRY_WAIT',reason:'PROVIDER_READ_UNAVAILABLE',nextAttemptAtMs:0},0);
      await delay(1100);
      const replacement=await a.claim(0,12000);
      assert.ok(replacement);
      const client=await connections().connect();
      try {
        for (const [claim,account] of [[lease,f.account],[replacement,foreign.account],[{...replacement,tenantId:foreign.tenant},f.account]]) {
          await client.query('BEGIN');
          await assert.rejects(openFence(client,claim,account),{code:'42501'});
          await client.query('ROLLBACK');
        }
        await client.query('BEGIN');
        await openFence(client,replacement,f.account);
        await writeProbe(client,replacement);
        await client.query('COMMIT');
        await a.settle(replacement,success,0);
      } finally {client.release();}
      assert.deepEqual(await evidence(f.id),{writes:1,fences:1});
      assert.deepEqual(await evidence(foreign.id),{writes:0,fences:0});
    });

    await t.test('forced writer termination rolls back in-flight writes before a new worker quarantines its lease',async()=>{
      const f=await schedule(),store=db(f.tenant);
      const workerSource = `
        import {createRequire} from 'node:module';
        import {once} from 'node:events';
        import {armCatalogueRefreshWrite} from ${JSON.stringify(new URL('../../packages/database/dist/database/src/catalogue-refresh-write-fence.js',import.meta.url).href)};
        const {Client}=createRequire(${JSON.stringify(new URL('../../packages/database/package.json',import.meta.url).href)})('pg');
        const client=new Client({connectionString:process.env.NUKHBA_TEST_WRITER});
        await client.connect();
        const input=once(process,'message');
        process.send('READY');
        const [claim]=await input;
        await client.query('BEGIN');
        await armCatalogueRefreshWrite(client,claim,{tenantId:claim.tenantId,providerAccountId:process.env.NUKHBA_TEST_ACCOUNT,
          purpose:'IMPORT',resourceKey:'forced-termination'});
        await client.query('INSERT INTO nukhabapay.refresh_fixture_writes VALUES(pg_catalog.gen_random_uuid(),$1,$2)',
          [claim.tenantId,claim.scheduleId]);
        process.send('WRITES_STAGED');
        setInterval(()=>{},1000);
      `;
      const writer=spawn(process.execPath,['--input-type=module','-e',workerSource],{
        env:{...process.env,NUKHBA_TEST_WRITER:target.href,NUKHBA_TEST_ACCOUNT:f.account},
        stdio:['ignore','ignore','ignore','ipc'],
      });
      const exit=once(writer,'exit');
      async function waitFor(expected) {
        const [message]=await Promise.race([once(writer,'message',{signal:AbortSignal.timeout(25000)}),
          exit.then(()=>{throw new Error('Fixture writer exited before '+expected);})]);
        assert.equal(message,expected);
      }
      let claim;
      try {
        await waitFor('READY');
        claim=await store.claim(0,2200);
        assert.ok(claim);
        const staged=waitFor('WRITES_STAGED');
        writer.send(claim);
        await staged;
        assert.equal(writer.kill('SIGKILL'),true);
        await exit;
      } finally {if (writer.exitCode===null && writer.signalCode===null) writer.kill('SIGKILL');}
      const restart=db(f.tenant);
      for (let attempt=0; attempt<40 && await restart.checkLease(claim); attempt++) await delay(100);
      await restart.expire(0);
      assert.equal((await row(f.id)).state,'UNCERTAIN');
      assert.equal(await restart.claim(0,12000),null);
      assert.deepEqual(await evidence(f.id),{writes:0,fences:0});
    });

    await t.test('commit acknowledgement loss resolves from durable evidence without replaying the write',async()=>{
      const f=await schedule(),store=db(f.tenant);
      const claim=await store.claim(0,15000);
      assert.ok(claim);
      await owner.query(`CREATE ROLE refresh_reader LOGIN NOINHERIT;
        GRANT USAGE ON SCHEMA nukhabapay TO refresh_reader;
        GRANT SELECT ON nukhabapay.catalogue_refresh_write_evidence TO refresh_reader;
        GRANT INSERT ON nukhabapay.catalogue_refresh_reconciliation TO refresh_reader`);
      const reader=new URL(target);
      reader.username='refresh_reader';
      const readPool=new Pool({connectionString:reader.href,max:1});
      pools.push(readPool);
      const reconcile=createCatalogueRefreshReconciler(readPool,[f.tenant]);
      const proxy=await hideCommitResponse(target);
      const unacknowledged=new Client({connectionString:proxy.url,connectionTimeoutMillis:2500,query_timeout:3000});
      unacknowledged.on('error',()=>{});
      const client=await connections().connect();
      try {
        await unacknowledged.connect();
        const targetFor=(resourceKey)=>({tenantId:f.tenant,providerAccountId:f.account,purpose:'IMPORT',resourceKey});
        const uncertain=targetFor('uncertain-commit'),aborted=targetFor('aborted-write');
        await unacknowledged.query('BEGIN');
        const xid=await armCatalogueRefreshWrite(unacknowledged,claim,uncertain);
        await writeProbe(unacknowledged,claim);
        assert.deepEqual(await reconcile(claim,uncertain,xid),{outcome:'IN_PROGRESS',transactionId:null});
        proxy.arm();
        await assert.rejects(unacknowledged.query('COMMIT'));
        assert.equal(proxy.dropped(),true);
        assert.deepEqual(await reconcile(claim,uncertain,xid),{outcome:'COMMITTED',transactionId:xid.transactionId});
        assert.deepEqual(await reconcile(claim,uncertain,xid),{outcome:'COMMITTED',transactionId:xid.transactionId});
        assert.deepEqual(await reconcile(claim,uncertain),{outcome:'COMMITTED',transactionId:xid.transactionId});
        await client.query('BEGIN');
        const rollback=await armCatalogueRefreshWrite(client,claim,aborted);
        await client.query('ROLLBACK');
        assert.deepEqual(await reconcile(claim,aborted,rollback),{outcome:'ROLLED_BACK',transactionId:rollback.transactionId});
        await assert.rejects(reconcile(claim,aborted,{...rollback}));
        assert.deepEqual(await reconcile(claim,aborted),{outcome:'QUARANTINED',transactionId:null});
        await assert.rejects(reconcile({...claim,tenantId:randomUUID()},aborted));
        assert.deepEqual(await evidence(f.id),{writes:1,fences:1});
        assert.equal((await owner.query('SELECT count(*)::int AS c FROM nukhabapay.catalogue_refresh_reconciliation WHERE schedule_id=$1',[f.id])).rows[0].c,3);
        await assert.rejects(readPool.query("UPDATE nukhabapay.catalogue_refresh_jobs SET state='SUCCEEDED'"),{code:'42501'});
      } finally {client.release();await unacknowledged.end();await proxy.close();}
    });

    await t.test('audited quarantine disposition makes a new version eligible without replaying the parked slot',async()=>{
      const f=await schedule(),store=createReconciledCatalogueRefreshStore(connections(),[f.tenant]),foreign=await schedule();
      await owner.query(`CREATE ROLE refresh_operator LOGIN NOINHERIT NOBYPASSRLS;
        GRANT USAGE ON SCHEMA nukhabapay TO refresh_operator;
        GRANT SELECT ON nukhabapay.catalogue_refresh_jobs,nukhabapay.catalogue_refresh_reconciliation,
          nukhabapay.catalogue_refresh_dispositions TO refresh_operator;
        GRANT INSERT ON nukhabapay.catalogue_refresh_dispositions TO refresh_operator`);
      const reader=new URL(target);reader.username='refresh_reader';
      const readPool=new Pool({connectionString:reader.href,max:1});pools.push(readPool);
      const operator=new URL(target);operator.username='refresh_operator';
      const operatorPool=new Pool({connectionString:operator.href,max:1});pools.push(operatorPool);
      const reconcile=createCatalogueRefreshReconciler(readPool,[f.tenant]);
      const dispose=createRefreshQuarantineDisposition(operatorPool,f.tenant);
      const claim=await store.claim(0,1050);
      assert.ok(claim);
      const resource={tenantId:f.tenant,providerAccountId:f.account,purpose:'IMPORT',resourceKey:'quarantine-observation'};
      const fabricated={outcome:'COMMITTED',transactionId:'1'};
      await assert.rejects(dispose(claim,resource,fabricated));
      await delay(1220);
      await store.expire(0);
      assert.equal((await row(f.id)).state,'UNCERTAIN');
      assert.equal(await store.claim(0,12000),null);
      await assert.rejects(owner.query("UPDATE nukhabapay.catalogue_refresh_schedules SET version='v2' WHERE id=$1",[f.id]),{code:'23514'});
      const observed=await reconcile(claim,resource);
      assert.equal(observed.outcome,'QUARANTINED');
      await assert.rejects(dispose({...claim,tenantId:foreign.tenant},resource,observed));
      await assert.rejects(dispose({...claim,token:randomUUID()},resource,observed));
      const dispositions=await Promise.all([dispose(claim,resource,observed),dispose(claim,resource,observed).catch(()=>null)]);
      assert.equal(dispositions.filter(value=>value==='RECORDED').length,1);
      assert.equal(await dispose(claim,resource,observed),'REPLAYED');
      assert.equal(await store.claim(0,12000),null);
      assert.equal((await row(f.id)).state,'UNCERTAIN');
      assert.equal((await owner.query('SELECT operator_role FROM nukhabapay.catalogue_refresh_dispositions WHERE schedule_id=$1',[f.id])).rows[0].operator_role,'refresh_operator');
      await assert.rejects(operatorPool.query("UPDATE nukhabapay.catalogue_refresh_jobs SET state='SUCCEEDED'"),{code:'42501'});
      await owner.query("UPDATE nukhabapay.catalogue_refresh_schedules SET version='v2' WHERE id=$1",[f.id]);
      const successor=await store.claim(0,12000);
      assert.ok(successor);
      assert.equal(successor.version,'v2');
      assert.notEqual(successor.token,claim.token);
      assert.equal(await store.checkLease(claim),false);
      await store.settle(successor,success,0);
    });

    const soakMs=Number(process.env.NUKHBA_DISPOSABLE_SOAK_MS ?? 0);
    if (soakMs) await t.test('bounded concurrent worker soak on disposable PostgreSQL',async()=>{
      assert.ok(Number.isSafeInteger(soakMs)&&soakMs>=1000&&soakMs<=600000);
      const workers=[connections(),connections(),connections()];
      const tenants=[await schedule(),await schedule(),await schedule()];
      const reader=new URL(target);reader.username='refresh_reader';
      const recoveryPool=new Pool({connectionString:reader.href,max:1});pools.push(recoveryPool);
      const recover=createCatalogueRefreshReconciler(recoveryPool,tenants.map(f=>f.tenant));
      let reconciliations=0;
      const started=performance.now();
      const initialHeap=process.memoryUsage().heapUsed;
      let rounds=0,conflicts=0,peakConnections=0,peakWaiters=0;
      const unique=new Set();
      do {
        if (rounds) {
          for (const f of tenants) await owner.query(`UPDATE nukhabapay.catalogue_refresh_schedules
             SET version=$2 WHERE id=$1`,[f.id,'v'+(rounds+1)]);
        }
        await Promise.all(tenants.map(async f => {
          const contenders=workers.map(pool=>createReconciledCatalogueRefreshStore(pool,[f.tenant]));
          const claiming=contenders.map(store=>store.claim(0,10000));
          peakWaiters=Math.max(peakWaiters,workers.reduce((n,p)=>n+p.waitingCount,0));
          const attempts=await Promise.all(claiming);
          const winner=attempts.findIndex(Boolean),claim=attempts[winner];
          assert.equal(attempts.filter(Boolean).length,1);
          assert.ok(!unique.has(claim.token));
          unique.add(claim.token);
          conflicts+=attempts.length-1;
          // The real refresh host and failure cases are exercised above. This loop
          // measures storage contention and durable claim/settle under repeated load.
          const client=await workers[winner].connect();
          try {
            await client.query('BEGIN');
            await openFence(client,claim,f.account);
            await client.query('COMMIT');
          }finally{client.release();}
          if (rounds%200===0) {
            const evidence=await recover(claim,{tenantId:f.tenant,providerAccountId:f.account,purpose:'IMPORT',resourceKey:'synthetic-'+claim.scheduleId});
            assert.equal(evidence.outcome,'COMMITTED');
            reconciliations++;
          }
          await contenders[winner].settle(claim,success,0);
        }));
        rounds++;
        peakConnections=Math.max(peakConnections,workers.reduce((n,p)=>n+p.totalCount,0));
        peakWaiters=Math.max(peakWaiters,workers.reduce((n,p)=>n+p.waitingCount,0));
        await delay(20);
      } while (performance.now()-started<soakMs);
      const ids=tenants.map(f=>f.id);
      const {rows:[counts]}=await owner.query(`SELECT
        count(*)::int AS jobs, count(*) FILTER(WHERE state='SUCCEEDED')::int AS succeeded,
        (SELECT count(*)::int FROM nukhabapay.catalogue_refresh_write_evidence WHERE schedule_id=ANY($1::uuid[])) AS fences
        FROM nukhabapay.catalogue_refresh_jobs WHERE schedule_id=ANY($1::uuid[])`,[ids]);
      assert.deepEqual(counts,{jobs:3*rounds,succeeded:3*rounds,fences:3*rounds});
      const {rows:[activity]}=await owner.query("SELECT count(*)::int AS connections FROM pg_stat_activity WHERE usename='refresh_worker'");
      assert.ok(peakConnections<=6);
      await Promise.all(workers.map(async pool => {
        pools.splice(pools.indexOf(pool),1);
        await pool.end();
      }));
      console.log('SOAK '+JSON.stringify({elapsedMs:Math.round(performance.now()-started),rounds,workers:3,tenants:3,
        conflicts,reconciliations,peakConnections,peakWaiters,heapDeltaBytes:process.memoryUsage().heapUsed-initialHeap,allFixtureConnections:activity.connections,...counts}));
    });

    await t.test('staff offer read uses only the latest complete snapshot for each tenant account',async()=>{
      const f=await schedule(), foreign=await schedule(), product=randomUUID(), mapping=randomUUID(), staff=randomUUID();
      await owner.query(`CREATE TABLE nukhabapay.products(id uuid,canonical_product_key text,redemption_country text,fulfillment_method text);
        CREATE TABLE nukhabapay.product_mappings(id uuid,tenant_id uuid,provider_account_id uuid,product_id uuid,status text);
        CREATE TABLE nukhabapay.provider_snapshots(id uuid,tenant_id uuid,provider_account_id uuid,observed_at timestamptz,completed_at timestamptz,status text);
        CREATE TABLE nukhabapay.provider_offers(id uuid,tenant_id uuid,provider_account_id uuid,product_id uuid,provider_snapshot_id uuid,
          product_mapping_id uuid,available boolean,valid_until timestamptz,provider_debit_minor bigint,additional_provider_fee_minor bigint);
        GRANT SELECT ON nukhabapay.products,nukhabapay.product_mappings,nukhabapay.provider_snapshots,nukhabapay.provider_offers TO refresh_worker`);
      await owner.query("INSERT INTO nukhabapay.products VALUES($1,'Card','AE','DIGITAL_PIN')",[product]);
      await owner.query("INSERT INTO nukhabapay.product_mappings VALUES($1,$2,$3,$4,'APPROVED')",[mapping,f.tenant,f.account,product]);
      const ids=[randomUUID(),randomUUID(),randomUUID()];
      for(let i=0;i<ids.length;i++){
        const observed=new Date(Date.UTC(2026,10,19,8+i));
        await owner.query('INSERT INTO nukhabapay.provider_snapshots VALUES($1,$2,$3,$4,$5,$6)',[ids[i],f.tenant,f.account,observed,
          i===2?null:observed,i===2?'IN_PROGRESS':'COMPLETE']);
      }
      await owner.query("INSERT INTO nukhabapay.provider_snapshots VALUES($1,$2,$3,'2026-11-19T12:00:00Z','2026-11-19T12:00:00Z','COMPLETE')",
        [randomUUID(),foreign.tenant,foreign.account]);
      const old=randomUUID(),current=randomUUID();
      for(const [i,id] of [old,current].entries()) await owner.query(`INSERT INTO nukhabapay.provider_offers VALUES
        ($1,$2,$3,$4,$5,$6,true,'2026-11-20T10:00:00Z',$7,23)`,[id,f.tenant,f.account,product,ids[i],mapping,9000+i*100]);
      const pool=new Pool({connectionString:target.href,max:1,connectionTimeoutMillis:3000});
      pools.push(pool);
      const service=new StaffCatalogueService({read:createStaffCatalogueReader(pool,new Map([[f.tenant,[
        {country:'AE',service:'DIGITAL_PIN',providerId:'synthetic',enabled:true}
      ]]])),authority:{require:async()=>({staffId:staff,tenantId:f.tenant,revalidate:async()=>true})},
        now:()=>new Date('2026-11-19T11:00:00Z'),audit:async()=>undefined});
      const result=await service.read({},f.tenant,'offers',{});
      assert.deepEqual(result.items.map(item=>item.id),[current]);
      assert.equal(result.items[0].providerCost,'91.23');
    });

    await t.test('bounded worker pool exhaustion does not reserve a job or block recovery',async()=>{
      const f=await schedule();
      const limited=new Pool({connectionString:target.href,max:1,connectionTimeoutMillis:500});
      pools.push(limited);
      const other=createCatalogueRefreshStore(limited,[f.tenant]);
      const occupying=await limited.connect();
      try {
        await assert.rejects(other.claim(0,10000));
        assert.equal(await row(f.id),undefined);
      } finally {occupying.release();}
      const claimed=await other.claim(0,10000);
      assert.ok(claimed);
      await other.settle(claimed,success,0);
      assert.equal((await row(f.id)).state,'SUCCEEDED');
    });

    await t.test('the fenced draft adapter commits exact draft evidence and rolls back after lease expiry',async()=>{
      // Dedicated projection fixture. The guarded 007 installer is not run here.
      await owner.query(`ALTER TABLE nukhabapay.products ADD COLUMN currency text, ADD COLUMN face_value_minor bigint;
        ALTER TABLE nukhabapay.provider_snapshots ADD COLUMN snapshot_key text, ADD COLUMN source_version text;
        ALTER TABLE nukhabapay.provider_offers ADD COLUMN provider_offer_key text;
        CREATE VIEW nukhabapay.catalogue_publication_provider_snapshots WITH(security_barrier=true) AS SELECT *
          FROM nukhabapay.provider_snapshots WHERE tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true);
        CREATE VIEW nukhabapay.catalogue_publication_provider_offers WITH(security_barrier=true) AS SELECT *
          FROM nukhabapay.provider_offers WHERE tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true);
        CREATE VIEW nukhabapay.catalogue_publication_provider_accounts WITH(security_barrier=true) AS SELECT *
          FROM nukhabapay.provider_accounts WHERE tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true);
        CREATE TABLE nukhabapay.catalogue_publication_candidates(candidate_id text PRIMARY KEY,candidate_digest text UNIQUE,tenant_id uuid,product_id uuid,
          canonical_product_key text,price_version bigint,expected_previous_version bigint,currency text,base_amount_minor bigint,service_fee_minor bigint,
          tax_amount_minor bigint,total_amount_minor bigint,provider_cost_minor bigint,payment_fee_minor bigint,agent_commission_minor bigint,
          expected_contribution_minor bigint,pricing_policy_version text,rounding_policy text,selected_provider_id text,selected_offer_id text,
          selected_snapshot_id uuid,source_count int,evaluated_at timestamptz,valid_until timestamptz,UNIQUE(tenant_id,product_id,price_version),
          CHECK(total_amount_minor=base_amount_minor+service_fee_minor+tax_amount_minor));
        CREATE TABLE nukhabapay.catalogue_publication_sources(candidate_id text REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id),
          tenant_id uuid,product_id uuid,snapshot_id uuid,provider_account_id uuid,snapshot_key text,source_version text,observed_at timestamptz,completed_at timestamptz,source_status text);
        CREATE TABLE nukhabapay.catalogue_publication_requests(operation_id text PRIMARY KEY,tenant_id uuid,product_id uuid,idempotency_key uuid,
          candidate_id text REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id),candidate_digest text,outcome text,UNIQUE(tenant_id,product_id,idempotency_key));
        CREATE TABLE nukhabapay.catalogue_publication_events(event_id uuid PRIMARY KEY,operation_id text REFERENCES nukhabapay.catalogue_publication_requests(operation_id),
          candidate_id text,tenant_id uuid,product_id uuid,price_version bigint,candidate_digest text,event_name text,occurred_at timestamptz);
        CREATE ROLE refresh_draft_writer LOGIN NOINHERIT;
        GRANT USAGE ON SCHEMA nukhabapay TO refresh_draft_writer;
        GRANT SELECT(tenant_id,id,status) ON nukhabapay.provider_accounts TO refresh_draft_writer;
        GRANT SELECT ON nukhabapay.catalogue_refresh_schedules,nukhabapay.catalogue_refresh_jobs,nukhabapay.catalogue_refresh_dispositions,nukhabapay.products,
          nukhabapay.catalogue_publication_provider_snapshots,nukhabapay.catalogue_publication_provider_offers,
          nukhabapay.catalogue_publication_provider_accounts TO refresh_draft_writer;
        GRANT INSERT ON nukhabapay.catalogue_refresh_write_evidence TO refresh_draft_writer;
        DO $role$ DECLARE name text; BEGIN
          FOREACH name IN ARRAY ARRAY['candidates','sources','requests','events'] LOOP
            EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY','catalogue_publication_'||name);
            EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY','catalogue_publication_'||name);
            EXECUTE format('CREATE POLICY scoped_draft ON nukhabapay.%I USING(tenant_id::text=current_setting(''nukhabapay.publication_tenant_id'',true)) WITH CHECK(tenant_id::text=current_setting(''nukhabapay.publication_tenant_id'',true))','catalogue_publication_'||name);
            EXECUTE format('GRANT SELECT,INSERT ON nukhabapay.%I TO refresh_draft_writer','catalogue_publication_'||name);
          END LOOP;
        END $role$;
        CREATE FUNCTION nukhabapay.delay_fixture_draft() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.canonical_product_key='draft-expired' THEN PERFORM pg_sleep(1.4); END IF; RETURN NEW; END $$;
        CREATE TRIGGER delay_fixture_draft BEFORE INSERT ON nukhabapay.catalogue_publication_candidates
          FOR EACH ROW EXECUTE FUNCTION nukhabapay.delay_fixture_draft()`);
      const writer=new URL(target);writer.username='refresh_draft_writer';
      const pool=new Pool({connectionString:writer.href,max:1});
      pools.push(pool);
      const drafts=createRefreshFencedDraftWriter(pool);
      for (const mode of ['commit','expired','old-source']) {
        const f=await schedule(), store=db(f.tenant), productId=randomUUID(), snapshotId=randomUUID();
        const observedAt=new Date(Date.now()-2000).toISOString(),completedAt=new Date(Date.now()-1000).toISOString();
        const validUntil=new Date(Date.now()+600000).toISOString();
        const product={canonicalProductId:'draft-'+mode,brand:'Synthetic',redemptionCountry:'AE',currency:'AED',faceValueMinor:10000n,
          fulfillmentMethod:'DIGITAL_PIN',termsVersion:'v1'};
        await owner.query("INSERT INTO nukhabapay.products VALUES($1,$2,'AE','DIGITAL_PIN','AED',10000)",[productId,product.canonicalProductId]);
        await owner.query("INSERT INTO nukhabapay.provider_snapshots VALUES($1,$2,$3,$4,$5,'COMPLETE','scheduled-draft','v1')",
          [snapshotId,f.tenant,f.account,observedAt,completedAt]);
        await owner.query("INSERT INTO nukhabapay.provider_offers VALUES($1,$2,$3,$4,$5,$6,true,$7,9600,0,'fixture-offer')",
          [randomUUID(),f.tenant,f.account,productId,snapshotId,randomUUID(),validUntil]);
        if (mode==='old-source') await owner.query("INSERT INTO nukhabapay.provider_snapshots VALUES($1,$2,$3,clock_timestamp(),clock_timestamp(),'COMPLETE','newer-draft','v1')",
          [randomUUID(),f.tenant,f.account]);
        const candidate=generateDraftPublicationCandidate({tenantId:f.tenant,productId,product,
          sourceSnapshots:[{snapshotId,providerAccountId:f.account,snapshotKey:'scheduled-draft',sourceVersion:'v1',observedAt,completedAt,status:'COMPLETE'}],
          offers:[{providerId:'synthetic',offerId:'fixture-offer',snapshotId,identity:product,mappingStatus:'APPROVED',providerDebitMinor:9600n,
            upfrontDiscountMinor:400n,additionalProviderFeeMinor:0n,available:true,eligible:true,observedAt,validUntil}],
          evaluatedAt:completedAt,expectedPreviousVersion:0,idempotencyKey:randomUUID(),
          pricingPolicy:{version:'v1',serviceFeeMinor:200n,maximumServiceFeeMinor:200n,taxAmountMinor:0n,paymentFeeBasisPoints:150,
            paymentFixedFeeMinor:20n,agentCommissionMinor:50n,minimumContributionMinor:100n,maximumOfferAgeMs:86400000}});
        const claim=await store.claim(0,mode==='expired'?1200:12000);
        assert.ok(claim);
        if (mode==='commit') {
          assert.equal((await drafts.saveFenced(candidate,claim)).outcome,'CREATED');
          assert.equal((await drafts.saveFenced(candidate,claim)).outcome,'REPLAYED');
          assert.equal((await owner.query('SELECT total_amount_minor FROM nukhabapay.catalogue_publication_candidates WHERE candidate_id=$1',
            [candidate.candidateId])).rows[0].total_amount_minor,'10200');
        } else {
          await assert.rejects(drafts.saveFenced(candidate,claim),mode==='expired'?{code:'42501'}:/Selected provider evidence mismatch/);
        }
        assert.equal((await owner.query('SELECT count(*)::int AS count FROM nukhabapay.catalogue_publication_events WHERE tenant_id=$1',[f.tenant])).rows[0].count,
          mode==='commit'?1:0);
      }
      await assert.rejects(pool.query('UPDATE nukhabapay.catalogue_publication_candidates SET total_amount_minor=0'),{code:'42501'});
    });
  }finally{
    await Promise.all(pools.map(pool=>pool.end()));await owner.end();
  }
});
