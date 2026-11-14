-- Creates no client, identity or role. Disposable owner-operated grants only.
DO $grant$ DECLARE reader text:=current_setting('nukhabapay.catalogue_reader_role',true);auditor text:=current_setting('nukhabapay.catalogue_audit_role',true);workload text;BEGIN
 IF current_user<>'nukhabapay_migrator' OR current_database() !~ '^nukhabapay_b3b3_[0-9a-f]{32}$'
 OR reader IS NULL OR reader !~ '^nukh_catalogue_[0-9a-f]{20}$' OR auditor IS NULL OR auditor !~ '^nukh_read_audit_[0-9a-f]{20}$' THEN
 RAISE EXCEPTION 'Unapproved catalogue readers' USING ERRCODE='42501';END IF;
 FOREACH workload IN ARRAY ARRAY[reader,auditor] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_roles r WHERE rolname=workload AND rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
 AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)) THEN RAISE EXCEPTION 'Unsafe catalogue role' USING ERRCODE='42501';END IF;
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),workload);
 EXECUTE format('GRANT USAGE ON SCHEMA nukhabapay TO %I',workload);
 END LOOP;
 EXECUTE format('GRANT SELECT(product_id,name,publication_id,total_amount_minor,valid_until) ON nukhabapay.published_catalogue_public TO %I',reader);
 EXECUTE format('GRANT INSERT ON nukhabapay.published_catalogue_read_audit TO %I',auditor);
END $grant$;
