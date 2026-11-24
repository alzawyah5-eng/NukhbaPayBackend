import assert from 'node:assert/strict';
import test from 'node:test';
import { installLocalCatalogueMigrations, loadLocalCatalogueMigrations } from '../local-catalogue-setup.mjs';

const foundation = await loadLocalCatalogueMigrations();
const next = { name: 'local_example_002', digest: 'a'.repeat(64), statements: ['CREATE TABLE nukhabapay.startup_example(id uuid PRIMARY KEY)'] };
const newer = { name: 'local_example_003', digest: 'b'.repeat(64), statements: ['ALTER TABLE nukhabapay.startup_example ADD COLUMN code text'] };
const source = [...foundation, next, newer];
const rows = migrations => migrations.map(({ name, digest }) => ({ name, source_sha256: digest }));

function client({ present = true, history = rows(foundation), failOn } = {}) {
  const calls = [];
  let committed = history;
  let working = history;
  return {
    calls,
    get history() { return committed; },
    async query(sql, params) {
      calls.push(sql);
      if (sql === failOn) throw new Error('migration failed');
      if (sql.startsWith('BEGIN')) working = [...committed];
      if (sql.startsWith('SELECT to_regnamespace')) return { rows: [{ present }] };
      if (sql.startsWith('SELECT name,source_sha256')) return { rows: working };
      if (sql.startsWith('INSERT INTO nukhabapay.local_catalogue_schema_history')) {
        working.push({ name: params[0], source_sha256: params[1] });
      }
      if (sql === 'COMMIT') { committed = working; return { command: 'COMMIT' }; }
      return { rows: [] };
    },
  };
}

test('first-time setup installs and records all registered migrations under one lock and transaction', async () => {
  const db = client({ present: false, history: [] });
  assert.deepEqual(await installLocalCatalogueMigrations(db, source, { initialise: true }), source.map(({ name }) => name));
  assert.match(db.calls[1], /pg_advisory_xact_lock/);
  assert.ok(db.calls.includes('CREATE SCHEMA nukhabapay'));
  assert.equal(db.calls.at(-1), 'COMMIT');
  assert.deepEqual(db.history, rows(source));
});

test('ordinary startup applies pending migrations once, in order', async () => {
  const db = client();
  assert.deepEqual(await installLocalCatalogueMigrations(db, source), [next.name, newer.name]);
  assert.deepEqual(await installLocalCatalogueMigrations(db, source), []);
  assert.ok(db.calls.indexOf(next.statements[0]) < db.calls.indexOf(newer.statements[0]));
  assert.equal(db.calls.filter(sql => sql === next.statements[0]).length, 1);
  assert.deepEqual(db.history, rows(source));
});

test('read-only preflight and incomplete setup block startup without changing schema', async () => {
  const db = client();
  await assert.rejects(installLocalCatalogueMigrations(db, source, { check: true }), /Pending catalogue migrations/);
  assert.equal(db.calls[0], 'BEGIN READ ONLY');
  assert.equal(db.calls.at(-1), 'ROLLBACK');
  assert.ok(!db.calls.includes(next.statements[0]));
  const missing = client({ present: false, history: [] });
  await assert.rejects(installLocalCatalogueMigrations(missing, source), /first-time setup/);
  assert.ok(!missing.calls.includes('CREATE SCHEMA nukhabapay'));
});

test('changed, incomplete and out-of-order histories fail before executing migrations', async () => {
  for (const history of [rows(foundation.slice(1)), rows([...foundation, newer]),
    [{ ...rows(foundation)[0], source_sha256: '0'.repeat(64) }, ...rows(foundation).slice(1)]]) {
    const db = client({ history });
    await assert.rejects(installLocalCatalogueMigrations(db, source), /history does not match/);
    assert.equal(db.calls.at(-1), 'ROLLBACK');
    assert.ok(!db.calls.includes(next.statements[0]));
  }
});

test('failure rolls back the entire pending migration batch', async () => {
  const db = client({ failOn: newer.statements[0] });
  await assert.rejects(installLocalCatalogueMigrations(db, source), /migration failed/);
  assert.ok(db.calls.includes(next.statements[0]));
  assert.equal(db.calls.at(-1), 'ROLLBACK');
  assert.ok(!db.calls.includes('COMMIT'));
  assert.deepEqual(db.history, rows(foundation));
});

test('rehearsal verifies the staged migration batch and rolls back instead of committing', async () => {
  const db = client();
  let qualified = false;
  const applied = await installLocalCatalogueMigrations(db, source, { rehearse: async pending => {
    assert.equal(pending, db);
    assert.ok(db.calls.includes(newer.statements[0]));
    qualified = true;
  } });
  assert.deepEqual(applied, [next.name, newer.name]);
  assert.equal(qualified, true);
  assert.equal(db.calls.at(-1), 'ROLLBACK');
  assert.ok(!db.calls.includes('COMMIT'));
  assert.deepEqual(db.history, rows(foundation));
});
