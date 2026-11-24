import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { StaffIdentityPostgresRepository } from "../src/repositories/staff-identity-repository.js";

function fixture(failures: readonly string[]) {
  const queries: string[] = [], releases: (Error | undefined)[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (failures.some(part => sql.startsWith(part))) throw new Error("isolated failure");
      return { rows: [] };
    },
    release: (error?: Error) => releases.push(error),
  };
  return { queries, releases, repository: new StaffIdentityPostgresRepository({ connect: async () => client } as unknown as Pool) };
}

test("tenant identity lookup commits an empty result and releases once", async () => {
  const f=fixture([]);
  assert.equal(await f.repository.findTenantMembership("staff", "tenant"),null);
  assert.equal(f.queries.at(-1),"COMMIT");assert.deepEqual(f.releases,[undefined]);
  assert.ok(f.queries[1]?.includes("set_config('nukhabapay.tenant_id', $1, true)"));
});

test("BEGIN, scoped read and commit failures all roll back before connection reuse", async () => {
  for(const fault of ["BEGIN","SELECT id,","COMMIT"]) {
    const f=fixture([fault]);await assert.rejects(()=>f.repository.findTenantMembership("staff","tenant"));
    assert.equal(f.queries.at(-1),"ROLLBACK");assert.deepEqual(f.releases,[undefined]);
  }
});

test("a failed rollback discards the identity connection exactly once", async () => {
  const f=fixture(["SELECT id,","ROLLBACK"]);
  await assert.rejects(()=>f.repository.findTenantMembership("staff","tenant"),AggregateError);
  assert.equal(f.releases.length,1);assert.ok(f.releases[0] instanceof Error);
});
