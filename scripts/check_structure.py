#!/usr/bin/env python3
"""Lightweight scaffold checks, not a compiler, API test or security assessment."""
from pathlib import Path
import json
import re
import sys
import subprocess

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = [
    "README.md", "ARCHITECTURE.md", "package.json", "pnpm-workspace.yaml",
    "apps/api/src/modules/quotes/README.md",
    "apps/worker/src/jobs/catalog-sync/README.md",
    "apps/ai-service/src/nukhbapay_ai/matching/guard.py",
    "apps/admin-web/README.md", "apps/kiosk-client/README.md", "apps/mobile/README.md",
    "packages/domain/src/pricing.ts", "packages/application/README.md",
    "packages/provider-contracts/src/catalog-provider.ts",
    "packages/provider-adapters/src/mock-provider.ts",
    "packages/database/migrations/README.md",
    "packages/contracts/public/quote.schema.json",
    "infra/local/compose.yaml", "docs/data-model.md", "docs/build-sequence.md",
]
errors = []
# Project names are coordinated workspace identifiers, not database role names.
workspace_packages = [ROOT / "package.json", ROOT / "apps/api/package.json",
                      ROOT / "apps/worker/package.json", ROOT / "apps/admin-web/package.json",
                      *sorted((ROOT / "packages").glob("*/package.json"))]
for manifest in workspace_packages:
    package = json.loads(manifest.read_text())
    expected = "nukhbapay" if manifest.parent == ROOT else f"@nukhbapay/{manifest.parent.name}"
    if package.get("name") != expected:
        errors.append(f"Unexpected project package name: {manifest.relative_to(ROOT)}")
    for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        if any(name.startswith("@nukhabapay/") for name in package.get(section, {})):
            errors.append(f"Legacy workspace dependency: {manifest.relative_to(ROOT)}")
for relative in REQUIRED:
    if not (ROOT / relative).is_file():
        errors.append(f"Missing required file: {relative}")

json_count = 0
for path in ROOT.rglob("*.json"):
    if any(part in {"node_modules", "__pycache__"} for part in path.parts):
        continue
    try:
        json.loads(path.read_text())
        json_count += 1
    except (ValueError, OSError) as exc:
        errors.append(f"Invalid JSON {path.relative_to(ROOT)}: {exc}")

private_fields = {
    "provider_cost", "provider_debit", "expected_contribution", "internal_trace",
    "provider_credentials", "agent_commission", "upfront_discount_already_netted"
}
for path in (ROOT / "packages/contracts/public").glob("*.json"):
    schema = json.loads(path.read_text())
    if schema.get("additionalProperties") is not False:
        errors.append(f"Public schema permits unspecified fields: {path.name}")
    overlap = private_fields & set(schema.get("properties", {}))
    if overlap:
        errors.append(f"Private fields in public schema {path.name}: {sorted(overlap)}")

# These checks detect selected obvious relative/package import violations only.
for path in (ROOT / "packages").rglob("*.ts"):
    if any(part in {"node_modules", "__pycache__", "dist", "dist-test"} for part in path.parts):
        continue
    if "/test/" in path.as_posix():
        continue
    text = path.read_text()
    imports = re.findall(r"""from\s+["']([^"']+)["']""", text)
    if any("/apps/" in value or value.startswith(("@nukhbapay/api", "@nukhabapay/api")) for value in imports):
        errors.append(f"Backend package imports an app: {path.relative_to(ROOT)}")
    if "/domain/src/" in path.as_posix():
        forbidden = ("@nestjs/", "fastapi", "redis", "provider-adapters", "/database/", "node:http", "node:fs")
        if any(any(item in value for item in forbidden) for value in imports):
            errors.append(f"Domain imports infrastructure: {path.relative_to(ROOT)}")

# admin-web contains a trusted Node BFF and an untrusted browser client. Its
# compiler-parsed, transitive graph is checked separately; no basename exemptions.
boundary = subprocess.run(
    ["node", str(ROOT / "scripts/browser-boundary.mjs")],
    cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
)
if boundary.returncode:
    errors.append("Browser/BFF boundary rejected:\n" + boundary.stderr.strip())

for client in ["mobile", "kiosk-client"]:
    for path in (ROOT / "apps" / client).rglob("*"):
        if any(part in {"node_modules", "__pycache__", "dist", "dist-test"} for part in path.parts):
            continue
        if path.suffix not in {".ts", ".tsx", ".js", ".jsx"}:
            continue
        text = path.read_text()
        for forbidden in [f"@{scope}/{package}" for scope in ("nukhbapay", "nukhabapay")
                          for package in ("domain", "database", "provider-adapters", "application")]:
            if forbidden in text:
                errors.append(f"Client imports backend package: {path.relative_to(ROOT)}")

if errors:
    print("\n".join(errors))
    sys.exit(1)
print(f"Scaffold structure, {json_count} JSON files, public-field separation and selected import checks passed.")
print("These checks do not establish production readiness or complete dependency/authorization enforcement.")
