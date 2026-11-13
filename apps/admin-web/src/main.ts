import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaffPortal } from "./portal.js";
import { loadBrowserAssets } from './browser-assets.js';

export async function startStaffPortal(env:Readonly<Record<string,string|undefined>>=process.env) {
  try {
    if((env['NUKHBAPAY_STAFF_SESSION_MODE']??'disabled')!=='disabled')throw new Error();
    const pfxPath=env['NUKHBAPAY_STAFF_TLS_PFX_PATH'],certPath=env['NUKHBAPAY_STAFF_TLS_CERT_PATH'],passphrase=env['NUKHBAPAY_STAFF_TLS_PASSPHRASE'];
    if(!pfxPath || !isAbsolute(pfxPath) || !certPath || !isAbsolute(certPath) || !passphrase || passphrase.length<32)throw new Error();
    // No IAM credentials, actor factory, synthetic provider or real OIDC transport is selected by environment.
    return await createStaffPortal({pfx:readFileSync(pfxPath),certificate:readFileSync(certPath),passphrase,port:3001,
      browserAssets:loadBrowserAssets(fileURLToPath(new URL('./client/',import.meta.url))),environment:env});
  } catch {throw new Error("Staff HTTPS portal startup failed");}
}
if(process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  void startStaffPortal().then(runtime=>{
    console.info(`Nukhbapay staff portal: ${runtime.origin}; sign-in disabled`);
    let closing=false;const close=()=>{if(!closing){closing=true;void runtime.close().catch(()=>{process.exitCode=1;});}};
    process.once('SIGINT',close);process.once('SIGTERM',close);
  }).catch(()=>{console.error("Staff HTTPS portal startup failed");process.exitCode=1;});
}
