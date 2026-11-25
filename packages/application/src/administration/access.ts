import { authorizeIsolatedCataloguePreview, authorizeIsolatedStaffRead, authorizeIsolatedTenantWorkspace, authorizeStaffAccess, resolveStaffTenantContext,
  type IsolatedStaffReadScope, type StaffAuthorizationRepository, type StaffAuthorizationRequest } from '../identity/staff-access.js';
import { isVerifiedStaffIdentity, type VerifiedStaffIdentity } from '../identity/verified-staff-identity.js';

export class AdministrationError extends Error {
  constructor(readonly status:400|401|403|404|409|503){super('Administration request unavailable');}
}
export const administrationUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface AdministrationLease {readonly staffId:string;readonly tenantId:string;revalidate():Promise<boolean>;}
/** Trusted backend port; never selectable by request, environment or token claims. */
export interface AdministrationAuthority {
  require(identity:VerifiedStaffIdentity,tenantId:string,permission:string):Promise<AdministrationLease>;
}
/** The default authority enforces the active phase. An isolated read scope is selected by trusted composition. */
export function createAdministrationAuthority(repository:StaffAuthorizationRepository,now:()=>Date,
  isolatedReadScope?:IsolatedStaffReadScope,isolatedWorkspaceTenant?:string,isolatedCataloguePreview?:IsolatedStaffReadScope):AdministrationAuthority {
  const scope=isolatedReadScope && Object.freeze({ ...isolatedReadScope });
  const catalogue=isolatedCataloguePreview && Object.freeze({ ...isolatedCataloguePreview });
  return Object.freeze({async require(identity:VerifiedStaffIdentity,tenantId:string,permission:string){
    if(!isVerifiedStaffIdentity(identity))throw new AdministrationError(401);
    if(!administrationUuid.test(tenantId))throw new AdministrationError(400);
    const resolve=async()=>{
      const time=now().getTime();
      if(!Number.isSafeInteger(time)||time<identity.security.issuedAt*1000||time>=identity.security.expiresAt*1000)throw new AdministrationError(401);
      const context=await resolveStaffTenantContext(repository,identity,tenantId);
      if(context.membership?.status!=='ACTIVE' || context.membership.tenantId!==tenantId)throw new AdministrationError(403);
      const request:StaffAuthorizationRequest=permission==='staff.self.read'
        ? {permissionCode:permission,scope:'SELF',...(context.principal && {targetStaffId:context.principal.staffId}),now:now().toISOString()}
        : {permissionCode:permission,scope:'TENANT',tenantId,objectTenantId:tenantId,now:now().toISOString()};
      const ordinary=request.scope==='SELF' ? authorizeStaffAccess(context,request)
        : isolatedWorkspaceTenant ? authorizeIsolatedTenantWorkspace(context,request,isolatedWorkspaceTenant)
        : scope ? authorizeIsolatedStaffRead(context,request,scope) : authorizeStaffAccess(context,request);
      const decision=!ordinary.allowed && catalogue && permission==='catalog.read'
        ? authorizeIsolatedCataloguePreview(context,request,catalogue) : ordinary;
      if(!decision.allowed||now().getTime()>=identity.security.expiresAt*1000)throw new AdministrationError(403);
      return context;
    };
    const context=await resolve(),stamp=(value:unknown)=>JSON.stringify(value,(_,v:unknown)=>typeof v==='bigint'?v.toString():v),initial=stamp(context);
    return Object.freeze({staffId:context.principal!.staffId,tenantId,revalidate:async()=>{try{return stamp(await resolve())===initial;}catch{return false;}}});
  }});
}
export function administrationPage(query:Readonly<Record<string,unknown>>) {
  if(!query||Object.keys(query).some(k=>!['limit','after'].includes(k)))throw new AdministrationError(400);
  const limit=query['limit']===undefined?20:typeof query['limit']==='string'&&/^[1-9][0-9]?$/.test(query['limit'])?Number(query['limit']):0;
  if(limit<1||limit>50||query['after']!==undefined&&(typeof query['after']!=='string'||!administrationUuid.test(query['after'])))throw new AdministrationError(400);
  return {limit,after:query['after'] as string|undefined};
}
export async function freshAdministration(lease:AdministrationLease){if(!await lease.revalidate())throw new AdministrationError(403);}
