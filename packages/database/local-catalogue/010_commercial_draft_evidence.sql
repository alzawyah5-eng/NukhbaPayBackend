-- Persistent local catalogue schema. Commercial evidence stays restricted to the
-- schema owner until a separate draft writer is qualified.
DO $target$
BEGIN
  IF current_database() <> 'nukhbapay_catalogue' OR current_user <> 'nukhbapay_catalogue_migrator' THEN
    RAISE EXCEPTION 'Unexpected local commercial evidence target' USING ERRCODE='42501';
  END IF;
END $target$;

CREATE TABLE nukhabapay.price_commercial_draft_evidence (
  candidate_id text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  operation_id text NOT NULL,
  creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id() CHECK (creation_xid=pg_current_xact_id()),
  commercial_digest text NOT NULL CHECK (commercial_digest ~ '^[0-9a-f]{64}$'),
  commercial_payload text NOT NULL CHECK (octet_length(commercial_payload) BETWEEN 1 AND 8192),
  review_digest text NOT NULL CHECK (review_digest ~ '^[0-9a-f]{64}$'),
  validity_deadline timestamptz NOT NULL CHECK (isfinite(validity_deadline)
    AND validity_deadline=date_trunc('milliseconds',validity_deadline)),
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
CREATE POLICY local_commercial_draft_scope ON nukhabapay.price_commercial_draft_evidence
  USING (tenant_id::text=current_setting('nukhabapay.tenant_id',true)
    AND tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true));
REVOKE ALL ON nukhabapay.price_commercial_draft_evidence FROM PUBLIC;
CREATE TRIGGER local_commercial_draft_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON nukhabapay.price_commercial_draft_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation();

CREATE FUNCTION nukhabapay.require_fresh_local_commercial_draft() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
  IF NEW.validity_deadline <= clock_timestamp() OR NOT EXISTS (
    SELECT FROM nukhabapay.catalogue_publication_events e
    JOIN nukhabapay.catalogue_publication_candidates c USING (candidate_id,tenant_id,product_id)
    WHERE e.candidate_id=NEW.candidate_id AND e.tenant_id=NEW.tenant_id AND e.product_id=NEW.product_id
      AND e.operation_id=NEW.operation_id AND e.event_name=NEW.event_name
      AND NEW.validity_deadline<=c.valid_until
  ) THEN
    RAISE EXCEPTION 'Expired or incomplete local commercial draft evidence' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $body$;
REVOKE ALL ON FUNCTION nukhabapay.require_fresh_local_commercial_draft() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER local_commercial_draft_fresh_at_commit
  AFTER INSERT ON nukhabapay.price_commercial_draft_evidence DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nukhabapay.require_fresh_local_commercial_draft();

DO $acl$
BEGIN
  IF EXISTS (
    SELECT FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.oid='nukhabapay.price_commercial_draft_evidence'::regclass AND a.grantee<>c.relowner
  ) OR EXISTS (
    SELECT FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
    WHERE p.oid='nukhabapay.require_fresh_local_commercial_draft()'::regprocedure AND a.grantee<>p.proowner
  ) THEN
    RAISE EXCEPTION 'Unexpected local commercial evidence default privileges' USING ERRCODE='42501';
  END IF;
END $acl$;
