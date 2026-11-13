import type { MigrationBuilder } from "node-pg-migrate";

const importRole = process.env["DB_IMPORT_ROLE"] ?? "nukhabapay_importer";
if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(importRole)) {
  throw new TypeError("DB_IMPORT_ROLE must be a simple PostgreSQL role name");
}
const importRoleIdentifier = `"${importRole}"`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA nukhabapay FROM ${importRoleIdentifier};
    GRANT SELECT ON
      nukhabapay.tenants,
      nukhabapay.products,
      nukhabapay.provider_accounts,
      nukhabapay.provider_snapshots,
      nukhabapay.product_mappings,
      nukhabapay.provider_offers
      TO ${importRoleIdentifier};
    GRANT INSERT ON nukhabapay.provider_snapshots, nukhabapay.provider_offers TO ${importRoleIdentifier};
    GRANT UPDATE (status, row_count, completed_at)
      ON nukhabapay.provider_snapshots TO ${importRoleIdentifier};
    ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay
      REVOKE INSERT, UPDATE, DELETE ON TABLES FROM ${importRoleIdentifier};
    ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay
      REVOKE USAGE, SELECT ON SEQUENCES FROM ${importRoleIdentifier};
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    GRANT INSERT, UPDATE, DELETE ON
      nukhabapay.tenants,
      nukhabapay.products,
      nukhabapay.provider_accounts,
      nukhabapay.provider_snapshots,
      nukhabapay.product_mappings,
      nukhabapay.provider_offers
      TO ${importRoleIdentifier};
    ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay
      GRANT INSERT, UPDATE, DELETE ON TABLES TO ${importRoleIdentifier};
    ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay
      GRANT USAGE, SELECT ON SEQUENCES TO ${importRoleIdentifier};
  `);
}
