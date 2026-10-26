import {randomUUID,timingSafeEqual} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {agentOsToolSchema} from "../../shared/operations-agentos-schema.mjs";

const fail=(code,status=403)=>{throw new ServiceError(code,status);};
const iso=value=>new Date(value*1000).toISOString();
const safeError=new Set(['operations_source_changed','operations_visibility_changed','operations_source_unavailable','operations_hide_expiry','operations_agentos_authority_changed','operations_agentos_execution_inactive','operations_permission_denied']);
const readArguments=z.strictObject({kind:z.enum(['post','reply']),id:z.uuid()});
const searchArguments=z.strictObject({kind:z.enum(['post','reply']),query:z.string().trim().min(1).max(160),
 after:z.number().int().min(0).max(10000).optional(),limit:z.number().int().min(1).max(30).optional()});
const searchSourceVersion=z.union([z.uuid(),z.string().regex(/^[1-9][0-9]{0,9}$/)]);

// This private service endpoint is not exposed through the browser BFF. The
// root HTTP adapter must call verifyService on both exact internal POST paths.
export class OperationsAgentOsGateway {
 constructor({authority,content,discovery=null,serviceKey,now=authority.now}){Object.assign(this,{authority,content,discovery,db:authority.db,endpoint:authority.endpoint,serviceKey,now});}
 verifyService(request){const raw=request.headers?.authorization;
  if(typeof this.serviceKey!=='string'||this.serviceKey.length<32||typeof raw!=='string'||!raw.startsWith('Bearer '))fail('operations_agentos_service_denied');
  const a=Buffer.from(raw.slice(7)),b=Buffer.from(this.serviceKey);if(a.length!==b.length||!timingSafeEqual(a,b))fail('operations_agentos_service_denied');
 }
 async authorize(input){if(input?.conversationId)return this.authority.conversations.authorizeNative(input);
  const result=await this.authority.nativeAuthorization(input);let readExpiresAt=this.now()+30;
  const refs=(await this.db.query('SELECT * FROM operations_agentos_source_refs_v1 WHERE execution_id=$1',[input.executionId])).rows;
  for(const ref of refs){
   const actor=await this.authority.actor(input.executionId,{resourceIds:[ref.target_id],active:input.operation==='run'}),response=await this.content.get(actor,ref.target_kind,ref.target_id),item=response.content;
   if(item.sourceState!=='available'||item.version!==ref.source_version)fail('operations_agentos_source_changed',409);
   if(Number.isFinite(item.publishedUntil))readExpiresAt=Math.min(readExpiresAt,item.publishedUntil);
  }
  return {...result,readExpiresAt};
 }
 async checkPriorDecision(db,actor,command){
  const targetKind=command.targetKind==='post'?'forum-post':'forum-reply';
  const head=(await db.query('SELECT * FROM operations_content_visibility_v1 WHERE endpoint=$1 AND target_kind=$2 AND target_id=$3',[this.endpoint,targetKind,command.targetId])).rows[0];
  if(head?.hidden_until&&Date.parse(head.hidden_until)>this.now()*1000){
   const origin=(await db.query('SELECT actor_kind,grant_id FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,head.operation_id])).rows[0];
   // An AI/program task cannot override a human or another authorization's
   // restriction. Current source, temporal policy and CAS remain in the domain.
   if(origin?.actor_kind!=='operations-executor'||origin.grant_id!==actor.grantId)fail('operations_agentos_human_review_required',409);
  }
 }
 async execute(input,{caller=null}={}){if(input?.conversationId){if(caller)fail('operations_agentos_scope_denied');return this.authority.conversations.executeTool(input);}
  const parsed=agentOsToolSchema.safeParse(input);if(!parsed.success)fail('invalid_operations_agentos_request',400);const x=parsed.data;
  if(x.tool==='search-selected-public-content'){
   const parsedArguments=searchArguments.safeParse(x.arguments);if(!parsedArguments.success)fail('invalid_operations_agentos_request',400);
   const args=parsedArguments.data,actor=await this.authority.actor(x.executionId,{caller});
   await this.authority.requireAction(actor,'content.read');
   if(!actor.resourceIds.length)fail('operations_agentos_scope_required',400);
   if(typeof this.discovery?.searchSelected!=='function')fail('operations_agentos_search_not_configured',503);
   // Scope is derived from the current server task, never model arguments.
   // The discovery adapter also filters at the engine and current-source gate.
   const selected=new Set(actor.resourceIds),result=await this.discovery.searchSelected(
    {query:args.query,...(args.after===undefined?{}:{after:args.after}),...(args.limit===undefined?{}:{limit:args.limit})},
    actor.resourceIds.map(id=>({kind:args.kind,id})));
   await this.authority.requireAction(actor,'content.read');
   // Search only locates the already selected objects. Prose must still pass
   // read-selected-content, which pins source revisions and current leases.
   return {items:(result.items??[]).filter(item=>item.kind===args.kind&&selected.has(item.id))
    .map(item=>({kind:item.kind,id:item.id,sourceVersion:searchSourceVersion.safeParse(item.version).success?item.version:null})),
    nextAfter:typeof result.nextAfter==='number'&&Number.isSafeInteger(result.nextAfter)?result.nextAfter:null,
    source:'meilisearch-selected-public-content',qualification:'current-anonymous-public-reader'};
  }
  if(x.tool==='read-selected-content'){
   const args=readArguments.safeParse(x.arguments);if(!args.success)fail('invalid_operations_agentos_request',400);
   const actor=await this.authority.actor(x.executionId,{resourceIds:[args.data.id],caller});
   const response=await this.content.get(actor,args.data.kind,args.data.id);
   await this.authority.requireAction(actor,'content.read');
   const item=response.item??response.content??response;
   if(item.sourceState==='available'){
    await this.db.query(`INSERT INTO operations_agentos_source_refs_v1(execution_id,target_kind,target_id,source_version)
     VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[x.executionId,item.kind,item.id,item.version]);
    const ref=(await this.db.query('SELECT source_version FROM operations_agentos_source_refs_v1 WHERE execution_id=$1 AND target_kind=$2 AND target_id=$3',[x.executionId,item.kind,item.id])).rows[0];
    if(ref?.source_version!==item.version)fail('operations_agentos_source_changed',409);
   }
   // No author email, hidden source, arbitrary links, attachment URLs, case
   // materials, history prose, reason or credentials become model context.
   return {kind:item.kind,id:item.id,version:item.version,sourceState:item.sourceState,
    // A reply's title is inherited from its parent under an independent source
    // lease. Do not persist that parent title in a reply-only model context.
    title:item.kind==='post'&&item.sourceState==='available'?item.title??null:null,
    body:item.sourceState==='available'?item.body??null:null,
    visibility:item.visibility?{hidden:item.visibility.hidden,version:item.visibility.version}:null};
  }
  if(Object.keys(x.arguments).length)fail('invalid_operations_agentos_request',400);
  const initial=await transaction(this.db,async db=>{
   const current=await this.authority.currentWithin(db,x.executionId,{caller}),command=current.row.prepared_command;
   if(!command)fail('operations_agentos_prepared_command_required',409);
   const actor=await this.authority.actor(x.executionId,{db,resourceIds:[command.targetId],caller});
   await this.authority.requireAction(actor,command.input.kind==='hide'?'content.hide':'content.restore',{db});
   await this.checkPriorDecision(db,actor,command);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912422))',[this.endpoint+':'+x.executionId+':'+x.runId+':'+x.callId]);
   const old=(await db.query('SELECT * FROM operations_agentos_tool_calls_v1 WHERE endpoint=$1 AND execution_id=$2 AND run_id=$3 AND call_id=$4',[this.endpoint,x.executionId,x.runId,x.callId])).rows[0];
   if(old){if(old.tool!==x.tool||!isDeepStrictEqual(old.arguments,x.arguments))fail('operations_agentos_operation_conflict',409);
    if(old.state==='completed')return {saved:old.result};
    // A previous acceptance whose ACK was lost must use the same frozen
    // business operation ID. The domain's stable command determines its result.
    return {operationId:old.operation_id,command};
   }
   const operationId=randomUUID();await db.query(`INSERT INTO operations_agentos_tool_calls_v1
    (id,endpoint,execution_id,run_id,call_id,tool,state,operation_id,arguments,created_at) VALUES($1,$2,$3,$4,$5,$6,'running',$7,$8,$9)`,
    [randomUUID(),this.endpoint,x.executionId,x.runId,x.callId,x.tool,operationId,JSON.stringify(x.arguments),iso(this.now())]);
   return {operationId,command};
  });
  if(initial.saved)return {...initial.saved,replayed:true};
  const {command,operationId}=initial;
  try{
   const actor=await this.authority.actor(x.executionId,{resourceIds:[command.targetId],caller});
   // The original decision check is repeated by BusinessAdmin immediately
   // before the exact domain command; a race cannot replace an intervening
   // human decision merely because this earlier preflight succeeded.
   const response=await this.content.visibility(actor,command.targetKind,command.targetId,{...command.input,operationId});
   const item=response.item??response.content??response,result={operationId,kind:command.targetKind,id:command.targetId,
    visibility:item.visibility??null,replayed:response.replayed??false};
   await this.authority.requireAction(actor,command.input.kind==='hide'?'content.hide':'content.restore');
   await this.db.query(`UPDATE operations_agentos_tool_calls_v1 SET state='completed',result=$5,code=NULL,completed_at=$6
    WHERE endpoint=$1 AND execution_id=$2 AND run_id=$3 AND call_id=$4`,[this.endpoint,x.executionId,x.runId,x.callId,JSON.stringify(result),iso(this.now())]);return result;
  }catch(error){const code=safeError.has(error.code)?error.code:'operations_agentos_tool_failed';
   // Never claim that a changed authorization rolled back an already committed
   // effect. The original operation ID remains available for reconciliation.
   await this.db.query(`UPDATE operations_agentos_tool_calls_v1 SET state='unknown',code=$5 WHERE endpoint=$1 AND execution_id=$2 AND run_id=$3 AND call_id=$4`,[this.endpoint,x.executionId,x.runId,x.callId,code]);
   fail(code,error.status??503);
  }
 }
 async guardOperationWithin(db,actor,action,selection){
  if(action!=='community-content-visibility')return;
  const {row}=await this.authority.currentWithin(db,actor.executionId,{from:actor});
  const command=row.prepared_command;
  if(!command||selection.id!==command.targetId||selection.targetKind!==command.targetKind||selection.kind!==command.input.kind||selection.expectedVersion!==command.input.expectedVersion||selection.expectedRevision!==command.input.expectedRevision)fail('operations_agentos_scope_denied');
  await this.checkPriorDecision(db,actor,command);
 }
}
