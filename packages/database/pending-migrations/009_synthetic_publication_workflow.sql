-- Unregistered synthetic workflow only. Does not alter 007, 008 or registered history.
DO $gate$ BEGIN
 IF current_user<>'nukhabapay_migrator' OR current_database() !~ '^nukhabapay_b3b3_[0-9a-f]{32}$'
 OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1' OR inet_server_port() IS DISTINCT FROM 5432
 OR current_setting('nukhbapay.workflow_migration',true) IS DISTINCT FROM 'BRICK_4B_WORKFLOW_SYNTHETIC'
 OR to_regclass('nukhabapay.price_submission_evidence') IS NULL
 OR (SELECT array_agg(name ORDER BY id) FROM nukhabapay.schema_migrations) IS DISTINCT FROM
 ARRAY['001_catalog','002_import_role_privileges','003_import_role_read_access','004_staff_identity_foundation','005_staff_workflow_persistence','006_staff_server_sessions']::varchar[]
 OR EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
 WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND a.grantee<>d.defaclrole)
 OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
 WHERE n.nspname='nukhabapay' AND a.grantee<>n.nspowner AND
 (pg_get_userbyid(a.grantee) NOT IN ('nukhabapay_runtime','nukhabapay_importer','nukhabapay_identity_reader','nukhabapay_identity_writer') OR a.privilege_type<>'USAGE' OR a.is_grantable)) THEN
 RAISE EXCEPTION 'Unapproved submission target' USING ERRCODE='42501'; END IF;
END $gate$;

CREATE TABLE nukhabapay.price_workflow_operations (
 operation_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,product_id uuid NOT NULL,candidate_id text NOT NULL,
 idempotency_key uuid NOT NULL,command_digest text NOT NULL CHECK(command_digest ~ '^[0-9a-f]{64}$'),
 actor_staff_id uuid NOT NULL,action text NOT NULL CHECK(action IN ('APPROVE','ACTIVATE','ROLLBACK')),
 issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 512),subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 512),
 permission text NOT NULL,authz_version bigint NOT NULL CHECK(authz_version>=0),membership_version bigint NOT NULL CHECK(membership_version>=0),
 occurred_at timestamptz NOT NULL,execution text NOT NULL DEFAULT 'NOT_AUTHORIZED' CHECK(execution='NOT_AUTHORIZED'),
 CHECK(permission=CASE action WHEN 'APPROVE' THEN 'pricing.approve' WHEN 'ACTIVATE' THEN 'pricing.activate' ELSE 'publication.rollback' END),
 UNIQUE(tenant_id,product_id,idempotency_key),UNIQUE(operation_id,tenant_id,product_id,candidate_id,actor_staff_id),
 FOREIGN KEY(candidate_id,tenant_id,product_id) REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id,tenant_id,product_id)
);
CREATE TABLE nukhabapay.price_workflow_approvals (
 operation_id uuid PRIMARY KEY,candidate_id text NOT NULL UNIQUE,tenant_id uuid NOT NULL,product_id uuid NOT NULL,
 actor_staff_id uuid NOT NULL,candidate_digest text NOT NULL CHECK(candidate_digest=candidate_id),
 synthetic_state text NOT NULL DEFAULT 'SYNTHETIC_APPROVED' CHECK(synthetic_state='SYNTHETIC_APPROVED'),
 UNIQUE(candidate_id,tenant_id,product_id),
 FOREIGN KEY(candidate_id,tenant_id,product_id) REFERENCES nukhabapay.catalogue_publication_candidates(candidate_id,tenant_id,product_id),
 FOREIGN KEY(operation_id,tenant_id,product_id,candidate_id,actor_staff_id) REFERENCES nukhabapay.price_workflow_operations(operation_id,tenant_id,product_id,candidate_id,actor_staff_id)
);
CREATE TABLE nukhabapay.price_workflow_versions (
 operation_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,product_id uuid NOT NULL,candidate_id text NOT NULL,actor_staff_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),previous_id uuid,rollback_source_id uuid,kind text NOT NULL CHECK(kind IN ('ACTIVATE','ROLLBACK')),
 reason text CHECK(length(reason) BETWEEN 3 AND 256 AND reason !~ '[[:cntrl:]]'),
 CHECK((kind='ACTIVATE' AND rollback_source_id IS NULL AND reason IS NULL) OR (kind='ROLLBACK' AND rollback_source_id IS NOT NULL AND reason IS NOT NULL)),
 CHECK((revision=1 AND previous_id IS NULL) OR (revision>1 AND previous_id IS NOT NULL)),
 UNIQUE(tenant_id,product_id,revision),UNIQUE(operation_id,tenant_id,product_id),
 FOREIGN KEY(previous_id,tenant_id,product_id) REFERENCES nukhabapay.price_workflow_versions(operation_id,tenant_id,product_id),
 FOREIGN KEY(rollback_source_id,tenant_id,product_id) REFERENCES nukhabapay.price_workflow_versions(operation_id,tenant_id,product_id),
 FOREIGN KEY(candidate_id,tenant_id,product_id) REFERENCES nukhabapay.price_workflow_approvals(candidate_id,tenant_id,product_id),
 FOREIGN KEY(operation_id,tenant_id,product_id,candidate_id,actor_staff_id) REFERENCES nukhabapay.price_workflow_operations(operation_id,tenant_id,product_id,candidate_id,actor_staff_id)
);
CREATE TABLE nukhabapay.price_workflow_audit (
 operation_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,product_id uuid NOT NULL,candidate_id text NOT NULL,actor_staff_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('APPROVE','ACTIVATE','ROLLBACK')),occurred_at timestamptz NOT NULL,
 FOREIGN KEY(operation_id,tenant_id,product_id,candidate_id,actor_staff_id) REFERENCES nukhabapay.price_workflow_operations(operation_id,tenant_id,product_id,candidate_id,actor_staff_id)
);
CREATE FUNCTION nukhabapay.check_price_workflow_transition() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE head nukhabapay.price_workflow_versions;creator uuid;approver uuid; BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||NEW.product_id::text,0));
 SELECT creator_staff_id INTO creator FROM nukhabapay.price_submission_evidence WHERE candidate_id=NEW.candidate_id AND tenant_id=NEW.tenant_id AND product_id=NEW.product_id;
 IF creator IS NULL OR creator=NEW.actor_staff_id THEN RAISE EXCEPTION 'Missing submission or separation of duties' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='price_workflow_versions' THEN
  SELECT actor_staff_id INTO approver FROM nukhabapay.price_workflow_approvals WHERE candidate_id=NEW.candidate_id AND tenant_id=NEW.tenant_id AND product_id=NEW.product_id;
  IF approver IS NULL OR approver=NEW.actor_staff_id THEN RAISE EXCEPTION 'Missing distinct approval' USING ERRCODE='42501';END IF;
  SELECT * INTO head FROM nukhabapay.price_workflow_versions WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id ORDER BY revision DESC LIMIT 1;
  IF NEW.revision<>coalesce(head.revision,0)+1 OR NEW.previous_id IS DISTINCT FROM head.operation_id THEN RAISE EXCEPTION 'Stale publication head' USING ERRCODE='40001';END IF;
  IF NEW.kind='ROLLBACK' AND NOT EXISTS(SELECT 1 FROM nukhabapay.price_workflow_versions WHERE operation_id=NEW.rollback_source_id AND tenant_id=NEW.tenant_id AND product_id=NEW.product_id AND candidate_id=NEW.candidate_id AND revision<head.revision) THEN
   RAISE EXCEPTION 'Invalid rollback source' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;END $f$;
CREATE TRIGGER approve_transition BEFORE INSERT ON nukhabapay.price_workflow_approvals FOR EACH ROW EXECUTE FUNCTION nukhabapay.check_price_workflow_transition();
CREATE TRIGGER version_transition BEFORE INSERT ON nukhabapay.price_workflow_versions FOR EACH ROW EXECUTE FUNCTION nukhabapay.check_price_workflow_transition();
CREATE FUNCTION nukhabapay.require_price_workflow_complete() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM nukhabapay.price_workflow_audit WHERE operation_id=NEW.operation_id AND tenant_id=NEW.tenant_id AND product_id=NEW.product_id AND candidate_id=NEW.candidate_id AND actor_staff_id=NEW.actor_staff_id AND action=NEW.action AND occurred_at=NEW.occurred_at)
 OR (NEW.action='APPROVE' AND NOT EXISTS(SELECT 1 FROM nukhabapay.price_workflow_approvals WHERE operation_id=NEW.operation_id AND candidate_id=NEW.candidate_id))
 OR (NEW.action<>'APPROVE' AND NOT EXISTS(SELECT 1 FROM nukhabapay.price_workflow_versions WHERE operation_id=NEW.operation_id AND candidate_id=NEW.candidate_id AND kind=NEW.action)) THEN
 RAISE EXCEPTION 'Incomplete publication transaction' USING ERRCODE='23514';END IF;RETURN NULL;END $f$;
CREATE CONSTRAINT TRIGGER workflow_complete AFTER INSERT ON nukhabapay.price_workflow_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nukhabapay.require_price_workflow_complete();
-- Narrow owner-operated row lock; no source data or human authority is returned.
CREATE FUNCTION nukhabapay.lock_price_workflow_sources(tenant uuid,product uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF tenant::text IS DISTINCT FROM current_setting('nukhabapay.publication_tenant_id',true) OR tenant::text IS DISTINCT FROM current_setting('nukhabapay.tenant_id',true) THEN RAISE EXCEPTION 'Tenant mismatch' USING ERRCODE='42501';END IF;
 PERFORM o.id FROM nukhabapay.provider_offers o JOIN nukhabapay.provider_accounts a ON a.id=o.provider_account_id AND a.tenant_id=o.tenant_id
 JOIN nukhabapay.provider_snapshots s ON s.id=o.provider_snapshot_id AND s.tenant_id=o.tenant_id
 JOIN nukhabapay.product_mappings m ON m.id=o.product_mapping_id AND m.tenant_id=o.tenant_id
 JOIN nukhabapay.products p ON p.id=o.product_id WHERE o.tenant_id=tenant AND o.product_id=product
 ORDER BY o.id FOR SHARE OF o,a,s,m,p;
 IF EXISTS(SELECT 1 FROM nukhabapay.provider_offers o JOIN nukhabapay.product_mappings m ON m.id=o.product_mapping_id AND m.tenant_id=o.tenant_id
 WHERE o.tenant_id=tenant AND o.product_id=product AND m.status<>'APPROVED') THEN RAISE EXCEPTION 'Unapproved mapping provenance' USING ERRCODE='23514';END IF;
END $f$;
DO $security$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['price_workflow_operations','price_workflow_approvals','price_workflow_versions','price_workflow_audit'] LOOP
 EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY workflow_tenant ON nukhabapay.%I USING (tenant_id::text=current_setting(''nukhabapay.publication_tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''nukhabapay.publication_tenant_id'',true))',n);
 EXECUTE format('REVOKE ALL ON nukhabapay.%I FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer',n);
 EXECUTE format('CREATE TRIGGER immutable_workflow BEFORE UPDATE OR DELETE ON nukhabapay.%I FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation()',n);
 END LOOP;
END $security$;
REVOKE ALL ON FUNCTION nukhabapay.check_price_workflow_transition(),nukhabapay.require_price_workflow_complete(),nukhabapay.lock_price_workflow_sources(uuid,uuid) FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer;
