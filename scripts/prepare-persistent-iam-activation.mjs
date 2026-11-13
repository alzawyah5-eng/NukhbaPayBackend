// Review wrapper only. Deliberately imports no PostgreSQL client or migration runner.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifiedMigrationSources } from './rehearse-reviewed-migrations.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function preparePersistentIamActivation(sourceRoot=root) {
  const {manifest}=verifiedMigrationSources(sourceRoot);
  return Object.freeze({
    status:'BLOCKED_PENDING_SEPARATE_APPROVAL_AND_SOURCE_TRANSITION',
    target:'127.0.0.1:5432/nukhabapay_dev',
    owner:'nukhabapay_migrator',
    manifestSha256:createHash('sha256').update(readFileSync(path.join(sourceRoot,'packages/database/migration-manifest.json'))).digest('hex'),
    sources:manifest.files,
    sequence:['004_staff_identity_foundation','005_staff_workflow_persistence','006_staff_server_sessions'],
    contract:'docs/runbooks/database-security-operator-review.md',
    executable:false,
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv.length!==3||process.argv[2]!=='--prepare')throw new Error();
    console.info(JSON.stringify(preparePersistentIamActivation(),null,2));
  } catch {console.error('Persistent IAM activation preparation rejected');process.exitCode=1;}
}
