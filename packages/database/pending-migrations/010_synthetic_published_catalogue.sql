-- Unregistered synthetic read boundary only. No existing migration or publication record is altered.
DO $gate$ BEGIN
 IF current_user<>'nukhabapay_migrator' OR current_database() !~ '^nukhabapay_b3b3_[0-9a-f]{32}$'
 OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1' OR inet_server_port() IS DISTINCT FROM 5432
 OR current_setting('nukhbapay.catalogue_read_migration',true) IS DISTINCT FROM 'BRICK_4B_READ_SYNTHETIC'
 OR to_regclass('nukhabapay.price_workflow_versions') IS NULL
 OR (SELECT array_agg(name ORDER BY id) FROM nukhabapay.schema_migrations) IS DISTINCT FROM
 ARRAY['001_catalog','002_import_role_privileges','003_import_role_read_access','004_staff_identity_foundation','005_staff_workflow_persistence','006_staff_server_sessions']::varchar[]
 OR EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
 WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND a.grantee<>d.defaclrole)
 OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
 WHERE n.nspname='nukhabapay' AND a.grantee<>n.nspowner AND
 (pg_get_userbyid(a.grantee) NOT IN ('nukhabapay_runtime','nukhabapay_importer','nukhabapay_identity_reader','nukhabapay_identity_writer') OR a.privilege_type<>'USAGE' OR a.is_grantable)) THEN
 RAISE EXCEPTION 'Unapproved submission target' USING ERRCODE='42501'; END IF;
END $gate$;

CREATE VIEW nukhabapay.published_catalogue_public WITH (security_barrier=true) AS
 WITH heads AS (
  SELECT DISTINCT ON (tenant_id,product_id) tenant_id,product_id,candidate_id,operation_id,revision
  FROM nukhabapay.price_workflow_versions
  WHERE tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true)
  ORDER BY tenant_id,product_id,revision DESC
 )
 SELECT h.product_id,p.brand AS name,h.operation_id AS publication_id,c.total_amount_minor,c.valid_until
 FROM heads h JOIN nukhabapay.catalogue_publication_candidates c USING(candidate_id,tenant_id,product_id)
 JOIN nukhabapay.price_workflow_approvals a USING(candidate_id,tenant_id,product_id)
 JOIN nukhabapay.price_workflow_audit e ON e.operation_id=h.operation_id AND e.tenant_id=h.tenant_id AND e.product_id=h.product_id AND e.candidate_id=h.candidate_id
 JOIN nukhabapay.products p ON p.id=h.product_id
 WHERE a.synthetic_state='SYNTHETIC_APPROVED' AND c.currency='AED'
 AND c.valid_until>nullif(current_setting('nukhabapay.catalogue_read_at',true),'')::timestamptz;
REVOKE ALL ON nukhabapay.published_catalogue_public FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer;
CREATE TABLE nukhabapay.published_catalogue_read_audit (
 request_id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES nukhabapay.tenants(id),client_digest text NOT NULL CHECK(client_digest ~ '^[0-9a-f]{64}$'),
 kind text NOT NULL CHECK(kind IN ('payment','kiosk')),kiosk_id uuid,catalogue_version text NOT NULL CHECK(catalogue_version ~ '^[0-9a-f]{64}$'),
 occurred_at timestamptz NOT NULL,outcome text NOT NULL DEFAULT 'SYNTHETIC_READ_AUTHORIZED' CHECK(outcome='SYNTHETIC_READ_AUTHORIZED'),
 CHECK((kind='payment' AND kiosk_id IS NULL) OR (kind='kiosk' AND kiosk_id IS NOT NULL))
);
ALTER TABLE nukhabapay.published_catalogue_read_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE nukhabapay.published_catalogue_read_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY catalogue_audit_tenant ON nukhabapay.published_catalogue_read_audit USING (tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true)) WITH CHECK (tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true));
CREATE TRIGGER immutable_catalogue_read_audit BEFORE UPDATE OR DELETE ON nukhabapay.published_catalogue_read_audit FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation();
REVOKE ALL ON nukhabapay.published_catalogue_read_audit FROM PUBLIC,nukhabapay_runtime,nukhabapay_importer,nukhabapay_identity_reader,nukhabapay_identity_writer;
