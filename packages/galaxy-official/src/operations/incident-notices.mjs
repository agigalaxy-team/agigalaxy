import * as z from 'zod/v4';
import { transaction } from '../database.mjs';
import { digest } from '../shared/digest.mjs';
import { verifyRuntimeConfigEvent } from './runtime-config-audit.mjs';

const ref=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const incidentNoticeCommandSchema=z.strictObject({version:z.literal(1),id:z.uuid(),
  endpoint:z.url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&u.origin===value;}),
  incidentId:ref,incidentRevision:z.number().int().positive(),operatorRef:ref,
  notices:z.array(z.strictObject({id:z.uuid(),subjectId:z.string().regex(/^GUID[0-9A-Z]{28}$/),
    title:z.string().trim().min(1).max(200),summary:z.string().trim().min(1).max(1200)})).min(1).max(128)
    .refine(items=>new Set(items.map(item=>item.id)).size===items.length),
});

// Operations-only delivery. The public API role has SELECT, not INSERT, on
// incident_notices. It cannot impersonate an operator by calling a public route.
export async function deliverIncidentNotices(database,input){
  const command=incidentNoticeCommandSchema.parse(input),commandHash=digest(JSON.stringify(command));
  return transaction(database,async db=>{
    await db.query('SELECT pg_advisory_xact_lock(734912308)');
    const prior=(await db.query("SELECT object_id FROM audit_events WHERE action='incident.notice.deliver' AND request_id=$1",[command.id])).rows[0];
    if(prior){
      if(prior.object_id!==commandHash)throw new Error('Incident notice operation conflict');
      return {operationId:command.id,delivered:command.notices.length,replayed:true,externalDelivery:false};
    }
    const current=(await db.query("SELECT * FROM runtime_config_events WHERE endpoint=$1 AND component='api' ORDER BY sequence DESC LIMIT 1",[command.endpoint])).rows[0];
    if(!current)throw new Error('Incident configuration not loaded');
    verifyRuntimeConfigEvent(current);
    const incident=current.payload.snapshot.incident;
    if(!incident||incident.id!==command.incidentId||incident.revision!==command.incidentRevision)throw new Error('Incident notice revision mismatch');
    for(const notice of command.notices){
      await db.query(`INSERT INTO incident_notices(id,subject_id,runtime_config_id,incident_id,incident_revision,operator_ref,title,summary,command_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[notice.id,notice.subjectId,current.id,command.incidentId,command.incidentRevision,command.operatorRef,notice.title,notice.summary,commandHash]);
    }
    await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,client_id,audience,scope,idempotency_key)
      VALUES($1,'incident.notice.deliver',$2,$3,'delivered','operations',$4,'operations/incident',$3)`,['operator:'+command.operatorRef,commandHash,command.id,command.endpoint]);
    return {operationId:command.id,delivered:command.notices.length,replayed:false,externalDelivery:false};
  });
}
