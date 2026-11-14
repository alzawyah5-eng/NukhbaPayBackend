import { Controller, Get, Req, HttpException, type ExecutionContext } from "@nestjs/common";
import type { Request, Response } from "express";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWK } from "jose";
import { attestCatalogueClient, CATALOGUE_AUDIENCES, CatalogueAccessError } from "@nukhbapay/application";
import type { CatalogueClientIdentity, CatalogueClientKind, PublishedCataloguePage, PublishedCatalogueService } from "@nukhbapay/application";
import { readBearerAuthorization } from "../identity/authorization-header.js";

const replies=new WeakMap<Request,PublishedCataloguePage>();
function reply(request:Request){const r=replies.get(request);replies.delete(request);if(!r)throw new HttpException("Unavailable",503);return r;}
@Controller()
export class PublishedCatalogueController {
 @Get("v1/payment/catalogue") payment(@Req() request:Request){return reply(request);}
 @Get("v1/payment/catalogue/:productId") paymentProduct(@Req() request:Request){return reply(request);}
 @Get("v1/kiosks/:kioskId/catalogue") kiosk(@Req() request:Request){return reply(request);}
 @Get("v1/kiosks/:kioskId/catalogue/:productId") kioskProduct(@Req() request:Request){return reply(request);}
}
export function isPublishedCatalogueHandler(context:ExecutionContext):boolean {
 return context.getType()==="http"&&context.getClass()===PublishedCatalogueController&&[PublishedCatalogueController.prototype.payment,PublishedCatalogueController.prototype.paymentProduct,PublishedCatalogueController.prototype.kiosk,PublishedCatalogueController.prototype.kioskProduct].includes(context.getHandler() as typeof PublishedCatalogueController.prototype.payment);
}
export class CatalogueCredentialError extends Error {constructor(){super("Invalid catalogue credential");}}
/** Synthetic trusted keys only; no token-selected JWKS URL, browser secret or production activation. */
export class SyntheticCatalogueTokenVerifier {
 readonly #keys;readonly #issuer:string;readonly #now:()=>Date;
 constructor(config:{issuer:string;keys:readonly JWK[];now:()=>Date}){
  const u=new URL(config.issuer);
  if(u.protocol!=="https:"||!u.hostname.endsWith(".invalid")||u.username||u.password||u.search||u.hash||config.keys.length<1||config.keys.length>8||new Set(config.keys.map(k=>k.kid)).size!==config.keys.length||config.keys.some(k=>k.kty!=="RSA"||k.alg!=="RS256"||k.use!=="sig"||!k.kid||k.kid.length>128||"d" in k))throw new Error("Invalid synthetic catalogue verifier");
  this.#issuer=config.issuer;this.#keys=createLocalJWKSet({keys:config.keys.map(k=>({...k}))});this.#now=config.now;
 }
 async verify(token:string,kind:CatalogueClientKind):Promise<CatalogueClientIdentity>{
  const currentDate=this.#now();if(!Number.isFinite(currentDate.getTime()))throw new Error("Catalogue verifier unavailable");
  try{
   if(token.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw new Error();
   const h=decodeProtectedHeader(token);
   if(h.alg!=="RS256"||h.typ!=="at+jwt"||typeof h.kid!=="string"||h.kid.length>128||["jku","x5u","jwk","x5c","crit","b64","cty"].some(k=>k in h))throw new Error();
   const {payload:p}=await jwtVerify(token,this.#keys,{issuer:this.#issuer,audience:CATALOGUE_AUDIENCES[kind],algorithms:["RS256"],typ:"at+jwt",requiredClaims:["iss","sub","aud","iat","exp","jti","client_id","client_kind","client_profile","principal_kind","scope"],maxTokenAge:300,currentDate});
   const text=(v:unknown):v is string=>typeof v==="string"&&v.length>0&&v.length<=512&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
   if(!text(p.sub)||!text(p["client_id"])||!text(p["scope"])||!text(p.jti)||p.aud!==CATALOGUE_AUDIENCES[kind]||p["client_kind"]!==kind||p["client_profile"]!=="synthetic-catalogue-client-v1"||p["principal_kind"]!=="machine"||
    !Number.isSafeInteger(p.iat)||!Number.isSafeInteger(p.exp)||p.exp!<=p.iat!||p.exp!-p.iat!>300||["roles","permissions","tenant_id","kiosk_id","staff_id","act","may_act","azp"].some(k=>k in p))throw new Error();
   return attestCatalogueClient({issuer:this.#issuer,subject:p.sub,clientId:p["client_id"],kind,audience:CATALOGUE_AUDIENCES[kind],scope:p["scope"],issuedAt:p.iat!,expiresAt:p.exp!});
  }catch{throw new CatalogueCredentialError();}
 }
}
export interface CatalogueHttpDependencies {readonly verifier:{verify(token:string,kind:CatalogueClientKind):Promise<CatalogueClientIdentity>};readonly service:PublishedCatalogueService;readonly now?:()=>Date;}
export class PublishedCatalogueHttpBoundary {
 readonly #identities=new WeakMap<Request,CatalogueClientIdentity>();
 readonly #ingress=new Map<string,{at:number;count:number}>();
 constructor(private readonly deps?:CatalogueHttpDependencies){}
 async authenticate(context:ExecutionContext){
  const request=context.switchToHttp().getRequest<Request>(),response=context.switchToHttp().getResponse<Response>();
  response.setHeader("Cache-Control","no-store");
  this.#identities.delete(request);replies.delete(request);
  if(request.method!=="GET")throw new HttpException("Unavailable",403);
  const now=(this.deps?.now?.()??new Date()).getTime();if(!Number.isFinite(now))throw new HttpException("Unavailable",503);
  for(const [k,r] of this.#ingress)if(now-r.at>=60000)this.#ingress.delete(k);
  const key=request.socket.remoteAddress??"unknown";let rate=this.#ingress.get(key);
  if(!rate){if(this.#ingress.size>=1024)throw new HttpException("Unavailable",429);rate={at:now,count:0};this.#ingress.set(key,rate);}
  if(++rate.count>240)throw new HttpException("Unavailable",429);
  if(request.originalUrl.length>1024||request.headers["transfer-encoding"]!==undefined||(request.headers["content-length"]!==undefined&&request.headers["content-length"]!=="0"))throw new HttpException("Unavailable",400);
  let token:string;try{token=readBearerAuthorization(request.rawHeaders);}catch{throw new HttpException("Unavailable",401);}
  if(!this.deps)throw new HttpException("Unavailable",503);
  const kind=context.getHandler()===PublishedCatalogueController.prototype.payment||context.getHandler()===PublishedCatalogueController.prototype.paymentProduct?"payment":"kiosk";
  try{this.#identities.set(request,await this.deps.verifier.verify(token,kind));}catch(e){throw new HttpException("Unavailable",e instanceof CatalogueCredentialError?401:503);}
  return true;
 }
 async authorize(context:ExecutionContext){
  const request=context.switchToHttp().getRequest<Request>(),identity=this.#identities.get(request);this.#identities.delete(request);
  if(!identity||!this.deps)throw new HttpException("Unavailable",503);
  const kind=context.getHandler()===PublishedCatalogueController.prototype.payment||context.getHandler()===PublishedCatalogueController.prototype.paymentProduct?"payment":"kiosk";
  const uuid="[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const path=request.originalUrl.split("?",1)[0]!;
  if(!new RegExp(kind==="payment"?`^/v1/payment/catalogue(?:/${uuid})?$`:`^/v1/kiosks/${uuid}/catalogue(?:/${uuid})?$`).test(path))throw new HttpException("Unavailable",400);
  const params=new URL(request.originalUrl,"http://catalogue.invalid").searchParams,q:Record<string,string>={};
  for(const [key,value] of params){if(!["limit","cursor"].includes(key)||Object.hasOwn(q,key))throw new HttpException("Unavailable",400);q[key]=value;}
  try{
   const result=await this.deps.service.read(identity,{kind,...(kind==="kiosk"?{kioskId:request.params["kioskId"] as string}:{}),...(request.params["productId"]===undefined?{}:{productId:request.params["productId"] as string}),query:q});
   replies.set(request,result);return true;
  }catch(e){throw new HttpException("Unavailable",e instanceof CatalogueAccessError?e.status:503);}
 }
}
