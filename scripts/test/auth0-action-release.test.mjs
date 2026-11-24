import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { buildActionPackage, checkActionPackage, assessActionRelease, validateProtectedConfiguration } from '../auth0/action-release.mjs';
import { CONFIG_NAMES, SOURCE_SHA256, MANIFEST_SHA256, manifest, digest, sha256 } from '../auth0/security-contract.mjs';
import { evidence, bytesOf, optionsFor, binding, readDependency } from './fixtures/auth0-security-evidence.mjs';

const parent = fileURLToPath(new URL('../../.local/', import.meta.url));
async function ownedTest(run) {
  const dir = mkdtempSync(path.join(parent, 'auth0-release-test-'));
  try { return await run(dir); }
  finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(parent));
    assert.match(path.basename(dir), /^auth0-release-test-[a-zA-Z0-9]+$/);
    rmSync(dir, { recursive: true, force: false });
  }
}

test('offline Action packages preserve exact bytes/hashes/runtime and cannot overwrite a prior package', () => ownedTest(dir => {
  const first = path.join(dir, 'first'), second = path.join(dir, 'second');
  const report = buildActionPackage(first); buildActionPackage(second);
  assert.equal(report.status, 'VERIFIED'); assert.equal(report.deployable, false);
  assert.equal(report.sourceSha256, SOURCE_SHA256); assert.equal(report.artifactSha256, SOURCE_SHA256);
  assert.equal(report.manifestSha256, MANIFEST_SHA256); assert.equal(report.runtime, 'node22');
  for (const name of ['staff-human-principal.cjs', 'manifest.json', 'SHA256SUMS']) {
    assert.deepEqual(readFileSync(path.join(first, name)), readFileSync(path.join(second, name)));
  }
  assert.equal(checkActionPackage(first).status, 'VERIFIED');
  assert.throws(() => buildActionPackage(first));
  assert.throws(() => buildActionPackage(path.resolve(parent, '..', '..', 'outside-action-package')));
  assert.throws(() => { manifest.conditions.responseType.push('token'); });
}));

test('artifact, manifest, runtime, configuration-name and extra-file tampering cannot pass package checks', () => ownedTest(dir => {
  for (const [index, mutation] of [
    target => writeFileSync(path.join(target, 'staff-human-principal.cjs'), 'exports.onExecutePostLogin = () => {};'),
    target => writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({ ...manifest, runtime: 'node24' })),
    target => writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({ ...manifest, configurationNames: ['CLIENT_SECRET'] })),
    target => writeFileSync(path.join(target, 'SHA256SUMS'), 'unreviewed'),
    target => writeFileSync(path.join(target, 'unreviewed.json'), '{}'),
  ].entries()) {
    const target = path.join(dir, 'case-' + index); buildActionPackage(target); mutation(target);
    assert.equal(checkActionPackage(target).status, 'FAILED');
  }
}));

test('protected configuration validates exact names, identifier mappings and audience syntax without reflecting values', () => {
  const values = Object.fromEntries(CONFIG_NAMES.map((name, index) => [name,
    ['synthetic-staff-client', 'con_synthetic_staff', 'urn:nukhbapay:synthetic:staff'][index]]));
  const expected = Object.fromEntries(CONFIG_NAMES.map(name => [name, sha256(values[name])]));
  assert.equal(validateProtectedConfiguration(values, expected).status, 'VERIFIED');
  for (const change of [
    { ...values, [CONFIG_NAMES[0]]: 'other-synthetic-client' }, { ...values, [CONFIG_NAMES[1]]: '' },
    { ...values, [CONFIG_NAMES[2]]: 'https://user:synthetic-private@api.invalid/' },
    { ...values, [CONFIG_NAMES[2]]: 'https://api.invalid/#synthetic-private' },
    { ...values, CLIENT_SECRET: 'synthetic-private-do-not-reflect' }, {},
  ]) {
    const report = validateProtectedConfiguration(change, expected);
    assert.equal(report.status, 'FAILED'); assert.equal(JSON.stringify(report).includes('synthetic-private'), false);
  }
});

test('safe binding plan preserves every reviewed binding and the exact empty-state rollback, without apply authority', () => ownedTest(dir => {
  const target = path.join(dir, 'package'); buildActionPackage(target);
  const value = evidence(); value.sections.actions.bindings.push(binding());
  const previous = Buffer.from('// previously reviewed synthetic Action version\n');
  value.sections.rollback.previousVersion = { kind: 'VERSION', sourceSha256: sha256(previous), versionRef: 'PREVIOUS_VERSION_A', artifactPreserved: true };
  value.sections.rollback.bindingsSnapshotSha256 = digest(value.sections.actions.bindings);
  value.sections.release.bindingsSnapshotSha256 = digest(value.sections.actions.bindings);
  let bytes = bytesOf(value), report = assessActionRelease(target, bytes, optionsFor(bytes), previous);
  assert.equal(report.status, 'VERIFIED'); assert.equal(report.readyForOperatorReview, true);
  assert.equal(report.plan.before.length, 1); assert.equal(report.plan.append.position, 1);
  assert.equal(report.plan.before[0].bindingRef, digest(binding()));
  assert.equal(report.plan.rollback.restoreSnapshotSha256, value.sections.rollback.bindingsSnapshotSha256);
  assert.equal(report.plan.applyAllowed, false); assert.equal(report.deployable, false);
  assert.equal(assessActionRelease(target, bytes, optionsFor(bytes)).status, 'UNKNOWN');
  assert.equal(assessActionRelease(target, bytes, optionsFor(bytes), Buffer.from('changed')).status, 'FAILED');
  value.sections.actions.bindings[0].sourceSha256 = 'd'.repeat(64); bytes = bytesOf(value);
  report = assessActionRelease(target, bytes, optionsFor(bytes), previous);
  assert.equal(report.status, 'FAILED'); assert.equal(report.plan, null);
}));

test('initial empty binding, missing evidence, unsafe prior-state and principal writer collision remain fail closed', () => ownedTest(dir => {
  const target = path.join(dir, 'package'); buildActionPackage(target);
  const value = evidence(), bytes = bytesOf(value);
  const good = assessActionRelease(target, bytes, optionsFor(bytes));
  assert.equal(good.status, 'VERIFIED'); assert.equal(good.plan.append.position, 0);
  assert.equal(good.plan.rollback.previousVersionKind, 'EMPTY');
  assert.equal(assessActionRelease(target, bytes).status, 'UNKNOWN');
  for (const mutate of [
    v => { v.sections.actions.bindings = [{ ...binding(), principalWriter: true }]; },
    v => { v.sections.rollback.priorBindingsPreserved = false; },
    v => { v.sections.rollback.previousVersion.artifactPreserved = false; },
    v => { v.sections.release.mappingApproved = false; },
    v => { v.sections.release.manifestSha256 = 'e'.repeat(64); },
    v => { v.sections.release.runtime = 'UNKNOWN'; },
  ]) {
    const next = evidence(); mutate(next); const input = bytesOf(next);
    const report = assessActionRelease(target, input, optionsFor(input));
    assert.notEqual(report.status, 'VERIFIED'); assert.equal(report.plan, null); assert.equal(report.deployable, false);
  }
}));

test('an unchanged valid Action package cannot bypass administrative grant capability blockers', () => ownedTest(dir => {
  const target = path.join(dir, 'package'); buildActionPackage(target);
  for (const scope of ['create:client_grants', 'update:client_grants', 'update:clients', 'update:client_keys', 'update:client_credentials']) for (const type of ['user', 'client']) {
    const value = readDependency(evidence(), type), m = value.sections.management;
    m.applications[1][type + 'RequiredScopes'] = [scope]; m.applications[1].staffReach = 'NONE';
    m.grants[0].scopes = [scope];
    const bytes = bytesOf(value), report = assessActionRelease(target, bytes, optionsFor(bytes));
    assert.equal(report.gates.package.status, 'VERIFIED');
    assert.equal(report.gates.grantAdministration.status, 'FAILED');
    assert.equal(report.status, 'FAILED'); assert.equal(report.plan, null);
    assert.equal(report.readyForOperatorReview, false); assert.equal(report.deployable, false);
    assert.equal(report.authenticationAllowed, false);
  }
}));

test('packaged Action emits the human claim only for reviewed context and denies negative contexts without identity mutation', () => ownedTest(dir => {
  const target = path.join(dir, 'package'); buildActionPackage(target);
  const source = readFileSync(path.join(target, 'staff-human-principal.cjs'), 'utf8');
  assert.equal(sha256(source), SOURCE_SHA256);
  const context = vm.createContext({ exports: {}, URL }); vm.runInContext(source, context, { timeout: 1000 });
  const event = () => ({ secrets: { [CONFIG_NAMES[0]]: 'synthetic-client', [CONFIG_NAMES[1]]: 'con_synthetic', [CONFIG_NAMES[2]]: 'urn:synthetic:staff' },
    client: { client_id: 'synthetic-client' }, connection: { id: 'con_synthetic', strategy: 'auth0' }, user: { user_id: 'auth0|synthetic' },
    resource_server: { identifier: 'urn:synthetic:staff' }, transaction: { protocol: 'oidc-basic-profile', response_type: ['code'],
      response_mode: 'query', redirect_uri: 'https://localhost:3001/auth/callback', requested_scopes: ['openid'] } });
  const valid = event(), before = structuredClone(valid), claims = [], denials = [];
  const api = { access: { deny: reason => denials.push(reason) }, accessToken: { setCustomClaim: (...args) => claims.push(args) } };
  // No imports/network or management APIs exist in this exact-source sandbox.
  return Promise.resolve(context.exports.onExecutePostLogin(valid, api)).then(async () => {
    assert.deepEqual(valid, before); assert.deepEqual(claims, [[manifest.claim, 'human']]); assert.equal(denials.length, 0);
    for (const mutate of [e => { e.connection.strategy = 'google-oauth2'; }, e => { e.transaction.requested_scopes = ['openid', 'update:users']; },
      e => { e.user.user_id = 'synthetic@clients'; }, e => { e.resource_server.identifier = 'urn:other'; },
      e => { e.transaction.linking_id = 'unapproved-link'; }, e => { e.session = { actor: null }; }]) {
      claims.length = 0; denials.length = 0; const bad = event(); mutate(bad);
      await context.exports.onExecutePostLogin(bad, api);
      assert.equal(claims.length, 0); assert.equal(denials.length, 1);
    }
  });
}));
