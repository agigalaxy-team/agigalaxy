import {randomUUID} from 'node:crypto';
import {transaction} from "../../infrastructure/database.mjs";
import {p14Evaluate} from '../rules/evaluator.mjs';
import {p14EmptyControls} from '../../shared/p14-rules-schema.mjs';
import {parse,fail} from './contract.mjs';
import {z} from 'zod';

/** Deterministic rule rounds use the same current readers, authority, frozen
 * operation and domain adapters as AI rounds. This function never calls a model. */
export async function runAutonomyCode(service,input){
 const {taskId}=parse(z.strictObject({taskId:z.uuid()}),input),row=await service.taskWithin(service.db,taskId);
 if(row.mode!=='code')fail('operations_autonomy_scope_denied',403);
 const response=state=>({taskId,operationId:taskId,nativeRunId:null,status:state==='completed'?'COMPLETED':state==='waiting-human'?'PAUSED':'ERROR',modelState:'not-required',awaitingHuman:state==='waiting-human',state,...service.stamp()});
 if(['completed','waiting-human','failed','stopped'].includes(row.state))return response(row.state);
 const actor=await transaction(service.db,db=>service.authorizeTaskWithin(db,row));
 const pinned=row.configuration.versionBindings?.strategyVersionId,version=pinned?(await service.db.query('SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2',[service.endpoint,pinned])).rows[0]:null;
 const strategies=version?.configuration?.strategies?.filter(s=>row.configuration.plan.strategyIds.includes(s.id)&&s.enabled&&s.mode==='code-automatic')??[];
 const wait=async code=>{await transaction(service.db,db=>service.waitForHumanWithin(db,{taskId,operationId:taskId,code}));return response('waiting-human');};
 if(!strategies.length||!service.queryTools)return wait('operations_autonomy_rule_requires_configuration');
 let checked=0,hits=0,needsHuman=false;
 for(const strategy of strategies){
  const actions=strategy.execution?.actions??row.configuration.plan.actions,files=actions.length===1&&actions[0]==='files.scan.retry',content=strategy.template==='selected-public-content-visibility'||actions.length===1&&actions[0]==='content.restore';
  if(!files&&!content){needsHuman=true;continue;}
  const targets=[],selectedIds=row.configuration.plan.resourceIds.length?row.configuration.plan.resourceIds:strategy.execution?.resourceScope?.kind==='selected'?strategy.execution.resourceScope.resourceIds:[];
  if(selectedIds.length){
   for(const id of selectedIds){
    const explicit={'content-reply':'reply','content-post':'post','file-chat':'chat-file','file-forum':'forum-file'}[row.target_type],kinds=explicit?[explicit]:files?['chat-file','forum-file']:['post','reply'];let found=false;
    for(const kind of kinds){try{const read=await service.queryTools.execute({actor,domain:row.domain,tool:'read-operation-object',arguments:{kind,id,filters:{}}});if(read.availability==='available'){targets.push({id,kind,read});found=true;break;}}catch(error){if(error.status!==404)throw error;}}
    if(!found)needsHuman=true;
   }
  }else if(strategy.execution?.resourceScope?.kind==='eligible'){
   // Explicit eligibility is continuously evaluated through current readers;
   // an empty selected set never silently becomes an all-object audience.
   let next={module:files?'files':'content',view:'list',filters:files?{processing:'scan',limit:20}:{days:'all',limit:20}};const seen=new Set();
   while(next){
    await transaction(service.db,db=>service.authorizeTaskWithin(db,row));const key=JSON.stringify(next);if(seen.has(key)){needsHuman=true;break;}seen.add(key);
    const page=await service.queryTools.execute({actor,domain:row.domain,tool:'query-operations',arguments:next});if(page.availability!=='available'){needsHuman=true;break;}checked++;
    for(const ref of page.evidenceRefs??[])if((files?['chat-file','forum-file']:['post','reply']).includes(ref.kind))targets.push({id:ref.id,kind:ref.kind});
    if(page.pagination?.complete===false&&!page.pagination.next){needsHuman=true;break;}next=page.pagination?.next??null;
   }
  }else{needsHuman=true;continue;}
  for(const target of targets){
   const targetId=target.id,kind=target.kind;
   await transaction(service.db,db=>service.authorizeTaskWithin(db,row));
   const read=target.read??await service.queryTools.execute({actor,domain:row.domain,tool:'read-operation-object',arguments:{kind,id:targetId,filters:{}}});
   if(read.availability!=='available'){needsHuman=true;continue;}checked++;
   let hit=true;
   if(strategy.condition){
    if(!['post','reply'].includes(kind)){needsHuman=true;continue;}
    const data=read.data,source=await service.authority.content.rawWithin(service.db,kind,targetId),qualified=await service.authority.content.publicSourceWithin(service.db,kind,source.head,source.source);
    if(!qualified.available){needsHuman=true;continue;}
    const result=p14Evaluate({...p14EmptyControls,rules:[{id:strategy.id,name:'已发布程序规则',enabled:true,targets:[kind==='post'?'forum-post':'forum-reply'],conditions:strategy.condition,action:'reject',exceptions:[]}]},{target:kind==='post'?'forum-post':'forum-reply',text:data.body??'',links:data.links??[],attachmentCount:(qualified.payload.attachments??[]).length});
    if(!['hit','miss'].includes(result.rules[0]?.state)){needsHuman=true;continue;}hit=result.rules[0].state==='hit';
   }
   if(!hit||row.configuration.inspectionStrategyIds?.includes(strategy.id))continue;hits++;
   let request=null;
   if(actions.length===1&&actions[0]==='files.scan.retry'&&['chat-file','forum-file'].includes(kind))request={kind:'file-scan-retry',targetKind:kind==='chat-file'?'chat':'forum',targetId,reason:'已批准的程序规则安排扫描重试'};
   if(actions.length===1&&actions[0]==='content.restore'&&['post','reply'].includes(kind))request={kind:'content-visibility',targetKind:kind,targetId,action:'restore',reason:'已批准的程序规则复核原自动处置'};
   // Hide, sending and other material effects require exact approved parameters;
   // a fixed rule cannot invent their deadline, audience or content.
   if(!request||!service.dutyTools){needsHuman=true;continue;}
   const prior=(await service.db.query("SELECT call_id FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND tool='execute-operation' AND arguments->>'targetId'=$3 ORDER BY created_at LIMIT 1",[service.endpoint,taskId,targetId])).rows[0];
   const result=await service.tool({taskId,callId:prior?.call_id??randomUUID(),tool:'execute-operation',arguments:request},{ruleSource:true});
   if(result.state==='waiting-human'||result.state==='unknown')needsHuman=true;
  }
 }
 if(needsHuman)return wait('operations_autonomy_rule_requires_human');
 if(!checked)return wait('operations_autonomy_effective_check_required');
 await transaction(service.db,async db=>{
  const current=await service.taskWithin(db,taskId);await service.authorizeTaskWithin(db,current);
  if(!hits)await service.recordBusinessReceiptWithin(db,{taskId,operationId:taskId,action:'fixed-rule-check',state:'no-action',basis:'published-p14-rule-on-current-qualified-source'});
  await db.query("UPDATE operations_autonomy_tasks_v1 SET state='completed',model_state='not-required',effective_check=true,lease_until=NULL,completed_at=$3,updated_at=$3,revision=revision+1 WHERE endpoint=$1 AND id=$2",[service.endpoint,taskId,service.at()]);
  await db.query('UPDATE operations_autonomy_configs_v1 SET last_valid_at=$3 WHERE endpoint=$1 AND id=$2',[service.endpoint,row.config_id,service.at()]);
 });return response('completed');
}
