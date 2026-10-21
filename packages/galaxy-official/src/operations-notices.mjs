import {z} from 'zod';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {operationsPageSchema,noticeCreateSchema,noticeSaveSchema,noticeActionSchema,accountNoticePageSchema,operationsProductParse as parse} from './shared/operations-product-schema.mjs';
import {operationsProductCommand,operationsStamp as stamp} from './operations-product-commands.mjs';

const cancellationRegistrations=new WeakMap();
export function registerOperationsNoticeCancellation({jobs,endpoint,now=()=>Math.floor(Date.now()/1000)}){
  let endpoints=cancellationRegistrations.get(jobs);
  if(!endpoints){
    endpoints=new Map();cancellationRegistrations.set(jobs,endpoints);
    jobs.onCancel('account-notice',async(db,data,context={})=>{
      const row=(await db.query('SELECT * FROM operations_notices_v1 WHERE id=$1 FOR UPDATE',[data.noticeId])).rows[0];
      if(!row||!endpoints.has(row.endpoint)||context.endpoint&&row.endpoint!==context.endpoint)throw new ServiceError('operations_notice_not_found',404);
      if(['delivered','expired'].includes(row.state))throw new ServiceError('operations_notice_not_cancellable',409);
      if(row.state!=='withdrawn')await db.query("UPDATE operations_notices_v1 SET state='withdrawn',version=version+1,updated_at=$2 WHERE id=$1",[row.id,new Date(endpoints.get(row.endpoint)()*1000).toISOString()]);
    });
  }
  endpoints.set(endpoint,now);
}

export class OperationsNotices{
  constructor({db,endpoint,businessAdmin,accounts,jobs,now=()=>Math.floor(Date.now()/1000)}){
    Object.assign(this,{db,endpoint,businessAdmin,accounts,jobs,now});registerOperationsNoticeCancellation({jobs,endpoint,now});
  }
  async rowWithin(db,id,{lock=false}={}){
    parse(z.uuid(),id);const row=(await db.query(`SELECT * FROM operations_notices_v1 WHERE id=$1 AND endpoint=$2${lock?' FOR UPDATE':''}`,[id,this.endpoint])).rows[0];
    if(!row)throw new ServiceError('operations_notice_not_found',404);return row;
  }
  async viewWithin(db,row){
    const counts=(await db.query(`SELECT count(*)::integer AS targets,count(*) FILTER(WHERE delivered_at IS NOT NULL)::integer AS delivered,
      count(*) FILTER(WHERE read_at IS NOT NULL)::integer AS read FROM account_operations_notices_v1 WHERE notice_id=$1`,[row.id])).rows[0];
    return {id:row.id,sequence:String(row.sequence),version:row.version,state:!['draft','withdrawn'].includes(row.state)&&Date.parse(row.expires_at)<=this.now()*1000?'expired':row.state,
      content:row.content,createdBy:row.created_by,updatedBy:row.updated_by,publishedBy:row.published_by,publishedAt:stamp(row.published_at),expiresAt:stamp(row.expires_at),
      createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at),jobId:row.job_id,
      delivery:{audienceCount:row.audience_count,deliveredCount:counts.delivered,readCount:counts.read,
        skippedCount:Math.max(0,row.audience_count-counts.targets),pendingCount:counts.targets-counts.delivered,errorCode:row.delivery_error_code,lastAttemptAt:stamp(row.last_attempt_at)}};
  }
  async list(operator,input={}){
    this.businessAdmin.require(operator);const page=parse(operationsPageSchema,input);
    const rows=(await this.db.query(`SELECT * FROM operations_notices_v1 WHERE endpoint=$1 AND ($2::bigint IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT $3`,[this.endpoint,page.after??null,page.limit+1])).rows;
    const items=[];for(const row of rows.slice(0,page.limit))items.push(await this.viewWithin(this.db,row));
    return {items,nextAfter:rows.length>page.limit?String(rows[page.limit-1].sequence):null,checkedAt:this.now()};
  }
  async get(operator,id){this.businessAdmin.require(operator);return {notice:await this.viewWithin(this.db,await this.rowWithin(this.db,id))};}
  async overview(operator){
    this.businessAdmin.require(operator);
    const rows=(await this.db.query(`SELECT state,count(*)::integer AS count FROM operations_notices_v1 WHERE endpoint=$1 AND expires_at>$2 GROUP BY state`,[this.endpoint,new Date(this.now()*1000).toISOString()])).rows;
    return {counts:Object.fromEntries(rows.map(row=>[row.state,row.count])),checkedAt:this.now()};
  }
  requireFuture(content){if(Date.parse(content.expiresAt)<=this.now()*1000)throw new ServiceError('operations_notice_expiry_invalid');}
  async create(operator,input){
    const data=parse(noticeCreateSchema,input);
    return operationsProductCommand(this,operator,'notice-create',data,async(db,actor)=>{
      this.requireFuture(data.content);
      const at=new Date(this.now()*1000).toISOString(),row=(await db.query(`INSERT INTO operations_notices_v1(id,endpoint,version,content,state,created_by,updated_by,expires_at,created_at,updated_at)
        VALUES($1,$2,1,$3,'draft',$4,$4,$5,$6,$6) RETURNING *`,[data.operationId,this.endpoint,JSON.stringify(data.content),actor.operatorId,data.content.expiresAt,at])).rows[0];
      return {result:{notice:await this.viewWithin(db,row)},selection:{noticeId:row.id},auditResult:{state:'draft',version:1}};
    });
  }
  async save(operator,id,input){
    const data=parse(noticeSaveSchema,input);parse(z.uuid(),id);
    return operationsProductCommand(this,operator,'notice-save',{...data,noticeId:id},async(db,actor)=>{
      this.requireFuture(data.content);
      const current=await this.rowWithin(db,id,{lock:true});
      if(current.version!==data.expectedVersion)throw new ServiceError('operations_notice_version_changed',409);
      if(current.state!=='draft')throw new ServiceError('operations_notice_not_draft',409);
      const row=(await db.query(`UPDATE operations_notices_v1 SET content=$2,expires_at=$3,version=version+1,updated_by=$4,updated_at=$5 WHERE id=$1 RETURNING *`,
        [id,JSON.stringify(data.content),data.content.expiresAt,actor.operatorId,new Date(this.now()*1000).toISOString()])).rows[0];
      return {result:{notice:await this.viewWithin(db,row)},selection:{noticeId:id,expectedVersion:data.expectedVersion},auditResult:{version:row.version,state:row.state}};
    });
  }
  async publish(operator,id,input){
    const data=parse(noticeActionSchema,input);parse(z.uuid(),id);
    return operationsProductCommand(this,operator,'notice-publish',{...data,noticeId:id},async(db,actor)=>{
      const current=await this.rowWithin(db,id,{lock:true});
      if(current.version!==data.expectedVersion)throw new ServiceError('operations_notice_version_changed',409);
      if(current.state!=='draft')throw new ServiceError('operations_notice_not_draft',409);this.requireFuture(current.content);
      const audience=current.content.audience,selected=audience.kind==='accounts'?audience.accountIds:null;
      // Freeze the exact current audience, rather than including accounts that
      // happen to register during a later delivery page. These are pending rows;
      // they are not visible in a recipient's inbox until actually delivered.
      const inserted=(await db.query(`WITH recipients AS(INSERT INTO account_operations_notices_v1(notice_id,account_id)
        SELECT $1,id FROM community_accounts WHERE endpoint=$2 AND ($3::uuid[] IS NULL OR id=ANY($3)) RETURNING account_id)
        SELECT count(*)::integer AS count FROM recipients`,[id,this.endpoint,selected])).rows[0].count;
      if(selected&&inserted!==selected.length)throw new ServiceError('operations_notice_audience_unavailable',409);
      const at=new Date(this.now()*1000).toISOString(),jobId=await this.jobs.enqueue('account-notice',{noticeId:id},{key:'notice:'+id+':start',db});
      if(!jobId)throw new ServiceError('operations_notice_queue_unavailable',503);
      const row=(await db.query(`UPDATE operations_notices_v1 SET state='queued',version=version+1,published_by=$2,published_at=$3,updated_at=$3,updated_by=$2,audience_count=$4,job_id=$5 WHERE id=$1 RETURNING *`,[id,actor.operatorId,at,inserted,jobId])).rows[0];
      return {result:{notice:await this.viewWithin(db,row)},selection:{noticeId:id,expectedVersion:data.expectedVersion,audience:audience.kind},auditResult:{version:row.version,state:'queued',audienceCount:inserted}};
    });
  }
  async withdraw(operator,id,input){
    const data=parse(noticeActionSchema,input);parse(z.uuid(),id);
    return operationsProductCommand(this,operator,'notice-withdraw',{...data,noticeId:id},async(db,actor)=>{
      const current=await this.rowWithin(db,id,{lock:true});if(current.version!==data.expectedVersion)throw new ServiceError('operations_notice_version_changed',409);
      if(current.state==='withdrawn')throw new ServiceError('operations_notice_already_withdrawn',409);
      const row=(await db.query("UPDATE operations_notices_v1 SET state='withdrawn',version=version+1,updated_by=$2,updated_at=$3 WHERE id=$1 RETURNING *",[id,actor.operatorId,new Date(this.now()*1000).toISOString()])).rows[0];
      return {result:{notice:await this.viewWithin(db,row)},selection:{noticeId:id,expectedVersion:data.expectedVersion},auditResult:{version:row.version,state:'withdrawn'}};
    });
  }
  async accountQuery(actor,input={}){
    const page=parse(accountNoticePageSchema,input);
    return this.accounts.runAuthorized(actor,'assistance',async(db,_authorization,currentActor)=>{
      const account=await this.accounts.resolveWithin(db,currentActor??actor),rows=(await db.query(`SELECT n.*,r.sequence AS recipient_sequence,r.delivered_at,r.read_at
        FROM account_operations_notices_v1 r JOIN operations_notices_v1 n ON n.id=r.notice_id WHERE r.account_id=$1 AND n.endpoint=$2
        AND r.delivered_at IS NOT NULL AND n.state IN ('queued','delivering','delivered') AND n.expires_at>$3
        AND ($4::bigint IS NULL OR r.sequence<$4) AND (NOT $5::boolean OR r.read_at IS NULL) ORDER BY r.sequence DESC LIMIT $6`,
      [account.id,this.endpoint,new Date(this.now()*1000).toISOString(),page.after??null,page.unreadOnly,page.limit+1])).rows;
      return {items:rows.slice(0,page.limit).map(row=>({noticeId:row.id,kind:'service-notice',purpose:row.content.purpose,title:row.content.title,body:row.content.body,href:row.content.href,
        at:stamp(row.delivered_at),expiresAt:stamp(row.expires_at),read:!!row.read_at,source:{kind:'business-operator',serviceEndpoint:this.endpoint}})),
        nextAfter:rows.length>page.limit?String(rows[page.limit-1].recipient_sequence):null,checkedAt:this.now()};
    });
  }
  async accountMarkRead(actor,input){
    const {noticeId}=parse(z.strictObject({noticeId:z.uuid()}),input);
    return this.accounts.runAuthorized(actor,'assistance',async(db,_authorization,currentActor)=>{
      const account=await this.accounts.resolveWithin(db,currentActor??actor),at=new Date(this.now()*1000).toISOString();
      const updated=await db.query(`UPDATE account_operations_notices_v1 r SET read_at=COALESCE(r.read_at,$3) FROM operations_notices_v1 n
        WHERE r.notice_id=$1 AND r.account_id=$2 AND n.id=r.notice_id AND n.endpoint=$4 AND r.delivered_at IS NOT NULL
        AND n.state IN ('queued','delivering','delivered') AND n.expires_at>$3 RETURNING r.notice_id`,[noticeId,account.id,at,this.endpoint]);
      if(!updated.rows.length)throw new ServiceError('operations_notice_not_found',404);
      return {noticeId,read:true,checkedAt:this.now()};
    });
  }
}

export function createOperationsNoticeWorker({notices,jobs=notices.jobs}){
  async function execute({noticeId}){
    parse(z.uuid(),noticeId);
    try{return await transaction(notices.db,async db=>{
      const row=await notices.rowWithin(db,noticeId,{lock:true});
      if(!['queued','delivering'].includes(row.state))return {state:row.state};
      const actor=await notices.businessAdmin.revalidate({kind:'business-operator',operatorId:row.published_by,role:'administrator',endpoint:notices.endpoint},{write:true,db});
      const at=new Date(notices.now()*1000).toISOString();
      if(Date.parse(row.expires_at)<=notices.now()*1000){
        await db.query("UPDATE operations_notices_v1 SET state='expired',updated_at=$2,last_attempt_at=$2 WHERE id=$1",[noticeId,at]);
        await notices.businessAdmin.recordWithin(db,actor,'notice-delivery',{selection:{noticeId,execution:'worker'},result:{state:'expired',deliveredCount:0}});
        return {state:'expired'};
      }
      const selected=(await db.query(`SELECT sequence,account_id FROM account_operations_notices_v1 WHERE notice_id=$1 AND delivered_at IS NULL ORDER BY sequence LIMIT 100 FOR UPDATE`,[noticeId])).rows;
      if(selected.length)await db.query(`UPDATE account_operations_notices_v1 SET delivered_at=$3 WHERE notice_id=$1 AND account_id=ANY($2::uuid[]) AND delivered_at IS NULL`,[noticeId,selected.map(recipient=>recipient.account_id),at]);
      const remaining=(await db.query('SELECT 1 FROM account_operations_notices_v1 WHERE notice_id=$1 AND delivered_at IS NULL LIMIT 1',[noticeId])).rows.length;
      let jobId=row.job_id;
      if(remaining){jobId=await jobs.enqueue('account-notice',{noticeId},{key:'notice:'+noticeId+':'+selected.at(-1).sequence,db});if(!jobId)throw new ServiceError('operations_notice_queue_unavailable',503);}
      const state=remaining?'delivering':'delivered';
      await db.query('UPDATE operations_notices_v1 SET state=$2,updated_at=$3,job_id=$4,delivery_error_code=NULL,last_attempt_at=$3 WHERE id=$1',[noticeId,state,at,jobId]);
      await notices.businessAdmin.recordWithin(db,actor,'notice-delivery',{
        selection:{noticeId,execution:'worker'},result:{state,deliveredCount:selected.length}});
      return {state,deliveredCount:selected.length};
    });}catch(error){
      const code=['business_admin_denied','identity_directory_unavailable','operations_authorization_unavailable'].includes(error?.code)?error.code:'operations_notice_delivery_failed';
      await transaction(notices.db,async db=>{
        const row=await notices.rowWithin(db,noticeId,{lock:true});if(!['queued','delivering'].includes(row.state))return;
        await db.query('UPDATE operations_notices_v1 SET delivery_error_code=$2,last_attempt_at=$3 WHERE id=$1',[noticeId,code,new Date(notices.now()*1000).toISOString()]);
        // Attribution is the original delegated operator, not an assertion that
        // they still have permission. No recipient delivery committed on error.
        await notices.businessAdmin.recordWithin(db,{kind:'business-operator',operatorId:row.published_by,role:'administrator',endpoint:notices.endpoint},'notice-delivery',{
          selection:{noticeId,execution:'worker',reason:code==='business_admin_denied'?'authority_changed':'execution_failed'},result:{state:'failed',code,deliveredCount:0}});
      });
      throw new ServiceError(code,code==='business_admin_denied'?403:503);
    }
  }
  return {execute,start:()=>jobs.work('account-notice',execute),stop:()=>jobs.stopWork('account-notice')};
}
