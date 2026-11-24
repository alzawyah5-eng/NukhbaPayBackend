import { createServer } from 'node:http';
import { request } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getCACertificates } from 'node:tls';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bookmarked HTTP entry. Staff authentication and application data stay on the pinned HTTPS origin.
function portalCA(){
  try {
    const cert=new X509Certificate(readFileSync(new URL('../.local/staff-workspace-localhost.cer',import.meta.url)));
    if(cert.fingerprint256==='67:ED:04:C0:14:4A:0B:0D:A7:24:3E:C3:4D:75:B2:77:C4:BE:4D:95:9C:DB:E7:D8:2F:72:A5:78:96:03:4D:61')return cert.toString();
  }catch{/* The system store can also contain the reviewed development certificate. */}
  return getCACertificates('system');
}
function portalResponds(method,path,headers,accept){
  return new Promise(resolve=>{
    const probe=request({hostname:'127.0.0.1',port:3001,servername:'localhost',headers:{host:'localhost:3001',...headers},
      ca:portalCA(),method,path,timeout:2500},res=>{
      res.resume();
      resolve(accept(res));
    });
    probe.on('error',()=>resolve(false));
    probe.on('timeout',()=>probe.destroy());
    probe.end();
  });
}
export async function staffWorkspaceEntry(request,response){
  response.setHeader('Cache-Control','no-store');
  response.setHeader('Referrer-Policy','no-referrer');
  response.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if(request.method==='GET' && request.headers.host==='127.0.0.1:3010' &&
    ['/','/preview','/preview/overview'].includes(request.url)){
    const storageReady=await portalResponds('HEAD','/health/staff-storage',{},res=>
      res.statusCode===204 && res.headers['x-nukhbapay-storage']==='windows-postgresql-staff');
    if(storageReady && await portalResponds('GET','/management',{
      'sec-fetch-mode':'navigate','sec-fetch-dest':'document','sec-fetch-site':'cross-site',accept:'text/html'
    },res=>res.statusCode===200 && /^text\/html\b/i.test(res.headers['content-type']??''))){
      response.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(
        '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NukhbaPay Staff Management</title><link rel="stylesheet" href="/entry.css"><main><header>NukhbaPay</header><h1>Staff management</h1><p>Open your tenant’s staff directory, invitations, departments and audit records.</p><a href="https://localhost:3001/management">Open management dashboard</a><footer>Department staff can use <a href="https://localhost:3001/">Staff sign-in</a>.</footer></main></html>');
    }
    else response.writeHead(503,{'Content-Type':'text/plain; charset=utf-8','Retry-After':'60'})
      .end(storageReady?'The management dashboard is waiting for the updated HTTPS portal. Complete the private PowerShell launcher, then refresh this page.':'NukhbaPay Staff Portal is waiting for its persistent Windows PostgreSQL connection.');
  }else if(request.method==='GET' && request.headers.host==='127.0.0.1:3010' && request.url==='/entry.css'){
    response.writeHead(200,{'Content-Type':'text/css'}).end('body{margin:0;background:#f6f7fb;color:#18243a;font:16px/1.5 system-ui}main{max-width:40rem;margin:12vh auto;padding:clamp(1.5rem,5vw,4rem);background:white;border:1px solid #dfe4ec;border-radius:18px}header{color:#6900bc;font-weight:700}h1{line-height:1.15}main>a{display:inline-block;background:#7100c7;color:white;text-decoration:none;padding:.7rem 1.2rem;border-radius:8px;font-weight:600}footer{margin-top:2rem;color:#526078}footer a{color:#6500aa}');
  }else response.writeHead(404).end();
}
export function startStaffWorkspaceEntry(){
  return createServer(staffWorkspaceEntry).listen(3010,'127.0.0.1');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))startStaffWorkspaceEntry();

