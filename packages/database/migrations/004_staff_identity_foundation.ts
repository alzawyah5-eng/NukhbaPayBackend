import type { MigrationBuilder } from "node-pg-migrate";

const readerRole = process.env["DB_IDENTITY_READER_ROLE"] ?? "nukhabapay_identity_reader";
const writerRole = process.env["DB_IDENTITY_WRITER_ROLE"] ?? "nukhabapay_identity_writer";
const runtimeRole = process.env["DB_RUNTIME_ROLE"] ?? "nukhabapay_runtime";
const importRole = process.env["DB_IMPORT_ROLE"] ?? "nukhabapay_importer";
const validRoleName = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const workloadRoles = [readerRole, writerRole, runtimeRole, importRole];
if (workloadRoles.some((role) => !validRoleName.test(role)) || new Set(workloadRoles).size !== workloadRoles.length) {
  throw new TypeError("Identity and catalog database role names must be distinct simple PostgreSQL role names");
}
const reader = `"${readerRole}"`;
const writer = `"${writerRole}"`;
const runtime = `"${runtimeRole}"`;
const importer = `"${importRole}"`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    -- Existing catalog table grants remain intact. New tables require explicit grants.
    ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay
      REVOKE ALL ON TABLES FROM ${runtime}, ${importer};

    CREATE TABLE nukhabapay.staff_users (
      id uuid PRIMARY KEY,
      display_name varchar(160) NOT NULL,
      contact_email varchar(254) NOT NULL,
      status varchar(16) NOT NULL,
      authz_version bigint NOT NULL DEFAULT 0,
      tokens_valid_after timestamptz,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CONSTRAINT staff_users_display_name_ck CHECK (
        display_name = btrim(display_name) AND display_name <> ''
      ),
      CONSTRAINT staff_users_contact_email_ck CHECK (
        contact_email = btrim(contact_email) AND contact_email <> ''
      ),
      CONSTRAINT staff_users_status_ck CHECK (
        status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED')
      ),
      CONSTRAINT staff_users_authz_version_ck CHECK (authz_version >= 0),
      CONSTRAINT staff_users_timestamps_ck CHECK (updated_at >= created_at)
    );

    CREATE TABLE nukhabapay.staff_identities (
      id uuid PRIMARY KEY,
      staff_id uuid NOT NULL REFERENCES nukhabapay.staff_users (id) ON DELETE RESTRICT,
      issuer varchar(512) NOT NULL,
      subject varchar(512) NOT NULL,
      status varchar(16) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CONSTRAINT staff_identities_issuer_ck CHECK (
        issuer = btrim(issuer) AND issuer <> ''
      ),
      CONSTRAINT staff_identities_subject_ck CHECK (
        subject = btrim(subject) AND subject <> ''
      ),
      CONSTRAINT staff_identities_status_ck CHECK (status IN ('ACTIVE', 'DISABLED')),
      CONSTRAINT staff_identities_issuer_subject_uq UNIQUE (issuer, subject)
    );
    CREATE INDEX staff_identities_staff_id_idx ON nukhabapay.staff_identities (staff_id);

    CREATE TABLE nukhabapay.staff_memberships (
      id uuid PRIMARY KEY,
      staff_id uuid NOT NULL REFERENCES nukhabapay.staff_users (id) ON DELETE RESTRICT,
      tenant_id uuid NOT NULL REFERENCES nukhabapay.tenants (id) ON DELETE RESTRICT,
      status varchar(16) NOT NULL,
      version bigint NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CONSTRAINT staff_memberships_status_ck CHECK (
        status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')
      ),
      CONSTRAINT staff_memberships_version_ck CHECK (version > 0),
      CONSTRAINT staff_memberships_timestamps_ck CHECK (updated_at >= created_at),
      CONSTRAINT staff_memberships_staff_tenant_uq UNIQUE (staff_id, tenant_id),
      CONSTRAINT staff_memberships_id_tenant_uq UNIQUE (id, tenant_id)
    );
    CREATE INDEX staff_memberships_tenant_staff_idx
      ON nukhabapay.staff_memberships (tenant_id, staff_id);

    CREATE TABLE nukhabapay.iam_roles (
      code varchar(64) PRIMARY KEY,
      scope varchar(16) NOT NULL,
      description varchar(512) NOT NULL,
      privileged boolean NOT NULL,
      CONSTRAINT iam_roles_scope_ck CHECK (scope IN ('PLATFORM', 'TENANT')),
      CONSTRAINT iam_roles_code_ck CHECK (
        code = upper(code) AND code ~ '^[A-Z][A-Z0-9_]{0,63}$'
      ),
      CONSTRAINT iam_roles_description_ck CHECK (
        description = btrim(description) AND description <> ''
      ),
      CONSTRAINT iam_roles_code_scope_uq UNIQUE (code, scope)
    );

    CREATE TABLE nukhabapay.iam_permissions (
      code varchar(96) PRIMARY KEY,
      scope varchar(16) NOT NULL,
      description varchar(512) NOT NULL,
      activation_phase varchar(16) NOT NULL,
      CONSTRAINT iam_permissions_scope_ck CHECK (scope IN ('SELF', 'PLATFORM', 'TENANT')),
      CONSTRAINT iam_permissions_code_ck CHECK (
        code = lower(code) AND code ~ '^[a-z][a-z0-9]*(\\.[a-z][a-z0-9_]*)+$'
      ),
      CONSTRAINT iam_permissions_description_ck CHECK (
        description = btrim(description) AND description <> ''
      ),
      CONSTRAINT iam_permissions_phase_ck CHECK (
        activation_phase IN ('3A', '3B', '3C', '3D', '3E', '4', 'LATER')
      ),
      CONSTRAINT iam_permissions_code_scope_uq UNIQUE (code, scope)
    );

    CREATE TABLE nukhabapay.iam_role_permissions (
      role_code varchar(64) NOT NULL,
      permission_code varchar(96) NOT NULL,
      scope varchar(16) NOT NULL,
      CONSTRAINT iam_role_permissions_pk PRIMARY KEY (role_code, permission_code),
      CONSTRAINT iam_role_permissions_scope_ck CHECK (scope IN ('PLATFORM', 'TENANT')),
      CONSTRAINT iam_role_permissions_role_fk
        FOREIGN KEY (role_code, scope)
        REFERENCES nukhabapay.iam_roles (code, scope) ON DELETE RESTRICT,
      CONSTRAINT iam_role_permissions_permission_fk
        FOREIGN KEY (permission_code, scope)
        REFERENCES nukhabapay.iam_permissions (code, scope) ON DELETE RESTRICT
    );

    CREATE TABLE nukhabapay.platform_role_grants (
      id uuid PRIMARY KEY,
      staff_id uuid NOT NULL REFERENCES nukhabapay.staff_users (id) ON DELETE RESTRICT,
      role_code varchar(64) NOT NULL,
      scope varchar(16) NOT NULL DEFAULT 'PLATFORM',
      granted_at timestamptz NOT NULL,
      expires_at timestamptz,
      revoked_at timestamptz,
      grant_source varchar(24) NOT NULL,
      evidence_reference varchar(128) NOT NULL,
      CONSTRAINT platform_role_grants_scope_ck CHECK (scope = 'PLATFORM'),
      CONSTRAINT platform_role_grants_role_fk
        FOREIGN KEY (role_code, scope)
        REFERENCES nukhabapay.iam_roles (code, scope) ON DELETE RESTRICT,
      CONSTRAINT platform_role_grants_time_ck CHECK (
        (expires_at IS NULL OR expires_at > granted_at)
        AND (revoked_at IS NULL OR revoked_at >= granted_at)
      ),
      CONSTRAINT platform_role_grants_source_ck CHECK (
        grant_source IN ('BOOTSTRAP', 'APPROVED_WORKFLOW', 'TEST')
      ),
      CONSTRAINT platform_role_grants_evidence_ck CHECK (
        evidence_reference ~ '^[A-Za-z0-9_.-]{1,128}$'
      )
    );
    CREATE UNIQUE INDEX platform_role_grants_unrevoked_uq
      ON nukhabapay.platform_role_grants (staff_id, role_code)
      WHERE revoked_at IS NULL;

    CREATE TABLE nukhabapay.tenant_role_grants (
      id uuid PRIMARY KEY,
      membership_id uuid NOT NULL,
      tenant_id uuid NOT NULL,
      role_code varchar(64) NOT NULL,
      scope varchar(16) NOT NULL DEFAULT 'TENANT',
      granted_at timestamptz NOT NULL,
      expires_at timestamptz,
      revoked_at timestamptz,
      grant_source varchar(24) NOT NULL,
      evidence_reference varchar(128) NOT NULL,
      CONSTRAINT tenant_role_grants_scope_ck CHECK (scope = 'TENANT'),
      CONSTRAINT tenant_role_grants_membership_fk
        FOREIGN KEY (membership_id, tenant_id)
        REFERENCES nukhabapay.staff_memberships (id, tenant_id) ON DELETE RESTRICT,
      CONSTRAINT tenant_role_grants_role_fk
        FOREIGN KEY (role_code, scope)
        REFERENCES nukhabapay.iam_roles (code, scope) ON DELETE RESTRICT,
      CONSTRAINT tenant_role_grants_time_ck CHECK (
        (expires_at IS NULL OR expires_at > granted_at)
        AND (revoked_at IS NULL OR revoked_at >= granted_at)
      ),
      CONSTRAINT tenant_role_grants_source_ck CHECK (
        grant_source IN ('BOOTSTRAP', 'APPROVED_WORKFLOW', 'TEST')
      ),
      CONSTRAINT tenant_role_grants_evidence_ck CHECK (
        evidence_reference ~ '^[A-Za-z0-9_.-]{1,128}$'
      )
    );
    CREATE INDEX tenant_role_grants_membership_idx
      ON nukhabapay.tenant_role_grants (tenant_id, membership_id);
    CREATE UNIQUE INDEX tenant_role_grants_unrevoked_uq
      ON nukhabapay.tenant_role_grants (membership_id, role_code)
      WHERE revoked_at IS NULL;

    CREATE TABLE nukhabapay.security_audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      occurred_at timestamptz NOT NULL,
      actor_staff_id uuid REFERENCES nukhabapay.staff_users (id) ON DELETE RESTRICT,
      tenant_id uuid REFERENCES nukhabapay.tenants (id) ON DELETE RESTRICT,
      action varchar(48) NOT NULL,
      outcome varchar(16) NOT NULL,
      target_type varchar(32) NOT NULL,
      target_id uuid,
      request_id uuid,
      reason_code varchar(48) NOT NULL,
      CONSTRAINT security_audit_events_action_ck CHECK (
        action IN (
          'STAFF_IDENTITY_RESOLUTION',
          'STAFF_MEMBERSHIP_RESOLUTION',
          'AUTHORIZATION_DECISION',
          'SECURITY_AUDIT_APPEND'
        )
      ),
      CONSTRAINT security_audit_events_outcome_ck CHECK (
        outcome IN ('SUCCESS', 'DENIED', 'FAILURE')
      ),
      CONSTRAINT security_audit_events_target_ck CHECK (
        target_type IN (
          'STAFF_USER',
          'STAFF_IDENTITY',
          'STAFF_MEMBERSHIP',
          'ROLE_GRANT',
          'PERMISSION',
          'AUTHORIZATION',
          'SYSTEM'
        )
      ),
      CONSTRAINT security_audit_events_reason_ck CHECK (
        reason_code IN (
          'NONE',
          'IDENTITY_NOT_FOUND',
          'STAFF_NOT_ACTIVE',
          'MEMBERSHIP_NOT_ACTIVE',
          'PERMISSION_UNKNOWN',
          'PERMISSION_INACTIVE',
          'SCOPE_MISMATCH',
          'GRANT_INACTIVE',
          'TENANT_MISMATCH',
          'ROLE_CONFLICT',
          'SELF_APPROVAL',
          'MISSING_CONTEXT',
          'DEPENDENCY_UNAVAILABLE'
        )
      )
    );
    CREATE INDEX security_audit_events_tenant_time_idx
      ON nukhabapay.security_audit_events (tenant_id, occurred_at DESC);

    INSERT INTO nukhabapay.iam_roles (code, scope, description, privileged) VALUES
      ('GOVERNANCE_OWNER', 'PLATFORM', 'Governance approvals for exceptional platform access.', true),
      ('SECURITY_ADMIN', 'PLATFORM', 'Security response and privileged access approvals.', true),
      ('ACCESS_ADMIN', 'PLATFORM', 'Submit controlled platform access requests.', true),
      ('PLATFORM_AUDITOR', 'PLATFORM', 'Read platform security audit evidence.', false),
      ('TENANT_ADMIN', 'TENANT', 'Manage limited staff access requests within one tenant.', true),
      ('CATALOG_OPERATOR', 'TENANT', 'Propose catalog operations within one tenant.', false),
      ('CATALOG_REVIEWER', 'TENANT', 'Review catalog mapping proposals within one tenant.', true),
      ('PRICING_EDITOR', 'TENANT', 'Prepare pricing drafts within one tenant.', false),
      ('PRICING_APPROVER', 'TENANT', 'Approve pricing proposals within one tenant.', true),
      ('FINANCE_REVIEWER', 'TENANT', 'Read reserved finance and settlement reports.', true),
      ('SUPPORT_AGENT', 'TENANT', 'Read reserved masked support information.', false),
      ('TENANT_AUDITOR', 'TENANT', 'Read tenant security audit evidence.', true);

    INSERT INTO nukhabapay.iam_permissions (code, scope, description, activation_phase) VALUES
      ('staff.self.read', 'SELF', 'Read only the active staff member self and membership summary.', '3A'),
      ('platform.audit.read', 'PLATFORM', 'Read platform security audit evidence only.', '3D'),
      ('platform.access.approve_privileged', 'PLATFORM', 'Approve privileged platform access requests.', '3D'),
      ('platform.staff.read', 'PLATFORM', 'Read minimal platform staff identity records.', '3D'),
      ('platform.access.approve', 'PLATFORM', 'Approve eligible platform access requests.', '3D'),
      ('platform.staff.suspend', 'PLATFORM', 'Suspend a compromised staff identity.', '3D'),
      ('platform.sessions.revoke', 'PLATFORM', 'Revoke a staff session through a controlled workflow.', '3C'),
      ('platform.access.request', 'PLATFORM', 'Submit controlled platform access requests.', '3D'),
      ('tenant.staff.read', 'TENANT', 'Read minimal staff membership information for one tenant.', '3D'),
      ('tenant.access.request', 'TENANT', 'Submit eligible access requests within one tenant.', '3D'),
      ('tenant.staff.suspend', 'TENANT', 'Suspend eligible low-risk staff within one tenant.', '3D'),
      ('tenant.audit.read', 'TENANT', 'Read security audit evidence for one tenant.', '3D'),
      ('catalog.read', 'TENANT', 'Read customer-safe catalog data for one tenant.', '4'),
      ('catalog.import.request', 'TENANT', 'Request a controlled catalog import operation.', 'LATER'),
      ('catalog.mapping.propose', 'TENANT', 'Propose a provider-to-product mapping for review.', 'LATER'),
      ('catalog.mapping.approve', 'TENANT', 'Approve an eligible provider-to-product mapping.', 'LATER'),
      ('pricing.read', 'TENANT', 'Read authorized tenant pricing economics.', '4'),
      ('pricing.draft', 'TENANT', 'Draft pricing policy changes for one tenant.', '4'),
      ('pricing.submit', 'TENANT', 'Submit pricing policy changes for review.', '4'),
      ('pricing.approve', 'TENANT', 'Approve an immutable pricing proposal.', '4'),
      ('finance.read', 'TENANT', 'Read reserved financial reports without execution rights.', 'LATER'),
      ('settlement.read', 'TENANT', 'Read reserved settlement reports without execution rights.', 'LATER'),
      ('support.read_masked', 'TENANT', 'Read reserved minimal masked support records.', 'LATER');

    INSERT INTO nukhabapay.iam_role_permissions (role_code, permission_code, scope) VALUES
      ('GOVERNANCE_OWNER', 'platform.audit.read', 'PLATFORM'),
      ('GOVERNANCE_OWNER', 'platform.access.approve_privileged', 'PLATFORM'),
      ('SECURITY_ADMIN', 'platform.staff.read', 'PLATFORM'),
      ('SECURITY_ADMIN', 'platform.access.approve', 'PLATFORM'),
      ('SECURITY_ADMIN', 'platform.staff.suspend', 'PLATFORM'),
      ('SECURITY_ADMIN', 'platform.sessions.revoke', 'PLATFORM'),
      ('SECURITY_ADMIN', 'platform.audit.read', 'PLATFORM'),
      ('ACCESS_ADMIN', 'platform.staff.read', 'PLATFORM'),
      ('ACCESS_ADMIN', 'platform.access.request', 'PLATFORM'),
      ('PLATFORM_AUDITOR', 'platform.audit.read', 'PLATFORM'),
      ('TENANT_ADMIN', 'tenant.staff.read', 'TENANT'),
      ('TENANT_ADMIN', 'tenant.access.request', 'TENANT'),
      ('TENANT_ADMIN', 'tenant.staff.suspend', 'TENANT'),
      ('TENANT_ADMIN', 'tenant.audit.read', 'TENANT'),
      ('CATALOG_OPERATOR', 'catalog.read', 'TENANT'),
      ('CATALOG_OPERATOR', 'catalog.import.request', 'TENANT'),
      ('CATALOG_OPERATOR', 'catalog.mapping.propose', 'TENANT'),
      ('CATALOG_REVIEWER', 'catalog.read', 'TENANT'),
      ('CATALOG_REVIEWER', 'catalog.mapping.approve', 'TENANT'),
      ('PRICING_EDITOR', 'catalog.read', 'TENANT'),
      ('PRICING_EDITOR', 'pricing.read', 'TENANT'),
      ('PRICING_EDITOR', 'pricing.draft', 'TENANT'),
      ('PRICING_EDITOR', 'pricing.submit', 'TENANT'),
      ('PRICING_APPROVER', 'catalog.read', 'TENANT'),
      ('PRICING_APPROVER', 'pricing.read', 'TENANT'),
      ('PRICING_APPROVER', 'pricing.approve', 'TENANT'),
      ('FINANCE_REVIEWER', 'pricing.read', 'TENANT'),
      ('FINANCE_REVIEWER', 'finance.read', 'TENANT'),
      ('FINANCE_REVIEWER', 'settlement.read', 'TENANT'),
      ('SUPPORT_AGENT', 'catalog.read', 'TENANT'),
      ('SUPPORT_AGENT', 'support.read_masked', 'TENANT'),
      ('TENANT_AUDITOR', 'tenant.audit.read', 'TENANT');

    CREATE FUNCTION nukhabapay.reject_security_audit_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, nukhabapay
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Security audit events are append-only'
        USING ERRCODE = '23000';
    END;
    $function$;
    CREATE TRIGGER security_audit_events_immutable
      BEFORE UPDATE OR DELETE ON nukhabapay.security_audit_events
      FOR EACH ROW EXECUTE FUNCTION nukhabapay.reject_security_audit_mutation();

    ALTER TABLE nukhabapay.staff_memberships ENABLE ROW LEVEL SECURITY;
    ALTER TABLE nukhabapay.staff_memberships FORCE ROW LEVEL SECURITY;
    CREATE POLICY staff_memberships_tenant_read ON nukhabapay.staff_memberships
      FOR SELECT TO ${reader}
      USING (
        tenant_id = NULLIF(current_setting('nukhabapay.tenant_id', true), '')::uuid
      );

    ALTER TABLE nukhabapay.tenant_role_grants ENABLE ROW LEVEL SECURITY;
    ALTER TABLE nukhabapay.tenant_role_grants FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_role_grants_tenant_read ON nukhabapay.tenant_role_grants
      FOR SELECT TO ${reader}
      USING (
        tenant_id = NULLIF(current_setting('nukhabapay.tenant_id', true), '')::uuid
      );

    ALTER TABLE nukhabapay.security_audit_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE nukhabapay.security_audit_events FORCE ROW LEVEL SECURITY;
    CREATE POLICY security_audit_events_tenant_read ON nukhabapay.security_audit_events
      FOR SELECT TO ${reader}
      USING (
        tenant_id IS NOT NULL
        AND tenant_id = NULLIF(current_setting('nukhabapay.tenant_id', true), '')::uuid
      );
    CREATE POLICY security_audit_events_append ON nukhabapay.security_audit_events
      FOR INSERT TO ${writer}
      WITH CHECK (
        tenant_id IS NULL
        OR tenant_id = NULLIF(current_setting('nukhabapay.tenant_id', true), '')::uuid
      );

    REVOKE ALL ON
      nukhabapay.staff_users,
      nukhabapay.staff_identities,
      nukhabapay.staff_memberships,
      nukhabapay.iam_roles,
      nukhabapay.iam_permissions,
      nukhabapay.iam_role_permissions,
      nukhabapay.platform_role_grants,
      nukhabapay.tenant_role_grants,
      nukhabapay.security_audit_events
      FROM PUBLIC, ${runtime}, ${importer};
    REVOKE ALL ON ALL TABLES IN SCHEMA nukhabapay FROM ${reader}, ${writer};
    GRANT USAGE ON SCHEMA nukhabapay TO ${reader}, ${writer};
    GRANT SELECT (id, status, authz_version)
      ON nukhabapay.staff_users TO ${reader};
    GRANT SELECT (staff_id, issuer, subject, status)
      ON nukhabapay.staff_identities TO ${reader};
    GRANT SELECT (id, staff_id, tenant_id, status, version)
      ON nukhabapay.staff_memberships TO ${reader};
    GRANT SELECT (staff_id, role_code, scope, granted_at, expires_at, revoked_at)
      ON nukhabapay.platform_role_grants TO ${reader};
    GRANT SELECT (membership_id, tenant_id, role_code, scope, granted_at, expires_at, revoked_at)
      ON nukhabapay.tenant_role_grants TO ${reader};
    GRANT SELECT (tenant_id, request_id)
      ON nukhabapay.security_audit_events TO ${reader};
    GRANT INSERT ON nukhabapay.security_audit_events TO ${writer};
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    REVOKE ALL ON ALL TABLES IN SCHEMA nukhabapay FROM ${reader}, ${writer};
    REVOKE USAGE ON SCHEMA nukhabapay FROM ${reader}, ${writer};
    DROP TABLE nukhabapay.security_audit_events;
    DROP TABLE nukhabapay.tenant_role_grants;
    DROP TABLE nukhabapay.platform_role_grants;
    DROP TABLE nukhabapay.iam_role_permissions;
    DROP TABLE nukhabapay.iam_permissions;
    DROP TABLE nukhabapay.iam_roles;
    DROP TABLE nukhabapay.staff_memberships;
    DROP TABLE nukhabapay.staff_identities;
    DROP TABLE nukhabapay.staff_users;
    DROP FUNCTION nukhabapay.reject_security_audit_mutation();
    ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay
      GRANT SELECT ON TABLES TO ${runtime}, ${importer};
  `);
}
