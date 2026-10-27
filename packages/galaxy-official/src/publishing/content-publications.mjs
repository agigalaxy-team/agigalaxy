import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {transaction} from "../infrastructure/database.mjs";
import {ServiceError} from "../shared/service-error.mjs";

import {contentSnapshotSchema} from './content-snapshot.mjs';
export {contentSnapshotSchema} from './content-snapshot.mjs';
const iso=value=>value?new Date(value).toISOString():null;
export const publicationView=row=>({id:row.id,state:row.state,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),publishedAt:iso(row.published_at),
  requestedBy:row.requested_by,result:row.result??null,error:row.error??null});
export {contentPublicationsV1MigrationSql} from "../infrastructure/content-publications-v1-schema.mjs";

const cancellationRegistrations=new WeakMap();
// API commands and a separately running publisher install the same domain
// cancellation. A process-local queue consumer is never its only authority.
export function registerContentPublicationCancellation({jobs,endpoint,now=()=>Math.floor(Date.now()/1000)}){
  if(!jobs||typeof jobs.onCancel!=='function')throw Error('Content publications require domain-aware queue cancellation');
  let registrations=cancellationRegistrations.get(jobs);
  if(!registrations){
    registrations=new Map();
    jobs.onCancel('content-publication',async(tx,data,context={})=>{
      await tx.query('SELECT pg_advisory_xact_lock(734912341)');
      const row=(await tx.query('SELECT id,endpoint,state,error,result FROM site_publications_v1 WHERE id=$1 FOR UPDATE',[data.publicationId])).rows[0];
      const registration=row&&registrations.get(row.endpoint);
      if(!row||!registration||context.endpoint&&context.endpoint!==row.endpoint)throw new ServiceError('site_publication_not_found',404);
      if(row.state==='published'||row.result?.activationPending
        ||row.error?.retryable===false&&row.error.code!=='site_publication_cancelled')throw new ServiceError('site_publication_not_cancellable',409);
      await tx.query(`UPDATE site_publications_v1 SET state='failed',error=$2,updated_at=$3 WHERE id=$1`,[row.id,
        JSON.stringify({code:'site_publication_cancelled',message:'已取消发布。',retryable:false}),new Date(registration.now()*1000).toISOString()]);
    });
    cancellationRegistrations.set(jobs,registrations);
  }
  if(!registrations.has(endpoint))registrations.set(endpoint,{now});
}

export class ContentPublications {
  constructor({db,endpoint,jobs,businessAdmin=null,now=()=>Math.floor(Date.now()/1000)}){
    Object.assign(this,{db,endpoint,jobs,businessAdmin,now});registerContentPublicationCancellation({jobs,endpoint,now});
  }
  async require(actor,write=false,db=this.db){if(!this.businessAdmin)throw new ServiceError('operations_authorization_unavailable',503);return this.businessAdmin.authorizeAction(actor,write?'cms.publish':'cms.read',{db});}
  async request(actor,input){
    await this.require(actor,true);
    const value=z.strictObject({operationId:z.uuid(),snapshot:contentSnapshotSchema}).safeParse(input);
    if(!value.success||Buffer.byteLength(JSON.stringify(value.data?.snapshot))>1048576)throw new ServiceError('invalid_site_publication');
    return transaction(this.db,async db=>{
      await this.require(actor,true,db);
      await db.query('SELECT pg_advisory_xact_lock(734912340)');
      const prior=(await db.query('SELECT * FROM site_publications_v1 WHERE id=$1',[value.data.operationId])).rows[0];
      if(prior){
        if(prior.endpoint!==this.endpoint||prior.requested_by!==actor.operatorId||!isDeepStrictEqual(prior.snapshot,value.data.snapshot))throw new ServiceError('site_publication_operation_changed',409);
        return {publication:publicationView(prior),replayed:true};
      }
      const at=new Date(this.now()*1000).toISOString();
      const row=(await db.query(`INSERT INTO site_publications_v1(id,endpoint,requested_by,snapshot,state,created_at,updated_at)
        VALUES($1,$2,$3,$4,'queued',$5,$5) RETURNING *`,[value.data.operationId,this.endpoint,actor.operatorId,JSON.stringify(value.data.snapshot),at])).rows[0];
      const jobId=await this.jobs.enqueue('content-publication',{publicationId:row.id},{key:'publication:'+row.id,db});
      if(!jobId)throw new ServiceError('site_publication_queue_unavailable',503);
      await db.query('UPDATE site_publications_v1 SET job_id=$2 WHERE id=$1',[row.id,jobId]);
      return {publication:publicationView(row),replayed:false};
    });
  }
  async get(actor,id){
    await this.require(actor);if(!z.uuid().safeParse(id).success)throw new ServiceError('invalid_site_publication');
    const row=(await this.db.query('SELECT * FROM site_publications_v1 WHERE id=$1 AND endpoint=$2',[id,this.endpoint])).rows[0];
    if(!row)throw new ServiceError('site_publication_not_found',404);
    return {publication:publicationView(row)};
  }
  async list(actor,{after,limit=20}={}){
    await this.require(actor);
    if(!Number.isInteger(limit)||limit<1||limit>100||after!==undefined&&!/^[1-9][0-9]{0,18}$/.test(after))throw new ServiceError('invalid_operations_query');
    const rows=(await this.db.query(`SELECT * FROM site_publications_v1 WHERE endpoint=$1 AND ($2::bigint IS NULL OR sequence<$2)
      ORDER BY sequence DESC LIMIT $3`,[this.endpoint,after??null,limit+1])).rows;
    return {items:rows.slice(0,limit).map(publicationView),nextAfter:rows.length>limit?String(rows[limit-1].sequence):null};
  }
}

// The runner renders only the immutable stored public snapshot. Queue data is
// a reference; no browser cookie, credential or file payload enters pg-boss.
export function createContentPublicationWorker({db,endpoint,publicOrigin=endpoint,jobs,publisher,businessAdmin=null,now=()=>Math.floor(Date.now()/1000)}){
  let stopped=false;
  registerContentPublicationCancellation({jobs,endpoint,now});
  async function execute({publicationId},{signal}={}){
    const row=(await db.query('SELECT * FROM site_publications_v1 WHERE id=$1 AND endpoint=$2',[publicationId,endpoint])).rows[0];
    if(!row||row.state==='published'||row.error?.retryable===false)return {state:row?.state??'superseded'};
    const authorize=async(connection=db)=>{
      if(!businessAdmin)throw new ServiceError('operations_authorization_unavailable',503);
      let action='cms.publish';
      if(row.base_publication_id){
        // Only the narrow, recorded settings-only bridge can use this action.
        // An ordinary CMS publication never gains it from browser input.
        const general=(await connection.query(`SELECT 1 FROM operations_system_general_publications_v1
          WHERE endpoint=$1 AND operation_id=$2 AND publication_id=$2 AND operator_id=$3
          AND input->>'expectedPublicationId'=$4`,[endpoint,row.id,row.requested_by,row.base_publication_id])).rows[0];
        if(!general)throw new ServiceError('operations_authorization_unavailable',503);
        action='system.settings.apply';
      }
      return businessAdmin.revalidate({kind:'business-operator',operatorId:row.requested_by,role:'reader',endpoint},{action,db:connection});
    };
    await authorize();
    signal?.throwIfAborted();
    const at=()=>new Date(now()*1000).toISOString();
    const claimed=(await db.query(`UPDATE site_publications_v1 SET state='building',attempts=attempts+1,error=NULL,updated_at=$2
      WHERE id=$1 AND state<>'published' AND (error IS NULL OR error->>'retryable'<>'false') RETURNING id`,[row.id,at()])).rows[0];
    if(!claimed)return {state:'superseded'};
    let artifact;
    try{
      const current=await publisher.current();
      if(current?.publicationId===row.id){
        const result={publicUrl:publicOrigin+'/',siteVersion:current.siteVersion,publicationId:row.id};
        return await transaction(db,async tx=>{
          await authorize(tx);
          await tx.query('SELECT pg_advisory_xact_lock(734912341)');
          const live=(await tx.query('SELECT * FROM site_publications_v1 WHERE id=$1 AND endpoint=$2 FOR UPDATE',[row.id,endpoint])).rows[0];
          if(!live||live.error?.retryable===false)return {state:'superseded'};
          if(live.state==='published')return {state:'published'};
          const newer=(await tx.query("SELECT 1 FROM site_publications_v1 WHERE endpoint=$1 AND sequence>$2 AND state='published' LIMIT 1",[endpoint,row.sequence])).rows.length;
          if(newer){
            await tx.query("UPDATE site_publications_v1 SET state='failed',result=NULL,error=$2,updated_at=$3 WHERE id=$1",[row.id,
              JSON.stringify({code:'site_publication_superseded',message:'已有更新的内容发布；可从所需版本发起新发布。',retryable:false}),at()]);
            return {state:'superseded'};
          }
          const actual=await publisher.current();
          if(actual?.publicationId!==row.id)throw new ServiceError('site_publication_failed',503);
          result.siteVersion=actual.siteVersion;
          await tx.query("UPDATE site_publications_v1 SET state='published',result=$2,error=NULL,published_at=COALESCE(published_at,$3),updated_at=$3 WHERE id=$1",[row.id,JSON.stringify(result),at()]);
          return {state:'published'};
        });
      }
      artifact=await publisher.prepare({publicationId:row.id,snapshot:row.snapshot,signal});
      signal?.throwIfAborted();
      const prepared=await transaction(db,async tx=>{
        await authorize(tx);
          await tx.query('SELECT pg_advisory_xact_lock(734912341)');
        const live=(await tx.query('SELECT * FROM site_publications_v1 WHERE id=$1 AND endpoint=$2 FOR UPDATE',[row.id,endpoint])).rows[0];
        if(!live||live.error?.retryable===false||stopped){return {state:'superseded'};}
        if(live.state==='published')return {state:'published'};
        const newer=(await tx.query("SELECT 1 FROM site_publications_v1 WHERE endpoint=$1 AND sequence>$2 AND state='published' LIMIT 1",[endpoint,row.sequence])).rows.length;
        if(newer){
          await tx.query("UPDATE site_publications_v1 SET state='failed',error=$2,updated_at=$3 WHERE id=$1",[row.id,
            JSON.stringify({code:'site_publication_superseded',message:'已有更新的内容发布；可从所需版本发起新发布。',retryable:false}),at()]);
          return {state:'superseded'};
        }
        signal?.throwIfAborted();
        // Commit this short phase before touching the filesystem. An API
        // process cannot safely promise cancellation during an unknown switch.
        await tx.query('UPDATE site_publications_v1 SET result=$2,updated_at=$3 WHERE id=$1',[row.id,
          JSON.stringify({publicationId:row.id,siteVersion:artifact.siteVersion,activationPending:true}),at()]);
        return {state:'prepared'};
      });
      if(prepared.state!=='prepared')return prepared;
      return await transaction(db,async tx=>{
        await authorize(tx);
          await tx.query('SELECT pg_advisory_xact_lock(734912341)');
        const live=(await tx.query('SELECT * FROM site_publications_v1 WHERE id=$1 AND endpoint=$2 FOR UPDATE',[row.id,endpoint])).rows[0];
        if(!live||live.error?.retryable===false||stopped)return {state:'superseded'};
        if(live.state==='published')return {state:'published'};
        const newer=(await tx.query("SELECT 1 FROM site_publications_v1 WHERE endpoint=$1 AND sequence>$2 AND state='published' LIMIT 1",[endpoint,row.sequence])).rows.length;
        if(newer){
          await tx.query("UPDATE site_publications_v1 SET state='failed',result=NULL,error=$2,updated_at=$3 WHERE id=$1",[row.id,
            JSON.stringify({code:'site_publication_superseded',message:'已有更新的内容发布；可从所需版本发起新发布。',retryable:false}),at()]);
          return {state:'superseded'};
        }
        signal?.throwIfAborted();await authorize(tx);
        let activated=null;
        if(live.base_publication_id){
          activated=await publisher.current();
          // Settings-only publication preserves this exact content base.
          // A lost acknowledgement of this same publication is reconciled.
          if(activated?.publicationId!==row.id&&activated?.publicationId!==live.base_publication_id)
            throw new ServiceError('site_publication_base_changed',409);
        }
        if(activated?.publicationId!==row.id)await publisher.activate(artifact);
        const result={publicUrl:publicOrigin+'/',siteVersion:activated?.publicationId===row.id?activated.siteVersion:artifact.siteVersion,publicationId:row.id};
        await tx.query("UPDATE site_publications_v1 SET state='published',result=$2,error=NULL,published_at=$3,updated_at=$3 WHERE id=$1",[row.id,JSON.stringify(result),at()]);
        return {state:'published'};
      });
    }catch(error){
      // If the pointer already moved but its DB acknowledgement was lost, the
      // next attempt reconciles the exact publication marker before rebuilding.
      let known=false;
      const current=await publisher.current().then(value=>{known=true;return value;},()=>null);
      if(current?.publicationId!==row.id)await db.query(`UPDATE site_publications_v1 SET state='failed',error=$2,updated_at=$3,
        result=CASE WHEN $4 THEN NULL ELSE result END
        WHERE id=$1 AND state<>'published' AND (error IS NULL OR error->>'retryable'<>'false')`,[row.id,
        JSON.stringify(error?.code==='site_publication_base_changed'
          ?{code:'site_publication_base_changed',message:'官网内容已有更新，请读取后应用。',retryable:false}
          :{code:'site_publication_failed',message:'发布尚未完成，可以重试或查看当前发布状态。',retryable:true}),at(),known]);
      const failure=error?.code==='site_publication_base_changed'
        ?new ServiceError('site_publication_base_changed',409):new ServiceError('site_publication_failed',503);
      Object.defineProperty(failure,'cause',{value:error});
      throw failure;
    }
  }
  return {start:()=>jobs.work('content-publication',execute),async stop(){stopped=true;await jobs.stopWork('content-publication');},execute};
}
