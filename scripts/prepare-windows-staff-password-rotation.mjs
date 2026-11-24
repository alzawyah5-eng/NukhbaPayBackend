import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {archiveInfo,candidate,insist,pilotIssuer,root} from './windows-staff-migration.mjs';
import {guardedBlock,targetChecks,installedChecks} from './windows-staff-install-sql.mjs';

const backup=archiveInfo(),bundle=await candidate();
const report=JSON.parse(readFileSync(path.join(root,'.local/windows-staff-rehearsal.json'),'utf8'));
insist(report.status==='passed' && report.candidateHash===bundle.candidateHash && report.backupHash===backup.sha256 &&
  report.sourceDatabaseOid===backup.databaseOid && report.sourceCluster===backup.systemIdentifier,'Qualification mismatch');
const pin={port:5432,databaseOid:backup.databaseOid,systemIdentifier:backup.systemIdentifier,directory:process.env.NUKHBAPAY_REGISTERED_PG_DIRECTORY};
const roles="('nukhabapay_identity_reader','nukhabapay_identity_writer')";
const sql=[
  '\\set ON_ERROR_STOP on','\\set ECHO none','BEGIN;','SET LOCAL search_path=pg_catalog;',
  "SET LOCAL lock_timeout='5s';","SET LOCAL password_encryption='scram-sha-256';",
  "SELECT pg_advisory_xact_lock(hashtextextended('nukhbapay_staff.iam_password_rotation',0));",
  guardedBlock(targetChecks(pin,false)+'\n'+installedChecks(bundle.candidateHash,backup.sha256,pilotIssuer)),
  guardedBlock(`IF EXISTS(SELECT FROM pg_authid WHERE rolname IN ${roles} AND rolvaliduntil <= clock_timestamp()) THEN
    RAISE EXCEPTION 'IAM credential expired; review its expiry separately'; END IF;`),
  `CREATE TEMP TABLE rotation_before ON COMMIT DROP AS SELECT oid, md5(rolpassword) AS previous FROM pg_authid WHERE rolname IN ${roles};`,
  '\\password nukhabapay_identity_reader','\\password nukhabapay_identity_writer',
  guardedBlock(`IF (SELECT count(*) FROM pg_authid r JOIN pg_temp.rotation_before b ON b.oid=r.oid WHERE rolname IN ${roles}
    AND rolpassword LIKE 'SCRAM-SHA-256$%' AND md5(rolpassword) IS DISTINCT FROM b.previous) <> 2 THEN
    RAISE EXCEPTION 'Both credentials must be set in the same transaction'; END IF;`),
  'COMMIT;','\\echo Reader and writer password rotation committed.',''
].join('\n');
const file=path.join(mkdtempSync(path.join(root,'.local','windows-iam-rotation-')),'rotate.psql');
writeFileSync(file,sql,{flag:'wx'});console.log(file);
