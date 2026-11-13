
import { parseDatabaseConfig } from './dist-test/src/config.js';
const urls = {
  DB_MIGRATION_URL: 'postgresql://nukhabapay_migrator:migrator_password@127.0.0.1:5432/nukhabapay_dev',
  DB_RUNTIME_URL: 'postgresql://nukhabapay_runtime:runtime_password@127.0.0.1:5432/nukhabapay_dev',
  DB_IMPORT_URL: 'postgresql://nukhabapay_importer:importer_password@127.0.0.1:5432/nukhabapay_dev',
  DB_RUNTIME_ROLE: 'nukhabapay_runtime',
  DB_IMPORT_ROLE: 'nukhabapay_importer',
};
const cases = [
  ['migration external host', { ...urls, DB_MIGRATION_URL: urls.DB_MIGRATION_URL.replace('127.0.0.1', 'db.example.com') }],
  ['http protocol', { ...urls, DB_MIGRATION_URL: urls.DB_MIGRATION_URL.replace('postgresql:', 'http:') }],
  ['missing password', { ...urls, DB_MIGRATION_URL: urls.DB_MIGRATION_URL.replace(':migrator_password', '') }],
  ['query param', { ...urls, DB_MIGRATION_URL: `${urls.DB_MIGRATION_URL}?sslmode=disable` }],
  ['other database', { ...urls, DB_MIGRATION_URL: urls.DB_MIGRATION_URL.replace('nukhabapay_dev', 'other_db') }],
  ['same import url as runtime', { ...urls, DB_IMPORT_URL: urls.DB_RUNTIME_URL }],
  ['runtime role mismatch', { ...urls, DB_RUNTIME_URL: urls.DB_RUNTIME_URL.replace('nukhabapay_runtime', 'nukhabapay_migrator') }],
  ['runtime role env mismatch', { ...urls, DB_RUNTIME_ROLE: 'other_role' }],
  ['pool max too high', { ...urls, DB_POOL_MAX: '21' }],
  ['non numeric timeout', { ...urls, DB_QUERY_TIMEOUT_MS: '5s' }],
  ['timeout equality', { ...urls, DB_QUERY_TIMEOUT_MS: '1000', DB_STATEMENT_TIMEOUT_MS: '1000' }],
];
for (const [label, env] of cases) {
  try { parseDatabaseConfig(env); console.log('PASS', label); }
  catch (e) { console.log('THROW', label, e.name, e.message); }
}
