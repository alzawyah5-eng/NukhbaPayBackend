import { createServer, type Server } from "node:https";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AdministrationError, administrationUuid, staffWorkspaceViews, type StaffCatalogueService, type StaffCatalogueView,
  type StaffManagementService, type StaffWorkspaceService, type StaffWorkspaceView } from "@nukhbapay/application";
import { Auth0Login, TRANSACTION_COOKIE_NAME, transactionCookie } from "./auth0.js";
import { createStaffCommandAdmission, type StaffPublicationPort, type StaffSuspensionPort } from "./staff-command-admission.js";
import { createPlatformStaffCommandAdmission, type PlatformStaffPilotPort } from './platform-staff-step-up.js';
import { browserAsset, developmentPreviewEnabled, type BrowserAssets } from './browser-assets.js';
import { validateDevelopmentCertificate, probeDevelopmentHttps } from './development-tls.js';
import { departmentCookie, positionAllows, positionAllowsCatalogue, positionProof, workspaceViewPage } from './department-access.js';
import { calculateAedPricePreview, parseStaffWorkspaceCommand, type LocalPricePreviewBasis } from '@nukhbapay/application';

export const PORTAL_COOKIE_NAME="__Host-nukhbapay_staff";
export interface InternalSessionPort {
  validate(token:string):Promise<{readonly ok:boolean;readonly reason?:string}>;
  revoke(token:string):Promise<{readonly ok:boolean;readonly reason?:string}>;
  readProfile?(token:string):Promise<{readonly ok:boolean;readonly reason?:string;
    readonly profile?:{readonly staffId:string;readonly tenantId:string|null;readonly expiresAtMs:number}}>;
  readHistory?(token:string):Promise<{readonly ok:boolean;readonly reason?:string;readonly items?:readonly unknown[]}>;
}
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
const unavailable=()=>new Error("Staff HTTPS portal unavailable");
export function staffCookie(value:string,clear=false):string {
  if(!tokenPattern.test(value) && !(clear && value===""))throw unavailable();
  return `${PORTAL_COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict${clear?"; Max-Age=0":""}`;
}
function sessionCookie(request:IncomingMessage,nameToFind:string=PORTAL_COOKIE_NAME):string|undefined {
  const values=request.headersDistinct['cookie'];
  if(!values || values.length!==1 || values[0]!.length>2048)return undefined;
  let found:string|undefined;
  for(const piece of values[0]!.split(';')) {
    const [name,...rest]=piece.trim().split('=');
    if(name===nameToFind) {
      if(found!==undefined || rest.length!==1 || !tokenPattern.test(rest[0]!))return undefined;
      found=rest[0];
    }
  }
  return found;
}
const landing='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Nukhbapay Staff Portal</title><h1>Nukhbapay Staff Portal</h1><p id="status">Staff sign-in is unavailable.</p><button id="logout" hidden>Sign out</button><script src="/portal.js" defer></script></html>';
const script=`"use strict";let csrf;const status=document.getElementById("status"),button=document.getElementById("logout");
fetch("/auth/session",{credentials:"same-origin",cache:"no-store"}).then(r=>r.ok?r.json():null).then(s=>{if(s?.authenticated===true){csrf=s.csrfToken;status.textContent="Local staff session active.";button.hidden=false;}}).catch(()=>{});
button.addEventListener("click",async()=>{button.disabled=true;try{const r=await fetch("/auth/logout",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":csrf},body:"{}"});let destination;if(r.status===204)destination="/auth/logged-out";else if(r.status===200 && expectedLogoutUrl && (await r.json()).logoutUrl===expectedLogoutUrl)destination=expectedLogoutUrl;else throw new Error();csrf=undefined;window.location.assign(destination);}catch{status.textContent="Sign out could not be confirmed.";button.disabled=false;}});`;

function htmlLogoutPolicy(body:Buffer,destination:string):Buffer {
  const html=body.toString('utf8');
  if(!/<head(?:\s[^>]*)?>/i.test(html) || /name\s*=\s*["']nukhbapay-provider-logout["']/i.test(html))throw unavailable();
  const safe=destination.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  return Buffer.from(html.replace(/<head(?:\s[^>]*)?>/i,head=>`${head}<meta name="nukhbapay-provider-logout" content="${safe}">`));
}

/** Trusted server DI only. CLI supplies neither sessions nor login. */
export async function createStaffPortal(options:{
  readonly pfx:Buffer;readonly certificate:Buffer;readonly passphrase:string;readonly port?:number;readonly sessions?:InternalSessionPort;
  readonly login?:Auth0Login;
  readonly staffCatalogue?: Pick<StaffCatalogueService,"read"> & Partial<Pick<StaffCatalogueService,"available">>;
  readonly staffManagement?: Pick<StaffManagementService,"read"> & Partial<Pick<StaffManagementService,"availableViews">>;
  readonly staffWorkspace?: Pick<StaffWorkspaceService,"availableViews"|"read"|"command">;
  readonly departmentAccess?: Pick<StaffWorkspaceService,'positions'>;
  readonly windowsStaffStorageReady?: () => Promise<boolean>;
  readonly localCataloguePreview?: boolean;
  readonly localPricePreview?: LocalPricePreviewBasis & {readonly tenantId:string;readonly discoveryId:string};
  readonly staffSuspension?: StaffSuspensionPort;
  readonly staffPublication?: StaffPublicationPort;
  readonly platformStaffPilot?: PlatformStaffPilotPort;
  readonly browserAssets?:BrowserAssets;
  readonly environment?:Readonly<Record<string,string|undefined>>;
}) {
  const port=options.port??3001;
  const environment=options.environment??process.env;
  const previewEnabled=developmentPreviewEnabled(environment);
  const workspaceService=options.staffWorkspace;
  const departmentAccess=options.departmentAccess;
  if(options.windowsStaffStorageReady && (!departmentAccess || !options.login || !options.sessions || previewEnabled))throw unavailable();
  if(options.localCataloguePreview && (!options.windowsStaffStorageReady || !options.staffCatalogue?.available ||
      !departmentAccess || environment['NODE_ENV']!=='development' || previewEnabled))throw unavailable();
  if(options.localPricePreview && !options.localCataloguePreview)throw unavailable();
  if(departmentAccess && (!workspaceService || !options.login || options.staffPublication ||
    options.staffSuspension || options.platformStaffPilot))throw unavailable();
  if(workspaceService && (!options.login || options.login.platformScope || !options.sessions ||
      environment['NODE_ENV']!=='development' || previewEnabled))throw unavailable();
  const suspension=options.staffSuspension;
  if (suspension && (!options.login || !options.sessions || suspension.capability!=='DISPOSABLE_STAFF_EFFECT_V1' ||
      environment['NODE_ENV']==='production')) throw unavailable();
  const publication=options.staffPublication;
  if (publication && (!options.login || !options.sessions ||
      publication.authority.capability!=='ISOLATED_SYNTHETIC_PUBLICATION_ONLY' || environment['NODE_ENV']==='production'))
    throw unavailable();
  const platform=options.platformStaffPilot;
  if(platform && (!options.login?.platformScope || !options.sessions || suspension || publication || options.staffCatalogue || options.staffManagement ||
    environment['NODE_ENV']==='production' || !['DISPOSABLE_PLATFORM_STAFF_EFFECT_V1','AUTH0_PLATFORM_STAFF_PILOT_V1'].includes(platform.capability)))
    throw unavailable();
  const platformCommands=platform && options.login ? createPlatformStaffCommandAdmission(options.login,platform) : undefined;
  const commands=(suspension || publication) && options.login ? createStaffCommandAdmission(options.login,suspension,publication) : undefined;
  if(options.login && !options.sessions || (options.staffCatalogue || options.staffManagement) && !options.login)throw unavailable();
  const certificate=validateDevelopmentCertificate(options.certificate);
  if(!Number.isInteger(port)||port<0||port>65535 || !Buffer.isBuffer(options.pfx) || !options.passphrase)throw unavailable();
  let origin="";const csrfKey=randomBytes(32);
  const csrf=(token:string)=>createHmac("sha256",csrfKey).update(token).digest("base64url");
  const sameOrigin=(req:IncomingMessage)=>req.headers.host===new URL(origin).host &&
    (!req.headersDistinct['origin'] || req.headersDistinct['origin'].length===1 && req.headers.origin===origin) &&
    (!req.headersDistinct['sec-fetch-site'] || req.headersDistinct['sec-fetch-site'].length===1 &&
      (req.headers['sec-fetch-site']==='same-origin' || req.method==='GET' && req.headers['sec-fetch-site']==='none'));
  const send=(res:ServerResponse,status:number,body:string|Buffer,type="application/json")=>{
    res.writeHead(status,{"content-type":type+"; charset=utf-8"});res.end(body);
  };
  let server:Server;
  try {
    server=createServer({pfx:options.pfx,passphrase:options.passphrase,minVersion:"TLSv1.2",maxHeaderSize:8192},(req,res)=>{
      res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");
      res.setHeader("Referrer-Policy","no-referrer");
      res.setHeader("Content-Security-Policy","default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      if(options.browserAssets)res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      void (async()=>{
        if(req.headers.host!==new URL(origin).host || req.rawHeaders.length>128 || req.headersDistinct['host']?.length!==1){send(res,400,'{"error":"Invalid request"}');return;}
        // Browsers can carry the provider's cross-site marker through the callback's redirect to the public shell.
        const documentNavigation=req.headersDistinct['sec-fetch-mode']?.length===1 && req.headers['sec-fetch-mode']==='navigate' &&
          req.headersDistinct['sec-fetch-dest']?.length===1 && req.headers['sec-fetch-dest']==='document';
        const signInFailed='/login?sign-in=failed';
        const callback=req.method==='GET' && req.url?.startsWith('/auth/callback?') && options.login;
        const callbackLanding=options.login && req.method==='GET' && documentNavigation &&
          (req.url==='/' || req.url==='/management' || req.url===signInFailed || suspension && req.url==='/staff/commands' ||
            publication && req.url==='/catalogue/publication');
        const providerNavigation=callback || callbackLanding || options.login && req.method==='GET' && req.url==='/auth/logged-out';
        if(!sameOrigin(req) && !(providerNavigation && !req.headersDistinct['origin'] &&
          (!req.headersDistinct['sec-fetch-site'] || req.headersDistinct['sec-fetch-site'].length===1 && ['cross-site','same-site'].includes(String(req.headers['sec-fetch-site']))) &&
          (!req.headersDistinct['sec-fetch-mode'] || req.headersDistinct['sec-fetch-mode'].length===1 && req.headers['sec-fetch-mode']==='navigate') &&
          (!req.headersDistinct['sec-fetch-dest'] || req.headersDistinct['sec-fetch-dest'].length===1 && req.headers['sec-fetch-dest']==='document'))){send(res,403,'{"error":"Request denied"}');return;}
        if(req.method==='HEAD' && req.url==='/health/staff-storage' && options.windowsStaffStorageReady) {
          const ready=await options.windowsStaffStorageReady().catch(()=>false);
          if(ready)res.setHeader('x-nukhbapay-storage','windows-postgresql-staff');
          res.writeHead(ready?204:503).end();
          return;
        }
        if(req.method==='GET' && req.url==='/auth/login' && options.login) {
          const presented=sessionCookie(req);
          let previous=presented;
          if(presented && !options.login.hasLocalSessionIdentity(presented)) previous=undefined;
          else if(presented) {
            const current=await options.sessions!.validate(presented);
            if(!current.ok) {
              if(current.reason!=='DENIED') {send(res,503,'{"error":"Staff sign-in unavailable"}');return;}
              previous=undefined;
            }
          }
          const transaction=options.login.begin(previous,sessionCookie(req,TRANSACTION_COOKIE_NAME));
          res.setHeader('Set-Cookie',presented && previous===undefined
            ?[transaction.cookie,staffCookie('',true)]:transaction.cookie);
          res.writeHead(303,{location:transaction.location});res.end();return;
        }
        if(req.method==='GET' && req.url==='/auth/config') {
          send(res,200,JSON.stringify({loginPath:options.login?'/auth/login':null,...(departmentAccess && {departmentLogin:true})}));return;
        }
        const positionsFor=(token:string)=>options.login!.readForSession(token,(identity,tenantId,staffId,revalidate)=>
          departmentAccess!.positions(identity,tenantId,{staffId,revalidate}));
        const selectedPosition=async(token:string)=>{
          const proof=sessionCookie(req,departmentCookie);
          return proof && departmentAccess ? (await positionsFor(token)).find(row=>positionProof(csrfKey,token,row)===proof) : undefined;
        };
        const checkPage=async(token:string,path:string)=>!departmentAccess || positionAllows(await selectedPosition(token),path);
        if(departmentAccess && req.url==='/auth/position' && req.method==='POST'){
          const token=sessionCookie(req), provided=req.headersDistinct['x-csrf-token'];
          if(!token){send(res,401,'{}');return;}
          if(req.headers.origin!==origin || provided?.length!==1 || !tokenPattern.test(provided[0]!) ||
            !timingSafeEqual(Buffer.from(provided[0]!),Buffer.from(csrf(token))) ||
            req.headersDistinct['content-type']?.length!==1 || req.headers['content-type']!=='application/json'){
            send(res,403,'{}');return;
          }
          const chunks:Buffer[]=[];let length=0;
          for await(const chunk of req){const bytes=Buffer.from(chunk);length+=bytes.length;
            if(length>256){send(res,413,'{}');return;}chunks.push(bytes);}
          let choice;
          try{choice=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{send(res,400,'{}');return;}
          if(!choice || Object.keys(choice).sort().join(',')!=='department,role' ||
            typeof choice.department!=='string'||typeof choice.role!=='string'){send(res,400,'{}');return;}
          const selected=(await positionsFor(token)).find(row=>row.department===choice.department && row.role===choice.role);
          if(!selected){send(res,403,'{}');return;}
          res.setHeader('Set-Cookie',departmentCookie+'='+positionProof(csrfKey,token,selected)+'; Path=/; Secure; HttpOnly; SameSite=Strict');
          res.writeHead(204);res.end();return;
        }
        if(req.method==='GET' && (req.url==='/auth/me' || req.url==='/auth/workspace')) {
          const workspace=req.url==='/auth/workspace';
          if(!options.sessions?.readProfile){send(res,503,'{"error":"Staff profile unavailable"}');return;}
          const token=sessionCookie(req);if(!token){send(res,401,'{"error":"Authentication required"}');return;}
          const clearSession=()=>res.setHeader('Set-Cookie',[staffCookie('',true),
            departmentCookie+'=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0']);
          if(options.login && !options.login.hasLocalSessionIdentity(token)){
            clearSession();send(res,401,'{"error":"Sign in again"}');return;
          }
          const result=await options.sessions.readProfile(token);
          if(!result.ok){
            if(result.reason!=='UNAVAILABLE')clearSession();
            send(res,result.reason==='UNAVAILABLE'?503:401,'{"error":"Staff profile unavailable"}');return;
          }
          const profile=result.profile,uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
          if(!profile || !uuid.test(profile.staffId) || profile.tenantId!==null&&!uuid.test(profile.tenantId) ||
            !Number.isSafeInteger(profile.expiresAtMs)||profile.expiresAtMs<1)throw unavailable();
          const navigation=['/overview'];
          const management=options.staffManagement;
          if (profile.tenantId && options.login && management?.availableViews) {
            const views:readonly ('STAFF'|'AUDIT')[]=await options.login.readForSession(token,(identity,tenantId)=>
              management.availableViews!(identity,tenantId)).catch(()=>[]);
            if (views.includes('STAFF')) navigation.push('/staff');
            if (views.includes('AUDIT')) navigation.push('/audit');
          }
          if (profile.tenantId && options.login && workspaceService) {
            const views=await options.login.readForSession(token,(identity,tenantId,staffId,revalidate)=>
              workspaceService.availableViews(identity,tenantId,{staffId,revalidate})).catch(()=>[]);
            const paths:Record<StaffWorkspaceView,readonly string[]>={
              roles:['/roles'],departments:['/departments'],invitations:['/staff/invite','/access-requests'],
              security:['/security'],sessions:['/sessions'],reports:['/reports'],settings:['/settings'],activity:[],
            };
            for(const view of views)navigation.push(...paths[view]);
          }
          if (profile.tenantId && options.staffCatalogue && (!options.staffCatalogue.available ||
              options.login && await options.login.readForSession(token,(identity,tenantId)=>
                options.staffCatalogue!.available!(identity,tenantId)).catch(()=>false))) navigation.push('/catalogue');
          if (profile.tenantId && suspension) navigation.push('/staff/commands');
          if (profile.tenantId && publication) navigation.push('/catalogue/publication');
          const positions=departmentAccess ? await positionsFor(token):undefined;
          const selected=positions?.find(row=>positionProof(csrfKey,token,row)===sessionCookie(req,departmentCookie));
          send(res,200,JSON.stringify({staffId:profile.staffId,tenantId:profile.tenantId,expiresAtMs:profile.expiresAtMs,
            navigation:positions ? navigation.filter(path=>path==='/overview'||(path==='/catalogue'
              ? positionAllowsCatalogue(selected,'discoveries',options.localCataloguePreview) : positionAllows(selected,path))):navigation,
            ...(workspace && positions && {departmentAccess:{positions:positions.map(({department,role})=>({department,role})),
              selected:selected?{department:selected.department,role:selected.role}:null}}),
            ...(workspace && {csrfToken:csrf(token)})}));return;
        }
        if(req.method==='POST' && options.localCataloguePreview && req.url==='/staff-api/catalogue/price-preview') {
          const token=sessionCookie(req), proof=req.headersDistinct['x-csrf-token'];
          if(!token){send(res,401,'{"error":"Authentication required"}');return;}
          if(req.headersDistinct['authorization'] || req.headersDistinct['origin']?.length!==1 || req.headers.origin!==origin ||
             proof?.length!==1 || !tokenPattern.test(proof[0]!) ||
             !timingSafeEqual(Buffer.from(proof[0]!),Buffer.from(csrf(token))) ||
             req.headersDistinct['content-type']?.length!==1 || req.headers['content-type']!=='application/json') {
            send(res,403,'{"error":"Request denied"}');return;
          }
          try {
            if((await selectedPosition(token))?.role!=='TENANT_STAFF_MANAGER') {
              send(res,403,'{"error":"Request denied"}');return;
            }
            const chunks:Buffer[]=[];let size=0;
            for await(const chunk of req) {
              const bytes=Buffer.from(chunk);
              size+=bytes.length;
              if(size>1024){send(res,413,'{"error":"Request too large"}');return;}
              chunks.push(bytes);
            }
            let input;
            try {input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
            catch {send(res,400,'{"error":"Invalid preview request"}');return;}
            if(!input || typeof input!=='object' || Array.isArray(input) ||
               Object.keys(input).join(',')!=='discoveryId' ||
               typeof input.discoveryId!=='string' || !administrationUuid.test(input.discoveryId)) {
              send(res,400,'{"error":"Invalid preview request"}');return;
            }
            const cost=options.localPricePreview;
            const available=await options.login!.readForSession(token,async (identity,tenantId)=>{
              if(!cost || cost.tenantId!==tenantId || cost.discoveryId!==input.discoveryId)return false;
              const page=await options.staffCatalogue!.read(identity,tenantId,'discoveries',{discoveryId:input.discoveryId,limit:'1'});
              return page.count===1&&page.items.length===1&&page.items[0]?.id===cost.discoveryId;
            });
            if((await selectedPosition(token))?.role!=='TENANT_STAFF_MANAGER') {
              send(res,403,'{"error":"Request denied"}');return;
            }
            if(!available || !cost){send(res,409,'{"error":"Provider cost is unavailable for this product"}');return;}
            send(res,200,JSON.stringify(calculateAedPricePreview(cost)));
          } catch {
            send(res,403,'{"error":"Price preview unavailable"}');
          }
          return;
        }
        if(req.method==='GET' && options.login && options.staffCatalogue && req.url?.startsWith('/staff-api/catalogue/')) {
          const token = sessionCookie(req);
          if (!token) {send(res,401,'{"error":"Authentication required"}');return;}
          const url = new URL(req.url,origin);
          const view = /^\/staff-api\/catalogue\/(countries|services|providers|products|offers|economics|drafts|publications|imports|discoveries|discovery-providers)$/
            .exec(url.pathname)?.[1] as StaffCatalogueView | undefined;
          if (!view || req.url.length>2048 || url.origin!==origin || url.pathname!==req.url.split('?')[0] ||
              url.hash || req.headersDistinct['authorization']) {
            send(res,400,'{"error":"Invalid request"}');return;
          }
          const query:Record<string,string> = Object.create(null) as Record<string,string>;
          for (const [name,value] of url.searchParams) {
            if (Object.hasOwn(query,name) || !['country','group','service','provider','product','search','sort','limit','cursor','sourceCountry','sourceRegion','productType'].includes(name)) {
              send(res,400,'{"error":"Invalid request"}');return;
            }
            query[name]=value;
          }
          try {
            if (departmentAccess && !positionAllowsCatalogue(await selectedPosition(token), view, options.localCataloguePreview)) {
              send(res,403,'{"error":"Catalogue unavailable"}');return;
            }
            const cost=options.localPricePreview;
            const {data,price}=await options.login.readForSession(token,async (identity,tenantId)=>{
              const data=await options.staffCatalogue!.read(identity,tenantId,view,query);
              const price=view==='discoveries' && cost?.tenantId===tenantId &&
                data.items.some(item=>item.id===cost.discoveryId) ? calculateAedPricePreview(cost) : undefined;
              return {data,price};
            });
            const positionAfterRead=departmentAccess ? await selectedPosition(token) : undefined;
            if (departmentAccess && !positionAllowsCatalogue(positionAfterRead, view, options.localCataloguePreview)) {
              send(res,403,'{"error":"Catalogue unavailable"}');return;
            }
            const previewCapability=view==='discovery-providers' && options.localCataloguePreview && positionAfterRead?.role==='TENANT_STAFF_MANAGER';
            if(price && cost && positionAfterRead?.role==='TENANT_STAFF_MANAGER') {
              const items=data.items.map(item=>item.id===cost.discoveryId?{...item,sellingPricePreview:price.indicativePrice}:item);
              send(res,200,JSON.stringify({...data,items}));
            } else {
              send(res,200,JSON.stringify(previewCapability?{...data,pricingPreviewAvailable:true}:data));
            }
          } catch (error) {
            send(res,error instanceof AdministrationError ? error.status : 403,'{"error":"Catalogue unavailable"}');
          }
          return;
        }
        if(req.method==='GET' && options.login && options.staffManagement && req.url &&
            /^\/staff-api\/(?:staff(?:[/?]|$)|audit(?:[?]|$))/.test(req.url)) {
          const token = sessionCookie(req);
          if (!token) {send(res,401,'{"error":"Authentication required"}');return;}
          const url = new URL(req.url,origin);
          const staff = /^\/staff-api\/staff(?:\/([^/]+))?$/.exec(url.pathname);
          const audit = url.pathname==='/staff-api/audit';
          const staffId = staff?.[1];
          if(!await checkPage(token,audit?'/audit':'/staff')){send(res,403,'{}');return;}
          if ((!audit && !staff) || staffId && !administrationUuid.test(staffId) ||
              req.url.length>2048 || url.origin!==origin || url.pathname!==req.url.split('?')[0] ||
              url.hash || req.headersDistinct['authorization']) {
            send(res,400,'{"error":"Invalid request"}');return;
          }
          const query:Record<string,string> = Object.create(null) as Record<string,string>;
          for (const [name,value] of url.searchParams) {
            if (Object.hasOwn(query,name) || !['limit','after'].includes(name)) {
              send(res,400,'{"error":"Invalid request"}');return;
            }
            query[name]=value;
          }
          try {
            const data = await options.login.readForSession(token,(identity,tenantId)=>
              options.staffManagement!.read(identity,tenantId,audit?'AUDIT':'STAFF',query,staffId));
            if(!await checkPage(token,audit?'/audit':'/staff')){send(res,403,'{}');return;}
            send(res,200,JSON.stringify(data));
          } catch (error) {
            send(res,error instanceof AdministrationError ? error.status : 403,'{"error":"Staff data unavailable"}');
          }
          return;
        }
        if(workspaceService && options.login && (req.url==='/staff-api/workspace' || req.url?.startsWith('/staff-api/workspace/'))) {
          const token=sessionCookie(req);
          if(!token){send(res,401,'{"error":"Authentication required"}');return;}
          if(req.headersDistinct['authorization']){send(res,400,'{"error":"Invalid request"}');return;}
          const login=options.login;
          try {
            if(req.method==='GET') {
              const requested=req.url.slice('/staff-api/workspace/'.length);
              const view=staffWorkspaceViews.find(candidate=>candidate===requested);
              if(!view){send(res,404,'{"error":"Not found"}');return;}
                const page=workspaceViewPage[view];
                if(!await checkPage(token,page)){send(res,403,'{}');return;}
              const data=await login.readForSession(token,async(identity,tenantId,staffId,revalidate)=>{
                const value=await workspaceService.read(identity,tenantId,{staffId,revalidate},view);
                  if(view==='roles' && departmentAccess && 'roles' in value && !await checkPage(token,'/staff')){
                    return {roles:value.roles.filter(role=>role.assigned)};
                  }
                if(view!=='sessions' || !options.sessions?.readHistory)return value;
                const history=await options.sessions.readHistory(token);
                if(!history.ok)throw new AdministrationError(history.reason==='UNAVAILABLE'?503:403);
                return {currentSession:true,items:history.items};
              });
                if(!await checkPage(token,page)){send(res,403,'{}');return;}
                send(res,200,JSON.stringify(data));
              return;
            }
            const provided=req.headersDistinct['x-csrf-token'];
            if(req.method!=='POST' || req.url!=='/staff-api/workspace' ||
                req.headersDistinct['origin']?.length!==1 || req.headers.origin!==origin ||
                provided?.length!==1 || !tokenPattern.test(provided[0]!) ||
                !timingSafeEqual(Buffer.from(provided[0]!),Buffer.from(csrf(token))) ||
                req.headersDistinct['content-type']?.length!==1 || req.headers['content-type']!=='application/json'){
              send(res,403,'{"error":"Request denied"}');return;
            }
            const chunks:Buffer[]=[];
            let size=0;
            for await(const chunk of req) {
              const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
              size+=bytes.length;
              if(size>4096){send(res,413,'{"error":"Request too large"}');return;}
              chunks.push(bytes);
            }
            let input:unknown;
            try {input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
            catch {send(res,400,'{"error":"Invalid request"}');return;}
              const command=parseStaffWorkspaceCommand(input);
              const page=command.action==='save-settings'?'/settings':command.action.endsWith('-department')?'/departments':'/staff/invite';
              if(!await checkPage(token,page)){send(res,403,'{}');return;}
              await login.readForSession(token,(identity,tenantId,staffId,revalidate)=>
                workspaceService.command(identity,tenantId,{staffId,revalidate:async()=>await revalidate() && await checkPage(token,page)},command));
            send(res,204,'');
          } catch(error) {
            send(res,error instanceof AdministrationError?error.status:403,'{"error":"Staff workspace unavailable"}');
          }
          return;
        }
        const commandRoute=/^\/staff-api\/commands\/(suspension|publication|platform-security)(\/confirm)?$/.exec(req.url??'');
        const publicationRoute=commandRoute?.[1]==='publication';
        const platformRoute=commandRoute?.[1]==='platform-security';
        if(commandRoute && (platformRoute ? platformCommands : commands && (publicationRoute ? publication : suspension))) {
          const token=sessionCookie(req),provided=req.headersDistinct['x-csrf-token'];
          if (!token) {send(res,401,'{"state":"EXPIRED_SESSION"}');return;}
          if (req.headersDistinct['authorization']) {send(res,403,'{"state":"FORBIDDEN"}');return;}
          if (req.method==='GET' && !commandRoute[2]) {
            try {send(res,200,JSON.stringify(platformRoute ? await platformCommands!.describe(token) : await commands!.describe(token,publicationRoute)));}
            catch {send(res,401,'{"state":"EXPIRED_SESSION"}');}
            return;
          }
          if (req.method!=='POST' || req.headersDistinct['origin']?.length!==1 || req.headers.origin!==origin ||
              provided?.length!==1 || !tokenPattern.test(provided[0]!) ||
              !timingSafeEqual(Buffer.from(provided[0]!),Buffer.from(csrf(token))) ||
              req.headersDistinct['content-type']?.length!==1 || req.headers['content-type']!=='application/json') {
            send(res,403,'{"state":"FORBIDDEN"}');return;
          }
          let body='';
          for await (const chunk of req) {
            body+=chunk.toString();
            if (Buffer.byteLength(body)>1024) {send(res,413,'{"error":"Request too large"}');return;}
          }
          let input:unknown;
          try {input=JSON.parse(body);} catch {send(res,400,'{"error":"Invalid request"}');return;}
          if (!input || typeof input!=='object' || Array.isArray(input)) {send(res,400,'{"error":"Invalid request"}');return;}
          const checked=await options.sessions!.validate(token);
          if (!checked.ok) {send(res,checked.reason==='UNAVAILABLE'?503:401,'{"state":"EXPIRED_SESSION"}');return;}
          if (commandRoute[2]) {
            if (Object.keys(input).length) {send(res,400,'{"error":"Invalid request"}');return;}
            try {
              const outcome=platformRoute ? await platformCommands!.confirm(token) : {state:await commands!.execute(token,publicationRoute)};
              const {state}=outcome;
              const status=state==='DENIED'?403:state==='STEP_UP_REQUIRED'?428:state==='UNRESOLVED'?503:200;
              send(res,status,JSON.stringify(outcome));
            } catch {send(res,403,'{"state":"FORBIDDEN"}');}
            return;
          }
          const candidate=input as Record<string,unknown>;
          if(platformRoute) {
            if(Object.keys(candidate).length!==1 || typeof candidate['actionId']!=='string' || !administrationUuid.test(candidate['actionId'])) {
              send(res,400,'{"error":"Invalid request"}');return;
            }
            try {
              const result=await platformCommands!.begin(token,candidate['actionId'],sessionCookie(req,TRANSACTION_COOKIE_NAME));
              if(!result){send(res,403,'{"state":"FORBIDDEN"}');return;}
              res.setHeader('Set-Cookie',result.cookie);
              send(res,200,JSON.stringify({state:'STEP_UP_REQUIRED',location:result.location}));
            } catch {send(res,403,'{"state":"FORBIDDEN"}');}
            return;
          }
          if (publicationRoute) {
            if (Object.hasOwn(candidate,'tenantId')) {send(res,400,'{"error":"Invalid request"}');return;}
            try {
              const result=await commands!.beginPublication(token,candidate,sessionCookie(req,TRANSACTION_COOKIE_NAME));
              if(!result){send(res,403,'{"state":"FORBIDDEN"}');return;}
              res.setHeader('Set-Cookie',result.cookie);
              send(res,200,JSON.stringify({state:'STEP_UP_REQUIRED',location:result.location}));
            } catch {send(res,403,'{"state":"FORBIDDEN"}');}
            return;
          }
          const {requestId,idempotencyKey,decision}=candidate;
          const validShape=Object.hasOwn(candidate,'decision')
            ? Object.keys(input).length===3 && (decision==='APPROVE'||decision==='REJECT')
            : Object.keys(input).length===2;
          if (!validShape || typeof requestId!=='string'||!administrationUuid.test(requestId) ||
              typeof idempotencyKey!=='string'||!administrationUuid.test(idempotencyKey)) {
            send(res,400,'{"error":"Invalid request"}');return;
          }
          try {
            const result=await commands!.begin(token,requestId,idempotencyKey,sessionCookie(req,TRANSACTION_COOKIE_NAME),
              decision==='APPROVE'||decision==='REJECT' ? decision : undefined);
            if (!result) {send(res,403,'{"state":"FORBIDDEN"}');return;}
            res.setHeader('Set-Cookie',result.cookie);
            send(res,200,JSON.stringify({state:'STEP_UP_REQUIRED',location:result.location}));
          } catch {send(res,403,'{"state":"FORBIDDEN"}');}
          return;
        }
        if(callback) {
          const rawTransaction=sessionCookie(req,TRANSACTION_COOKIE_NAME), existing=sessionCookie(req);
          try {
            const result=platformCommands ? await platformCommands.callback(req.url!,rawTransaction,existing) :
              commands ? await commands.callback(req.url!,rawTransaction,existing) :
              {token:await options.login!.complete(req.url!,rawTransaction,existing),redirect:'/'};
            res.setHeader('Set-Cookie',[transactionCookie('',true),staffCookie(result.token)]);
            res.writeHead(303,{location:result.redirect});res.end();
          }catch{
            if(!options.login!.hasPendingLogin(rawTransaction))res.setHeader('Set-Cookie',transactionCookie('',true));
            if(documentNavigation && options.browserAssets){res.writeHead(303,{location:signInFailed});res.end();}
            else send(res,401,'{"error":"Staff authentication failed"}');
          }
          return;
        }
        if(req.method==='GET' && options.browserAssets && req.url){
          const asset=browserAsset(options.browserAssets,req.url,previewEnabled);
          if(asset){send(res,200,asset.type==='text/html' && options.login?htmlLogoutPolicy(asset.body,options.login.logoutUrl):asset.body,asset.type);return;}
        }
        if(!options.browserAssets && req.method==="GET" && (req.url==="/" || req.url==="/auth/logged-out")){send(res,200,landing,"text/html");return;}
        if(req.method==="GET" && req.url==="/portal.js"){send(res,200,`const expectedLogoutUrl=${JSON.stringify(options.login?.logoutUrl??null)};\n${script}`,"text/javascript");return;}
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
          // Cancel before awaiting persistence, so a pending callback cannot finish during revocation.
          options.login?.cancel(sessionCookie(req,TRANSACTION_COOKIE_NAME));
          commands?.forget(token);
          platformCommands?.forget(token);
          const result=await options.sessions.revoke(token);
          if(!result.ok){send(res,503,'{"error":"Sign out not confirmed"}');return;}
          options.login?.forgetSession(token);
          res.setHeader("Set-Cookie",[staffCookie("",true),transactionCookie('',true)]);
          if(options.login)send(res,200,JSON.stringify({logoutUrl:options.login.logoutUrl}));else send(res,204,"");return;
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
  if(options.login && options.login.origin!==origin){await new Promise<void>(resolve=>server.close(()=>resolve()));throw unavailable();}
  try {
    // Strict certificate/hostname/expiry verification also proves the PFX matches the reviewed public certificate.
    await probeDevelopmentHttps(address.port,certificate);
  }catch{await new Promise<void>(resolve=>server.close(()=>resolve()));throw unavailable();}
  let closing:Promise<void>|undefined;
  return Object.freeze({origin,close:()=>closing??=new Promise<void>((resolve,reject)=>{commands?.close();platformCommands?.close();options.login?.close();server.close(error=>error?reject(unavailable()):resolve());server.closeIdleConnections();})});
}
