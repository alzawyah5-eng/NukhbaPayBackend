-- No identity or role creation. Explicit owner-operated disposable grants only.
DO $grant$ DECLARE workload text:=current_setting('nukhabapay.ai_job_role',true); BEGIN
 IF current_user<>'nukhabapay_migrator' OR current_database() !~ '^nukhabapay_b3b3_[0-9a-f]{32}$'
 OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1' OR inet_server_port() IS DISTINCT FROM 5432
 OR workload IS NULL OR workload !~ '^nukh_ai_jobs_[0-9a-f]{20}$'
 OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE rolname=workload AND rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
 AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid))
 THEN RAISE EXCEPTION 'Unapproved AI job role' USING ERRCODE='42501'; END IF;
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),workload);
 EXECUTE format('GRANT USAGE ON SCHEMA nukhabapay TO %I',workload);
 EXECUTE format('GRANT SELECT,INSERT ON nukhabapay.ai_jobs TO %I',workload);
 EXECUTE format('GRANT UPDATE(state,attempts,retry_at,summary) ON nukhabapay.ai_jobs TO %I',workload);
 -- Scoped SELECT is needed by the deferred non-definer audit integrity trigger.
 EXECUTE format('GRANT SELECT,INSERT ON nukhabapay.ai_job_audit TO %I',workload);
 EXECUTE format('GRANT SELECT ON nukhabapay.ai_job_sources,nukhabapay.ai_job_candidates TO %I',workload);
END $grant$;
