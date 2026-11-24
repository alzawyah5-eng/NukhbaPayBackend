import { readFileSync, writeFileSync, mkdirSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAIM, CONFIG_NAMES, SOURCE_SHA256, MANIFEST_SHA256, manifest, manifestBytes,
  sha256, digest, hash, object, result, check, safeReport, invalid } from './security-contract.mjs';
import { evaluateEvidence, parseEvidence, parseArguments, readEvidenceFile, reportExitCode } from './security-evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const artifactName = 'staff-human-principal.cjs';
const checksums = () => `${SOURCE_SHA256}  ${artifactName}\n${MANIFEST_SHA256}  manifest.json\n`;
const sourceBytes = () => readFileSync(new URL('./staff-human-principal.cjs', import.meta.url));

/** Public identifiers only, in memory. Neither input nor value-specific errors are ever returned. */
export function validateProtectedConfiguration(values, expectedDigests) {
  try {
    const text = x => typeof x === 'string' && x.length > 0 && !/[\s\u0000-\u001f\u007f]/.test(x);
    object(values, Object.fromEntries(CONFIG_NAMES.map((name, index) => [name, x => text(x) && x.length <= (index === 2 ? 512 : 128)])));
    object(expectedDigests, Object.fromEntries(CONFIG_NAMES.map(name => [name, hash])));
    const url = new URL(values[CONFIG_NAMES[2]]);
    const validAudience = ['https:', 'urn:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    return result([check(validAudience, 'PROTECTED_AUDIENCE_INVALID'),
      check(CONFIG_NAMES.every(name => sha256(values[name]) === expectedDigests[name]), 'PROTECTED_MAPPING_MISMATCH')]);
  } catch { return result([check(false, 'PROTECTED_CONFIGURATION_REJECTED')]); }
}

function insideWorkspace(destination) {
  const absolute = path.resolve(destination), relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw invalid();
  let current = path.dirname(absolute);
  while (true) {
    if (lstatSync(current).isSymbolicLink()) throw invalid();
    if (current === path.resolve(root)) break;
    const parent = path.dirname(current); if (parent === current) throw invalid(); current = parent;
  }
  return absolute;
}

/** Writes only a NEW local directory and deterministic, known-safe public artifacts. Never overwrites. */
export function buildActionPackage(destination) {
  const bytes = sourceBytes();
  if (sha256(bytes) !== SOURCE_SHA256) throw invalid();
  const directory = insideWorkspace(destination);
  mkdirSync(directory); // Must be new; a missing parent or existing target is rejected.
  writeFileSync(path.join(directory, artifactName), bytes, { flag: 'wx' });
  writeFileSync(path.join(directory, 'manifest.json'), manifestBytes(), { flag: 'wx' });
  writeFileSync(path.join(directory, 'SHA256SUMS'), checksums(), { flag: 'wx' });
  return { status: 'VERIFIED', sourceSha256: SOURCE_SHA256, artifactSha256: SOURCE_SHA256,
    manifestSha256: MANIFEST_SHA256, runtime: manifest.runtime, version: manifest.version,
    basis: 'OFFLINE_ARTIFACT_ONLY', deployable: false, authenticationAllowed: false };
}

export function checkActionPackage(directory) {
  try {
    const absolute = path.resolve(directory);
    if (!lstatSync(absolute).isDirectory() || lstatSync(absolute).isSymbolicLink()) throw invalid();
    const names = readdirSync(absolute).sort();
    if (JSON.stringify(names) !== JSON.stringify(['SHA256SUMS', 'manifest.json', artifactName].sort())) throw invalid();
    const bytes = name => readEvidenceFile(path.join(absolute, name));
    return result([check(sha256(bytes(artifactName)) === SOURCE_SHA256 && sha256(sourceBytes()) === SOURCE_SHA256, 'ACTION_SOURCE_CHANGED'),
      check(bytes('manifest.json').equals(manifestBytes()), 'MANIFEST_CHANGED'),
      check(bytes('SHA256SUMS').toString('utf8') === checksums(), 'CHECKSUMS_CHANGED')]);
  } catch { return result([check(false, 'PACKAGE_REJECTED')]); }
}

/** Produces a review plan only. No Auth0 SDK, network, binding executor or session exists here. */
export function assessActionRelease(directory, bytes, options = {}, previousArtifactBytes) {
  const evidence = evaluateEvidence(bytes, options);
  const gates = { ...evidence.gates, package: checkActionPackage(directory) };
  let plan = null;
  try {
    const s = parseEvidence(bytes).sections;
    const prior = s.rollback?.previousVersion;
    if (!prior || prior.kind === 'UNKNOWN') gates.previousArtifact = result([check(null, 'PRIOR_VERSION_UNKNOWN')]);
    else if (prior.kind === 'EMPTY') gates.previousArtifact = result([check(previousArtifactBytes === undefined, 'UNEXPECTED_PRIOR_ARTIFACT')]);
    else gates.previousArtifact = result([check(previousArtifactBytes === undefined ? null :
      sha256(previousArtifactBytes) === prior.sourceSha256, 'PRIOR_ARTIFACT_MISSING_OR_CHANGED')]);
    if (Object.values(gates).every(x => x.status === 'VERIFIED')) {
      const before = s.actions.bindings;
      // Hash references, not raw application/user identifiers. Keep every reviewed binding in order.
      plan = { before: before.map(x => ({ position: x.position, bindingRef: digest(x) })),
        append: { position: before.length, artifactSha256: SOURCE_SHA256 },
        beforeSnapshotSha256: digest(before),
        rollback: { restoreSnapshotSha256: s.rollback.bindingsSnapshotSha256,
          previousVersionKind: prior.kind, previousSourceSha256: prior.sourceSha256 },
        applyAllowed: false };
    }
  } catch { gates.releaseInput = result([check(false, 'RELEASE_INPUT_REJECTED')]); }
  return safeReport(gates, { readyForOperatorReview: plan !== null, plan });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let report;
  try {
    const args = parseArguments(process.argv.slice(2), ['--package', '--check', '--evidence', '--tenant-ref', '--approved-sha256', '--previous-artifact']);
    if (args['--package']) {
      if (Object.keys(args).length !== 1) throw invalid();
      report = buildActionPackage(args['--package']);
    } else {
      if (!args['--check'] || !args['--evidence']) throw invalid();
      report = assessActionRelease(args['--check'], readEvidenceFile(args['--evidence']), {
        expectedTenantRef: args['--tenant-ref'], approvedSha256: args['--approved-sha256'],
      }, args['--previous-artifact'] ? readEvidenceFile(args['--previous-artifact']) : undefined);
    }
  } catch { report = safeReport({ package: result([check(false, 'RELEASE_COMMAND_REJECTED')]) }); }
  console.info(JSON.stringify(report)); process.exitCode = reportExitCode(report);
}
