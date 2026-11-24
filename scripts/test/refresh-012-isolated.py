"""Verify proposal 012 R2 in disposable PostgreSQL with a rollback-only fixture."""
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import sys
import time

if len(sys.argv) > 3 or (len(sys.argv) > 1 and sys.argv[1] not in ("--staff", "--workers", "--workers-only", "--legacy", "--effective", "--platform", "--publication")):
    raise SystemExit("Use no arguments, --staff, --effective, --platform, --legacy, --publication, --workers or --workers-only [soak-seconds] (publication also accepts soak-seconds)")
mode = sys.argv[1] if len(sys.argv) > 1 else ""
soak_seconds = 0
if len(sys.argv) == 3:
    if mode not in ("--workers", "--workers-only", "--publication") or not re.fullmatch(r"[1-9][0-9]{0,2}", sys.argv[2]) or int(sys.argv[2]) > 600:
        raise SystemExit("Use --workers, --workers-only or --publication with a bounded soak duration between 1 and 600 seconds")
    soak_seconds = int(sys.argv[2])
root = Path(__file__).resolve().parents[2]
bin_dir = Path("C:/Program Files/PostgreSQL/18/bin")
env = {k: v for k, v in os.environ.items()
       if k.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA",
                         "USERNAME", "USERPROFILE"}}
directory = Path(tempfile.mkdtemp(prefix="012-r2-offline-", dir=(root / ".local").resolve()))
# Keep database writes outside the synchronized workspace. Evidence stays in .local.
temp_root = Path(tempfile.gettempdir()).resolve(strict=True)
cluster = Path(tempfile.mkdtemp(prefix="nukhbapay-012-cluster-", dir=temp_root))
print(f"Evidence: {directory}", flush=True)

schema = (root / "packages/database/pending-migrations/012_catalogue_refresh_R2_PROPOSAL.sql").read_text()
setup = """
BEGIN;
CREATE SCHEMA nukhabapay;
CREATE TABLE nukhabapay.provider_accounts (
  tenant_id uuid NOT NULL, id uuid NOT NULL, provider_code text NOT NULL, status text NOT NULL,
  UNIQUE (tenant_id,id)
);
INSERT INTO nukhabapay.provider_accounts VALUES
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','fixture','ACTIVE');
"""
fixtures = """
CREATE ROLE refresh_fixture NOLOGIN;
GRANT USAGE ON SCHEMA nukhabapay TO refresh_fixture;
GRANT SELECT ON nukhabapay.provider_accounts,nukhabapay.catalogue_refresh_schedules,
  nukhabapay.catalogue_refresh_jobs,nukhabapay.catalogue_refresh_audit TO refresh_fixture;
GRANT INSERT,UPDATE ON nukhabapay.catalogue_refresh_jobs TO refresh_fixture;
GRANT INSERT ON nukhabapay.catalogue_refresh_audit TO refresh_fixture;
GRANT USAGE ON SEQUENCE nukhabapay.catalogue_refresh_audit_id_seq TO refresh_fixture;
SELECT set_config('nukhabapay.refresh_tenant_id','00000000-0000-4000-8000-000000000001',true);
DO $fixture$
DECLARE
  tenant uuid := '00000000-0000-4000-8000-000000000001';
  foreign_tenant uuid := '00000000-0000-4000-8000-000000000002';
  account uuid := '00000000-0000-4000-8000-000000000003';
  schedule uuid := '00000000-0000-4000-8000-000000000004';
  token_value uuid := '00000000-0000-4000-8000-000000000005';
  slot bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 1000;
  job nukhabapay.catalogue_refresh_jobs%ROWTYPE;
  previous_expiry bigint;
BEGIN
  BEGIN
    INSERT INTO nukhabapay.catalogue_refresh_schedules VALUES
      (schedule,foreign_tenant,account,'src','v1',true,slot,86400000);
    RAISE EXCEPTION 'foreign provider account accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  INSERT INTO nukhabapay.catalogue_refresh_schedules VALUES
    (schedule,tenant,account,'src','v1',true,slot,86400000);
  BEGIN
    INSERT INTO nukhabapay.catalogue_refresh_schedules VALUES
      ('00000000-0000-4000-8000-000000000006',tenant,account,'src','v1',true,slot,86400000);
    RAISE EXCEPTION 'duplicate provider schedule accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;

END;
$fixture$;
SET LOCAL ROLE refresh_fixture;
DO $fixture_worker$
DECLARE
  tenant uuid := '00000000-0000-4000-8000-000000000001';
  account uuid := '00000000-0000-4000-8000-000000000003';
  schedule uuid := '00000000-0000-4000-8000-000000000004';
  token_value uuid := '00000000-0000-4000-8000-000000000005';
  slot bigint := (SELECT first_run_at_ms FROM nukhabapay.catalogue_refresh_schedules WHERE id=schedule);
  job nukhabapay.catalogue_refresh_jobs%ROWTYPE;
  previous_expiry bigint;
BEGIN
  IF current_user <> 'refresh_fixture' OR NOT row_security_active('nukhabapay.catalogue_refresh_jobs') THEN
    RAISE EXCEPTION 'fixture worker does not enforce row security (role %)', current_user;
  END IF;
  INSERT INTO nukhabapay.catalogue_refresh_jobs
    (tenant_id,schedule_id,version,slot_at_ms,token,attempt,lease_duration_ms,lease_until_ms,state,reason,updated_at_ms)
    VALUES(tenant,schedule,'v1',slot,token_value,1,1010,0,'CLAIMED','NONE',0)
    RETURNING * INTO STRICT job;
  IF job.lease_until_ms - job.updated_at_ms <> 1010 OR job.updated_at_ms <= slot THEN
    RAISE EXCEPTION 'database did not stamp lease';
  END IF;

  INSERT INTO nukhabapay.catalogue_refresh_jobs
    (tenant_id,schedule_id,version,slot_at_ms,token,attempt,lease_duration_ms,lease_until_ms,state,reason,updated_at_ms)
    VALUES(tenant,schedule,'v1',slot,token_value,1,1010,0,'CLAIMED','NONE',0)
    ON CONFLICT DO NOTHING;
  IF FOUND THEN RAISE EXCEPTION 'duplicate job accepted'; END IF;

  BEGIN
    UPDATE nukhabapay.catalogue_refresh_jobs SET state='FAILED',reason='PROVIDER_READ_UNAVAILABLE';
    RAISE EXCEPTION 'early failure accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO nukhabapay.catalogue_refresh_audit
      (tenant_id,schedule_id,version,slot_at_ms,token,attempt,state,reason,occurred_at_ms)
    VALUES (tenant,schedule,'v1',slot,token_value,1,'CLAIMED','NONE',job.updated_at_ms);
    RAISE EXCEPTION 'forged audit accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  previous_expiry := job.lease_until_ms;
  UPDATE nukhabapay.catalogue_refresh_jobs SET lease_duration_ms=2010 RETURNING * INTO STRICT job;
  IF job.lease_until_ms<=previous_expiry OR job.lease_until_ms-job.updated_at_ms<>2010 THEN
    RAISE EXCEPTION 'invalid renewal interval';
  END IF;
  PERFORM pg_sleep(2.1);
  BEGIN
    UPDATE nukhabapay.catalogue_refresh_jobs SET state='SUCCEEDED';
    RAISE EXCEPTION 'expired settlement accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE nukhabapay.catalogue_refresh_jobs SET lease_duration_ms=3000;
    RAISE EXCEPTION 'expired renewal accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE nukhabapay.catalogue_refresh_jobs SET state='UNCERTAIN',reason='LEASE_EXPIRED';
  BEGIN
    UPDATE nukhabapay.catalogue_refresh_jobs SET state='CLAIMED',reason='NONE';
    RAISE EXCEPTION 'quarantined job reclaimed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF EXISTS (SELECT 1 FROM nukhabapay.catalogue_refresh_audit) THEN
    RAISE EXCEPTION 'worker could read insert-only audit';
  END IF;
END;
$fixture_worker$;
RESET ROLE;
DO $fixture_audit$
BEGIN
  IF (SELECT count(*) FROM nukhabapay.catalogue_refresh_audit)<>3 THEN
    RAISE EXCEPTION 'audit completeness failure';
  END IF;
END;
$fixture_audit$;
SET LOCAL ROLE refresh_fixture;
SELECT set_config('nukhabapay.refresh_tenant_id','00000000-0000-4000-8000-000000000002',true);
DO $fixture_rls$
BEGIN
  IF current_user <> 'refresh_fixture' OR NOT row_security_active('nukhabapay.catalogue_refresh_jobs') THEN
    RAISE EXCEPTION 'fixture worker does not enforce row security';
  END IF;
  IF EXISTS (SELECT 1 FROM nukhabapay.catalogue_refresh_jobs) THEN
    RAISE EXCEPTION 'foreign tenant jobs disclosed (role %, tenant %)', current_user,
      current_setting('nukhabapay.refresh_tenant_id',true);
  END IF;
  RAISE NOTICE 'NUKHBA_012_FIXTURE_PASS';
END;
$fixture_rls$;
ROLLBACK;
"""

server = None
pid_file = cluster / "postmaster.pid"


def matching_pid_file(port):
    try:
        rows = pid_file.read_text().splitlines()
        return (rows[0] == str(server.pid) and Path(rows[1]).resolve() == cluster.resolve()
                and rows[3] == str(port) and rows[5] == "127.0.0.1")
    except (OSError, IndexError):
        return False


try:
    try:
        init = subprocess.run([str(bin_dir / "initdb.exe"), "-D", str(cluster), "--auth=trust",
                               "--locale=C", "--encoding=UTF8", "--no-sync", "--username=nukh_fixture"],
                              env=env, capture_output=True, timeout=90)
    except subprocess.TimeoutExpired as error:
        log = (error.stdout or b"") + (error.stderr or b"")
        (directory / "initdb.log").write_bytes(log + b"\nFixture initialization timed out after 90 seconds.\n")
        raise SystemExit("Disposable fixture initialization timed out; see initdb.log") from None
    (directory / "initdb.log").write_bytes(init.stdout + init.stderr)
    if init.returncode:
        raise SystemExit("Disposable fixture initialization failed")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = reserved.getsockname()[1]
    if port <= 1024 or port in {5432,55437}:
        raise SystemExit("Unsafe disposable port")
    with (directory / "server.log").open("wb") as log_file:
        server = subprocess.Popen([str(bin_dir / "postgres.exe"), "-D", str(cluster),
                                   "-h", "127.0.0.1", "-p", str(port),
                                   "-c", "ssl=off", "-c", "fsync=off", "-c", "listen_addresses=127.0.0.1",
                                   "-c", "nukhbapay.effective_staff_fixture=isolated"],
                                  env=env, stdout=log_file, stderr=subprocess.STDOUT,
                                  creationflags=subprocess.CREATE_NO_WINDOW)
        end = time.monotonic() + 20
        while time.monotonic() < end and server.poll() is None:
            if matching_pid_file(port) and pid_file.read_text().splitlines()[-1].strip() == "ready":
                break
            time.sleep(0.05)
        else:
            raise SystemExit("Disposable PostgreSQL did not become ready")
        # Bind the first command to the fresh process and its exact data directory.
        client = [str(bin_dir / "psql.exe"), "-X", "-w", "-h", "127.0.0.1", "-p", str(port),
                  "-U", "nukh_fixture", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]
        probe = subprocess.run([*client, "-Atc", "SHOW data_directory"], env=env,
                               capture_output=True, timeout=10)
        if probe.returncode or Path(probe.stdout.decode().strip()).resolve() != cluster.resolve():
            raise SystemExit("Disposable fixture target mismatch")
        if mode in ("", "--workers"):
            result = subprocess.run(client, env=env, input=(setup + schema + fixtures).encode(),
                                    capture_output=True, timeout=20)
            log = result.stdout + result.stderr
            (directory / "fixture.log").write_bytes(log)
            if result.returncode or b"NUKHBA_012_FIXTURE_PASS" not in log or re.search(rb"(?:ERROR|FATAL|PANIC):", log):
                raise SystemExit("Disposable SQL fixture failed; see fixture.log")
            print("PASS 1 disposable SQL scenario (binding, duplicate claim scope, lease, transitions, audit and RLS)")
        if mode == "--legacy":
            roles = ["nukhabapay_migrator", "nukhabapay_runtime", "nukhabapay_importer",
                     "nukhabapay_identity_reader", "nukhabapay_identity_writer"]
            creation = subprocess.run([*client, "-c", " ".join(f"CREATE ROLE {role} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;" for role in roles)],
                                      env=env, capture_output=True, timeout=10)
            if creation.returncode:
                raise SystemExit("Disposable legacy fixture role setup failed")
            def fixture_url(role, database="nukhabapay_fixture"):
                return f"postgresql://{role}:disposable-placeholder@127.0.0.1:{port}/{database}"
            # The historical identity preflight requires port 5432. Run its
            # original suite in the separate guarded container instead.
            legacy = subprocess.run(["node", "--test", "--test-reporter=tap", *[
                f"packages/database/dist-test/database/test/{name}.spec.js"
                for name in ("catalog-import", "integration")
            ]], cwd=root, env={**env,
                "DB_TEST_ADMIN_URL": fixture_url("nukh_fixture", "postgres"),
                "NUKHBA_DISPOSABLE_PG_DIRECTORY": str(cluster),
                "DB_MIGRATION_URL": fixture_url(roles[0]), "DB_RUNTIME_URL": fixture_url(roles[1]),
                "DB_IMPORT_URL": fixture_url(roles[2]), "DB_RUNTIME_ROLE": roles[1], "DB_IMPORT_ROLE": roles[2],
                "DB_IDENTITY_READER_URL": fixture_url(roles[3]), "DB_IDENTITY_WRITER_URL": fixture_url(roles[4]),
            }, capture_output=True, timeout=180)
            log = legacy.stdout + legacy.stderr
            (directory / "legacy.log").write_bytes(log)
            print(log.decode("utf-8", errors="replace")[-5000:].encode("ascii", "backslashreplace").decode("ascii"))
            if legacy.returncode or b"# skipped 0" not in log:
                raise SystemExit("Disposable legacy tests failed; see legacy.log")
        elif mode:
            suite = {
                "--staff": "apps/api/dist-test/test/staff-execution-rehearsal.integration.js",
                "--platform": "scripts/test/staff-effective-platform.mjs",
            }.get(mode, "scripts/test/refresh-012-workers.mjs")
            tls_mode = {"--effective": "--effective-db", "--publication": "--publication-db"}.get(mode)
            command = (["node", "scripts/test/run-staff-synthetic-tests.mjs", tls_mode] if tls_mode
                       else ["node", "--test", "--test-reporter=tap", suite])
            timeout = 120 + soak_seconds
            try:
                result = subprocess.run(command, cwd=root, env={
                    **env, "NUKHBA_DISPOSABLE_PG": f"postgresql://nukh_fixture@127.0.0.1:{port}/postgres",
                    "NUKHBA_DISPOSABLE_PG_DIRECTORY": str(cluster),
                    "NUKHBA_DISPOSABLE_SOAK_MS": str(soak_seconds * 1000),
                }, capture_output=True, timeout=timeout)
            except subprocess.TimeoutExpired as error:
                log = (error.stdout or b"") + (error.stderr or b"")
                (directory / "integration.log").write_bytes(log + f"\nFixture runner timed out after {timeout} seconds.\n".encode())
                raise SystemExit("Disposable integration timed out; see integration.log") from None
            log = result.stdout + result.stderr
            (directory / "integration.log").write_bytes(log)
            print(log.decode("utf-8", errors="replace")[-4000:].encode("ascii", "backslashreplace").decode("ascii"))
            if result.returncode:
                raise SystemExit("Disposable integration failed; see integration.log")

finally:
    if server is not None and server.poll() is None:
        if matching_pid_file(port):
            subprocess.run([str(bin_dir / "pg_ctl.exe"), "-D", str(cluster), "-m", "fast", "-w", "stop"],
                           env=env, capture_output=True, timeout=20)
            server.wait(timeout=5)
        if server.poll() is None:
            raise SystemExit("Disposable PostgreSQL requires cleanup; retained its fixture directory")
    if cluster.exists():
        if (cluster.resolve() != cluster or cluster.parent != temp_root
                or not re.fullmatch(r"nukhbapay-012-cluster-[a-z0-9_]+", cluster.name)):
            raise SystemExit("Disposable PostgreSQL directory identity changed; retained for inspection")
        shutil.rmtree(cluster)

