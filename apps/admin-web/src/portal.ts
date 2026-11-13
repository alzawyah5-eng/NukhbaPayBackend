import { createServer, request, type Server } from "node:https";
import { createHmac, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const PORTAL_COOKIE_NAME="__Host-nukhbapay_staff";
export interface InternalSessionPort {
  validate(token:string):Promise<{readonly ok:boolean;readonly reason?:string}>;
  revoke(token:string):Promise<{readonly ok:boolean;readonly reason?:string}>;
}
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
const unavailable=()=>new Error("Staff HTTPS portal unavailable");
export function staffCookie(value:string,clear=false):string {
  if(!tokenPattern.test(value) && !(clear && value===""))throw unavailable();
  return `${PORTAL_COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict${clear?"; Max-Age=0":""}`;
}
function sessionCookie(request:IncomingMessage):string|undefined {
  const values=request.headersDistinct['cookie'];
  if(!values || values.length!==1 || values[0]!.length>2048)return undefined;
  let found:string|undefined;
  for(const piece of values[0]!.split(';')) {
    const [name,...rest]=piece.trim().split('=');
    if(name===PORTAL_COOKIE_NAME) {
      if(found!==undefined || rest.length!==1 || !tokenPattern.test(rest[0]!))return undefined;
      found=rest[0];
    }
  }
  return found;
}
const landing='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Nukhbapay Staff Portal</title><h1>Nukhbapay Staff Portal</h1><p id="status">Staff sign-in is unavailable.</p><button id="logout" hidden>Sign out</button><script src="/portal.js" defer></script></html>';
const script=`"use strict";let csrf;const status=document.getElementById("status"),button=document.getElementById("logout");
fetch("/auth/session",{credentials:"same-origin",cache:"no-store"}).then(r=>r.ok?r.json():null).then(s=>{if(s?.authenticated===true){csrf=s.csrfToken;status.textContent="Local staff session active.";button.hidden=false;}}).catch(()=>{});
button.addEventListener("click",async()=>{button.disabled=true;try{const r=await fetch("/auth/logout",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":csrf},body:"{}"});if(r.ok){csrf=undefined;window.location.assign("/auth/logged-out");}else{status.textContent="Sign out could not be confirmed.";button.disabled=false;}}catch{status.textContent="Sign out could not be confirmed.";button.disabled=false;}});`;

/** Trusted server DI only. CLI supplies no session port; no HTTP operation creates a session. */
export async function createStaffPortal(options:{
  readonly pfx:Buffer;readonly certificate:Buffer;readonly passphrase:string;readonly port?:number;readonly sessions?:InternalSessionPort;
}) {
  const port=options.port??3001;
  let certificate:X509Certificate;
  try {
    certificate=new X509Certificate(options.certificate);
    if(certificate.ca || certificate.subjectAltName!=='DNS:localhost' || !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.1') ||
      Date.now()<Date.parse(certificate.validFrom) || Date.now()>=Date.parse(certificate.validTo))throw unavailable();
  }catch{throw unavailable();}
  if(!Number.isInteger(port)||port<0||port>65535 || !Buffer.isBuffer(options.pfx) || !options.passphrase)throw unavailable();
  let origin="";const csrfKey=randomBytes(32);
  const csrf=(token:string)=>createHmac("sha256",csrfKey).update(token).digest("base64url");
  const sameOrigin=(req:IncomingMessage)=>req.headers.host===new URL(origin).host &&
    (!req.headersDistinct['origin'] || req.headersDistinct['origin'].length===1 && req.headers.origin===origin) &&
    (!req.headersDistinct['sec-fetch-site'] || req.headersDistinct['sec-fetch-site'].length===1 &&
      (req.headers['sec-fetch-site']==='same-origin' || req.method==='GET' && req.headers['sec-fetch-site']==='none'));
  const send=(res:ServerResponse,status:number,body:string,type="application/json")=>{
    res.writeHead(status,{"content-type":type+"; charset=utf-8"});res.end(body);
  };
  let server:Server;
  try {
    server=createServer({pfx:options.pfx,passphrase:options.passphrase,minVersion:"TLSv1.2",maxHeaderSize:8192},(req,res)=>{
      res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");
      res.setHeader("Referrer-Policy","no-referrer");
      res.setHeader("Content-Security-Policy","default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      void (async()=>{
        if(req.headers.host!==new URL(origin).host || req.rawHeaders.length>128 || req.headersDistinct['host']?.length!==1){send(res,400,'{"error":"Invalid request"}');return;}
        if(!sameOrigin(req)){send(res,403,'{"error":"Request denied"}');return;}
        if(req.method==="GET" && (req.url==="/" || req.url==="/auth/logged-out")){send(res,200,landing,"text/html");return;}
        if(req.method==="GET" && req.url==="/portal.js"){send(res,200,script,"text/javascript");return;}
        if(req.method==="GET" && req.url==="/health/live"){send(res,200,'{"status":"ok"}');return;}
        if(req.method==="GET" && req.url==="/auth/session") {
          if(!options.sessions){send(res,503,'{"error":"Session service unavailable"}');return;}
          const token=sessionCookie(req);if(!token){send(res,401,'{"error":"Authentication required"}');return;}
          const result=await options.sessions.validate(token);
          if(!result.ok){send(res,result.reason==="UNAVAILABLE"?503:401,'{"error":"Authentication unavailable"}');return;}
          send(res,200,JSON.stringify({authenticated:true,csrfToken:csrf(token)}));return;
        }
        if(req.method==="POST" && req.url==="/auth/logout") {
          const token=sessionCookie(req),provided=req.headersDistinct['x-csrf-token'];
          if(req.headersDistinct['origin']?.length!==1 || req.headers.origin!==origin || !token || !provided || provided.length!==1 ||
            !tokenPattern.test(provided[0]!) || req.headersDistinct['content-type']?.length!==1 || req.headers['content-type']!=="application/json" ||
            !timingSafeEqual(Buffer.from(provided[0]!),Buffer.from(csrf(token)))){send(res,403,'{"error":"Request denied"}');return;}
          let body="";
          for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>4096){send(res,413,'{"error":"Request too large"}');return;}}
          let input:unknown;try{input=JSON.parse(body);}catch{send(res,400,'{"error":"Invalid request"}');return;}
          if(!input || typeof input!=="object" || Array.isArray(input) || Object.keys(input).length!==0){send(res,400,'{"error":"Invalid request"}');return;}
          if(!options.sessions){send(res,503,'{"error":"Session service unavailable"}');return;}
          const result=await options.sessions.revoke(token);
          if(!result.ok){send(res,503,'{"error":"Sign out not confirmed"}');return;}
          res.setHeader("Set-Cookie",staffCookie("",true));send(res,204,"");return;
        }
        send(res,404,'{"error":"Not found"}');
      })().catch(()=>{if(!res.headersSent)send(res,503,'{"error":"Service unavailable"}');else res.destroy();});
    });
    server.requestTimeout=10000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxHeadersCount=64;
    server.setTimeout(15000,socket=>socket.destroy());
    server.on("tlsClientError",()=>undefined);
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  } catch {throw unavailable();}
  const address=server.address();if(!address || typeof address==='string')throw unavailable();
  origin=`https://localhost:${address.port}`;
  try {
    // Strict certificate/hostname/expiry verification also proves the PFX matches the reviewed public certificate.
    await new Promise<void>((resolve,reject)=>{
      const probe=request({hostname:'127.0.0.1',port:address.port,servername:'localhost',path:'/health/live',
        headers:{host:`localhost:${address.port}`},ca:certificate.toString(),agent:false,timeout:3000},response=>{
        response.resume();response.on('end',()=>response.statusCode===200?resolve():reject(unavailable()));
      });probe.once('error',reject);probe.once('timeout',()=>probe.destroy(unavailable()));probe.end();
    });
  }catch{await new Promise<void>(resolve=>server.close(()=>resolve()));throw unavailable();}
  let closing:Promise<void>|undefined;
  return Object.freeze({origin,close:()=>closing??=new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(unavailable()):resolve());server.closeIdleConnections();})});
}
