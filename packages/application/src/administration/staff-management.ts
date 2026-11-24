import {AdministrationError,administrationUuid,administrationPage,freshAdministration,type AdministrationAuthority,type AdministrationLease} from './access.js';
import type {VerifiedStaffIdentity} from '../identity/verified-staff-identity.js';
import {normalizeStaffRequestCommand,type StaffRequestCommand} from '../identity/durable-staff-request.js';
import type {TrustedStaffActorBoundary} from '../identity/trusted-staff-actor.js';
import {findRoleDefinition} from '../identity/permission-catalog.js';

export interface StaffDirectoryRow {readonly id:string;readonly tenantId:string;readonly status:string;readonly membershipStatus:string;readonly version:string;readonly roles:readonly string[];}
export interface StaffAuditRow {readonly id:string;readonly tenantId:string;readonly occurredAt:string;readonly action:string;readonly outcome:string;readonly actorStaffId:string|null;}
export interface AdministrationReadTicket {readonly tenantId:string;revalidate():Promise<boolean>;}
const tickets=new WeakSet<object>();
export function consumeAdministrationRead(ticket:AdministrationReadTicket){if(!tickets.delete(ticket))throw new AdministrationError(403);return ticket;}
export interface StaffAdministrationReader {
  staff(ticket:AdministrationReadTicket):Promise<readonly StaffDirectoryRow[]>;
  audit(ticket:AdministrationReadTicket):Promise<readonly StaffAuditRow[]>;
}
export class StaffManagementService {
  constructor(private readonly deps:{authority:AdministrationAuthority;reader:StaffAdministrationReader;
    actors:Pick<TrustedStaffActorBoundary,'establish'|'recordStaffRequest'>;
    auditRead(lease:AdministrationLease,kind:'STAFF'|'AUDIT'):Promise<void>}){}
  async availableViews(identity:VerifiedStaffIdentity,tenantId:string):Promise<readonly ('STAFF'|'AUDIT')[]> {
    const views: ('STAFF'|'AUDIT')[]=[];
    for(const [view,permission] of [['STAFF','tenant.staff.read'],['AUDIT','tenant.audit.read']] as const) {
      try {
        await freshAdministration(await this.deps.authority.require(identity,tenantId,permission));
        views.push(view);
      } catch(error) {
        if(!(error instanceof AdministrationError) || error.status!==403)throw error;
      }
    }
    return Object.freeze(views);
  }
  async read(identity:VerifiedStaffIdentity,tenantId:string,kind:'STAFF'|'AUDIT',query:Readonly<Record<string,unknown>>,staffId?:string){
    const page=administrationPage(query);if(staffId!==undefined&&!administrationUuid.test(staffId))throw new AdministrationError(400);
    const lease=await this.deps.authority.require(identity,tenantId,kind==='STAFF'?'tenant.staff.read':'tenant.audit.read');
    await freshAdministration(lease);
    const ticket=Object.freeze({tenantId,revalidate:()=>lease.revalidate()});tickets.add(ticket);
    try {
      const rows=kind==='STAFF'?await this.deps.reader.staff(ticket):await this.deps.reader.audit(ticket);
      if(rows.length>1000)throw new AdministrationError(503);
      const ids=new Set<string>();
      const safe=rows.map(row=>{
        if(row.tenantId!==tenantId||!administrationUuid.test(row.id)||ids.has(row.id))throw new AdministrationError(503);ids.add(row.id);
        if(kind==='STAFF'){
          const r=row as StaffDirectoryRow;
          if(!['PENDING','ACTIVE','SUSPENDED','DISABLED'].includes(r.status)||!['ACTIVE','SUSPENDED','REVOKED'].includes(r.membershipStatus)||
            !/^[1-9][0-9]{0,18}$/.test(r.version)||!Array.isArray(r.roles)||r.roles.length>12||r.roles.some(code=>findRoleDefinition(code)?.scope!=='TENANT'))throw new AdministrationError(503);
          return Object.freeze({id:r.id,status:r.status,membershipStatus:r.membershipStatus,version:r.version,roles:Object.freeze([...new Set(r.roles)].sort())});
        }
        const r=row as StaffAuditRow;
        if(!Number.isFinite(Date.parse(r.occurredAt))||!['STAFF_IDENTITY_RESOLUTION','STAFF_MEMBERSHIP_RESOLUTION','AUTHORIZATION_DECISION','SECURITY_AUDIT_APPEND'].includes(r.action)||
          !['SUCCESS','DENIED','FAILURE'].includes(r.outcome)||r.actorStaffId!==null&&!administrationUuid.test(r.actorStaffId))throw new AdministrationError(503);
        return Object.freeze({id:r.id,occurredAt:r.occurredAt,action:r.action,outcome:r.outcome,actorStaffId:r.actorStaffId});
      }).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
      const visible=safe.filter(row=>(!staffId||row.id===staffId)&&(!page.after||row.id>page.after));
      if(staffId&&visible.length===0)throw new AdministrationError(404);
      await freshAdministration(lease);await this.deps.auditRead(lease,kind);await freshAdministration(lease);
      return Object.freeze({items:Object.freeze(visible.slice(0,page.limit)),next:visible.length>page.limit?visible[page.limit-1]!.id:null});
    }finally{tickets.delete(ticket);}
  }
  /** This endpoint records existing non-authorized access requests, not effective
   * staff/role changes. ADR0013's real assurance/executor gate remains closed. */
  async request(identity:VerifiedStaffIdentity,tenantId:string,input:StaffRequestCommand){
    let command:StaffRequestCommand;try{command=normalizeStaffRequestCommand(input);}catch{throw new AdministrationError(400);}
    const lease=await this.deps.authority.require(identity,tenantId,'tenant.access.request');
    if(command.kind!=='SUBMIT'||command.targetStaffId===lease.staffId)throw new AdministrationError(403);
    if(command.proposedRoles.some(role=>!['CATALOG_OPERATOR','PRICING_EDITOR','SUPPORT_AGENT'].includes(role)))throw new AdministrationError(403);
    const actor=await this.deps.actors.establish(identity,tenantId);if(!actor.allowed)throw new AdministrationError(403);
    await freshAdministration(lease);const result=await this.deps.actors.recordStaffRequest(actor.actor,command);await freshAdministration(lease);
    if(result.execution!=='NOT_AUTHORIZED'||result.acceptedApproval!==false)throw new AdministrationError(503);
    return result;
  }
}
