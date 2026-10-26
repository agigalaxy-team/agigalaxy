import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {transaction} from "../infrastructure/database.mjs";
import {ServiceError} from '../shared/service-error.mjs';
import {discoveryDeliveryTargets} from './purpose.mjs';
const iso=value=>new Date(value*1000).toISOString();
export class DiscoveryStore{
 constructor({db,endpoint,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{db,endpoint,now});this.indexClaimCursor=0;}
 async initialize(){await this.db.query('INSERT INTO discovery_index_control_v1(endpoint) VALUES($1) ON CONFLICT DO NOTHING',[this.endpoint]);}
 async record(event){return transaction(this.db,async db=>{
  if(event.accountId&&!(await db.query('SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2',[event.accountId,this.endpoint])).rows.length)throw new ServiceError('discovery_identity_required',401);
  const before=(await db.query('SELECT payload FROM discovery_usage_events_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,event.eventId])).rows[0];
  if(before){const prior={...before.payload},next={...event};delete prior.occurredAt;delete next.occurredAt;delete prior.transport;delete next.transport;if(!isDeepStrictEqual(prior,next))throw new ServiceError('discovery_event_conflict',409);return {accepted:true,replayed:true,eventId:event.eventId};}
  const inserted=await db.query('INSERT INTO discovery_usage_events_v1(endpoint,id,account_id,visitor_id,profile_id,name,purpose,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id',[this.endpoint,event.eventId,event.accountId,event.visitorId,event.profileId,event.name,event.purpose,event,iso(this.now())]);
  if(!inserted.rows.length){const prior={...(await db.query('SELECT payload FROM discovery_usage_events_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,event.eventId])).rows[0]?.payload},next={...event};delete prior.occurredAt;delete next.occurredAt;delete prior.transport;delete next.transport;if(!isDeepStrictEqual(prior,next))throw new ServiceError('discovery_event_conflict',409);return{accepted:true,replayed:true,eventId:event.eventId};}
  for(const target of discoveryDeliveryTargets(event))await db.query('INSERT INTO discovery_delivery_outbox_v1(endpoint,event_id,target) VALUES($1,$2,$3)',[this.endpoint,event.eventId,target]);
  if(event.itemKey&&event.name==='not-interested')await db.query('INSERT INTO discovery_feedback_v1(endpoint,profile_id,item_key,negative,updated_at) VALUES($1,$2,$3,true,$4) ON CONFLICT(endpoint,profile_id,item_key) DO UPDATE SET negative=true,updated_at=excluded.updated_at',[this.endpoint,event.profileId,event.itemKey,event.occurredAt]);
  return {accepted:true,replayed:false,eventId:event.eventId};
 });}
 async excluded(profileId){return new Set((await this.db.query('SELECT item_key FROM discovery_feedback_v1 WHERE endpoint=$1 AND profile_id=$2 AND negative',[this.endpoint,profileId])).rows.map(row=>row.item_key));}
 async enqueue(reference){return this.db.query(`INSERT INTO discovery_index_outbox_v1(endpoint,kind,source_id) VALUES($1,$2,$3) ON CONFLICT(endpoint,kind,source_id) DO UPDATE SET generation=discovery_index_outbox_v1.generation+1,state='pending',next_attempt_at=$4,updated_at=$4`,[this.endpoint,reference.kind,reference.id,iso(this.now())]);}
 // A periodic scan schedules one durable recheck of a clean applied source.
 // Its generation remains ahead of the applied generation until a real lease
 // completes; another scan cannot reset its place or turn it into a mutation.
 // Source mutations and expiry still use the existing pending state.
 async reconcile(reference){return (await this.db.query(`INSERT INTO discovery_index_outbox_v1(endpoint,kind,source_id) VALUES($1,$2,$3) ON CONFLICT(endpoint,kind,source_id) DO UPDATE SET generation=discovery_index_outbox_v1.generation+1,next_attempt_at=$4,updated_at=$4 WHERE discovery_index_outbox_v1.state='applied' AND discovery_index_outbox_v1.generation=discovery_index_outbox_v1.applied_generation RETURNING source_id`,[this.endpoint,reference.kind,reference.id,iso(this.now())])).rows.length===1;}
 async claim(table){if(!['discovery_index_outbox_v1','discovery_delivery_outbox_v1'].includes(table))throw new Error('Invalid discovery worker target');return transaction(this.db,async db=>{
  const key=table==='discovery_index_outbox_v1'?'kind,source_id':'event_id,target';
  // Each non-empty class gets a turn: never-applied sources, changed/retrying
  // sources, then periodic rechecks. Empty classes fall through in this query.
  // The cursor is process-local scheduling only; all work, backoff and leases
  // remain in the original outbox and survive a worker restart.
  const isIndex=table==='discovery_index_outbox_v1';
  const row=isIndex?(await db.query(`SELECT * FROM discovery_index_outbox_v1 WHERE endpoint=$1 AND next_attempt_at<=$2 AND (state IN ('pending','failed') OR state='leased' AND lease_until<=$2 OR state='applied' AND generation>applied_generation) ORDER BY ((CASE WHEN state='applied' THEN 2 WHEN applied_generation=0 THEN 0 ELSE 1 END-$3::integer+3)%3),next_attempt_at,kind,source_id LIMIT 1 FOR UPDATE SKIP LOCKED`,[this.endpoint,iso(this.now()),this.indexClaimCursor])).rows[0]:(await db.query(`SELECT * FROM ${table} WHERE endpoint=$1 AND next_attempt_at<=$2 AND (state IN ('pending','failed','result-unknown') OR state='leased' AND lease_until<=$2) ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED`,[this.endpoint,iso(this.now())])).rows[0];if(!row)return null;
  const lease=randomUUID(),values=key==='kind,source_id'?[row.kind,row.source_id]:[row.event_id,row.target],columns=key.split(',');
  await db.query(`UPDATE ${table} SET state='leased',lease_id=$4,lease_until=$5,attempts=attempts+1 WHERE endpoint=$1 AND ${columns[0]}=$2 AND ${columns[1]}=$3`,[this.endpoint,...values,lease,iso(this.now()+60)]);if(isIndex)this.indexClaimCursor=row.state==='applied'?0:String(row.applied_generation)==='0'?1:2;return{...row,lease_id:lease};
 });}
 async queueExpired(limit=100){return this.db.query(`UPDATE discovery_index_outbox_v1 SET generation=generation+1,state='pending',next_attempt_at=$2,updated_at=$2 WHERE (endpoint,kind,source_id) IN (SELECT endpoint,kind,source_id FROM discovery_index_outbox_v1 WHERE endpoint=$1 AND state='applied' AND source_expires_at<=$2 LIMIT $3)`,[this.endpoint,iso(this.now()),limit]);}
 async completeIndex(row,{version=null,expiresAt=null,error=null}={}){await this.db.query(`UPDATE discovery_index_outbox_v1 SET state=CASE WHEN $6::text IS NOT NULL THEN 'failed' WHEN generation=$5 THEN 'applied' ELSE 'pending' END,applied_generation=CASE WHEN $6::text IS NULL THEN $5 ELSE applied_generation END,indexed_version=CASE WHEN $6::text IS NULL THEN $7 ELSE indexed_version END,source_expires_at=CASE WHEN $6::text IS NULL THEN $9::timestamptz ELSE source_expires_at END,last_error=$6,lease_id=NULL,lease_until=NULL,next_attempt_at=$8 WHERE endpoint=$1 AND kind=$2 AND source_id=$3 AND lease_id=$4`,[this.endpoint,row.kind,row.source_id,row.lease_id,row.generation,error,version,iso(this.now()+(error?Math.min(300,2**Math.min(row.attempts+1,8)):0)),expiresAt===null?null:iso(expiresAt)]);}
 async deliveryEvent(row){return (await this.db.query('SELECT payload FROM discovery_usage_events_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,row.event_id])).rows[0]?.payload;}
 async beginSubmission(row){return (await this.db.query('UPDATE discovery_delivery_outbox_v1 SET submission_started=true WHERE endpoint=$1 AND event_id=$2 AND target=$3 AND lease_id=$4 RETURNING event_id',[this.endpoint,row.event_id,row.target,row.lease_id])).rows.length===1;}
 async completeDelivery(row,state,error=null){if(!['delivered','pending','result-unknown','excluded'].includes(state))throw new Error('Invalid delivery result');await this.db.query("UPDATE discovery_delivery_outbox_v1 SET state=$5,last_error=$6,submission_started=CASE WHEN $6='discovery_engine_authorization_failed' THEN false ELSE submission_started END,lease_id=NULL,lease_until=NULL,next_attempt_at=$7 WHERE endpoint=$1 AND event_id=$2 AND target=$3 AND lease_id=$4",[this.endpoint,row.event_id,row.target,row.lease_id,state,error,iso(this.now()+Math.min(300,2**Math.min(row.attempts+1,8)))]);}
 async status(){const deliveries=(await this.db.query('SELECT target,state,count(*)::int AS count FROM discovery_delivery_outbox_v1 WHERE endpoint=$1 GROUP BY target,state',[this.endpoint])).rows,index=(await this.db.query("SELECT CASE WHEN state='applied' AND generation>applied_generation THEN 'pending' ELSE state END AS state,count(*)::int AS count FROM discovery_index_outbox_v1 WHERE endpoint=$1 GROUP BY 1",[this.endpoint])).rows;return{deliveries,index,checkedAt:this.now()};}
}
