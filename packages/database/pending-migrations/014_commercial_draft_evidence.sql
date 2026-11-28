-- Unregistered, disposable catalogue rehearsal only. No live or startup installer.
DO $gate$
DECLARE
  workload text := current_setting('nukhabapay.publication_writer_role', true);
BEGIN
  IF current_user <> 'nukhabapay_migrator'
    OR current_database() !~ '^nukhabapay_b3b3_[0-9a-f]{32}$'
    OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1' OR inet_server_port() IS DISTINCT FROM 5432
    OR current_setting('nukhbapay.commercial_draft_migration', true)
       IS DISTINCT FROM 'DISPOSABLE_COMMERCIAL_DRAFT_V1'
    OR (SELECT array_agg(name ORDER BY id) FROM nukhabapay.schema_migrations) IS DISTINCT FROM
       ARRAY['001_catalog','002_import_role_privileges','003_import_role_read_access',
             '004_staff_identity_foundation','005_staff_workflow_persistence','006_staff_server_sessions']::varchar[]
    OR to_regclass('nukhabapay.price_submission_births') IS NULL
    OR NOT EXISTS (
      SELECT FROM pg_roles r WHERE r.rolname=workload AND r.rolname ~ '^nukh_publication_[0-9a-f]{20}$'
        AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolbypassrls)
        AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid))
    OR EXISTS (
      SELECT FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND a.grantee<>d.defaclrole)
  THEN
    RAISE EXCEPTION 'Unapproved commercial draft rehearsal target' USING ERRCODE='42501';
  END IF;
END $gate$;

CREATE TABLE nukhabapay.price_commercial_draft_evidence (
  candidate_id text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  operation_id text NOT NULL,
  creation_xid bigint NOT NULL DEFAULT txid_current() CHECK (creation_xid=txid_current()),
  commercial_digest text NOT NULL CHECK (commercial_digest ~ '^[0-9a-f]{64}$'),
  commercial_payload text NOT NULL CHECK (octet_length(commercial_payload) BETWEEN 1 AND 8192),
  review_digest text NOT NULL CHECK (review_digest ~ '^[0-9a-f]{64}$'),
  validity_deadline timestamptz NOT NULL,
  event_name text NOT NULL DEFAULT 'CATALOGUE_PUBLICATION_CANDIDATE_CREATED'
    CHECK (event_name='CATALOGUE_PUBLICATION_CANDIDATE_CREATED'),
  CHECK (encode(sha256(convert_to(commercial_payload,'UTF8')),'hex')=commercial_digest),
  CHECK (review_digest=encode(sha256(convert_to(format(
    '["AED_COMMERCIAL_PRICE_DRAFT_REVIEW_V2","%s","%s","%s","%s"]',
    commercial_digest,operation_id,candidate_id,
    to_char(validity_deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'UTF8')),'hex')),
  FOREIGN KEY (candidate_id,tenant_id,product_id,creation_xid)
    REFERENCES nukhabapay.price_submission_births(candidate_id,tenant_id,product_id,creation_xid),
  FOREIGN KEY (operation_id,tenant_id,product_id,candidate_id)
    REFERENCES nukhabapay.catalogue_publication_requests(operation_id,tenant_id,product_id,candidate_id),
  FOREIGN KEY (candidate_id,event_name)
    REFERENCES nukhabapay.catalogue_publication_events(candidate_id,event_name)
);

ALTER TABLE nukhabapay.price_commercial_draft_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.price_commercial_draft_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_draft_tenant ON nukhabapay.price_commercial_draft_evidence
  USING (tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true));
REVOKE ALL ON nukhabapay.price_commercial_draft_evidence FROM PUBLIC;

CREATE TRIGGER commercial_draft_immutable BEFORE UPDATE OR DELETE ON nukhabapay.price_commercial_draft_evidence
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation();
CREATE TRIGGER commercial_draft_no_truncate BEFORE TRUNCATE ON nukhabapay.price_commercial_draft_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation();

CREATE FUNCTION nukhabapay.require_fresh_commercial_draft() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
  IF NEW.validity_deadline <= clock_timestamp() OR NOT EXISTS (
    SELECT FROM nukhabapay.catalogue_publication_events e JOIN nukhabapay.catalogue_publication_candidates c
      USING (candidate_id,tenant_id,product_id)
    WHERE e.candidate_id=NEW.candidate_id AND e.tenant_id=NEW.tenant_id AND e.product_id=NEW.product_id
      AND e.operation_id=NEW.operation_id AND e.event_name=NEW.event_name AND NEW.validity_deadline<=c.valid_until
  ) THEN
    RAISE EXCEPTION 'Expired or incomplete commercial draft evidence' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $body$;
REVOKE ALL ON FUNCTION nukhabapay.require_fresh_commercial_draft() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER commercial_draft_fresh_at_commit
  AFTER INSERT ON nukhabapay.price_commercial_draft_evidence DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.require_fresh_commercial_draft();

DO $grant$
BEGIN
  EXECUTE format('GRANT SELECT, INSERT ON nukhabapay.price_commercial_draft_evidence TO %I',
    current_setting('nukhabapay.publication_writer_role'));
END $grant$;
