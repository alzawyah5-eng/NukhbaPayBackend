import { randomBytes, X509Certificate } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic-only acceptance: no configuration, account, database or trust-store provisioning.
const args=process.argv.slice(2);
if(args.length>1||(args.length===1&&!['--tls-only','--diagnose-tls','--built','--effective-db','--publication-db'].includes(args[0]))) {
  throw new Error('Expected no arguments, --tls-only, --diagnose-tls, --built, --effective-db or --publication-db');
}
const mode=args[0];
const startedAt=performance.now();
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
  if(mode==='--diagnose-tls') {
    const certificate=new X509Certificate(readFileSync(path.join(directory,'certificate.pem')));
    const now=Date.now();
    console.info(JSON.stringify({
      node:process.version, nodeOpenSsl:process.versions.openssl,
      subject:certificate.subject, issuer:certificate.issuer, san:certificate.subjectAltName,
      nonCA:!certificate.ca, currentlyValid:now>=Date.parse(certificate.validFrom)&&now<Date.parse(certificate.validTo),
      exactHostname:certificate.checkHost('localhost',{subject:'never',wildcards:false})==='localhost',
      serverAuth:certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.1'),
      rsaBits:certificate.publicKey.asymmetricKeyDetails?.modulusLength,
      checkIssuedSelf:certificate.checkIssued(certificate), selfSignature:certificate.verify(certificate.publicKey),
    }));
    console.info(run(['x509','-in','certificate.pem','-noout','-ext','keyUsage']).toString().trim());
  } else {
    run(['pkcs12','-export','-out','certificate.pfx','-inkey','key.pem','-in','certificate.pem',
      '-passout','env:NUKHBAPAY_STAFF_SYNTHETIC_PFX_PASSWORD']);
    // Public negative fixtures, same private key: fingerprint equality must still hold.
    for(const [name,san,basic,eku,subject='localhost'] of [
      ['mismatch','DNS:localhost','CA:FALSE','serverAuth'],
      ['wrong-host','DNS:wrong.synthetic.invalid','CA:FALSE','serverAuth'],
      ['ca','DNS:localhost','CA:TRUE','serverAuth'],
      ['client-only','DNS:localhost','CA:FALSE','clientAuth'],
      ['wrong-subject','DNS:localhost','CA:FALSE','serverAuth','wrong.synthetic.invalid'],
      ['extra-san','DNS:localhost,DNS:other.synthetic.invalid','CA:FALSE','serverAuth'],
      ['wildcard','DNS:*.localhost','CA:FALSE','serverAuth'],
    ])run(['req','-x509','-key','key.pem','-out',`${name}.pem`,'-days','1','-subj',`/CN=${subject}`,
      '-addext',`subjectAltName=${san}`,'-addext',`basicConstraints=critical,${basic}`,'-addext',`extendedKeyUsage=${eku}`]);
    // Same key, different issuer name: a valid signature alone must not satisfy the self-issued policy.
    run(['req','-x509','-key','key.pem','-out','issuer.pem','-days','1','-subj','/CN=issuer.synthetic.invalid',
      '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign']);
    run(['req','-new','-key','key.pem','-out','localhost.csr','-subj','/CN=localhost']);
    writeFileSync(path.join(directory,'leaf-extensions.cnf'),
      'subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n');
    run(['x509','-req','-in','localhost.csr','-CA','issuer.pem','-CAkey','key.pem','-set_serial','2',
      '-days','1','-extfile','leaf-extensions.cnf','-out','wrong-issuer.pem']);
    env.NUKHBAPAY_STAFF_TEST_PFX_PATH=path.join(directory,'certificate.pfx');
    env.NUKHBAPAY_STAFF_TEST_CA_PATH=path.join(directory,'certificate.pem');
    env.NUKHBAPAY_STAFF_TEST_TLS_CASES_DIR=directory;
    env.NUKHBAPAY_STAFF_TEST_PASSPHRASE=password;
    delete env.NUKHBAPAY_STAFF_SYNTHETIC_PFX_PASSWORD;
    const command=mode==='--effective-db' ? 'node --test --test-reporter=tap scripts/test/staff-effective-membership.mjs' : mode==='--built' ? 'node --test apps/admin-web/dist-test/test/*.spec.js' : mode==='--tls-only'
      ? 'pnpm.cmd --filter @nukhbapay/admin-web exec tsc -p tsconfig.test.json && node --test apps/admin-web/dist-test/test/development-tls.spec.js apps/admin-web/dist-test/test/portal.spec.js'
      : 'pnpm.cmd staff:test';
    const options={cwd:root,env,encoding:'utf8',windowsHide:true,maxBuffer:12*1024*1024};
    let result;
    if(mode==='--publication-db') {
      const soakMs=Number(env.NUKHBA_DISPOSABLE_SOAK_MS);
      const soakBudget=Number.isSafeInteger(soakMs)&&soakMs>=1000&&soakMs<=600000?soakMs:0;
      // Leave time for the inner runner to record output and tear down its certificate.
      const elapsedMs=performance.now()-startedAt;
      const timeout=Math.max(1,Math.floor(110000+soakBudget-elapsedMs));
      console.info('Starting disposable publication suite with temporary HTTPS credentials.');
      result=spawnSync(process.execPath,['--test','--test-reporter=tap','scripts/test/catalogue-publication-outbox.mjs'],{...options,timeout});
      if(result.error)console.error('Disposable publication process status: '+result.error.code);
    } else if(process.platform==='win32') {
      result=spawnSync(process.env.ComSpec??'cmd.exe',['/d','/s','/c',command],options);
    } else {
      result=spawnSync('/bin/sh',['-c',command.replaceAll('pnpm.cmd','pnpm')],options);
    }
    const output=((result.stdout??'')+(result.stderr??'')).replaceAll(password,'[redacted]');
    process.stdout.write(output);
    if(result.status!==0||result.error)throw new Error('Synthetic staff acceptance failed');
  }
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
