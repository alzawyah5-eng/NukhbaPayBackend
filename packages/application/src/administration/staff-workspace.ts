import { AdministrationError, administrationUuid, type AdministrationAuthority, type AdministrationLease } from './access.js';
import { activeTenantRoleCodes, resolveStaffTenantContext, type StaffAuthorizationRepository } from '../identity/staff-access.js';
import { PERMISSION_CATALOG, ROLE_CATALOG } from '../identity/permission-catalog.js';
import type { VerifiedStaffIdentity } from '../identity/verified-staff-identity.js';

const views = {
  roles: 'staff.self.read',
  departments: 'tenant.departments.manage',
  invitations: 'tenant.access.request',
  security: 'staff.self.read',
  sessions: 'staff.self.read',
  reports: 'tenant.staff.read',
  settings: 'staff.self.read',
  activity: 'tenant.audit.read',
} as const;
export type StaffWorkspaceView = keyof typeof views;
export const staffWorkspaceViews = Object.freeze(Object.keys(views) as StaffWorkspaceView[]);
export const staffInvitationRoles = ['SUPPORT_AGENT','CATALOG_OPERATOR'] as const;
export const staffWorkspaceLocales = ['en-GB','en-US','fr-FR','ar-AE'] as const;
type InvitationRole = typeof staffInvitationRoles[number];
type Locale = typeof staffWorkspaceLocales[number];

export type StaffWorkspaceCommand =
  | { action:'create-department'; id:string; name:string }
  | { action:'rename-department'; id:string; version:number; name:string }
  | { action:'submit-invitation'; id:string; name:string; email:string; departmentId:string|null; role:InvitationRole }
  | { action:'cancel-invitation'; id:string; version:number }
  | { action:'save-settings'; version:number; timeZone:string; locale:Locale;contact?:{name:string;email:string} };

type StoredView = Exclude<StaffWorkspaceView,'roles'|'security'|'sessions'>;
export interface StaffWorkspaceData {
  positions: readonly {department:string;role:string;grantId:string}[];
  departments: readonly {id:string;name:string;version:number}[];
  invitations: readonly {id:string;name:string;email:string;departmentId:string|null;role:string;requesterId:string;
    state:'SUBMITTED'|'CANCELLED'|'EXPIRED';version:number;createdAt:string;expiresAt:string}[];
  settings: {locale:Locale;timeZone:string;version:number;contact?:{name:string;email:string}|null};
  reports: {activeStaff:number;activeMemberships:number;departments:number};
  activity: readonly {id:string;action:string;actorId:string;targetId:string;occurredAt:string}[];
}

export interface WorkspaceSessionCheck {
  readonly staffId:string;
  revalidate():Promise<boolean>;
}

export interface WorkspaceDataAccess {
  readonly staffId:string;
  readonly tenantId:string;
  revalidate():Promise<boolean>;
}

const issuedAccess = new WeakSet<WorkspaceDataAccess>();
export function consumeWorkspaceDataAccess(access:WorkspaceDataAccess):WorkspaceDataAccess {
  if (!issuedAccess.delete(access)) throw new AdministrationError(403);
  return access;
}

export interface StaffWorkspaceStore {
  read<View extends StoredView|'positions'>(access:WorkspaceDataAccess,view:View):Promise<StaffWorkspaceData[View]>;
  save(access:WorkspaceDataAccess,command:StaffWorkspaceCommand):Promise<void>;
}

const invalid = () => { throw new AdministrationError(400); };
function exact(record:Record<string,unknown>,fields:readonly string[]):void {
  const keys=Object.keys(record);
  if (keys.length!==fields.length || fields.some(field=>!Object.hasOwn(record,field))) invalid();
}
function uuid(value:unknown):string {
  if (typeof value!=='string'||!administrationUuid.test(value)) throw new AdministrationError(400);
  return value;
}
function name(value:unknown):string {
  if (typeof value!=='string') throw new AdministrationError(400);
  const trimmed=value.trim();
  if (trimmed.length<2||trimmed.length>120||/[\p{Cc}\p{Cf}]/u.test(trimmed)) invalid();
  return trimmed;
}
function version(value:unknown,min=1):number {
  if (typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>2147483646) throw new AdministrationError(400);
  return value;
}
function timeZone(value:unknown):string {
  if (typeof value!=='string'||value.length>100||!(/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/).test(value)) {
    throw new AdministrationError(400);
  }
  try {return new Intl.DateTimeFormat('en-GB',{timeZone:value}).resolvedOptions().timeZone;}
  catch {return invalid();}
}

export function parseStaffWorkspaceCommand(input:unknown):StaffWorkspaceCommand {
  if (!input||typeof input!=='object'||Array.isArray(input)) throw new AdministrationError(400);
  const row=input as Record<string,unknown>;
  switch(row['action']) {
    case 'create-department':
      exact(row,['action','id','name']);
      return {action:row['action'],id:uuid(row['id']),name:name(row['name'])};
    case 'rename-department':
      exact(row,['action','id','name','version']);
      return {action:row['action'],id:uuid(row['id']),name:name(row['name']),version:version(row['version'])};
    case 'submit-invitation': {
      exact(row,['action','id','name','email','departmentId','role']);
      const email=typeof row['email']==='string'?row['email'].trim().toLowerCase():'';
      const role=staffInvitationRoles.find(code=>code===row['role']);
      if (!role||email.length>254||!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email)) {
        throw new AdministrationError(400);
      }
      return {action:row['action'],id:uuid(row['id']),name:name(row['name']),email,role,
        departmentId:row['departmentId']===null?null:uuid(row['departmentId'])};
    }
    case 'cancel-invitation':
      exact(row,['action','id','version']);
      return {action:row['action'],id:uuid(row['id']),version:version(row['version'])};
    case 'save-settings': {
      const hasContact=Object.hasOwn(row,'contact');
      exact(row,['action','version','timeZone','locale',...(hasContact?['contact']:[])]);
      let contact;
      if(hasContact){
        const data=row['contact'];
        if(!data||typeof data!=='object'||Array.isArray(data))throw new AdministrationError(400);
        const fields=data as Record<string,unknown>;
        exact(fields,['name','email']);
        const email=typeof fields['email']==='string'?fields['email'].trim().toLowerCase():'';
        if(email.length>254||!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email))throw new AdministrationError(400);
        contact={name:name(fields['name']),email};
      }
      const locale=staffWorkspaceLocales.find(value=>value===row['locale']);
      if (!locale) throw new AdministrationError(400);
      return {action:row['action'],version:version(row['version'],0),timeZone:timeZone(row['timeZone']),locale,...(contact && {contact})};
    }
    default: throw new AdministrationError(400);
  }
}

export class StaffWorkspaceService {
  constructor(private readonly dependencies:{authority:AdministrationAuthority;repository:StaffAuthorizationRepository;
    store:StaffWorkspaceStore;now:()=>Date}) {}

  async availableViews(identity:VerifiedStaffIdentity,tenantId:string,session:WorkspaceSessionCheck):Promise<readonly StaffWorkspaceView[]> {
    const base=await this.dependencies.authority.require(identity,tenantId,'staff.self.read');
    if (base.staffId!==session.staffId || base.tenantId!==tenantId || !await session.revalidate())
      throw new AdministrationError(403);
    const candidates=await Promise.all(staffWorkspaceViews.map(async view=>{
      if (views[view]==='staff.self.read') return view;
      try {
        const lease=await this.dependencies.authority.require(identity,tenantId,views[view]);
        return lease.staffId===session.staffId && lease.tenantId===tenantId && await lease.revalidate()?view:null;
      } catch(error) {
        if (error instanceof AdministrationError && error.status===403) return null;
        throw error;
      }
    }));
    if (!await session.revalidate() || !await base.revalidate()) throw new AdministrationError(403);
    return candidates.filter(view=>view!==null);
  }

  private async access(identity:VerifiedStaffIdentity,tenantId:string,session:WorkspaceSessionCheck,permission:string) {
    const lease:AdministrationLease=await this.dependencies.authority.require(identity,tenantId,permission);
    if (lease.staffId!==session.staffId || lease.tenantId!==tenantId) throw new AdministrationError(403);
    const access=Object.freeze({staffId:lease.staffId,tenantId,
      revalidate:async()=>await lease.revalidate() && await session.revalidate() && await lease.revalidate()});
    if (!await access.revalidate()) throw new AdministrationError(403);
    return access;
  }

  async read(identity:VerifiedStaffIdentity,tenantId:string,session:WorkspaceSessionCheck,view:StaffWorkspaceView) {
    const access=await this.access(identity,tenantId,session,views[view]);
    if (view==='roles') {
      const context=await resolveStaffTenantContext(this.dependencies.repository,identity,tenantId);
      const active=activeTenantRoleCodes(context,this.dependencies.now().getTime());
      let canReadDirectory=false;
      try {
        await this.dependencies.authority.require(identity,tenantId,'tenant.staff.read');
        canReadDirectory=true;
      } catch(error) {
        if (!(error instanceof AdministrationError) || error.status!==403) throw error;
      }
      if (!await access.revalidate()) throw new AdministrationError(403);
      return {roles:ROLE_CATALOG.filter(role=>role.scope==='TENANT' && (canReadDirectory||active.includes(role.code))).map(role=>({
        code:role.code,description:role.description,assigned:active.includes(role.code),
        permissions:role.permissions.map(code=>({code,description:PERMISSION_CATALOG.find(permission=>permission.code===code)!.description})),
      }))};
    }
    if (view==='security') return {mfaRequired:true,commandAssuranceEstablished:false};
    if (view==='sessions') return {currentSession:true};
    issuedAccess.add(access);
    try {return await this.dependencies.store.read(access,view);}
    finally {issuedAccess.delete(access);}
  }

  async positions(identity:VerifiedStaffIdentity,tenantId:string,session:WorkspaceSessionCheck) {
    const access=await this.access(identity,tenantId,session,'staff.self.read');
    issuedAccess.add(access);
    try {
      const rows=await this.dependencies.store.read(access,'positions');
      const context=await resolveStaffTenantContext(this.dependencies.repository,identity,tenantId);
      const active=activeTenantRoleCodes(context,this.dependencies.now().getTime());
      if(!await access.revalidate()) throw new AdministrationError(403);
      return rows.filter(row=>active.includes(row.role));
    } finally {issuedAccess.delete(access);}
  }

  async command(identity:VerifiedStaffIdentity,tenantId:string,session:WorkspaceSessionCheck,input:unknown):Promise<void> {
    const command=parseStaffWorkspaceCommand(input);
    const permission=command.action==='save-settings'?'staff.self.read':
      command.action.endsWith('-department')?'tenant.departments.manage':'tenant.access.request';
    const access=await this.access(identity,tenantId,session,permission);
    issuedAccess.add(access);
    try {await this.dependencies.store.save(access,command);}
    finally {issuedAccess.delete(access);}
  }
}
