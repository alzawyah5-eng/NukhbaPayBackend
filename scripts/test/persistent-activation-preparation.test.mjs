import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { preparePersistentIamActivation } from '../prepare-persistent-iam-activation.mjs';
import { verifyPersistentTargetEvidence } from '../persistent-development-iam.mjs';

test('preparation binds frozen sources and has no execution capability',()=>{
  const plan=preparePersistentIamActivation();
  assert.equal(plan.executable,false);
  assert.equal(plan.manifestSha256,'7ae4f427e640360813edf4b3007f1c2a1a02b74b384e76558dd1358cb4359666');
  assert.equal(plan.sequence.length,3);
  for(const argument of ['--apply','--down','--fake','--preflight']) {
    const result=spawnSync(process.execPath,['scripts/prepare-persistent-iam-activation.mjs',argument],{encoding:'utf8'});
    assert.equal(result.status,1);
    assert.match(result.stderr,/rejected/);
  }
});

test('target identity drift stops evidence collection before any further query',async()=>{
  const valid={database:'nukhabapay_dev',role:'nukhabapay_migrator',host:'127.0.0.1',port:5432,
    database_oid:'24576',system_identifier:'7000000000000000001',owner:'nukhabapay_migrator',
    server_version_num:170011,password_encryption:'scram-sha-256',unsafe:false,membership:false};
  const config={database:valid.database,expectedDatabaseOid:valid.database_oid,expectedSystemIdentifier:valid.system_identifier};
  for(const [key,value] of Object.entries({database:'postgres',role:'postgres',host:'::1',port:5433,
    database_oid:'24577',system_identifier:'7000000000000000002',owner:'postgres',
    server_version_num:180000,password_encryption:'md5',unsafe:true,membership:true})) {
    let calls=0;
    await assert.rejects(()=>verifyPersistentTargetEvidence({query:async()=>{calls++;return {rows:[{...valid,[key]:value}]};}},config),/rejected/);
    assert.equal(calls,1,key);
  }
});
