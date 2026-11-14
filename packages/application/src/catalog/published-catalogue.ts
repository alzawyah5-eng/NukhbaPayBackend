import { createHash, randomBytes, randomUUID } from "node:crypto";
import { formatAed } from "../../../domain/src/index.js";
export type CatalogueClientKind="payment"|"kiosk";
export const CATALOGUE_AUDIENCES=Object.freeze({payment:"urn:nukhbapay:synthetic:payment-catalogue",kiosk:"urn:nukhbapay:synthetic:kiosk-catalogue"});
export const CATALOGUE_SCOPES=Object.freeze({payment:"catalog.published.read:payment",kiosk:"catalog.published.read:kiosk"});
export interface CatalogueClientIdentity {readonly issuer:string;readonly subject:string;readonly clientId:string;readonly kind:CatalogueClientKind;readonly audience:string;readonly scope:string;readonly issuedAt:number;readonly expiresAt:number;}
const identities=new WeakSet<object>();
/** Trusted signature-verifier adapters only. This factory does not verify tokens. */
export function attestCatalogueClient(e:CatalogueClientIdentity):CatalogueClientIdentity {const v=Object.freeze({...e});identities.add(v);return v;}
export interface CatalogueClientBinding {readonly issuer:string;readonly subject:string;readonly clientId:string;readonly kind:CatalogueClientKind;readonly tenantId:string;readonly kioskId:string|null;readonly scope:string;readonly enabled:boolean;readonly version:string;}
export interface CatalogueBindingRepository {find(identity:CatalogueClientIdentity):Promise<CatalogueClientBinding|null>;}
export interface CatalogueRow {readonly productId:string;readonly name:string;readonly publicationId:string;readonly totalMinor:string;readonly validUntil:string;}
export interface CatalogueReadTicket {readonly tenantId:string;readonly nowMs:number;revalidate():Promise<boolean>;}
const tickets=new WeakSet<object>();
export function consumeCatalogueReadTicket(value:unknown):CatalogueReadTicket {if(typeof value!=="object"||value===null||!tickets.has(value))throw new Error("Untrusted catalogue read");tickets.delete(value);return value as CatalogueReadTicket;}
export interface CatalogueReader {read(ticket:CatalogueReadTicket):Promise<readonly CatalogueRow[]>;}
export interface CatalogueReadAudit {readonly requestId:string;readonly tenantId:string;readonly clientDigest:string;readonly kind:CatalogueClientKind;readonly kioskId:string|null;readonly catalogueVersion:string;readonly occurredAt:string;}
export interface CatalogueAuditWriter {append(event:CatalogueReadAudit):Promise<void>;}
export class CatalogueAccessError extends Error {constructor(readonly status:400|401|403|404|409|429|503){super("Catalogue request unavailable");}}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
export interface PublicCatalogueProduct {readonly product_id:string;readonly name:string;readonly category:"DIGITAL_PIN";readonly price_status:"INDICATIVE";readonly catalog_version:string;readonly display_total:string;readonly currency:"AED";}
export interface PublishedCataloguePage {readonly catalogue_version:string;readonly items:readonly PublicCatalogueProduct[];readonly next_cursor:string|null;}
/** Fail-closed, fixture-only composition; no browser enrollment, environment toggle or operational client registry. */
export class PublishedCatalogueService {
 readonly #cursors=new Map<string,{binding:string;version:string;after:string;limit:number;expires:number}>();
 readonly #rates=new Map<string,{start:number;count:number}>();
 constructor(private readonly deps:{capability:"SYNTHETIC_PUBLISHED_CATALOGUE_ONLY";bindings:CatalogueBindingRepository;reader:CatalogueReader;audit:CatalogueAuditWriter;now:()=>Date;requestsPerMinute?:number}){
  if(deps.capability!=="SYNTHETIC_PUBLISHED_CATALOGUE_ONLY"||!Number.isSafeInteger(deps.requestsPerMinute??60)||(deps.requestsPerMinute??60)<1||(deps.requestsPerMinute??60)>200)throw new Error("Invalid catalogue composition");
 }
 async read(identity:CatalogueClientIdentity,input:{kind:CatalogueClientKind;kioskId?:string;productId?:string;query:Readonly<Record<string,unknown>>}):Promise<PublishedCataloguePage>{
  try{return await this.#read(identity,input);}catch(e){if(e instanceof CatalogueAccessError)throw e;throw new CatalogueAccessError(503);}
 }
 async #read(identity:CatalogueClientIdentity,input:{kind:CatalogueClientKind;kioskId?:string;productId?:string;query:Readonly<Record<string,unknown>>}):Promise<PublishedCataloguePage>{
  const clock=()=>{const n=this.deps.now().getTime();if(!Number.isFinite(n))throw new CatalogueAccessError(503);return n;};
  if(!identity||!identities.has(identity))throw new CatalogueAccessError(401);
  const resolve=async()=>{
   const now=clock();
   if(!Number.isSafeInteger(identity.issuedAt)||!Number.isSafeInteger(identity.expiresAt)||now<identity.issuedAt*1000||now>=identity.expiresAt*1000||identity.kind!==input.kind||identity.audience!==CATALOGUE_AUDIENCES[input.kind]||!new URL(identity.issuer).hostname.endsWith(".invalid"))throw new CatalogueAccessError(401);
   const b=await this.deps.bindings.find(identity);
   if(!b||!b.enabled||b.issuer!==identity.issuer||b.subject!==identity.subject||b.clientId!==identity.clientId||b.kind!==input.kind||!uuid.test(b.tenantId)||!/^([1-9][0-9]{0,18})$/.test(b.version)||
    identity.scope!==CATALOGUE_SCOPES[input.kind]||b.scope!==CATALOGUE_SCOPES[input.kind]||
    (input.kind==="payment"?(b.kioskId!==null||input.kioskId!==undefined):(!b.kioskId||!uuid.test(b.kioskId)||b.kioskId!==input.kioskId)))throw new CatalogueAccessError(403);
   return Object.freeze({...b});
  };
  const binding=await resolve(),bindingStamp=hash(binding),now=clock(),clientKey=hash([binding.issuer,binding.subject,binding.clientId,binding.kind,binding.tenantId,binding.kioskId]);
  for(const [k,r] of this.#rates)if(now-r.start>=60000)this.#rates.delete(k);
  let rate=this.#rates.get(clientKey);if(!rate){if(this.#rates.size>=1000)throw new CatalogueAccessError(503);rate={start:now,count:0};this.#rates.set(clientKey,rate);}
  if(++rate.count>(this.deps.requestsPerMinute??60))throw new CatalogueAccessError(429);
  const q=input.query;
  if(Object.keys(q).some(k=>k!=="limit"&&k!=="cursor")||(input.productId!==undefined&&(!uuid.test(input.productId)||Object.keys(q).length!==0)))throw new CatalogueAccessError(400);
  const limit=q["limit"]===undefined?20:typeof q["limit"]==="string"&&/^[1-9][0-9]?$/.test(q["limit"])?Number(q["limit"]):0;
  if(limit<1||limit>50)throw new CatalogueAccessError(400);
  if(q["cursor"]!==undefined&&(typeof q["cursor"]!=="string"||!/^([0-9a-f]{64})$/.test(q["cursor"])))throw new CatalogueAccessError(400);
  const continuation=typeof q["cursor"]==="string"?this.#cursors.get(q["cursor"]):undefined;
  if(q["cursor"]!==undefined){if(!continuation||continuation.binding!==bindingStamp||continuation.limit!==limit||now>=continuation.expires)throw new CatalogueAccessError(409);this.#cursors.delete(q["cursor"] as string);}
  const fresh=async()=>{try{return hash(await resolve())===bindingStamp;}catch{return false;}};
  const ticket=Object.freeze({tenantId:binding.tenantId,nowMs:now,revalidate:fresh});tickets.add(ticket);
  let rows:readonly CatalogueRow[];try{rows=await this.deps.reader.read(ticket);}finally{tickets.delete(ticket);}
  if(!Array.isArray(rows)||rows.length>1000)throw new CatalogueAccessError(503);
  // Reconstruct an allowlist before awaiting audit; never serialize arbitrary adapter objects.
  const safe=rows.map(r=>{
   if(!uuid.test(r.productId)||!uuid.test(r.publicationId)||typeof r.name!=="string"||!r.name.trim()||r.name.length>128||typeof r.totalMinor!=="string"||!/^[1-9][0-9]{0,18}$/.test(r.totalMinor)||!Number.isFinite(Date.parse(r.validUntil))||Date.parse(r.validUntil)<=now)throw new CatalogueAccessError(503);
   return Object.freeze({product_id:r.productId,name:r.name,category:"DIGITAL_PIN" as const,price_status:"INDICATIVE" as const,catalog_version:r.publicationId,display_total:formatAed(BigInt(r.totalMinor)),currency:"AED" as const});
  }).sort((a,b)=>a.product_id<b.product_id?-1:a.product_id>b.product_id?1:0);
  if(new Set(safe.map(r=>r.product_id)).size!==safe.length)throw new CatalogueAccessError(503);
  const version=hash(safe);
  if(continuation&&continuation.version!==version)throw new CatalogueAccessError(409);
  const visible=input.productId?safe.filter(r=>r.product_id===input.productId):safe.filter(r=>!continuation||r.product_id>continuation.after);
  if(input.productId&&visible.length===0)throw new CatalogueAccessError(404);
  const items=Object.freeze(visible.slice(0,limit));
  if(!await fresh())throw new CatalogueAccessError(403);
  await this.deps.audit.append(Object.freeze({requestId:randomUUID(),tenantId:binding.tenantId,clientDigest:clientKey,kind:binding.kind,kioskId:binding.kioskId,catalogueVersion:version,occurredAt:this.deps.now().toISOString()}));
  if(!await fresh()||rows.some(r=>Date.parse(r.validUntil)<=clock()))throw new CatalogueAccessError(403);
  let next:string|null=null;
  for(const [key,c] of this.#cursors)if(clock()>=c.expires)this.#cursors.delete(key);
  if(visible.length>limit){if(this.#cursors.size>=1000)throw new CatalogueAccessError(503);next=randomBytes(32).toString("hex");this.#cursors.set(next,{binding:bindingStamp,version,after:items.at(-1)!.product_id,limit,expires:Math.min(now+60000,identity.expiresAt*1000)});}
  return Object.freeze({catalogue_version:version,items,next_cursor:next});
 }
}
