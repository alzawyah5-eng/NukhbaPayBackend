-- Unregistered, isolated synthetic foundation only. 007 remains unchanged.
DO $gate$ BEGIN
 IF current_user<>'nukhabapay_migrator' OR current_database() !~ '^nukhabapay_b3b3_[0-9a-f]{32}$'
 OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1' OR inet_server_port() IS DISTINCT FROM 5432
 OR current_setting('nukhbapay.submission_migration',true) IS DISTINCT FROM 'BRICK_4B_FOUNDATION_SYNTHETIC'
 OR to_regclass('nukhabapay.catalogue_publication_candidates') IS NULL
 OR (SELECT array_agg(name ORDER BY id) FROM nukhabapay.schema_migrations) IS DISTINCT FROM
 ARRAY['001_catalog','002_import_role_privileges','003_import_role_read_access','004_staff_identity_foundation','005_staff_workflow_persistence','006_staff_server_sessions']::varchar[]
 OR EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
 WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND a.grantee<>d.defaclrole)
 OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
 WHERE n.nspname='nukhabapay' AND a.grantee<>n.nspowner AND
 (pg_get_userbyid(a.grantee) NOT IN ('nukhabapay_runtime','nukhabapay_importer','nukhabapay_identity_reader','nukhabapay_identity_writer') OR a.privilege_type<>'USAGE' OR a.is_grantable)) THEN
 RAISE EXCEPTION 'Unapproved submission target' USING ERRCODE='42501'; END IF;
END $gate$;
CREATE TABLE nukhabapay.price_submission_births (
 candidate_id text PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL, creation_xid bigint NOT NULL,
 UNIQUE(candidate_id,tenant_id,product_id,creation_xid),
 FOREIGN KEY(candidate_id,tenant_id,product_id) REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id,tenant_id,product_id)
);
CREATE TABLE nukhabapay.price_submission_evidence (
 candidate_id text PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL,
 creation_xid bigint NOT NULL CHECK(creation_xid=txid_current()),
 canonical_payload text NOT NULL CHECK(octet_length(canonical_payload) BETWEEN 1 AND 1048576),
 algorithm text NOT NULL DEFAULT 'SHA-256' CHECK(algorithm='SHA-256'),
 canonicalization text NOT NULL DEFAULT 'BRICK4A_ORDERED_ARRAY_JSON_V1' CHECK(canonicalization='BRICK4A_ORDERED_ARRAY_JSON_V1'),
 creator_staff_id uuid NOT NULL, issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 512),
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 512),
 authz_version bigint NOT NULL CHECK(authz_version>=0), membership_version bigint NOT NULL CHECK(membership_version>=0),
 submitted_at timestamptz NOT NULL,
 provenance text NOT NULL DEFAULT 'VERIFIED_SYNTHETIC_STAFF_SUBMISSION_V1' CHECK(provenance='VERIFIED_SYNTHETIC_STAFF_SUBMISSION_V1'),
 execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
 accepted_approval boolean NOT NULL DEFAULT false CHECK(NOT accepted_approval),
 CHECK(encode(sha256(convert_to(canonical_payload,'UTF8')),'hex')=candidate_id),
 UNIQUE(candidate_id,tenant_id,product_id,creator_staff_id),
 FOREIGN KEY(candidate_id,tenant_id,product_id,creation_xid) REFERENCES nukhabapay.price_submission_births(candidate_id,tenant_id,product_id,creation_xid)
);
CREATE TABLE nukhabapay.price_submission_events (
 candidate_id text PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL, creator_staff_id uuid NOT NULL,
 event_name text NOT NULL DEFAULT 'SYNTHETIC_PRICE_SUBMITTED' CHECK(event_name='SYNTHETIC_PRICE_SUBMITTED'),
 occurred_at timestamptz NOT NULL,
 FOREIGN KEY(candidate_id,tenant_id,product_id,creator_staff_id) REFERENCES nukhabapay.price_submission_evidence(candidate_id,tenant_id,product_id,creator_staff_id)
);
CREATE FUNCTION nukhabapay.record_price_submission_birth() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN INSERT INTO nukhabapay.price_submission_births VALUES(NEW.candidate_id,NEW.tenant_id,NEW.product_id,txid_current()); RETURN NEW; END $f$;
REVOKE ALL ON FUNCTION nukhabapay.record_price_submission_birth() FROM PUBLIC;
CREATE TRIGGER price_submission_birth AFTER INSERT ON nukhabapay.catalogue_publication_candidates
 FOR EACH ROW EXECUTE FUNCTION nukhabapay.record_price_submission_birth();
CREATE FUNCTION nukhabapay.require_price_submission_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN IF NOT EXISTS(SELECT 1 FROM nukhabapay.price_submission_events WHERE candidate_id=NEW.candidate_id AND tenant_id=NEW.tenant_id
 AND product_id=NEW.product_id AND creator_staff_id=NEW.creator_staff_id AND occurred_at=NEW.submitted_at) THEN
 RAISE EXCEPTION 'Missing submission audit' USING ERRCODE='23514'; END IF; RETURN NULL; END $f$;
REVOKE ALL ON FUNCTION nukhabapay.require_price_submission_audit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER submission_audit AFTER INSERT ON nukhabapay.price_submission_evidence
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nukhabapay.require_price_submission_audit();
DO $secure$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['price_submission_births','price_submission_evidence','price_submission_events'] LOOP
 EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY submission_tenant ON nukhabapay.%I USING (tenant_id::text=current_setting(''nukhabapay.publication_tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''nukhabapay.publication_tenant_id'',true))',n);
 EXECUTE format('REVOKE ALL ON nukhabapay.%I FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer',n);
 EXECUTE format('CREATE TRIGGER immutable_submission BEFORE UPDATE OR DELETE ON nukhabapay.%I FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation()',n);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
 WHERE c.relnamespace='nukhabapay'::regnamespace AND c.relname LIKE 'price_submission_%%' AND a.grantee<>c.relowner) THEN
 RAISE EXCEPTION 'Unexpected submission grants' USING ERRCODE='42501'; END IF;
END $secure$;
