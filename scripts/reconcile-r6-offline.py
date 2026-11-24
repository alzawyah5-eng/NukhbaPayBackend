"""Build an R6 review input without mutating the candidate worktree."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

MAIN = Path(__file__).resolve().parent.parent
WORKSPACE = MAIN.parent
BRICK = WORKSPACE / "nukhabapay-worktrees" / "brick4-platform"
RECORDS = WORKSPACE / "recovery-checkpoints"
HISTORY = RECORDS / "master-continuation-20261119"
PHASES = RECORDS / "master-development-20261119"


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def pin(root, name):
    path = (root / name).resolve(strict=True)
    path.relative_to(root.resolve())
    data = path.read_bytes()
    return {"path": name, "bytes": len(data), "sha256": digest(data)}


def same_pin(actual, expected):
    return all(actual[key] == expected[key] for key in ("sha256", "bytes"))


governance = load(BRICK / "docs/security/owner-review/current-brick4-review-governance.json")
candidate = governance["candidate"]
if not same_pin(pin(BRICK, candidate["path"]), candidate):
    raise SystemExit("Archived candidate digest changed")
r6 = load(BRICK / candidate["path"])
archived = {item["source"]: item for item in r6["snapshotPins"]}
if not all(same_pin(pin(BRICK, item["path"]), item) for item in r6["snapshotPins"]):
    raise SystemExit("Archive drift")

before = {item["path"]: pin(BRICK, item["path"]) for item in r6["sourceSqlCompiledExecutableAndTestPins"]}
previous = load(HISTORY / "r6-integrity-check.json")
history = {item["path"]: item["sha256"] for item in load(PHASES / "final-main-files.json")["files"]}
history.update({item["path"]: item["after"] for item in load(PHASES / "phase3-integration.json")["files"]})
baseline = {item["path"]: item["sha256"] for item in load(HISTORY / "baseline-files.json")}
output = MAIN / ".local" / f"r6-reconciliation-{time.time_ns()}"
output.mkdir(parents=True)
builds = []
repeat = output / "repeat"
repeat.mkdir()
for destination in (output, repeat):
    for package in ("application", "database"):
        for kind, config in (("dist", "tsconfig.json"), ("dist-test", "tsconfig.test.json")):
            folder = f"packages/{package}"
            dest = destination / folder / kind
            # The compiler reads the existing project and installed dependencies. All emits
            # go under the evidence directory, including any build-info file if configured.
            args = ["node", f"{folder}/node_modules/typescript/bin/tsc", "-p",
                    f"{folder}/{config}", "--outDir", str(dest), "--incremental", "false"]
            env = {key: value for key, value in os.environ.items()
                   if key.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATHEXT"}}
            result = subprocess.run(args, cwd=BRICK, env=env, capture_output=True, timeout=120)
            (destination / f"{package}-{kind}.log").write_bytes(result.stdout + result.stderr)
            builds.append({"root": destination.name, "package": package, "target": kind, "exitCode": result.returncode})
            if result.returncode:
                raise SystemExit(f"Isolated compile failed. Evidence: {output}")


def comparable_output(path):
    data = path.read_bytes()
    if path.suffix != ".map":
        return data
    # Source-map relative paths change with outDir. Compare their resolved locations.
    parsed = json.loads(data)
    parsed["sources"] = [str((path.parent / source).resolve()).lower() for source in parsed["sources"]]
    return json.dumps(parsed, sort_keys=True).encode()


def emitted_paths(directory):
    return {p.relative_to(directory).as_posix() for p in (directory / "packages").rglob("*") if p.is_file()}


paths = emitted_paths(output)
if paths != emitted_paths(repeat) or any(
    comparable_output(output / name) != comparable_output(repeat / name) for name in paths
):
    raise SystemExit("Isolated rebuilds disagree")

prior_path = MAIN / ".local/r6-reconciliation-1795100333937237100/manifest.json"
prior = load(prior_path)
if digest(prior_path.read_bytes()) != "ab706d1ddcf18efceec238d7043c809b789434191b5803a12744af371f03542b":
    raise SystemExit("Prior reconciliation manifest digest changed")
staged = {entry["path"]: entry for entry in prior["reviewInputPins"]["isolatedRebuild"]}
if set(staged) != paths or any(
    not same_pin(pin(prior_path.parent, name), staged[name]) or
    comparable_output(prior_path.parent / name) != comparable_output(output / name) for name in paths
):
    raise SystemExit("Prior staged output and rebuilt output disagree")

probe = subprocess.run(["node", "--test", str(MAIN / "scripts/test/r6-staged-expiry.test.mjs")],
    env={**env, "NUKHBA_R6_STAGED_ROOT": str(output)}, capture_output=True, timeout=30)
(output / "compiled-expiry.log").write_bytes(probe.stdout + probe.stderr)
if probe.returncode:
    raise SystemExit(f"Compiled expiry tests failed. Evidence: {output}")


reasons = {
    "published-catalogue.ts": "Destination/service/search filters and signed expiry after binding lookup",
    "staff-session.ts": "Immediate local logout/rotation denial and expired-binding cleanup",
    "trusted-staff-actor.ts": "Sanitized fixed-category audit for failed admission",
    "index.ts": "Scheduled refresh exports",
    "staff-session.test.ts": "Regression coverage for logout races and expiry cleanup",
    "catalogue-publication-draft-store.ts": "Pool startup and rollback cleanup",
    "config.ts": "Same-target port validation",
    "staff-identity-repository.ts": "BEGIN included in the rollback and release guard",
    "config.spec.ts": "Cross-port rejection and default-port tests",
}
rows = []
current = []
changed = set()
for expected in r6["sourceSqlCompiledExecutableAndTestPins"]:
    name = expected["path"]
    actual = pin(BRICK, name)
    if actual != before[name]:
        raise SystemExit(f"Worktree changed during evidence capture: {name}")
    current.append(actual)
    if not same_pin(actual, expected):
        changed.add(name)
    if name not in previous["sourceMismatches"] and same_pin(actual, expected):
        continue
    source = BRICK / name
    rebuilt = output / name
    entry = {"path": name, "archived": expected, "worktree": actual,
             "mainMatches": (MAIN / name).is_file() and pin(MAIN, name)["sha256"] == actual["sha256"]}
    if rebuilt.is_file():
        entry["isolatedBuild"] = pin(output, name)
        same = comparable_output(source) == comparable_output(rebuilt)
        entry["status"] = "REPRODUCIBLE_GENERATED_OUTPUT" if same else "STALE_OR_UNEXPLAINED_BUILD_OUTPUT"
        entry["candidateUses"] = "ISOLATED_REBUILD"
    elif Path(name).suffix == ".ts" and (actual["sha256"] in (history.get(name), baseline.get(name)) or entry["mainMatches"]):
        entry["status"] = "DOCUMENTED_DEVELOPMENT_CHANGE"
        entry["reason"] = reasons.get(source.name, "Matches prior development evidence")
        entry["candidateUses"] = "CURRENT_SOURCE"
    else:
        entry["status"] = "UNEXPECTED_REQUIRES_REVIEW"
        entry["candidateUses"] = "NONE"
    rows.append(entry)

# Changed source/export dependencies and rebuilt outputs may extend older pin coverage.
# Pin the entire isolated emit, not just the 29 historically drifting files.
rebuilt_pins = [pin(output, p.relative_to(output).as_posix()) for p in sorted((output / "packages").rglob("*")) if p.is_file()]
rebuilt_paths = {p["path"] for p in rebuilt_pins}
dependency_pins = [pin(BRICK, name) for name in (
    "packages/application/src/catalog/refresh-schedule.ts",
    "packages/application/test/refresh-schedule.test.ts",
    "packages/provider-contracts/src/catalog-provider.ts",
) if (BRICK / name).is_file()]
if changed != set(previous["sourceMismatches"]):
    raise SystemExit("Current drift paths differ from original evidence")
counts = {status: sum(row["status"] == status for row in rows) for status in {
    "DOCUMENTED_DEVELOPMENT_CHANGE", "REPRODUCIBLE_GENERATED_OUTPUT", "STALE_OR_UNEXPLAINED_BUILD_OUTPUT"
}}
if counts != {"DOCUMENTED_DEVELOPMENT_CHANGE": 9, "REPRODUCIBLE_GENERATED_OUTPUT": 18,
              "STALE_OR_UNEXPLAINED_BUILD_OUTPUT": 2}:
    raise SystemExit("Drift classification changed")
if {row["path"] for row in rows if row["status"] == "STALE_OR_UNEXPLAINED_BUILD_OUTPUT"} != {
    "packages/application/dist/application/src/catalog/published-catalogue.js",
    "packages/application/dist/application/src/catalog/published-catalogue.js.map",
}:
    raise SystemExit("Unexpected stale outputs")
report = {
    "status": "TECHNICALLY_REPRODUCED_OFFLINE",
    "compiledExpiryTests": 2,
    "priorStageVerifiedFiles": len(staged),
    "repeatedBuildFiles": len(paths),
    "executionAuthorization": "NOT_GRANTED",
    "historicalCandidate": candidate,
    "archivedSnapshotPinsVerified": len(archived),
    "currentPinCount": len(current),
    "currentDriftCount": len(changed),
    "originalDriftCount": len(previous["sourceMismatches"]),
    "drift": rows,
    "isolatedBuilds": builds,
    "reviewInputPins": {"worktree": [p for p in current if p["path"] not in rebuilt_paths],
                        "isolatedRebuild": rebuilt_pins, "addedDependencies": dependency_pins,
                        "requiredExecutables": r6["executablePins"]},
    "protectedTiming": r6["timing"],
    "remainingOriginalGates": r6["mandatoryPending"],
    "runtimeChecks": "NOT_RUN",
}
(output / "manifest.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"manifest": str(output / "manifest.json"), "status": report["status"],
                  "drift": len(changed), "archiveVerified": len(archived),
                  "classifications": {status: sum(row["status"] == status for row in rows)
                                      for status in sorted({row["status"] for row in rows})}}))
