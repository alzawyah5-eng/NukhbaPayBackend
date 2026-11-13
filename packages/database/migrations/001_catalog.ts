import type { MigrationBuilder } from "node-pg-migrate";

const runtimeRole = process.env["DB_RUNTIME_ROLE"] ?? "nukhabapay_runtime";
const importRole = process.env["DB_IMPORT_ROLE"] ?? "nukhabapay_importer";
if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(runtimeRole)) {
  throw new TypeError("DB_RUNTIME_ROLE must be a simple PostgreSQL role name");
}
if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(importRole)) {
  throw new TypeError("DB_IMPORT_ROLE must be a simple PostgreSQL role name");
}
const runtimeRoleIdentifier = `"${runtimeRole}"`;
const importRoleIdentifier = `"${importRole}"`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE nukhabapay.tenants (
      id uuid PRIMARY KEY,
      tenant_key varchar(128) NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CONSTRAINT tenants_key_ck CHECK (tenant_key = btrim(tenant_key) AND tenant_key <> '')
    );

    CREATE TABLE nukhabapay.products (
      id uuid PRIMARY KEY,
      canonical_product_key varchar(128) NOT NULL UNIQUE,
      brand varchar(128) NOT NULL,
      redemption_country char(2) NOT NULL,
      currency char(3) NOT NULL,
      face_value_minor bigint NOT NULL,
      fulfillment_method varchar(32) NOT NULL,
      terms_version varchar(128) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CONSTRAINT products_key_ck CHECK (canonical_product_key = btrim(canonical_product_key) AND canonical_product_key <> ''),
      CONSTRAINT products_brand_ck CHECK (brand = btrim(brand) AND brand <> ''),
      CONSTRAINT products_country_ck CHECK (redemption_country = 'AE'),
      CONSTRAINT products_currency_ck CHECK (currency = 'AED'),
      CONSTRAINT products_face_value_ck CHECK (face_value_minor BETWEEN 1 AND 100000000),
      CONSTRAINT products_fulfillment_ck CHECK (fulfillment_method = 'DIGITAL_PIN'),
      CONSTRAINT products_terms_version_ck CHECK (terms_version = btrim(terms_version) AND terms_version <> ''),
      CONSTRAINT products_id_face_value_uq UNIQUE (id, face_value_minor)
    );

    CREATE TABLE nukhabapay.provider_accounts (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES nukhabapay.tenants (id) ON DELETE RESTRICT,
      provider_code varchar(64) NOT NULL,
      external_account_key varchar(128) NOT NULL,
      credential_reference varchar(256),
      status varchar(16) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CONSTRAINT provider_accounts_provider_ck CHECK (provider_code = btrim(provider_code) AND provider_code <> ''),
      CONSTRAINT provider_accounts_external_key_ck CHECK (external_account_key = btrim(external_account_key) AND external_account_key <> ''),
      CONSTRAINT provider_accounts_credential_reference_ck CHECK (credential_reference IS NULL OR (credential_reference = btrim(credential_reference) AND credential_reference <> '')),
      CONSTRAINT provider_accounts_status_ck CHECK (status IN ('ACTIVE', 'DISABLED')),
      CONSTRAINT provider_accounts_tenant_id_uq UNIQUE (tenant_id, id),
      CONSTRAINT provider_accounts_identity_uq UNIQUE (tenant_id, provider_code, external_account_key)
    );

    CREATE TABLE nukhabapay.provider_snapshots (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      provider_account_id uuid NOT NULL,
      snapshot_key varchar(128) NOT NULL,
      source_version varchar(128) NOT NULL,
      observed_at timestamptz NOT NULL,
      effective_at timestamptz,
      status varchar(16) NOT NULL,
      row_count integer,
      failure_code varchar(64),
      started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      completed_at timestamptz,
      CONSTRAINT provider_snapshots_account_fk
        FOREIGN KEY (tenant_id, provider_account_id)
        REFERENCES nukhabapay.provider_accounts (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT provider_snapshots_key_ck CHECK (snapshot_key = btrim(snapshot_key) AND snapshot_key <> ''),
      CONSTRAINT provider_snapshots_source_version_ck CHECK (source_version = btrim(source_version) AND source_version <> ''),
      CONSTRAINT provider_snapshots_status_ck CHECK (status IN ('IN_PROGRESS', 'COMPLETE', 'FAILED')),
      CONSTRAINT provider_snapshots_row_count_ck CHECK (row_count IS NULL OR row_count >= 0),
      CONSTRAINT provider_snapshots_failure_code_ck CHECK (failure_code IS NULL OR (failure_code = btrim(failure_code) AND failure_code <> '')),
      CONSTRAINT provider_snapshots_state_ck CHECK (
        (status = 'IN_PROGRESS' AND row_count IS NULL AND failure_code IS NULL AND completed_at IS NULL)
        OR (status = 'COMPLETE' AND row_count IS NOT NULL AND failure_code IS NULL AND completed_at IS NOT NULL)
        OR (status = 'FAILED' AND row_count IS NULL AND failure_code IS NOT NULL AND completed_at IS NOT NULL)
      ),
      CONSTRAINT provider_snapshots_account_id_uq UNIQUE (tenant_id, provider_account_id, id),
      CONSTRAINT provider_snapshots_key_uq UNIQUE (tenant_id, provider_account_id, snapshot_key)
    );

    CREATE TABLE nukhabapay.product_mappings (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      provider_account_id uuid NOT NULL,
      provider_sku varchar(128) NOT NULL,
      product_id uuid NOT NULL REFERENCES nukhabapay.products (id) ON DELETE RESTRICT,
      mapping_version integer NOT NULL,
      status varchar(16) NOT NULL,
      provenance_kind varchar(16) NOT NULL,
      provenance jsonb NOT NULL,
      source_snapshot_id uuid,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CONSTRAINT product_mappings_account_fk
        FOREIGN KEY (tenant_id, provider_account_id)
        REFERENCES nukhabapay.provider_accounts (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT product_mappings_source_snapshot_fk
        FOREIGN KEY (tenant_id, provider_account_id, source_snapshot_id)
        REFERENCES nukhabapay.provider_snapshots (tenant_id, provider_account_id, id) ON DELETE RESTRICT,
      CONSTRAINT product_mappings_sku_ck CHECK (provider_sku = btrim(provider_sku) AND provider_sku <> ''),
      CONSTRAINT product_mappings_version_ck CHECK (mapping_version > 0),
      CONSTRAINT product_mappings_status_ck CHECK (status IN ('PROPOSED', 'APPROVED', 'REJECTED')),
      CONSTRAINT product_mappings_provenance_kind_ck CHECK (provenance_kind IN ('MANUAL', 'RULES', 'ADVISORY', 'IMPORT')),
      CONSTRAINT product_mappings_provenance_ck CHECK (
        jsonb_typeof(provenance) = 'object'
        AND provenance <> '{}'::jsonb
        AND octet_length(provenance::text) <= 8192
      ),
      CONSTRAINT product_mappings_identity_uq UNIQUE (tenant_id, provider_account_id, provider_sku, mapping_version),
      CONSTRAINT product_mappings_offer_fk_uq UNIQUE (tenant_id, provider_account_id, id, mapping_version, product_id)
    );

    CREATE TABLE nukhabapay.provider_offers (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      provider_account_id uuid NOT NULL,
      provider_snapshot_id uuid NOT NULL,
      product_mapping_id uuid NOT NULL,
      product_mapping_version integer NOT NULL,
      product_id uuid NOT NULL,
      face_value_minor bigint NOT NULL,
      provider_offer_key varchar(128) NOT NULL,
      provider_debit_minor bigint NOT NULL,
      additional_provider_fee_minor bigint,
      upfront_discount_minor bigint,
      available boolean NOT NULL,
      observed_at timestamptz NOT NULL,
      valid_until timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CONSTRAINT provider_offers_snapshot_fk
        FOREIGN KEY (tenant_id, provider_account_id, provider_snapshot_id)
        REFERENCES nukhabapay.provider_snapshots (tenant_id, provider_account_id, id) ON DELETE RESTRICT,
      CONSTRAINT provider_offers_mapping_fk
        FOREIGN KEY (tenant_id, provider_account_id, product_mapping_id, product_mapping_version, product_id)
        REFERENCES nukhabapay.product_mappings (tenant_id, provider_account_id, id, mapping_version, product_id) ON DELETE RESTRICT,
      CONSTRAINT provider_offers_product_value_fk
        FOREIGN KEY (product_id, face_value_minor)
        REFERENCES nukhabapay.products (id, face_value_minor) ON DELETE RESTRICT,
      CONSTRAINT provider_offers_key_ck CHECK (provider_offer_key = btrim(provider_offer_key) AND provider_offer_key <> ''),
      CONSTRAINT provider_offers_debit_ck CHECK (provider_debit_minor BETWEEN 1 AND 100000000),
      CONSTRAINT provider_offers_fee_ck CHECK (
        additional_provider_fee_minor IS NULL
        OR additional_provider_fee_minor BETWEEN 0 AND 100000000
      ),
      CONSTRAINT provider_offers_discount_ck CHECK (
        upfront_discount_minor IS NULL
        OR (
          upfront_discount_minor BETWEEN 0 AND 100000000
          AND provider_debit_minor + upfront_discount_minor = face_value_minor
        )
      ),
      CONSTRAINT provider_offers_validity_ck CHECK (valid_until > observed_at),
      CONSTRAINT provider_offers_snapshot_key_uq UNIQUE (tenant_id, provider_account_id, provider_snapshot_id, provider_offer_key)
    );

    CREATE INDEX provider_snapshots_tenant_observed_idx
      ON nukhabapay.provider_snapshots (tenant_id, observed_at DESC);
    CREATE INDEX product_mappings_tenant_product_idx
      ON nukhabapay.product_mappings (tenant_id, product_id, status);
    CREATE INDEX provider_offers_tenant_snapshot_idx
      ON nukhabapay.provider_offers (tenant_id, provider_snapshot_id, observed_at DESC);

    CREATE FUNCTION nukhabapay.reject_immutable_catalog_update()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, nukhabapay
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Catalog identity records are immutable; insert a new version'
        USING ERRCODE = '23000';
    END;
    $function$;

    CREATE TRIGGER products_immutable_update
      BEFORE UPDATE ON nukhabapay.products
      FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_immutable_catalog_update();
    CREATE TRIGGER product_mappings_immutable_update
      BEFORE UPDATE ON nukhabapay.product_mappings
      FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_immutable_catalog_update();

    CREATE FUNCTION nukhabapay.enforce_snapshot_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, nukhabapay
    AS $function$
    BEGIN
      IF ROW(
        NEW.tenant_id, NEW.provider_account_id, NEW.snapshot_key, NEW.source_version,
        NEW.observed_at, NEW.effective_at, NEW.started_at
      ) IS DISTINCT FROM ROW(
        OLD.tenant_id, OLD.provider_account_id, OLD.snapshot_key, OLD.source_version,
        OLD.observed_at, OLD.effective_at, OLD.started_at
      ) OR OLD.status <> 'IN_PROGRESS'
        OR NEW.status NOT IN ('COMPLETE', 'FAILED') THEN
        RAISE EXCEPTION 'Snapshot identity is immutable and only in-progress snapshots may be completed'
          USING ERRCODE = '23000';
      END IF;
      RETURN NEW;
    END;
    $function$;

    CREATE TRIGGER provider_snapshots_transition
      BEFORE UPDATE ON nukhabapay.provider_snapshots
      FOR EACH ROW EXECUTE FUNCTION nukhabapay.enforce_snapshot_transition();

    GRANT USAGE ON SCHEMA nukhabapay TO ${runtimeRoleIdentifier}, ${importRoleIdentifier};
    GRANT SELECT ON
      nukhabapay.tenants,
      nukhabapay.products,
      nukhabapay.provider_accounts,
      nukhabapay.provider_snapshots,
      nukhabapay.product_mappings,
      nukhabapay.provider_offers
      TO ${runtimeRoleIdentifier};
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      nukhabapay.tenants,
      nukhabapay.products,
      nukhabapay.provider_accounts,
      nukhabapay.provider_snapshots,
      nukhabapay.product_mappings,
      nukhabapay.provider_offers
      TO ${importRoleIdentifier};
    ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay
      GRANT SELECT ON TABLES TO ${runtimeRoleIdentifier};
    ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${importRoleIdentifier};
    ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay
      GRANT USAGE, SELECT ON SEQUENCES TO ${importRoleIdentifier};
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay
      REVOKE SELECT ON TABLES FROM ${runtimeRoleIdentifier};
    ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ${importRoleIdentifier};
    ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay
      REVOKE USAGE, SELECT ON SEQUENCES FROM ${importRoleIdentifier};
    REVOKE SELECT, INSERT, UPDATE, DELETE ON
      nukhabapay.tenants,
      nukhabapay.products,
      nukhabapay.provider_accounts,
      nukhabapay.provider_snapshots,
      nukhabapay.product_mappings,
      nukhabapay.provider_offers
      FROM ${runtimeRoleIdentifier};
    REVOKE SELECT ON
      nukhabapay.tenants,
      nukhabapay.products,
      nukhabapay.provider_accounts,
      nukhabapay.provider_snapshots,
      nukhabapay.product_mappings,
      nukhabapay.provider_offers
      FROM ${importRoleIdentifier};
    REVOKE USAGE ON SCHEMA nukhabapay FROM ${runtimeRoleIdentifier}, ${importRoleIdentifier};

    DROP TABLE nukhabapay.provider_offers;
    DROP TABLE nukhabapay.product_mappings;
    DROP TABLE nukhabapay.provider_snapshots;
    DROP TABLE nukhabapay.provider_accounts;
    DROP TABLE nukhabapay.products;
    DROP TABLE nukhabapay.tenants;
    DROP FUNCTION nukhabapay.enforce_snapshot_transition();
    DROP FUNCTION nukhabapay.reject_immutable_catalog_update();
  `);
}
