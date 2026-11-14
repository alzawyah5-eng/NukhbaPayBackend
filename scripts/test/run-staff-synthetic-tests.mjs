import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic-only acceptance: no configuration, account, database or trust-store provisioning.
const root=fileURLToPath(new URL('../../',import.meta.url));
const parent=path.resolve(tmpdir());
const directory=mkdtempSync(path.join(parent,'nukhbapay-staff-synthetic-'));
const password=randomBytes(32).toString('hex');
const env={...process.env};
for(const key of Object.keys(env))if(/^(?:DB_|PG|NUKHBAPAY_STAFF_AUTH0_|NUKHBAPAY_STAFF_TLS_|NUKHBAPAY_STAFF_TEST_)/.test(key))delete env[key];
delete env.NODE_TLS_REJECT_UNAUTHORIZED;
env.NUKHBAPAY_STAFF_SESSION_MODE='disabled';
env.NUKHBAPAY_STAFF_SYNTHETIC_PFX_PASSWORD=password;
const openssl=process.platform==='win32'?'C:\\Program Files\\Git\\usr\\bin\\openssl.exe':'openssl';
try {
  if(process.platform==='win32') {
    if(!existsSync(openssl))throw new Error('Explicit test OpenSSL binary is unavailable');
    // Fixed commands, task-created cwd; no interpolated shell path or secret.
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      "$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')); Set-Acl -LiteralPath . -AclObject $acl"],
      {cwd:directory,stdio:'pipe',windowsHide:true});
  }
  const run=args=>execFileSync(openssl,args,{cwd:directory,env,stdio:'pipe',windowsHide:true});
  run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','key.pem','-out','certificate.pem','-days','1',
    '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-addext','basicConstraints=critical,CA:FALSE',
    '-addext','extendedKeyUsage=serverAuth','-addext','keyUsage=critical,digitalSignature,keyEncipherment']);
  run(['pkcs12','-export','-out','certificate.pfx','-inkey','key.pem','-in','certificate.pem',
    '-passout','env:NUKHBAPAY_STAFF_SYNTHETIC_PFX_PASSWORD']);
  env.NUKHBAPAY_STAFF_TEST_PFX_PATH=path.join(directory,'certificate.pfx');
  env.NUKHBAPAY_STAFF_TEST_CA_PATH=path.join(directory,'certificate.pem');
  env.NUKHBAPAY_STAFF_TEST_PASSPHRASE=password;
  delete env.NUKHBAPAY_STAFF_SYNTHETIC_PFX_PASSWORD;
  const result=process.platform==='win32'
    ?spawnSync(process.env.ComSpec??'cmd.exe',['/d','/s','/c','pnpm.cmd staff:test'],{cwd:root,env,encoding:'utf8',windowsHide:true,maxBuffer:12*1024*1024})
    :spawnSync('pnpm',['staff:test'],{cwd:root,env,encoding:'utf8',maxBuffer:12*1024*1024});
  const output=((result.stdout??'')+(result.stderr??'')).replaceAll(password,'[redacted]');
  process.stdout.write(output);
  if(result.status!==0||result.error)throw new Error('Synthetic staff acceptance failed');
} catch {
  console.error('Synthetic staff acceptance failed; no private diagnostics emitted.');
  process.exitCode=1;
} finally {
  const resolved=path.resolve(directory);
  if(path.dirname(resolved)!==parent||!/^nukhbapay-staff-synthetic-[a-zA-Z0-9]+$/.test(path.basename(resolved))||lstatSync(resolved).isSymbolicLink()) {
    throw new Error('Test credential directory ownership check failed; retained');
  }
  // Created exclusively by this invocation; never recursively remove a linked child.
  const {readdirSync}=await import('node:fs');
  if(readdirSync(resolved,{withFileTypes:true}).some(item=>!item.isFile()||item.isSymbolicLink()))throw new Error('Unexpected test credential entry; retained');
  rmSync(resolved,{recursive:true,force:false});
  console.info('Temporary synthetic TLS credentials removed; system trust unchanged.');
}
