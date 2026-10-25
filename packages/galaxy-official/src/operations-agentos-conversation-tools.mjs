import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import canonicalize from 'canonicalize';
import {z} from 'zod';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {OperationsAgentOsQueryTools} from './operations-agentos-query-tools.mjs';
import {OperationsAgentOsActionTools} from './operations-agentos-action-tools.mjs';
import {agentOsQueryInvalidFeedback} from './shared/operations-agentos-query-schema.mjs';
import {operationsToolCallIdSchema} from './shared/operations-tool-call-id.mjs';
import {conversationReadRoute,conversationPriorActionTarget,conversationPriorActionReference,conversationAccountRestrictionReference} from './operations-agentos-tool-evidence.mjs';
import {operationsAiWorkScope} from './shared/operations-ai-use.mjs';
import {workbenchActionCatalog,workbenchAiPromptReviewSchema} from './operations-agentos-action-catalog.mjs';
import {conversationPublicReferenceSchema,checkConversationPublicReference} from './operations-agentos-public-reference.mjs';

const fail=(code,status=403)=>{throw new ServiceError(code,status);};
const parse=(schema,value)=>{const result=schema.safeParse(value);if(!result.success)fail('invalid_operations_agentos_request',400);return result.data;};
const digest=value=>createHash('sha256').update(canonicalize(value)).digest('hex');
const envelope=z.strictObject({conversationId:z.uuid(),sessionId:z.uuid(),turnId:z.uuid(),runId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),callId:operationsToolCallIdSchema,
 tool:z.enum(['workbench-summary','query-operations','read-operation-object','read-ai-delegation','list-authorized-work','run-authorized-work','prepare-operation']),arguments:z.record(z.string(),z.unknown()),publicReference:conversationPublicReferenceSchema.optional()});
const confirmSchema=z.strictObject({cardId:z.uuid(),operationId:z.uuid()});
const code=error=>error?.code==='invalid_operations_agentos_query'||/^(?:operations|business_admin|p13|search_quality|feedback|messaging|content|file|forum)_[a-z0-9_]{1,100}$/.test(error?.code??'')?error.code:'operations_agentos_tool_unavailable';
const same=(left,right)=>left?.operatorId===right?.operatorId&&left?.endpoint===right?.endpoint;
const attempted=row=>Object.hasOwn(row.proposal??{},'confirmationAttemptedAt')||Object.hasOwn(row.result??{},'confirmationAttemptedAt');
const withAttempt=(row,result)=>Object.hasOwn(row.result??{},'confirmationAttemptedAt')?{...result,confirmationAttemptedAt:row.result.confirmationAttemptedAt}:result;
const publicResult=value=>{if(!value||typeof value!=='object')return value;const {confirmationAttemptedAt,...result}=value;return result;};
const projection=row=>({cardId:row.id,operationId:row.operation_id,turnId:row.turn_id,kind:row.proposal.kind,domain:row.domain,
 target:row.proposal.target,title:row.proposal.title,impact:row.proposal.impact,basis:row.proposal.basis,requiredAction:row.proposal.requiredAction,
 state:row.state,result:publicResult(row.result)??null,checkedAt:null,readExpiresAt:null,capability:{canConfirm:false,canDismiss:false,reason:null}});

// The model receives a closed, typed tool surface. Human sessions, execution
// grants, native turn IDs, CAS versions and operation IDs are server-owned.
// Tool ledgers contain metadata, not arbitrary results or private messages.
export class AgentOsConversationTools{
 constructor({conversations,authority,gateway,services,now=authority.now}){
  Object.assign(this,{conversations,authority,gateway,db:authority.db,endpoint:authority.endpoint,now});
  this.query=new OperationsAgentOsQueryTools({authority,services,now});
  this.actions=new OperationsAgentOsActionTools({conversations,authority,gateway,services,now});
  this.confirming=new Map();
 }
 async contextValid(row,actor){
  const refs=(await this.db.query('SELECT evidence_ref FROM operations_agentos_conversation_sources_v1 WHERE conversation_id=$1',[row.id])).rows.map(value=>value.evidence_ref);
  if(!refs.length)return true;
  const value=await this.query.revalidate({actor,domain:row.domain,evidenceRefs:refs});
  return value.valid===true;
 }
 async priorActionReferences(operator,domain,context){
  const result={basis:'same-owner-current-fixed-ai-completed-action-ledger',scope:'latest-20-completed-content-feedback-and-account-cards',absenceMeaning:'not-evidence-of-no-previous-effect',valuesCurrent:false,availability:'available',items:[],checkedAt:this.now(),readExpiresAt:this.now()+30};
  if(!context)return result;
  const conversationId=parse(z.uuid(),context.conversationId),turnId=parse(z.uuid(),context.turnId);
  const current=await this.conversations.current(conversationId,{operator});
  if(current.row.domain!==domain)fail('operations_agentos_domain_mismatch');
  const turn=(await this.db.query('SELECT created_at FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2 AND conversation_id=$3 AND operator_id=$4',[this.endpoint,turnId,conversationId,operator.operatorId])).rows[0];
  if(!turn)fail('operations_agentos_scope_denied');
  const rows=(await this.db.query(`SELECT c.* FROM operations_agentos_conversation_cards_v1 c
   JOIN operations_agentos_conversations_v1 s ON s.id=c.conversation_id AND s.endpoint=c.endpoint
   WHERE c.endpoint=$1 AND c.operator_id=$2 AND c.domain=$3 AND s.operator_id=$2 AND s.domain=$3 AND s.ai_account_id=$4
    AND c.state='completed' AND c.proposal->>'kind' IN ('content-visibility','content-curation','feedback-update','account-restriction') AND c.created_at<=$5 AND c.updated_at<=$5
   ORDER BY c.created_at DESC,c.id DESC LIMIT 20`,[this.endpoint,operator.operatorId,domain,current.row.ai_account_id,turn.created_at])).rows;
  for(const row of rows){
   try{
    const target=conversationPriorActionTarget(row);
    if(!target){result.availability='partial';continue;}
    const actor=await this.cardActor(operator,row);
    if(target.kind==='account'){
     // This reference is narrower than a general historical receipt read:
     // current human and fixed AI must still have the preparation permission.
     const permissions=[row.proposal.requiredAction,row.proposal.request.action==='apply'?'accounts.restriction.release':'accounts.restriction.apply'];
     for(const action of permissions)await this.authority.human(actor,{domain,action,purpose:'prepare'});
     const accounts=this.actions.service('accounts','operation');
     const original=await accounts.operation(actor,target.id,row.operation_id);
     if(original.state!=='recorded'){result.availability='partial';continue;}
     const current=await this.actions.service('accounts','get').get(actor,target.id);
     const checkedAt=this.now(),readExpiresAt=Math.min(checkedAt+30,original.readExpiresAt??0,current.readExpiresAt??checkedAt+30,Number.isSafeInteger(current.checkedAt)?current.checkedAt+30:0);
     const reference=conversationAccountRestrictionReference(row,original,{...current,checkedAt,readExpiresAt});
     await this.cardActor(operator,row);
     for(const action of permissions)await this.authority.human(actor,{domain,action,purpose:'prepare'});
     if(reference)result.items.push(reference);else result.availability='partial';
     continue;
    }
    if(target.kind==='feedback'){
     // Card state alone is not a business receipt. Re-read this owner's exact
     // immutable audit before using its minimum locator, without any effect.
     const recorded=await this.actions.recoverPrepared(actor,row.proposal,row.operation_id);
     if(recorded.state!=='completed'||recorded.operationId!==row.operation_id||recorded.receipt?.feedbackId!==target.id
      ||recorded.receipt.revision!==row.result?.receipt?.revision){result.availability='partial';continue;}
    }
    const value=await this.query.execute({actor,domain,tool:'read-operation-object',arguments:{kind:target.kind,id:target.id,filters:{}}});
    await this.cardActor(operator,row);
    const reference=conversationPriorActionReference(row,value);if(reference)result.items.push(reference);
    else result.availability='partial';
   }catch(error){
    result.availability='partial';
   }
  }
  await this.conversations.current(conversationId,{operator});
  result.checkedAt=this.now();result.items=result.items.filter(item=>item.current.readExpiresAt>result.checkedAt);
  result.readExpiresAt=Math.min(result.checkedAt+30,...result.items.map(item=>item.current.readExpiresAt));
  return result;
 }
 async bind(input){
  const x=parse(envelope,input);
  if(x.publicReference!==undefined&&!['read-operation-object','prepare-operation'].includes(x.tool))fail('invalid_operations_agentos_request',400);
  const current=await this.conversations.current(x.conversationId);
  if(current.row.session_id!==x.sessionId)fail('operations_agentos_scope_denied');
  const call=await transaction(this.db,async db=>{
   const command=(await db.query('SELECT * FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2 FOR UPDATE',[this.endpoint,x.turnId])).rows[0];
   if(!command||command.conversation_id!==x.conversationId||command.operator_id!==current.actor.operatorId||command.state==='not-started'||command.native_run_id&&command.native_run_id!==x.runId||command.result?.runId&&command.result.runId!==x.runId)fail('operations_agentos_scope_denied');
   await this.conversations.boundedTaskWithin(db,current.row,command);
   if(!command.native_run_id)await db.query('UPDATE operations_agentos_conversation_commands_v1 SET native_run_id=$3 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.turnId,x.runId]);
   const argsDigest=digest(x.publicReference===undefined?x.arguments:{arguments:x.arguments,publicReference:x.publicReference}),at=new Date(this.now()*1000);
   await db.query(`INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'started',$9,$9) ON CONFLICT(endpoint,conversation_id,native_run_id,call_id) DO NOTHING`,[randomUUID(),this.endpoint,x.conversationId,x.turnId,x.runId,x.callId,x.tool,argsDigest,at]);
   const saved=(await db.query('SELECT * FROM operations_agentos_conversation_tool_calls_v1 WHERE endpoint=$1 AND conversation_id=$2 AND native_run_id=$3 AND call_id=$4',[this.endpoint,x.conversationId,x.runId,x.callId])).rows[0];
   if(saved.turn_id!==x.turnId||saved.tool!==x.tool||saved.arguments_digest!==argsDigest)fail('operations_agentos_operation_conflict',409);
   return saved;
  });
  return {...current,x,call};
 }
 async rememberSources(row,refs){
  // Only prose that can later become unavailable pins the conversation.
  // Aggregate counts retain their observation time; a changed count is not a
  // revoked source and must not continuously discard the conversation.
  for(const ref of refs??[]){
   if(ref?.purpose!=='public-content'&&ref?.controlledSource!==true)continue;
   const sourceKey=digest([ref.kind,ref.id]);
   await this.db.query(`INSERT INTO operations_agentos_conversation_sources_v1(conversation_id,source_key,evidence_ref,created_at)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[row.id,sourceKey,JSON.stringify(ref),new Date(this.now()*1000)]);
   const original=(await this.db.query('SELECT evidence_ref FROM operations_agentos_conversation_sources_v1 WHERE conversation_id=$1 AND source_key=$2',[row.id,sourceKey])).rows[0]?.evidence_ref;
   if(original?.version!==ref.version)fail('operations_agentos_source_changed',409);
  }
 }
 async execute(input){
  const {row,actor,x,call}=await this.bind(input);let result;
  try{
   if(x.tool==='workbench-summary')result=await this.conversations.summaryFor(actor,row.domain,x.arguments,{conversationId:row.id,turnId:x.turnId});
   else if(['query-operations','read-operation-object','read-ai-delegation'].includes(x.tool)){
    result=await this.query.execute({actor,domain:row.domain,tool:x.tool,arguments:x.arguments});
    if(x.publicReference!==undefined)checkConversationPublicReference(x.publicReference,x.arguments.kind,x.arguments.id,result.data);
    await this.rememberSources(row,result.evidenceRefs);
   }else if(x.tool==='prepare-operation')result=await this.prepare(row,actor,x,call);
   else result=await this.actions.execute(x);
   await this.conversations.current(row.id);
   await this.db.query("UPDATE operations_agentos_conversation_tool_calls_v1 SET state='completed',metadata=$3,updated_at=$4 WHERE endpoint=$1 AND id=$2",[this.endpoint,call.id,JSON.stringify({tool:x.tool,...conversationReadRoute(x.tool,x.arguments),state:result?.state??result?.availability??'read',cardId:result?.card?.cardId??null}),new Date(this.now()*1000)]);
   return result;
  }catch(error){
   const feedback=error?.code==='invalid_operations_agentos_query'?agentOsQueryInvalidFeedback(x.tool,x.arguments):null;
   if(feedback){
    try{await this.conversations.current(row.id);}
    catch(currentError){
     await this.db.query("UPDATE operations_agentos_conversation_tool_calls_v1 SET state='unavailable',metadata=$3,updated_at=$4 WHERE endpoint=$1 AND id=$2",[this.endpoint,call.id,JSON.stringify({tool:x.tool,code:code(currentError)}),new Date(this.now()*1000)]);
     throw currentError;
    }
    await this.db.query("UPDATE operations_agentos_conversation_tool_calls_v1 SET state='unavailable',metadata=$3,updated_at=$4 WHERE endpoint=$1 AND id=$2",[this.endpoint,call.id,JSON.stringify({tool:x.tool,code:feedback.code,module:feedback.module,view:feedback.view,filterKeys:feedback.filterKeys}),new Date(this.now()*1000)]);
    return feedback;
   }
   await this.db.query("UPDATE operations_agentos_conversation_tool_calls_v1 SET state='unavailable',metadata=$3,updated_at=$4 WHERE endpoint=$1 AND id=$2",[this.endpoint,call.id,JSON.stringify({tool:x.tool,...conversationReadRoute(x.tool,x.arguments),code:code(error)}),new Date(this.now()*1000)]);
   throw error;
  }
 }
 async prepare(row,actor,x,call){
  const argsDigest=digest(x.publicReference===undefined?x.arguments:{arguments:x.arguments,publicReference:x.publicReference});
  let stored=(await this.db.query('SELECT * FROM operations_agentos_conversation_cards_v1 WHERE endpoint=$1 AND turn_id=$2 AND request_digest=$3',[this.endpoint,x.turnId,argsDigest])).rows[0];
  if(!stored){
   const operationId=randomUUID(),proposal=await this.actions.prepareFor(actor,row.domain,x.arguments,{publicReference:x.publicReference,operationId}),at=new Date(this.now()*1000);
   await this.conversations.assertBoundedProposal(row.id,x.turnId,proposal);
   stored=(await this.db.query(`INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prepared',$11,$11) ON CONFLICT(endpoint,turn_id,request_digest) DO NOTHING RETURNING *`,[randomUUID(),this.endpoint,row.id,x.turnId,call.id,actor.operatorId,row.domain,operationId,argsDigest,JSON.stringify({...proposal,dismissalAllowed:true}),at])).rows[0];
   if(!stored)stored=(await this.db.query('SELECT * FROM operations_agentos_conversation_cards_v1 WHERE endpoint=$1 AND turn_id=$2 AND request_digest=$3',[this.endpoint,x.turnId,argsDigest])).rows[0];
  }
  const card=await this.cardView(actor,stored);
  // The frozen command/CAS proposal remains private. It cannot be copied into
  // a later model tool or treated as an unattended automation grant.
  return {state:card.state,card,decision:'human-confirmation-required',effectExecuted:card.state==='completed'};
 }
 async ownedCard(operator,domain,id){
  parse(z.uuid(),id);await this.authority.human(operator,{domain});
  const row=(await this.db.query('SELECT * FROM operations_agentos_conversation_cards_v1 WHERE endpoint=$1 AND id=$2 AND operator_id=$3 AND domain=$4',[this.endpoint,id,operator.operatorId,domain])).rows[0];
  if(!row)fail('operations_agentos_operation_not_found',404);
  await this.cardActor(operator,row);
  return row;
 }
 async cardActor(operator,row){
  const entry=workbenchActionCatalog.find(item=>item.kind===row.proposal?.kind);
  if(!entry)fail('invalid_operations_agentos_action',400);
  const actor=await this.authority.human(operator,{domain:row.domain,action:entry.read,purpose:'query'});
  const conversation=(await this.db.query('SELECT operator_id,domain,ai_account_id FROM operations_agentos_conversations_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,row.conversation_id])).rows[0];
  // A completed action may invalidate its own public source. Its receipt is
  // still bound to the original owner and fixed AI position, with fresh read
  // authority. This does not reopen the retired conversation's prose/history.
  if(!same(actor,operator)||row.operator_id!==actor.operatorId||!conversation||conversation.operator_id!==actor.operatorId||conversation.domain!==row.domain)fail('operations_agentos_scope_denied');
  if(!conversation.ai_account_id||operationsAiWorkScope(actor)?.accountId!==conversation.ai_account_id)fail('operations_ai_work_unassigned');
  return actor;
 }
 async cardView(operator,row){
  operator=await this.cardActor(operator,row);const item=projection(row);
  const promptCard=row.proposal.kind==='ai-work-prompt-save';
  if(row.state==='prepared'){
   try{
    const current=await this.actions.prepareFor(operator,row.domain,row.proposal.request,{publicReference:row.proposal.publicReference,operationId:row.operation_id});
    if(isDeepStrictEqual(current.command,row.proposal.command))item.capability.canConfirm=true;
    else{item.state='not-available';item.capability.reason='operations_agentos_proposal_changed';}
    item.target=current.target;item.title=current.title;item.impact=current.impact;item.basis=current.basis;item.readExpiresAt=current.readExpiresAt;
    if(promptCard){const review=workbenchAiPromptReviewSchema.safeParse(current.review);if(review.success)item.review=review.data;else{item.capability.canConfirm=false;item.state='not-available';item.capability.reason='operations_agentos_prompt_review_unavailable';}}
   }catch(error){
    if(error.status===403)throw error;
    item.state='not-available';item.capability.reason=code(error);
    item.target={kind:row.proposal.target.kind,id:row.proposal.target.id,label:item.capability.reason==='operations_agentos_restriction_deadline'?'方案已过期':'原处理对象当前不可用',href:null};item.impact=[];item.basis=[];delete item.review;
   }
  }else if(promptCard){
   // Old prompt bodies are private materials. A historical card/receipt is
   // not permission to reveal them after target delegation was withdrawn.
   try{
    const review=workbenchAiPromptReviewSchema.safeParse(row.proposal.review);
    if(!review.success)throw new Error('operations_agentos_prompt_review_unavailable');
    const current=await this.query.execute({actor:operator,domain:row.domain,tool:'read-ai-delegation',arguments:{aiAccountId:review.data.aiAccountId}});
    if(current.availability!=='available')throw new Error('operations_agentos_prompt_review_unavailable');
    item.review=review.data;item.readExpiresAt=current.readExpiresAt;
   }catch(error){if(error.status===403)throw error;item.impact=[];item.basis=[];delete item.review;}
  }else if(['post','reply'].includes(row.proposal.target.kind)){
   try{const value=await this.query.execute({actor:operator,domain:row.domain,tool:'read-operation-object',arguments:{kind:row.proposal.target.kind,id:row.proposal.target.id,filters:{}}});
    const readable=value.data?.publiclyReadable===true;
    item.target={...item.target,label:readable&&value.data?.title?value.data.title:'该条公开内容'};
    item.readExpiresAt=value.readExpiresAt;
    if(!readable){item.impact=[];item.basis=[];delete item.review;}
   }catch(error){if(error.status===403)throw error;item.target={...item.target,label:'原处理对象当前不可用',href:null};item.impact=[];item.basis=[];delete item.review;}
  }
  if(row.state==='prepared'&&item.capability.canConfirm){
   try{await this.conversations.assertBoundedProposal(row.conversation_id,row.turn_id,row.proposal);}
   catch(error){item.capability.canConfirm=false;item.capability.reason=code(error);delete item.review;}
  }
  // Old prepared rows may have been re-armed by older receipt recovery. Only
  // newly created, never-claimed proposals can be described as unexecuted.
  item.capability.canDismiss=row.state==='prepared'&&row.proposal.dismissalAllowed===true&&!attempted(row);
  await this.cardActor(operator,row);
  if(this.conversations.autonomy)await transaction(this.db,db=>this.conversations.syncWorkbenchCardWithin(db,row));
  item.checkedAt=this.now();item.readExpiresAt=Math.min(this.now()+30,item.readExpiresAt??this.now()+30);
  return item;
 }
 async card(operator,domain,id){
  let row=await this.ownedCard(operator,domain,id);
  operator=await this.cardActor(operator,row);
  if(['processing','unknown'].includes(row.state)&&typeof this.actions.recoverPrepared==='function'){
   let recovered;try{recovered=await this.actions.recoverPrepared(operator,row.proposal,row.operation_id);}catch(error){if(error.status===403)throw error;recovered={operationId:row.operation_id,state:'unknown',summary:'正在读取这次处理的原结果。',code:code(error)};}
   let state=recovered?.state==='failed'?'not-available':recovered?.state;
   // Absence of a receipt cannot disprove an attempted, delayed business call.
   // Keep this original intent read-only; never re-arm it from a GET.
   if(['not-recorded','prepared'].includes(state))state='unknown';
   if(['prepared','completed','processing','unknown','not-available'].includes(state)){
    // A slower original-result read must not overwrite a confirmation or
    // newer recovery that settled this row while its receipt was in flight.
    const changed=(await this.db.query('UPDATE operations_agentos_conversation_cards_v1 SET state=$3,result=$4,updated_at=$5 WHERE endpoint=$1 AND id=$2 AND state=$6 AND updated_at=$7 RETURNING *',[this.endpoint,row.id,state,JSON.stringify(withAttempt(row,{...recovered,state})),new Date(this.now()*1000),row.state,row.updated_at])).rows[0];
    row=changed??await this.ownedCard(operator,domain,id);
   }
  }
  return this.cardView(operator,row);
 }
 async cards(operator,domain){
  await this.authority.human(operator,{domain});
  const rows=(await this.db.query('SELECT * FROM operations_agentos_conversation_cards_v1 WHERE endpoint=$1 AND domain=$2 AND operator_id=$3 ORDER BY created_at DESC LIMIT 30',[this.endpoint,domain,operator.operatorId])).rows;
  const result=[];
  for(const row of rows){try{result.push(await this.card(operator,row.domain,row.id));}catch(error){if(error.status!==403)throw error;}}
  return result.reverse();
 }
 async confirm(operator,domain,id,input,{authorize}={}){
  const x=parse(confirmSchema,input);if(x.cardId!==id||typeof authorize!=='function')fail('invalid_operations_agentos_request',400);
  const current=await authorize();if(!same(current,operator))fail('business_admin_denied');
  let row=await this.ownedCard(current,domain,id);if(row.operation_id!==x.operationId)fail('operations_agentos_operation_conflict',409);
  const bound=await this.cardActor(current,row);
  await this.authority.human(bound,{action:row.proposal.requiredAction,domain:row.domain,purpose:'prepare'});
  if(row.state==='completed')return this.cardView(current,row);
  // Read the original durable receipt first. Recreating a proposal before a
  // lost-ACK recovery would compare CAS against our own already-applied effect.
  if(['processing','unknown'].includes(row.state)){
   const recovered=await this.card(current,domain,id);if(recovered.state==='completed')return recovered;
  }else{
   const view=await this.cardView(current,row);if(!view.capability.canConfirm)fail('operations_agentos_proposal_changed',409);
  }
  if(this.confirming.has(row.id))return this.confirming.get(row.id);
  const task=this.performConfirmation(bound,row,authorize);
  this.confirming.set(row.id,task);try{return await task;}finally{this.confirming.delete(row.id);}
 }
 async dismiss(operator,domain,id,input,{authorize}={}){
  const x=parse(confirmSchema,input);if(x.cardId!==id||typeof authorize!=='function')fail('invalid_operations_agentos_request',400);
  const fresh=await authorize();if(!same(fresh,operator))fail('business_admin_denied');
  const row=await this.ownedCard(fresh,domain,id);if(row.operation_id!==x.operationId)fail('operations_agentos_operation_conflict',409);
  if(row.state==='prepared'&&(row.proposal.dismissalAllowed!==true||attempted(row)))fail('operations_agentos_card_dismissal_unavailable',409);
  const result={operationId:row.operation_id,state:'cancelled',summary:'已取消，未执行处理。'};
  // The same row is atomically claimed by confirmation. Dismissal can only
  // retire an unattempted proposal, never processing/unknown/completed work.
  const changed=(await this.db.query("UPDATE operations_agentos_conversation_cards_v1 SET state='not-available',result=$3,updated_at=$4 WHERE endpoint=$1 AND id=$2 AND state='prepared' AND proposal->>'dismissalAllowed'='true' AND NOT (proposal ? 'confirmationAttemptedAt') AND (result IS NULL OR NOT (result ? 'confirmationAttemptedAt')) RETURNING *",[this.endpoint,row.id,JSON.stringify(result),new Date(this.now()*1000)])).rows[0];
  const current=await authorize();if(!same(current,fresh))fail('business_admin_denied');
  return this.cardView(current,changed??await this.ownedCard(current,domain,id));
 }
 async performConfirmation(operator,row,authorize){
  const claimed=(await this.db.query("UPDATE operations_agentos_conversation_cards_v1 SET state='processing',result=jsonb_build_object('operationId',operation_id,'state','processing','summary','正在处理…','confirmationAttemptedAt',to_jsonb($3::timestamptz)),updated_at=$3 WHERE endpoint=$1 AND id=$2 AND state='prepared' AND NOT (proposal ? 'confirmationAttemptedAt') AND (result IS NULL OR NOT (result ? 'confirmationAttemptedAt')) RETURNING *",[this.endpoint,row.id,new Date(this.now()*1000)])).rows[0];
  if(!claimed)return this.cardView(operator,await this.ownedCard(operator,row.domain,row.id));
  row=claimed;
  let result,state;
  const scopedAuthorize=async()=>{const fresh=await authorize();if(!same(fresh,operator))fail('business_admin_denied');const bound=await this.cardActor(fresh,row);await this.conversations.assertBoundedProposal(row.conversation_id,row.turn_id,row.proposal);return this.authority.human(bound,{domain:row.domain,purpose:'prepare'});};
  try{const scoped=await scopedAuthorize();result=await this.actions.executePrepared(scoped,row.proposal,{authorize:scopedAuthorize,operationId:row.operation_id});state=['completed','processing','unknown'].includes(result.state)?result.state:'not-available';}
  catch(error){state=error.status===403||error.status===409||error.status===400||error.status===404?'not-available':'unknown';result={operationId:row.operation_id,state,summary:state==='unknown'?'正在查询这次处理的原结果。':'当前条件已变化，本次处理未继续。',code:code(error)};}
  row=(await this.db.query('UPDATE operations_agentos_conversation_cards_v1 SET state=$3,result=$4,updated_at=$5 WHERE endpoint=$1 AND id=$2 RETURNING *',[this.endpoint,row.id,state,JSON.stringify(withAttempt(row,result)),new Date(this.now()*1000)])).rows[0];
  const fresh=await authorize();if(!same(fresh,operator))fail('business_admin_denied');return this.cardView(fresh,row);
 }
}
