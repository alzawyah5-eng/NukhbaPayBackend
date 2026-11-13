import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { MigrationBuilder } from "node-pg-migrate";

// Registered source. The approved runner stages this wrapper with the exact
// manifest-verified IAM and session SQL sidecars before database execution.
export function up(pgm: MigrationBuilder): void {
  const manifest = JSON.parse(readFileSync(new URL("./migration-manifest.json",import.meta.url),"utf8"));
  const sql = (name:string) => {
    const bytes=readFileSync(new URL("./"+name,import.meta.url));
    const key="packages/database/pending-migrations/"+name;
    if(createHash("sha256").update(bytes).digest("hex")!==manifest.files[key])throw new Error("Migration source integrity rejected");
    return bytes.toString("utf8");
  };
  pgm.sql(`DO $dependency$ BEGIN
    IF (SELECT array_agg(name ORDER BY id) FROM nukhabapay.schema_migrations) IS DISTINCT FROM
      ARRAY['001_catalog','002_import_role_privileges','003_import_role_read_access','004_staff_identity_foundation','005_staff_workflow_persistence']::varchar[] THEN
      RAISE EXCEPTION 'Unexpected session migration dependencies' USING ERRCODE='42501';
    END IF;
  END $dependency$;`);
  pgm.sql(sql("004_identity_activation_safeguards.sql"));
  pgm.sql(sql("006_staff_server_sessions.sql"));
}
export function down():never {
  throw new Error("Session evidence rollback is disabled; use a separately approved verified restore");
}
