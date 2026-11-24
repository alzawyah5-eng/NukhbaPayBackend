"""Build a clean Linux qualification image and run existing guarded suites without host networking."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile

root = Path(__file__).resolve().parents[2]
docker = Path(os.environ["LOCALAPPDATA"]) / "Programs/DockerDesktop/resources/bin/docker.exe" if sys.platform == "win32" else "docker"
socket = "npipe:////./pipe/dockerDesktopLinuxEngine" if sys.platform == "win32" else "unix:///var/run/docker.sock"
engine = [str(docker), "--host", socket]
dockerfile = root / "infra/local/Dockerfile.qualification"
tag = "nukhbapay-guarded-qualification:local"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check-context", action="store_true", help="Validate the build input locally without contacting Docker")
args = parser.parse_args()

files = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=root).decode().split("\0")
allowed_roots = {
    "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml",
    "scripts/browser-boundary.mjs", "scripts/import-synthetic-catalog.ts",
    "scripts/rehearse-reviewed-migrations.mjs", "scripts/test/run-guarded-container-suites.mjs",
}
manifest_path = "packages/database/migration-manifest.json"
required = allowed_roots | {manifest_path, "apps/admin-web/client/index.html", "apps/api/package.json",
                            "packages/database/package.json"}
required |= set(json.loads((root / manifest_path).read_text(encoding="utf-8"))["files"])
package_source = re.compile(
    r"^(?:apps|packages)/[^/]+/(?:(?:src|test|client|migrations|pending-migrations|roles|fixtures)/.+"
    r"|(?:package\.json|tsconfig(?:\.[a-z]+)?\.json|nest-cli\.json|vite\.config\.ts|migration-manifest\.json))$"
)
with tempfile.TemporaryFile() as archive:
    added = set()
    with tarfile.open(fileobj=archive, mode="w:gz", format=tarfile.USTAR_FORMAT) as context:
        context.add(dockerfile, arcname="Dockerfile", recursive=False)
        for relative in sorted(set(files)):
            if relative not in allowed_roots and not package_source.fullmatch(relative):
                continue
            item = root / relative
            if (not item.is_file() or not item.resolve().is_relative_to(root) or item.is_symlink()
                    or any(part.startswith(".") for part in item.relative_to(root).parts)
                    or item.suffix.lower() in {".pem", ".pfx", ".p12", ".key", ".env"}):
                continue
            context.add(item, arcname=relative, recursive=False)
            added.add(relative)
    missing = required - added
    if missing:
        raise SystemExit("Missing qualification build files: " + ", ".join(sorted(missing)))
    if args.check_context:
        print(f"Qualification context verified: {len(added) + 1} files")
        sys.exit(0)

    try:
        candidate = subprocess.run([*engine, "version", "--format", "{{.Server.Os}}"],
                                   capture_output=True, text=True, timeout=15)
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        raise SystemExit("A working local Docker Linux engine is required.") from error
    if candidate.returncode or candidate.stdout.strip() != "linux":
        raise SystemExit("A working local Docker Linux engine is required.")
    archive.seek(0)
    subprocess.run([*engine, "build", "--progress=plain", "--tag", tag, "-"],
                   stdin=archive, timeout=1200, check=True)

subprocess.run([*engine, "run", "--rm", "--init", "--network", "none", "--cpus", "2",
                "--memory", "1700m", "--tmpfs", "/tmp:rw,nosuid,nodev,size=768m", tag], timeout=1680, check=True)
