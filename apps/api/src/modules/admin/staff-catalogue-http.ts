import {Controller,Get,Req,HttpException,type ExecutionContext} from '@nestjs/common';
import type {Request,Response} from 'express';
import {AdministrationError,administrationUuid,type StaffCatalogueService,type StaffCatalogueView} from '@nukhbapay/application';
import {verifiedRequestIdentity} from '../identity/staff-request-context.js';
const results=new WeakMap<Request,unknown>();
@Controller('v1/admin/tenants/:tenantId/catalogue')
export class StaffCatalogueController {
 @Get(':view') read(@Req() request:Request){if(!results.has(request))throw new HttpException('Unavailable',503);const result=results.get(request);results.delete(request);return result;}
}
export function isStaffCatalogueHandler(context:ExecutionContext){return context.getType()==='http'&&context.getClass()===StaffCatalogueController&&context.getHandler()===StaffCatalogueController.prototype.read;}
export class StaffCatalogueHttpBoundary {
 constructor(private readonly service?:StaffCatalogueService){}
 async authorize(context:ExecutionContext){
  const request=context.switchToHttp().getRequest<Request>(),response=context.switchToHttp().getResponse<Response>();results.delete(request);response.setHeader('Cache-Control','no-store');
  if(request.method!=='GET'||request.headers['origin']!==undefined||request.headers['cookie']!==undefined)throw new HttpException('Unavailable',403);
  const identity=verifiedRequestIdentity(request);if(!identity)throw new HttpException('Unavailable',401);if(!this.service)throw new HttpException('Unavailable',503);
  if(request.originalUrl.length>2048)throw new HttpException('Unavailable',400);
  const tenant=request.params['tenantId'],view=request.params['view'];if(typeof tenant!=='string'||!administrationUuid.test(tenant)||typeof view!=='string')throw new HttpException('Unavailable',400);
  const q:Record<string,string>=Object.create(null) as Record<string,string>;for(const [key,value] of new URL(request.originalUrl,'http://admin.invalid').searchParams){if(Object.hasOwn(q,key))throw new HttpException('Unavailable',400);q[key]=value;}
  try{results.set(request,await this.service.read(identity,tenant,view as StaffCatalogueView,q));return true;}catch(error){throw new HttpException('Unavailable',error instanceof AdministrationError?error.status:503);}
 }
}
