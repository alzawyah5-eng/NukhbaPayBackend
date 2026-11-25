import { createHmac } from 'node:crypto';
import { ROLE_CATALOG, type StaffCatalogueView, type StaffWorkspaceData } from '@nukhbapay/application';

export type DepartmentPosition = StaffWorkspaceData['positions'][number];
export const departmentCookie = '__Host-nukhbapay_position';
export function positionProof(key:Buffer,session:string,position:DepartmentPosition):string {
  return createHmac('sha256',key).update(JSON.stringify(['position',session,position.department,position.role,position.grantId])).digest('base64url');
}
const permissions:Readonly<Record<string,string>>={
  '/overview':'staff.self.read','/roles':'staff.self.read','/security':'staff.self.read',
  '/sessions':'staff.self.read','/settings':'staff.self.read','/staff':'tenant.staff.read',
  '/staff/invite':'tenant.access.request','/access-requests':'tenant.access.request',
  '/departments':'tenant.departments.manage','/audit':'tenant.audit.read','/reports':'tenant.staff.read',
  '/catalogue':'catalog.read',
};

const privateCatalogueViews: ReadonlySet<StaffCatalogueView> = new Set(['offers', 'economics', 'drafts', 'publications']);

export function positionAllowsCatalogue(position:DepartmentPosition|undefined, view:StaffCatalogueView, localPreview=false):boolean {
  if (localPreview && position?.role==='TENANT_STAFF_MANAGER' && !privateCatalogueViews.has(view)) return true;
  if (!positionAllows(position, '/catalogue')) return false;
  return !privateCatalogueViews.has(view) || ROLE_CATALOG.some(role =>
    role.scope === 'TENANT' && role.code === position?.role && role.permissions.some(code => code === 'pricing.read'));
}
export function positionAllows(position:DepartmentPosition|undefined,path:string):boolean {
  if(!position)return false;
  const role=ROLE_CATALOG.find(candidate=>candidate.code===position.role && candidate.scope==='TENANT');
  const permission=Object.hasOwn(permissions,path)?permissions[path]:undefined;
  return !!role && (permission==='staff.self.read' || (!!permission && role.permissions.some(code=>code===permission)));
}
export const workspaceViewPage={
  departments:'/departments',invitations:'/access-requests',roles:'/roles',activity:'/audit',
  reports:'/reports',sessions:'/sessions',security:'/security',settings:'/settings',
} as const;
