import {randomUUID,createHash} from 'node:crypto';
import * as z from 'zod/v4';
import {navigationSchema} from '../../../packages/galaxy-edge-mcp/src/native-v2/interaction/navigation.mjs';
import {helpPaths,helpActionPrepareSchema,helpActionExecuteSchema} from '../../../packages/galaxy-official/src/shared/help-schema-v2.mjs';
import {hostViewOwnerScope} from './host-view-state.mjs';
import {chatSendSchema} from '../../../packages/galaxy-official/src/shared/chat-schema.mjs';
import {chatSendRequestHash} from '../../../packages/galaxy-official/src/shared/chat-message-request-hash.mjs';
import {readProfileDisplayNames} from '../../../packages/galaxy-official/src/profile-display-names.mjs';

export const panelInputSchema=z.strictObject({...navigationSchema.shape,object:navigationSchema.shape.object.optional(),helpSessionId:z.uuid().optional()});
export const panelIdSchema=z.strictObject({viewId:z.uuid()});
export const panelOpenSchema=panelIdSchema.extend({entry:z.enum(['match','publish','participate','messages']).optional()});
export const panelReturnSchema=panelIdSchema.extend({navigationId:z.uuid()});
export const panelDraftSchema=panelIdSchema.extend({expectedRevision:z.number().int().nonnegative(),draft:z.string().max(4000)});
export const panelSelectSchema=panelIdSchema.extend({expectedRevision:z.number().int().positive(),offerIds:z.array(z.uuid()).max(32)});
export const panelFinishSchema=panelIdSchema.extend({expectedRevision:z.number().int().positive()});
export const panelPrepareSchema=panelIdSchema.extend({action:helpActionPrepareSchema});
export const panelExecuteSchema=panelIdSchema.extend({...helpActionExecuteSchema.shape,confirmed:z.literal(true)});
export const panelOperationSchema=panelIdSchema.extend({operationId:z.uuid()});
export const panelReplyDraftSchema=panelDraftSchema.extend({draft:z.string().max(16000)});
export const panelMessageSchema=panelIdSchema.extend({clientMessageId:z.uuid(),text:z.string().trim().min(1).max(16000),replyTo:z.uuid().nullable().default(null)});
const labels={'continue-current-ai':'继续当前 AI','capsule-or-history':'Capsule／历史方案','open-assistance':'开放协助','bounty-or-expert':'赏金／专家协助'};
const text=(s,max=1600)=>typeof s==='string'?s.slice(0,max):null;
const code=e=>/^[a-z0-9_-]{1,100}$/.test(e.code??e.message??'')?e.code??e.message:'panel_source_unavailable';
const error=c=>Object.assign(new Error(c),{code:c});
const fingerprint=s=>JSON.stringify([s.identity,s.endpoint,s.connection?.bindingId??null,s.connection?.generation??null]);
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

// The view stores only references and a device-local draft. Every source read
// uses the existing authenticated runtime, never model-provided source bodies.
export function createCompactController(runtime,{reviewAction}={}){
 const views=new Map(),locks=new Map();let closed=false;
 const now=()=>runtime.now?.()??Math.floor(Date.now()/1000);
 async function current(){if(closed)throw error('panel_closed');return runtime.status();}
 async function owner(view){const state=await current();if(state.identity!==view.owner||state.endpoint!==view.endpoint)throw error('panel_identity_changed');return state;}
 async function required(id){z.uuid().parse(id);const view=views.get(id);if(!view)throw error('panel_view_expired');await owner(view);return view;}
 async function guarded(view,operation){const before=await owner(view),result=await operation();if(fingerprint(await owner(view))!==fingerprint(before))throw error('panel_connection_changed');return result;}
 function path(object){return object?'/app/'+({task:'tasks',room:'rooms',messages:'rooms',project:'projects',capsule:'capsules',match:'match',publish:'publish',participate:'participate',identity:'settings/identity',privacy:'settings/privacy',search:'search',capsules:'capsules',summaries:'settings/summaries',notifications:'notifications'}[object.kind])+(object.id?'/'+object.id:'')+(object.versionId?'/versions/'+object.versionId:''):null;}
 function project(object,data){
  if(object.kind==='task')return{title:text(data.request?.title,160),summary:text(data.request?.summary),state:data.state,revision:data.version,
   source:{kind:'task',id:data.taskId,version:data.version,caseId:data.caseId},enrollmentOpen:data.enrollmentOpen,capabilityVerified:false,
   contacts:data.contacts?{suggestions:data.contacts.suggestions,responses:data.contacts.responses}:null,
   participations:(data.participations??[]).map(p=>({participationId:p.participationId,subjectId:p.subjectId,state:p.state,scopeVersion:p.scopeVersion}))};
  if(object.kind==='room')return{title:text(data.title,160),state:data.state,revision:data.revision,kind:data.kind,taskRefs:data.taskRefs,
   source:{kind:'room',id:data.roomId,revision:data.revision},transportAvailable:data.transportAvailable};
  if(object.kind==='project')return{title:text(data.document?.title,160),summary:text(data.document?.summary),state:data.state,revision:data.revision,
   source:{kind:'project',id:data.projectId,revision:data.revision,documentEventId:data.source?.documentEventId,policyEventId:data.source?.policyEventId},classification:data.classification,capabilityVerified:false};
  const version=data.version??{};
  return{title:text(version.title,160),summary:text(version.summary),state:data.sourceStatus,revision:data.revision??null,
   source:{kind:'capsule',id:data.capsuleId,versionId:data.versionId},method:{problemPattern:text(version.problemPattern,4000),solutionStrategy:text(version.solutionStrategy,16000),
    applicableScope:text(version.applicableScope,4000),limitations:(version.limitations??[]).filter(value=>typeof value==='string'),
    environment:version.environment?{name:text(version.environment.name,300),version:text(version.environment.version,160)}:null,
    tools:(version.tools??[]).filter(value=>typeof value==='string'),skills:(version.skills??[]).filter(value=>typeof value==='string'),
    mcpRefs:(version.mcpRefs??[]).filter(value=>typeof value==='string'),verificationMethod:text(version.verificationMethod,4000),license:text(version.license,160)},
   deprecated:data.deprecated??null,securityIssue:data.securityIssue??null,sourceNeedsReview:data.sourceNeedsReview??null,readingIsReuse:false,capabilityVerified:false};
 }
 async function readObject(view){const object=view.input.object;if(!object?.id)return null;
  const data=await guarded(view,()=>object.kind==='task'?runtime.api.call('/v2/tasks/'+object.id,undefined,{method:'GET'}):
   object.kind==='room'?runtime.api.call('/v2/chat/rooms/'+object.id+'/read',{}):object.kind==='project'?runtime.api.call('/v2/projects/'+object.id,undefined,{method:'GET'}):
    runtime.api.call('/v2/capsules/read',{capsuleId:object.id,...(object.versionId?{versionId:object.versionId}:{})}));
  const projected=project(object,data);if(projected.source.id!==object.id||object.versionId&&projected.source.versionId!==object.versionId)throw error('panel_source_reference_mismatch');
  if(object.kind==='room')projected.conversation=await readConversation(view,data);
  return projected;
 }
 async function currentReplyGrant(view){
  const state=await owner(view),roomId=view.input.object?.id;let after='';
  for(let page=0;page<8;page++){
   const data=await guarded(view,()=>runtime.api.call('/v2/chat/rooms/'+roomId+'/agent-grants',{after,limit:100}));
   const grant=(data.items??[]).find(g=>g.state==='active'&&g.mode==='respond'&&g.bindingId===state.connection?.bindingId);
   if(grant)return grant;
   if(!data.next||data.next===after)return null;after=data.next;
  }
  return null;
 }
 async function profileLabels(view,ids){
  const names=new Map(),subjects=[...new Set(ids)].filter(id=>/^GUID[0-9A-Z]{28}$/.test(id)).slice(0,100);
  for(let index=0;index<subjects.length;index+=20){const rows=await guarded(view,()=>readProfileDisplayNames((path,input)=>guarded(view,()=>runtime.api.call(path,input)),subjects.slice(index,index+20)));
   for(const row of rows){const name=text(row.displayName,80);if(name)names.set(row.subjectId,name);}}
  return names;
 }
 async function readConversation(view,room){
  const history=await guarded(view,()=>runtime.api.call('/v2/chat/rooms/'+room.roomId+'/history',{latest:true,limit:100})),messages=history.messages??[];
  const members=(room.members??[]).map(m=>m.subjectId),names=await profileLabels(view,messages.slice(-100).map(m=>m.subjectId)),grant=await currentReplyGrant(view);
  return{messages:messages.slice(-100).map(m=>({messageId:m.messageId,sequence:m.sequence,revision:m.revision,state:m.state,
   text:m.state==='accepted'?m.text:null,mine:m.subjectId===view.owner,
   authorLabel:m.subjectId===view.owner?'我':names.get(m.subjectId)??'成员 '+Math.max(1,members.indexOf(m.subjectId)+1),
   sentAt:m.sentAt,replyTo:m.replyTo,attachments:m.attachments??[]})),complete:true,historyProjection:'current-window',
   earlierMessagesAvailable:!!history.previous,canReply:room.transportAvailable===true&&!['archived','owner-succession'].includes(room.state)&&!!grant,
   replyUnavailable:!room.transportAvailable?'transport':!grant?'authorization':null};
 }
 async function pendingMessage(view){
  const row=await runtime.store.get(view.draftKey+':pending-message');await owner(view);if(!row)return null;
  if(row.state!=='unknown'&&row.state!=='pending')return{clientMessageId:row.payload.clientMessageId,state:row.state};
  try{const receipt=await guarded(view,()=>runtime.api.call('/v2/chat/rooms/'+view.input.object.id+'/receipt',{clientMessageId:row.payload.clientMessageId,requestHash:row.requestHash}));
   const state=receipt.state==='not-found'?'absent':receipt.state;
   await runtime.store.put(view.draftKey+':pending-message',{...row,state});await owner(view);
   return{clientMessageId:row.payload.clientMessageId,state};
  }catch(e){if(['panel_identity_changed','panel_connection_changed','receipt_status_authority_changed'].includes(code(e)))throw e;
   return{clientMessageId:row.payload.clientMessageId,state:'unknown'};}
 }
 async function render(view){const lease=runtime.api?.snapshot?.()?runtime.receiptStatus?.captureLease():null;await owner(view);let selected=null,sourceError=null,help=null,helpError=null;
  try{selected=await readObject(view);}catch(e){if(['panel_identity_changed','panel_connection_changed'].includes(code(e)))throw e;sourceError=code(e);}
  if(view.input.helpSessionId){try{
   let review=await guarded(view,()=>runtime.helpFlow.review(view.input.helpSessionId));
   const uncertain=(review.session.actionOperations??[]).filter(o=>['unknown','submitting'].includes(o.state));
   for(const op of uncertain){try{await guarded(view,()=>runtime.helpFlow.reconcileAction(view.input.helpSessionId,{operationId:op.operationId}));}
    catch(e){if(['panel_identity_changed','panel_connection_changed','receipt_status_authority_changed'].includes(code(e)))throw e;}}
   if(uncertain.length)review=await guarded(view,()=>runtime.helpFlow.review(view.input.helpSessionId));const row=review.session;
   // Never spread the stored session here: it includes the original private
   // work prompt and historical explanations whose sources may be withdrawn.
   help={sessionId:row.id,revision:row.revision,state:row.pauseState,caseId:row.caseId,taskId:row.taskId,
    selectedHelpIds:row.selectedHelpIds,sourceRefreshRequiredBeforeAction:true,checkedAt:review.checkedAt,
    operations:row.linkedOperations.map(({operationId,taskId,state,version,checkedAt})=>({operationId,taskId,state,version,checkedAt})),
    actionOperations:row.actionOperations??[],
    offers:review.offers.map(item=>({id:item.id,state:item.state,...(item.state==='current'&&item.offer?{
     path:item.offer.path,kind:item.offer.kind,helpDescription:item.offer.helpDescription,userFacingReason:item.offer.userFacingReason,
     explanationAuthor:'user-agent',participants:item.offer.participants,interventionKinds:item.offer.interventionKinds,
     environmentDifferences:item.offer.environmentDifferences,conditions:item.offer.conditions,availability:item.offer.availability,
     basisRefs:item.offer.basisRefs.map(b=>({kind:b.kind,id:b.id,sourceRevision:b.sourceRevision,checkedAt:b.checkedAt,classification:b.classification,capabilityVerified:false}))
    }:{})}))};
   if(!view.input.object&&row.taskId){view.input.object={kind:'task',id:row.taskId};try{selected=await readObject(view);}catch(e){if(['panel_identity_changed','panel_connection_changed'].includes(code(e)))throw e;sourceError=code(e);}}
  }catch(e){if(['panel_identity_changed','panel_connection_changed'].includes(code(e)))throw e;helpError=code(e);}
  }
  const saved=await runtime.store.get(view.draftKey),reply=await runtime.store.get(view.draftKey+':reply');
  const messageResult=view.input.object?.kind==='room'?await pendingMessage(view):null;await owner(view);lease?.assertCurrent();
  return{schemaVersion:1,viewId:view.id,...(lease?{ownerScope:hostViewOwnerScope(lease)}:{}),checkedAt:now(),subjectId:view.owner,object:view.input.object??null,source:selected,sourceError,help,helpError,
   paths:helpPaths.map(id=>({id,label:labels[id],availability:'由当前资料和用户模型判断',selectedHelpCount:help?.offers.filter(o=>o.path===id).length??0})),
   activeEntries:[{id:'match',label:'主动匹配'},{id:'publish',label:'发布任务'},{id:'participate',label:'参与任务'}],
   objectUrl:path(view.input.object)?runtime.website+path(view.input.object):null,
   draft:{text:saved?.draft??'',revision:saved?.revision??0,scope:'this-device-only'},
   replyDraft:{text:reply?.draft??'',revision:reply?.revision??0,scope:'this-device-only'},messageResult,
   presentation:{embeddedHostAcceptance:'unverified',completeRoom:'browser',closingDoesNotCancel:true},businessMutation:false,modelCalls:0};
 }
 async function show(input){const parsed=panelInputSchema.parse(input),state=await current();
  const id=randomUUID(),view={id,input:parsed,owner:state.identity,endpoint:state.endpoint,navigations:new Set(),draftKey:'compact-draft:'+digest([state.endpoint,state.identity,parsed.object??null,parsed.helpSessionId??null,parsed.origin??null])};
  if(views.size>=64)views.delete(views.keys().next().value);views.set(id,view);return render(view);
 }
 async function refresh({viewId}){return render(await required(viewId));}
 async function open(input){const {viewId,entry}=panelOpenSchema.parse(input),view=await required(viewId),object=entry?{kind:entry}:(view.input.object??{kind:'search'});
  if(!object)throw error('panel_object_required');const result=await guarded(view,()=>runtime.navigation.open({object,...(view.input.origin?{origin:view.input.origin}:{})}));
  if(result.navigationId)view.navigations.add(result.navigationId);return{...result,viewId,businessMutation:false};
 }
 async function resume(input){const {viewId,navigationId}=panelReturnSchema.parse(input),view=await required(viewId);
  if(!view.navigations.has(navigationId))throw error('panel_navigation_mismatch');
  // Navigation refresh already reads current source permissions. Do not expose
  // its full Task/Room data or local original prompt to a small UI accidentally.
  const lease=runtime.api?.snapshot?.()?runtime.receiptStatus?.captureLease():null;
  await guarded(view,()=>runtime.navigation.resume(navigationId));
  lease?.assertCurrent();const result=await render(view);lease?.assertCurrent();
  return{...result,returned:true,navigationId};
 }
 async function save(input){const x=panelDraftSchema.parse(input),view=await required(x.viewId),previous=locks.get(view.draftKey)??Promise.resolve();
  const work=previous.catch(()=>{}).then(async()=>{await owner(view);const old=await runtime.store.get(view.draftKey);
   if((old?.revision??0)!==x.expectedRevision)throw error('panel_draft_conflict');
   const saved={draft:x.draft,revision:x.expectedRevision+1,updatedAt:now()};await runtime.store.put(view.draftKey,saved);await owner(view);
   return{viewId:x.viewId,draft:{text:saved.draft,revision:saved.revision,scope:'this-device-only'},businessMutation:false};});
  locks.set(view.draftKey,work);try{return await work;}finally{if(locks.get(view.draftKey)===work)locks.delete(view.draftKey);}
 }
 async function saveReply(input){
  const x=panelReplyDraftSchema.parse(input),view=await required(x.viewId);if(view.input.object?.kind!=='room')throw error('panel_room_required');
  const key=view.draftKey+':reply',previous=locks.get(key)??Promise.resolve();
  const work=previous.catch(()=>{}).then(async()=>{await owner(view);const old=await runtime.store.get(key);
   if((old?.revision??0)!==x.expectedRevision)throw error('panel_draft_conflict');
   const replyDraft={text:x.draft,revision:x.expectedRevision+1,scope:'this-device-only'};
   await runtime.store.put(key,{draft:x.draft,revision:replyDraft.revision,updatedAt:now()});await owner(view);
   return{viewId:x.viewId,replyDraft,businessMutation:false};});locks.set(key,work);
  try{return await work;}finally{if(locks.get(key)===work)locks.delete(key);}
 }
 async function sendMessage(input){
  const x=panelMessageSchema.parse(input),view=await required(x.viewId);if(view.input.object?.kind!=='room')throw error('panel_room_required');
  const key=view.draftKey+':pending-message',previous=locks.get(key)??Promise.resolve();
  const work=previous.catch(()=>{}).then(async()=>{
   const grant=await currentReplyGrant(view);if(!grant)throw error('chat_agent_not_authorized');
   let row=await runtime.store.get(key);await owner(view);
   if(row&&row.payload.clientMessageId===x.clientMessageId){
    if(row.payload.text!==x.text||row.payload.replyTo!==x.replyTo||row.payload.agentGrantId!==grant.grantId)throw error('chat_message_conflict');
    if(row.state==='accepted')return render(view);
    const receipt=await pendingMessage(view);
    if(receipt.state==='accepted')return render(view);
    if(!['absent','pending'].includes(receipt.state))return{...await render(view),messageResult:receipt};
   }else{
    if(row&&['unknown','pending','conflict'].includes(row.state))throw error('panel_message_pending');
    const payload=chatSendSchema.parse({clientMessageId:x.clientMessageId,text:x.text,replyTo:x.replyTo,agentGrantId:grant.grantId});
    row={payload,requestHash:await chatSendRequestHash(payload),state:'unknown'};
   }
   await runtime.store.put(key,{...row,state:'unknown'});await owner(view);
   try{const result=await guarded(view,()=>runtime.api.call('/v2/chat/rooms/'+view.input.object.id+'/send',row.payload));
    await runtime.store.put(key,{...row,state:result.state});await owner(view);
   }catch(e){if(['panel_identity_changed','panel_connection_changed','receipt_status_authority_changed'].includes(code(e)))throw e;
    // A lost response is checked using its original exact hash; never create a
    // fresh message to hide an uncertain result.
    await pendingMessage(view);
   }
   return render(view);
  });locks.set(key,work);try{return await work;}finally{if(locks.get(key)===work)locks.delete(key);}
 }
 async function select(input){const {viewId,expectedRevision,offerIds}=panelSelectSchema.parse(input),view=await required(viewId);
  if(!view.input.helpSessionId)throw error('panel_help_session_required');
  const review=await guarded(view,()=>runtime.helpFlow.review(view.input.helpSessionId));
  if(review.session.revision!==expectedRevision)throw error('help_session_changed');
  if(offerIds.some(id=>!review.offers.some(o=>o.id===id&&o.state==='current')))throw error('help_selection_refresh_required');
  await guarded(view,()=>runtime.helpFlow.select(view.input.helpSessionId,{expectedRevision,offerIds}));return render(view);
 }
 async function finish(input){const {viewId,expectedRevision}=panelFinishSchema.parse(input),view=await required(viewId);
  if(!view.input.helpSessionId)throw error('panel_help_session_required');
  const result=await guarded(view,()=>runtime.helpFlow.returnToTask(view.input.helpSessionId,{expectedRevision}));
  return{...await render(view),handoff:{sessionId:view.input.helpSessionId,taskId:result.handoff.taskId,caseId:result.handoff.caseId,
   operationRefs:result.handoff.operationRefs,method:result.handoff.method,hostCallbackVerified:false},remoteOperationsCanceled:false,successFactsCreated:false};
 }
 async function helpView(viewId){const view=await required(viewId);if(!view.input.helpSessionId)throw error('panel_help_session_required');return view;}
 async function readablePreview(view,preview){const names=await profileLabels(view,preview.recipientIds??[]);return{...preview,
  recipientNames:(preview.recipientIds??[]).map(id=>names.get(id)??(id===view.owner?'自己':'未公开名称的成员'))};}
 async function prepare(input){const {viewId,action}=panelPrepareSchema.parse(input),view=await helpView(viewId);
  const preview=await guarded(view,()=>runtime.helpFlow.prepareAction(view.input.helpSessionId,action));return{...await render(view),preview:await readablePreview(view,preview)};}
 async function preview(input){const {viewId,operationId}=panelOperationSchema.parse(input),view=await helpView(viewId);
  const preview=await guarded(view,()=>runtime.helpFlow.actionPreview(view.input.helpSessionId,operationId));return{...await render(view),preview:await readablePreview(view,preview)};}
 async function execute(input,{context}={}){const {viewId,operationId,payloadHash,authorizationRequestId}=panelExecuteSchema.parse(input),view=await helpView(viewId);
  const preview=await guarded(view,()=>runtime.helpFlow.actionPreview(view.input.helpSessionId,operationId));
  if(preview.payloadHash!==payloadHash)throw error('help_action_preview_changed');
  if(authorizationRequestId&&authorizationRequestId!==preview.authorizationRequestId)throw error('help_authorization_preview_changed');
  const run=()=>guarded(view,()=>runtime.helpFlow.executeAction(view.input.helpSessionId,{operationId,payloadHash,...(authorizationRequestId?{authorizationRequestId}:{})}));
  let outcome;
  if(['prepared','absent'].includes(preview.state)){
   if(!reviewAction)throw error('panel_action_review_required');
   outcome=await guarded(view,()=>reviewAction({name:'galaxy_panel_action_execute',input,preview,context,run}));
  }else outcome=await run();
  if(outcome?.resultType==='input_required')return outcome;
  if(Array.isArray(outcome?.content)){
   if(outcome.isError||outcome.content.length!==1||outcome.content[0].type!=='text')throw error('panel_action_review_failed');
   outcome=outcome.structuredContent??JSON.parse(outcome.content[0].text);
  }
  if(['declined','user-choice-needs-browser'].includes(outcome?.state)){
   const {preview:ignored,...choice}=outcome;
   return{...await render(view),...(outcome.state==='user-choice-needs-browser'?{preview:await readablePreview(view,preview)}:{}),choice,actionResult:{operationId,state:outcome.state,receipt:null,successFactsCreated:false}};
  }
  // Only state/reference receipts are copied out, never the complete session.
  const rendered=await render(view),result=projectActionResult(outcome,operationId);
  const reconciled=rendered.help?.actionOperations?.find(op=>op.operationId===operationId);
  return{...rendered,actionResult:{...result,...(reconciled?{state:reconciled.state}:{})}};}
 async function reconcile(input){const {viewId,operationId}=panelOperationSchema.parse(input),view=await helpView(viewId);
  const outcome=await guarded(view,()=>runtime.helpFlow.reconcileAction(view.input.helpSessionId,{operationId}));
  return{...await render(view),actionResult:projectActionResult(outcome,operationId)};}
 function projectActionResult(result,operationId){return{operationId,state:result.state??result.operation?.state??result.action?.state??result.receipt?.state??'unknown',
  receipt:result.receipt??result.action?.receipt??null,successFactsCreated:false};}
 return{show,refresh,open,resume,save,saveReply,sendMessage,select,finish,prepare,preview,execute,reconcile,close:()=>{closed=true;views.clear();}};
}
