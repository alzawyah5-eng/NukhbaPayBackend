import type { MigrationBuilder } from "node-pg-migrate";

const importRole = process.env["DB_IMPORT_ROLE"] ?? "nukhabapay_importer";
if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(importRole)) {
  throw new TypeError("DB_IMPORT_ROLE must be a simple PostgreSQL role name");
}
const importRoleIdentifier = `"${importRole}"`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    GRANT SELECT ON
      nukhabapay.tenants,
      nukhabapay.products,
      nukhabapay.provider_accounts,
      nukhabapay.provider_snapshots,
      nukhabapay.product_mappings,
      nukhabapay.provider_offers
      TO ${importRoleIdentifier};
    ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay
      GRANT SELECT ON TABLES TO ${importRoleIdentifier};
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    REVOKE SELECT ON
      nukhabapay.tenants,
      nukhabapay.products,
      nukhabapay.provider_accounts,
      nukhabapay.provider_snapshots,
      nukhabapay.product_mappings,
      nukhabapay.provider_offers
      FROM ${importRoleIdentifier};
    ALTER DEFAULT PRIVILEGES IN SCHEMA nukhabapay
      REVOKE SELECT ON TABLES FROM ${importRoleIdentifier};
  `);
}
