import type {Pool} from 'pg';
import {consumeAdministrationRead,type AdministrationReadTicket,type StaffAdministrationReader} from '@nukhbapay/application';

/** Caller owns a separately approved, restricted reader pool. Construction opens
 * no connection, grants no rights and never provisions an IAM workload role. */
export function createStaffAdministrationReader(pool:Pool):StaffAdministrationReader {
  async function read(ticket:AdministrationReadTicket,kind:'STAFF'|'AUDIT') {
    consumeAdministrationRead(ticket);if(!await ticket.revalidate())throw new Error('Administration read denied');
    const client=await pool.connect();let broken=false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SELECT set_config('nukhabapay.tenant_id',$1,true)",[ticket.tenantId]);
      const result=kind==='STAFF'?await client.query(`SELECT u.id,m.tenant_id,u.status,m.status AS membership_status,m.version::text,
        COALESCE(array_agg(g.role_code ORDER BY g.role_code) FILTER (WHERE g.role_code IS NOT NULL),ARRAY[]::text[]) AS roles
        FROM nukhabapay.staff_memberships m JOIN nukhabapay.staff_users u ON u.id=m.staff_id
        LEFT JOIN nukhabapay.tenant_role_grants g ON g.membership_id=m.id AND g.tenant_id=m.tenant_id
          AND g.revoked_at IS NULL AND g.granted_at<=transaction_timestamp() AND (g.expires_at IS NULL OR g.expires_at>transaction_timestamp())
        WHERE m.tenant_id=$1 GROUP BY u.id,m.id ORDER BY u.id LIMIT 1001`,[ticket.tenantId]):
        await client.query(`SELECT id,tenant_id,occurred_at,action,outcome,actor_staff_id FROM nukhabapay.security_audit_events
          WHERE tenant_id=$1 ORDER BY id LIMIT 1001`,[ticket.tenantId]);
      if(!await ticket.revalidate())throw new Error('Administration read denied');
      await client.query('COMMIT');if(!await ticket.revalidate())throw new Error('Administration read denied');
      return result.rows;
    }catch{try{await client.query('ROLLBACK');}catch{broken=true;}throw new Error('Administration read unavailable');}
    finally{client.release(broken);}
  }
  return Object.freeze({staff:async(ticket:AdministrationReadTicket)=>(await read(ticket,'STAFF')).map(r=>({id:r.id as string,tenantId:r.tenant_id as string,status:r.status as string,membershipStatus:r.membership_status as string,version:r.version as string,roles:r.roles as string[]})),
    audit:async(ticket:AdministrationReadTicket)=>(await read(ticket,'AUDIT')).map(r=>({id:r.id as string,tenantId:r.tenant_id as string,occurredAt:(r.occurred_at as Date).toISOString(),action:r.action as string,outcome:r.outcome as string,actorStaffId:r.actor_staff_id as string|null}))});
}
