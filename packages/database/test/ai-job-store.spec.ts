import assert from "node:assert/strict";
import test from "node:test";
import { createAiJobPersistence } from "../src/ai-job-store.js";

test("AI persistence rejects operational targets, unsafe roles and credentials before connection", async () => {
  const database = `nukhabapay_b3b3_${"a".repeat(32)}`, role = `nukh_ai_jobs_${"b".repeat(20)}`;
  const url = new URL(`postgresql://${role}:${"c".repeat(32)}@127.0.0.1:5432/${database}`);
  for (const patch of [{ hostname: "remote.invalid" }, { pathname: "/nukhabapay_dev" }, { username: "postgres" },
    { port: "5433" }, { search: "?sslmode=disable" }, { password: "short" }, { hash: "#options" }]) {
    const changed = new URL(url); Object.assign(changed, patch);
    await assert.rejects(createAiJobPersistence({ connectionString: changed.href, expectedRole: role, expectedDatabase: database }),
      (e: unknown) => e instanceof Error && e.message === "AI job unavailable" && !e.message.includes(changed.password));
  }
  await assert.rejects(createAiJobPersistence({ connectionString: url.href, expectedRole: "postgres", expectedDatabase: database }));
});
