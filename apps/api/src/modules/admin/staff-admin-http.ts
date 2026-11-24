import {Controller,Get,Post,Req,HttpCode,HttpException,type ExecutionContext} from '@nestjs/common';
import type {Request,Response} from 'express';
import {AdministrationError,administrationUuid, type StaffManagementService,type StaffRequestCommand} from '@nukhbapay/application';
import {verifiedRequestIdentity} from '../identity/staff-request-context.js';
const results=new WeakMap<Request,unknown>();
const reply=(request:Request)=>{if(!results.has(request))throw new HttpException('Unavailable',503);const value=results.get(request);results.delete(request);return value;};
@Controller('v1/admin/tenants/:tenantId')
export class StaffAdministrationController {
  @Get('staff') list(@Req() request:Request){return reply(request);}
  @Get('staff/:staffId') profile(@Req() request:Request){return reply(request);}
  @Get('audit') audit(@Req() request:Request){return reply(request);}
  @Post('staff/requests') @HttpCode(202) request(@Req() request:Request){return reply(request);}
}
const handlers=[StaffAdministrationController.prototype.list,StaffAdministrationController.prototype.profile,StaffAdministrationController.prototype.audit,StaffAdministrationController.prototype.request];
export function isStaffAdministrationHandler(context:ExecutionContext){return context.getType()==='http'&&context.getClass()===StaffAdministrationController&&handlers.includes(context.getHandler() as typeof handlers[number]);}
export function parseStaffAdministrationCommand(input:unknown):StaffRequestCommand {
  const bad=()=>new AdministrationError(400);
  if(!input||typeof input!=='object'||Array.isArray(input))throw bad();
  const b=input as Record<string,unknown>,keys=['key','id','version','previousDigest','targetStaffId','operation','proposedRoles','expectedAuthzVersion','expectedMembershipVersion','expiresAtMs'];
  if(Object.keys(b).length!==keys.length||Object.keys(b).some(k=>!keys.includes(k)))throw bad();
  const version=(v:unknown)=>{if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(v)||BigInt(v)>9223372036854775807n)throw bad();return BigInt(v);};
  const operation=b['operation'];if(!operation||typeof operation!=='object'||Array.isArray(operation))throw bad();
  const op=operation as Record<string,unknown>;
  if(Object.keys(op).some(k=>!['kind','target','grantId'].includes(k)))throw bad();
  return {kind:'SUBMIT',key:b['key'],id:b['id'],version:version(b['version']),previousDigest:b['previousDigest'],targetStaffId:b['targetStaffId'],operation:op,
    proposedRoles:b['proposedRoles'],expectedAuthzVersion:version(b['expectedAuthzVersion']),expectedMembershipVersion:b['expectedMembershipVersion']===null?null:version(b['expectedMembershipVersion']),expiresAtMs:b['expiresAtMs']} as StaffRequestCommand;
}
export class StaffAdministrationHttpBoundary {
  constructor(private readonly service?:StaffManagementService){}
  async authorize(context:ExecutionContext){
    const request=context.switchToHttp().getRequest<Request>(),response=context.switchToHttp().getResponse<Response>();results.delete(request);response.setHeader('Cache-Control','no-store');
    const identity=verifiedRequestIdentity(request);if(!identity)throw new HttpException('Unavailable',401);
    const submit=context.getHandler()===StaffAdministrationController.prototype.request;
    if(request.method!==(submit?'POST':'GET')||request.headers['cookie']!==undefined||request.headers['origin']!==undefined)throw new HttpException('Unavailable',403);
    if(!this.service)throw new HttpException('Unavailable',503);
    if(request.originalUrl.length>2048)throw new HttpException('Unavailable',400);
    const tenant=request.params['tenantId'];if(typeof tenant!=='string'||!administrationUuid.test(tenant))throw new HttpException('Unavailable',400);
    try {
      if(submit){
        if(request.url.includes('?')||request.headersDistinct['content-type']?.length!==1||request.headers['content-type']!=='application/json')throw new AdministrationError(400);
        const result=await this.service.request(identity,tenant,parseStaffAdministrationCommand(request.body));
        if(!['RECORDED','REPLAYED'].includes(result.kind))throw new AdministrationError(result.kind==='CONFLICT'?409:result.kind==='DENIED'?403:503);
        response.status(202);results.set(request,result);
      } else {
        const query:Record<string,string>={};for(const [key,value] of new URL(request.originalUrl,'http://admin.invalid').searchParams){if(!['limit','after'].includes(key)||Object.hasOwn(query,key))throw new AdministrationError(400);query[key]=value;}
        const staffId=request.params['staffId'];if(staffId!==undefined&&typeof staffId!=='string')throw new AdministrationError(400);
        results.set(request,await this.service.read(identity,tenant,context.getHandler()===StaffAdministrationController.prototype.audit?'AUDIT':'STAFF',query,staffId));
      }
      return true;
    }catch(error){throw new HttpException('Unavailable',error instanceof AdministrationError?error.status:503);}
  }
}
