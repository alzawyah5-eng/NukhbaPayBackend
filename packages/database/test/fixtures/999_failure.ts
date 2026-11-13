import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE nukhabapay.rollback_probe (id integer PRIMARY KEY);
    SELECT 1 / 0;
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql("DROP TABLE nukhabapay.rollback_probe");
}
