import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AdministrationError, consumeWorkspaceDataAccess, type StaffWorkspaceCommand, type StaffWorkspaceData,
  type StaffWorkspaceStore, type WorkspaceDataAccess } from '@nukhbapay/application';

const prefix='nukhbapay_staff_workspace';
const conflict=()=>new AdministrationError(409);

/** Separate guarded pools prevent authorization rechecks from waiting on the workspace transaction itself. */
export function createStaffWorkspaceStore(reader:Pool,writer:Pool):StaffWorkspaceStore {
  async function transaction<T>(ticket:WorkspaceDataAccess,write:boolean,run:(client:PoolClient)=>Promise<T>):Promise<T> {
    const access=consumeWorkspaceDataAccess(ticket);
    if (!await access.revalidate()) throw new AdministrationError(403);
    const client=await (write?writer:reader).connect();
    let discard=false;
    try {
      await client.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query(`SELECT set_config('nukhabapay.tenant_id',$1,true),
        set_config('nukhbapay_staff_workspace.staff_id',$2,true)`,[access.tenantId,access.staffId]);
      const result=await run(client);
      if (!await access.revalidate()) throw new AdministrationError(403);
      if ((await client.query('COMMIT')).command!=='COMMIT') throw new AdministrationError(503);
      return result;
    } catch(error) {
      try {await client.query('ROLLBACK');} catch {discard=true;}
      if (error instanceof AdministrationError) throw error;
      if (error && typeof error==='object' && 'code' in error && ['23503','23505'].includes(String(error.code))) throw conflict();
      throw new AdministrationError(503);
    } finally {client.release(discard);}
  }

  async function read<Kind extends keyof StaffWorkspaceData>(access:WorkspaceDataAccess,view:Kind):Promise<StaffWorkspaceData[Kind]> {
    return transaction(access,false,async client=>{
      const scope=[access.tenantId];
      let result:StaffWorkspaceData[keyof StaffWorkspaceData];
      switch(view) {
        case 'positions':
          result=(await client.query<StaffWorkspaceData['positions'][number]>(`SELECT p.department_code AS department,
            g.role_code AS role,g.id AS "grantId" FROM nukhbapay_staff_departments.positions p
            JOIN nukhabapay.tenant_role_grants g ON g.tenant_id=p.tenant_id AND g.id=p.grant_id
            JOIN nukhabapay.staff_memberships m ON m.tenant_id=g.tenant_id AND m.id=g.membership_id
            WHERE p.tenant_id=$1 AND m.staff_id=$2 AND m.status='ACTIVE' AND g.revoked_at IS NULL
              AND g.granted_at<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
            UNION ALL
            SELECT 'central',g.role_code,g.id FROM nukhabapay.tenant_role_grants g
            JOIN nukhabapay.staff_memberships m ON m.tenant_id=g.tenant_id AND m.id=g.membership_id
            WHERE g.tenant_id=$1 AND m.staff_id=$2 AND m.status='ACTIVE' AND g.role_code='TENANT_STAFF_MANAGER'
              AND g.revoked_at IS NULL AND g.granted_at<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
            ORDER BY department,role`,[access.tenantId,access.staffId])).rows;
          break;
        case 'departments':
          result=(await client.query<StaffWorkspaceData['departments'][number]>(
            `SELECT id,name,version FROM ${prefix}.departments WHERE tenant_id=$1 ORDER BY lower(name),id LIMIT 200`,scope)).rows;
          break;
        case 'invitations': {
          type Row=Omit<StaffWorkspaceData['invitations'][number],'createdAt'|'expiresAt'>&{createdAt:Date;expiresAt:Date};
          const {rows}=await client.query<Row>(`SELECT id,name,email,department_id AS "departmentId",role_code AS role,
            requester_id AS "requesterId",CASE WHEN state='SUBMITTED' AND expires_at<=transaction_timestamp()
              THEN 'EXPIRED' ELSE state END AS state,version,created_at AS "createdAt",expires_at AS "expiresAt"
            FROM ${prefix}.invitations WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200`,scope);
          result=rows.map(row=>({...row,createdAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString()}));
          break;
        }
        case 'settings': {
          const {rows:[row]}=await client.query<StaffWorkspaceData['settings']>(
            `SELECT time_zone AS "timeZone",locale,version,CASE WHEN display_name IS NOT NULL THEN
              json_build_object('name',display_name,'email',work_email) END AS contact FROM ${prefix}.preferences WHERE tenant_id=$1 AND staff_id=$2`,
            [...scope,access.staffId]);
          result=row??{timeZone:'UTC',locale:'en-GB',version:0};
          break;
        }
        case 'reports': {
          const {rows:[row]}=await client.query<StaffWorkspaceData['reports']>(`SELECT
            count(*) FILTER (WHERE u.status='ACTIVE' AND m.status='ACTIVE')::int AS "activeStaff",
            count(*) FILTER (WHERE m.status='ACTIVE')::int AS "activeMemberships",
            (SELECT count(*)::int FROM ${prefix}.departments WHERE tenant_id=$1) AS departments
            FROM nukhabapay.staff_memberships m JOIN nukhabapay.staff_users u ON u.id=m.staff_id WHERE m.tenant_id=$1`,scope);
          if (!row) throw new AdministrationError(503);
          result=row;
          break;
        }
        case 'activity': {
          type Row=Omit<StaffWorkspaceData['activity'][number],'occurredAt'>&{occurredAt:Date};
          const {rows}=await client.query<Row>(`SELECT id,actor_id AS "actorId",target_id AS "targetId",action,occurred_at AS "occurredAt"
            FROM ${prefix}.activity WHERE tenant_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 100`,scope);
          result=rows.map(row=>({...row,occurredAt:row.occurredAt.toISOString()}));
          break;
        }
        default: throw new AdministrationError(400);
      }
      return result as StaffWorkspaceData[Kind];
    });
  }

  async function save(access:WorkspaceDataAccess,command:StaffWorkspaceCommand):Promise<void> {
    await transaction(access,true,async client=>{
      const tenant=access.tenantId,actor=access.staffId;
      let target=actor;
      switch(command.action) {
        case 'create-department': {
          target=command.id;
          const result=await client.query(`INSERT INTO ${prefix}.departments(tenant_id,id,name) VALUES ($1,$2,$3)
            ON CONFLICT (tenant_id,id) DO NOTHING`,[tenant,target,command.name]);
          if (result.rowCount===0) {
            const {rows:[row]}=await client.query(`SELECT name FROM ${prefix}.departments WHERE tenant_id=$1 AND id=$2`,[tenant,target]);
            if (row?.name!==command.name) throw conflict();
            return;
          }
          break;
        }
        case 'rename-department': {
          target=command.id;
          const result=await client.query(`UPDATE ${prefix}.departments SET name=$4,version=version+1
            WHERE tenant_id=$1 AND id=$2 AND version=$3`,[tenant,target,command.version,command.name]);
          if (result.rowCount!==1) throw conflict();
          break;
        }
        case 'submit-invitation': {
          target=command.id;
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[tenant+':staff-invitation:'+command.email]);
          const {rows:[prior]}=await client.query(`SELECT requester_id,name,email,department_id,role_code FROM ${prefix}.invitations
            WHERE tenant_id=$1 AND id=$2`,[tenant,target]);
          if (prior) {
            if (prior.requester_id!==actor || prior.name!==command.name || prior.email!==command.email ||
                prior.department_id!==command.departmentId || prior.role_code!==command.role) throw conflict();
            return;
          }
          const duplicate=await client.query(`SELECT 1 FROM ${prefix}.invitations WHERE tenant_id=$1 AND email=$2
            AND state='SUBMITTED' AND expires_at>clock_timestamp()`,[tenant,command.email]);
          if (duplicate.rowCount!==0) throw conflict();
          await client.query(`INSERT INTO ${prefix}.invitations(tenant_id,id,requester_id,department_id,name,email,role_code)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`,[tenant,target,actor,command.departmentId,command.name,command.email,command.role]);
          break;
        }
        case 'cancel-invitation': {
          target=command.id;
          const result=await client.query(`UPDATE ${prefix}.invitations SET state='CANCELLED',version=version+1
            WHERE tenant_id=$1 AND id=$2 AND requester_id=$3 AND version=$4 AND state='SUBMITTED' AND expires_at>clock_timestamp()`,
            [tenant,target,actor,command.version]);
          if (result.rowCount!==1) throw conflict();
          break;
        }
        case 'save-settings': {
          const fields=[tenant,actor,command.timeZone,command.locale];
          const result=command.version===0
            ? await client.query(`INSERT INTO ${prefix}.preferences(tenant_id,staff_id,time_zone,locale) VALUES ($1,$2,$3,$4)
              ON CONFLICT DO NOTHING`,fields)
            : await client.query(`UPDATE ${prefix}.preferences SET time_zone=$3,locale=$4,version=version+1
              WHERE tenant_id=$1 AND staff_id=$2 AND version=$5`,[...fields,command.version]);
          if (result.rowCount!==1) throw conflict();
          if(command.contact)await client.query(`UPDATE ${prefix}.preferences SET display_name=$3,work_email=$4 WHERE tenant_id=$1 AND staff_id=$2`,
            [tenant,actor,command.contact.name,command.contact.email]);
          break;
        }
      }
      await client.query(`INSERT INTO ${prefix}.activity(tenant_id,id,actor_id,target_id,action) VALUES ($1,$2,$3,$4,$5)`,
        [tenant,randomUUID(),actor,target,command.action]);
    });
  }
  return Object.freeze({read,save});
}
