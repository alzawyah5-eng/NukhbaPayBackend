import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const {Client}=createRequire(path.join(root,"packages/database/package.json"))("pg");
const env={...process.env};
for(const [name,role,database] of [
  ["DB_MIGRATION_URL","nukhabapay_migrator","nukhabapay_dev"],["DB_RUNTIME_URL","nukhabapay_runtime","nukhabapay_dev"],
  ["DB_IMPORT_URL","nukhabapay_importer","nukhabapay_dev"],["DB_IDENTITY_READER_URL","nukhabapay_identity_reader","nukhabapay_dev"],
  ["DB_IDENTITY_WRITER_URL","nukhabapay_identity_writer","nukhabapay_dev"],["DB_TEST_ADMIN_URL","postgres","postgres"],
]){const url=new URL("postgresql://127.0.0.1:5432");url.username=role;url.password=randomBytes(32).toString("hex");url.pathname="/"+database;env[name]=url.href;}
Object.assign(env,{DB_RUNTIME_ROLE:"nukhabapay_runtime",DB_IMPORT_ROLE:"nukhabapay_importer",DB_IDENTITY_READER_ROLE:"nukhabapay_identity_reader",DB_IDENTITY_WRITER_ROLE:"nukhabapay_identity_writer"});
const postgresBin=path.join(process.env.USERPROFILE??"","PostgreSQL","pgsql","bin");
if(existsSync(path.join(postgresBin,"pg_dump.exe"))&&existsSync(path.join(postgresBin,"pg_restore.exe")))env.NUKHBAPAY_PG_TEST_BIN=postgresBin;
async function persistentEvidence(){
  const client=new Client({connectionString:env.DB_MIGRATION_URL,connectionTimeoutMillis:3000});await client.connect();
  try {await client.query("BEGIN READ ONLY");const history=(await client.query("SELECT name FROM nukhabapay.schema_migrations ORDER BY id")).rows.map(row=>row.name);
    const databases=(await client.query("SELECT datname FROM pg_database ORDER BY datname")).rows.map(row=>row.datname);
    const generatedRoles=(await client.query("SELECT rolname FROM pg_roles WHERE rolname ~ '^nukh_(publication|hostile)_[0-9a-f]{20}$' ORDER BY rolname")).rows.map(row=>row.rolname);
    const disposableConnections=(await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname ~ '^nukhabapay_b3b3_[0-9a-f]{32}$'")).rows[0].n;
    await client.query("COMMIT");return {history,databases,generatedRoles,disposableConnections};}
  finally {await client.end();}
}
const before=await persistentEvidence();
if(JSON.stringify(before.history)!==JSON.stringify(["001_catalog","002_import_role_privileges","003_import_role_read_access"]))throw new Error("Persistent development history rejected");
if(before.generatedRoles.length!==0||before.disposableConnections!==0)throw new Error("Disposable publication resources were not clean before acceptance");
let failed=false;
try {
  const commands=process.argv.includes("--migration-only")
    ? ["pnpm.cmd --filter @nukhbapay/api test:migration:integration"]
    : ["pnpm.cmd --filter @nukhbapay/api test:catalogue-publication:integration"];
  if(process.argv.includes("--regression"))commands.push("pnpm.cmd db:test","pnpm.cmd --filter @nukhbapay/api test:migration:integration");
  for(const command of commands){
    console.info(`Running: ${command}`);
    const result=spawnSync(process.env.ComSpec??"cmd.exe",["/d","/s","/c",command],
      {cwd:root,env,encoding:"utf8",windowsHide:true,timeout:240000,maxBuffer:8*1024*1024});
    process.stdout.write(result.stdout??"");process.stderr.write(result.stderr??"");
    if(result.status!==0||result.error){failed=true;break;}
  }
} finally {
  const after=await persistentEvidence();
  if(JSON.stringify(after)!==JSON.stringify(before))throw new Error("Persistent development database evidence changed");
}
if(failed)throw new Error("Brick 4A regression acceptance failed");
console.info("Brick 4A acceptance passed; persistent 001-003 history and database inventory are unchanged.");
