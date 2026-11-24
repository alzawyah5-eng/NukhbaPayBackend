# Docker Desktop for NukhbaPay on Windows

Use Docker Desktop in per-user mode with the WSL 2 backend and Linux containers. Check the Windows servicing status and WSL version before relying on the installation. On the current 9.9 GiB host, the WSL profile caps the VM at 3 GiB RAM, three logical processors and 2 GiB swap. This profile applies to all WSL 2 distributions. The current Windows session had about 1.1 GiB RAM available during preflight. Close memory-heavy applications before the first engine run if memory remains tight. [Docker Desktop Windows installation](https://docs.docker.com/desktop/setup/install/windows-install/) · [Microsoft WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)

When WSL must be enabled, run the Microsoft installer from elevated PowerShell. A Windows restart is a separate manual step. The test project needs no general-purpose Linux distribution. After restarting, update WSL with `wsl --update --web-download` if the version remains below Docker's minimum. [Microsoft WSL installation](https://learn.microsoft.com/en-us/windows/wsl/install)

```powershell
wsl --install --no-distribution --web-download
wsl --version
wsl --status
```

Download the x86-64 installer from Docker, verify its published checksum and Authenticode signature, and run the per-user installer with the WSL 2 backend. Start Docker Desktop and complete any first-run agreement under your account. [Docker Desktop release notes](https://docs.docker.com/desktop/release-notes/) · [Docker WSL 2 backend](https://docs.docker.com/desktop/features/wsl/)

```powershell
Start-Process -FilePath '.\Docker Desktop Installer.exe' -ArgumentList 'install','--user','--backend=wsl-2' -Wait
docker --context desktop-linux version
docker --context desktop-linux compose version
docker --context desktop-linux run --rm --network none docker.io/library/hello-world
```

## Disposable PostgreSQL

Run these commands from the repository root. The project uses a separate PostgreSQL 17 instance with an isolated loopback-only network namespace, temporary database storage and a fresh credential generated inside the container. It listens on container-local `127.0.0.1:5432`. Windows port 5432 stays with the existing service. The container uses at most 768 MiB RAM and one CPU. Stopping the container discards its temporary data. [Docker Compose service configuration](https://docs.docker.com/reference/compose-file/services/)

```powershell
$composeArgs = @('--context','desktop-linux','compose','--project-name','nukhabapay-postgres-test',
    '-f','infra/local/compose.postgres-test.yaml')
$env:COMPOSE_DISABLE_ENV_FILE = '1'
docker @composeArgs config --quiet
docker @composeArgs up -d --wait --wait-timeout 90
'SELECT inet_server_addr(), inet_server_port(), current_database()' | docker @composeArgs exec -T --user postgres postgres sh -ec 'export PGPASSWORD=$(cat /dev/shm/nukhbapay-test-password); exec psql -X -w -h 127.0.0.1 -p 5432 -U nukhba_container_fixture -d nukhabapay_docker_smoke -At'
docker @composeArgs down
Remove-Item Env:COMPOSE_DISABLE_ENV_FILE
```

The probe should report `127.0.0.1|5432|nukhabapay_docker_smoke`. The explicit project name and environment setting keep this run separate from the development project and its default environment file. The existing `infra/local/compose.yaml` is a separate persistent development project whose current port mapping requires Windows port 5432.

## Brick 3 and Brick 4 qualification

Run from the repository root with Python 3.10 or later. The launcher selects the local Linux engine explicitly. The build uses pinned Node.js, pnpm and PostgreSQL versions, the workspace lockfile and an allowlisted source context. It then runs the database, historical IAM and guarded publication suites inside a new container with loopback-only networking, no host mounts and no published ports. The runner creates a temporary PostgreSQL cluster and a one-day HTTPS test certificate. It verifies the database target and migration source hashes before running the original suites and checks database and role cleanup afterward.

```powershell
node scripts/rehearse-reviewed-migrations.mjs --verify-only
python scripts/test/run-guarded-qualification.py --check-context
python scripts/test/run-guarded-qualification.py
```

Save the `database`, `iam` and `publication` TAP summaries and the launcher exit code. The scheduled-import guard requires a private alternate port for its own regression. Run that case separately with `python scripts/test/refresh-012-isolated.py --legacy` on Windows after compiling database tests. A Windows process using `127.0.0.1:5432` reaches the existing service. [NukhbaPay runtime qualification](../../docs/runbooks/runtime-qualification.md)

## Rendered staff workspace

Use Node.js 24 and an installed Chromium-compatible browser on an approved development machine. The script launches a fresh headless profile, discovers the browser's assigned loopback DevTools port and serves the built React workspace with disposable same-origin HTTP fixture responses. It exercises catalogue filtering, pagination and pricing, staff and publication confirmations, session states and keyboard navigation. The synthetic HTTPS and database suites provide the corresponding server-side evidence. Auth0 enrollment and real factor-event acceptance require their approved environment.

```powershell
pnpm.cmd --filter @nukhbapay/admin-web... -r build
node --test --test-reporter=tap scripts/test/staff-browser-final-smoke.mjs
```

Edge is the Windows default. The rendered run passed with Chrome for Testing headless shell `158.0.8127.36` on Windows. Set `NUKHBA_TEST_BROWSER` to the absolute executable path of the approved Chromium build. Run from a desktop user session with local loopback access. The test preserves startup and fixture-request diagnostics in `.local/staff-browser-final-*.log` when it fails. [Chrome for Testing downloads](https://googlechromelabs.github.io/chrome-for-testing/) · [Chromium headless debugging](https://developer.chrome.com/docs/automation-and-testing/debug-headless)
