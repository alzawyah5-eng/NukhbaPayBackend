-- Pending review is evidence only. Neither table confers pricing authority.
ALTER TABLE nukhabapay.catalogue_discoveries ADD UNIQUE (tenant_id,id);
CREATE TABLE nukhabapay.catalogue_pricing_proposals (
  tenant_id uuid NOT NULL REFERENCES nukhabapay.tenants(id),
  id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('MAPPING','POLICY')),
  scope text NOT NULL, version integer NOT NULL CHECK (version > 0),
  creator_id uuid NOT NULL, discovery_id uuid, product_id uuid,
  payload text NOT NULL CHECK (octet_length(payload) BETWEEN 1 AND 4096),
  digest text NOT NULL CHECK (digest=encode(sha256(convert_to(payload,'UTF8')),'hex')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,kind,scope,version),
  UNIQUE (tenant_id,id,kind,version,digest,creator_id),
  FOREIGN KEY (tenant_id,discovery_id) REFERENCES nukhabapay.catalogue_discoveries(tenant_id,id),
  FOREIGN KEY (product_id) REFERENCES nukhabapay.products(id),
  CHECK ((kind='POLICY' AND scope='ARE_GIFT_CARD' AND discovery_id IS NULL AND product_id IS NULL)
    OR (kind='MAPPING' AND discovery_id IS NOT NULL AND product_id IS NOT NULL AND scope=discovery_id::text)),
  CHECK ((payload::jsonb->>1=tenant_id::text AND CASE kind
    WHEN 'POLICY' THEN payload::jsonb->>0='AED_PRICING_POLICY_V1' AND jsonb_array_length(payload::jsonb)=3
      AND jsonb_array_length(payload::jsonb->2)=9
    WHEN 'MAPPING' THEN payload::jsonb->>0='CATALOGUE_MAPPING_V1' AND jsonb_array_length(payload::jsonb)=5
      AND payload::jsonb->>2=discovery_id::text AND payload::jsonb->>3=product_id::text
      AND payload::jsonb->>4 ~ '^[a-f0-9]{64}$'
  END) IS TRUE)
);

CREATE TABLE nukhabapay.catalogue_pricing_decisions (
  tenant_id uuid NOT NULL, proposal_id uuid NOT NULL, kind text NOT NULL,
  version integer NOT NULL, digest text NOT NULL, creator_id uuid NOT NULL,
  reviewer_id uuid NOT NULL CHECK (reviewer_id<>creator_id),
  decision text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,proposal_id),
  FOREIGN KEY (tenant_id,proposal_id,kind,version,digest,creator_id)
    REFERENCES nukhabapay.catalogue_pricing_proposals(tenant_id,id,kind,version,digest,creator_id)
);

DO $security$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['catalogue_pricing_proposals','catalogue_pricing_decisions'] LOOP
    EXECUTE format('ALTER TABLE nukhabapay.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE nukhabapay.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format($policy$CREATE POLICY review_scope ON nukhabapay.%I
      USING (tenant_id::text=current_setting('nukhabapay.tenant_id',true)
        AND tenant_id::text=current_setting('nukhabapay.publication_tenant_id',true))$policy$,relation);
    EXECUTE format('REVOKE ALL ON nukhabapay.%I FROM PUBLIC',relation);
    EXECUTE format('CREATE TRIGGER immutable_pricing_review BEFORE UPDATE OR DELETE OR TRUNCATE ON nukhabapay.%I
      FOR EACH STATEMENT EXECUTE FUNCTION nukhabapay.reject_publication_evidence_mutation()',relation);
  END LOOP;
  IF EXISTS (SELECT FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.oid IN ('nukhabapay.catalogue_pricing_proposals'::regclass,'nukhabapay.catalogue_pricing_decisions'::regclass)
      AND a.grantee<>c.relowner) THEN
    RAISE EXCEPTION 'Unexpected pricing review ACL' USING ERRCODE='42501';
  END IF;
END $security$;
