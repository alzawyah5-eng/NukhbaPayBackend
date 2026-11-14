-- Owner-operated disposable foundation recipe. Creates no role or operational authority.
DO $grant$ DECLARE workload text:=current_setting('nukhabapay.publication_writer_role',true); BEGIN
 IF current_user<>'nukhabapay_migrator' OR current_database() !~ '^nukhabapay_b3b3_[0-9a-f]{32}$'
 OR workload IS NULL OR workload !~ '^nukh_publication_[0-9a-f]{20}$'
 OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE rolname=workload AND rolcanlogin
 AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
 AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)) THEN
 RAISE EXCEPTION 'Unapproved submission writer' USING ERRCODE='42501'; END IF;
 EXECUTE format('GRANT SELECT,INSERT ON nukhabapay.price_submission_evidence,nukhabapay.price_submission_events TO %I',workload);
END $grant$;
