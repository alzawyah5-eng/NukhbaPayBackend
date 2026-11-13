import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";

export async function workflowMigrationInstalled(client: Client): Promise<boolean> {
  const result=await client.query("SELECT name FROM nukhabapay.schema_migrations WHERE name='005_staff_workflow_persistence'");
  return result.rowCount===1;
}

/** Verified-target bootstrap, not an application authorization entry point. */
export async function grantWorkflowBackend(client: Client, role: string, provenance: boolean): Promise<void> {
  assert.match(role,/^nukh_request_[0-9a-f]{20}$/);
  assert.equal(await workflowMigrationInstalled(client),true);
  await client.query("BEGIN");
  try{
    await client.query("SELECT set_config('nukhabapay.workflow_backend_role',$1,true),set_config('nukhabapay.workflow_provenance_mode',$2,true)",[role,provenance?"LOCAL_SYNTHETIC_ONLY":"off"]);
    await client.query(readFileSync(new URL("../../../../../packages/database/roles/grant_staff_workflow_backend.sql",import.meta.url),"utf8"));
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}
}
