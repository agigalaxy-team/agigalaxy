import {randomUUID,createHash} from 'node:crypto';
import * as z from 'zod/v4';
import {navigationSchema} from '../../../packages/galaxy-edge-mcp/src/native-v2/navigation.mjs';
import {helpPaths} from '../../../packages/galaxy-official/src/shared/help-schema-v2.mjs';

export const panelInputSchema=z.strictObject({...navigationSchema.shape,object:navigationSchema.shape.object.optional(),helpSessionId:z.uuid().optional()});
export const panelIdSchema=z.strictObject({viewId:z.uuid()});
export const panelOpenSchema=panelIdSchema.extend({entry:z.enum(['match','publish','participate']).optional()});
export const panelReturnSchema=panelIdSchema.extend({navigationId:z.uuid()});
export const panelDraftSchema=panelIdSchema.extend({expectedRevision:z.number().int().nonnegative(),draft:z.string().max(4000)});
const labels={'continue-current-ai':'继续当前 AI','capsule-or-history':'Capsule／历史方案','open-assistance':'开放协助','bounty-or-expert':'赏金／专家协助'};
const text=(s,max=1600)=>typeof s==='string'?s.slice(0,max):null;
const code=e=>/^[a-z0-9_-]{1,100}$/.test(e.code??e.message??'')?e.code??e.message:'panel_source_unavailable';
const error=c=>Object.assign(new Error(c),{code:c});
const fingerprint=s=>JSON.stringify([s.identity,s.endpoint,s.connection?.bindingId??null]);
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

// The view stores only references and a device-local draft. Every source read
// uses the existing authenticated runtime, never model-provided source bodies.
export function createCompactController(runtime){
 const views=new Map(),locks=new Map();let closed=false;
 const now=()=>runtime.now?.()??Math.floor(Date.now()/1000);
 async function current(){if(closed)throw error('panel_closed');return runtime.status();}
 async function owner(view){const state=await current();if(state.identity!==view.owner||state.endpoint!==view.endpoint)throw error('panel_identity_changed');return state;}
 async function required(id){z.uuid().parse(id);const view=views.get(id);if(!view)throw error('panel_view_expired');await owner(view);return view;}
 async function guarded(view,operation){const before=await owner(view),result=await operation();if(fingerprint(await owner(view))!==fingerprint(before))throw error('panel_connection_changed');return result;}
 function path(object){return object?'/app/'+({task:'tasks',room:'rooms',project:'projects',capsule:'capsules',match:'match',publish:'publish',participate:'participate',identity:'settings/identity',privacy:'settings/privacy',search:'search',capsules:'capsules',summaries:'settings/summaries',notifications:'notifications'}[object.kind])+(object.id?'/'+object.id:'')+(object.versionId?'/versions/'+object.versionId:''):null;}
 function project(object,data){
  if(object.kind==='task')return{title:text(data.request?.title,160),summary:text(data.request?.summary),state:data.state,revision:data.version,
   source:{kind:'task',id:data.taskId,version:data.version,caseId:data.caseId},enrollmentOpen:data.enrollmentOpen,capabilityVerified:false};
  if(object.kind==='room')return{title:text(data.title,160),state:data.state,revision:data.revision,kind:data.kind,taskRefs:data.taskRefs,
   source:{kind:'room',id:data.roomId,revision:data.revision},history:'完整共享历史、背景摘要和关键消息在房间分别读取',transportAvailable:data.transportAvailable};
  if(object.kind==='project')return{title:text(data.document?.title,160),summary:text(data.document?.summary),state:data.state,revision:data.revision,
   source:{kind:'project',id:data.projectId,revision:data.revision,documentEventId:data.source?.documentEventId,policyEventId:data.source?.policyEventId},classification:data.classification,capabilityVerified:false};
  return{title:text(data.version?.title,160),summary:text(data.version?.summary),state:data.sourceStatus,revision:data.revision??null,
   source:{kind:'capsule',id:data.capsuleId,versionId:data.versionId},deprecated:data.deprecated??null,securityIssue:data.securityIssue??null,readingIsReuse:false,capabilityVerified:false};
 }
 async function readObject(view){const object=view.input.object;if(!object?.id)return null;
  const data=await guarded(view,()=>object.kind==='task'?runtime.api.call('/v2/tasks/'+object.id,undefined,{method:'GET'}):
   object.kind==='room'?runtime.api.call('/v2/chat/rooms/'+object.id+'/read',{}):object.kind==='project'?runtime.api.call('/v2/projects/'+object.id,undefined,{method:'GET'}):
    runtime.api.call('/v2/capsules/read',{capsuleId:object.id,...(object.versionId?{versionId:object.versionId}:{})}));
  const projected=project(object,data);if(projected.source.id!==object.id||object.versionId&&projected.source.versionId!==object.versionId)throw error('panel_source_reference_mismatch');return projected;
 }
 async function render(view){await owner(view);let selected=null,sourceError=null,help=null;
  try{selected=await readObject(view);}catch(e){if(['panel_identity_changed','panel_connection_changed'].includes(code(e)))throw e;sourceError=code(e);}
  if(view.input.helpSessionId){const row=await guarded(view,()=>runtime.helpFlow.get(view.input.helpSessionId));
   // Saved model explanations can reference withdrawn sources: expose exact
   // local reference metadata, not their old private text or participant claims.
   help={sessionId:row.id,revision:row.revision,state:row.pauseState,caseId:row.caseId,taskId:row.taskId,
    selectedHelpIds:row.selectedHelpIds,sourceRefreshRequiredBeforeAction:true,
    offers:row.offers.map(o=>({id:o.id,path:o.path,kind:o.kind,sourceStatus:o.sourceStatus,basisRefs:o.basisRefs.map(b=>({kind:b.kind,id:b.id,sourceRevision:b.sourceRevision,checkedAt:b.checkedAt}))}))};
  }
  const saved=await runtime.store.get(view.draftKey);await owner(view);
  return{schemaVersion:1,viewId:view.id,checkedAt:now(),subjectId:view.owner,object:view.input.object??null,source:selected,sourceError,help,
   paths:helpPaths.map(id=>({id,label:labels[id],availability:'由当前资料和用户模型判断',selectedHelpCount:help?.offers.filter(o=>o.path===id).length??0})),
   activeEntries:[{id:'match',label:'主动匹配'},{id:'publish',label:'发布任务'},{id:'participate',label:'参与任务'}],
   objectUrl:path(view.input.object)?runtime.website+path(view.input.object):null,
   draft:{text:saved?.draft??'',revision:saved?.revision??0,scope:'this-device-only'},
   presentation:{embeddedHostAcceptance:'unverified',completeRoom:'browser',closingDoesNotCancel:true},businessMutation:false,modelCalls:0};
 }
 async function show(input){const parsed=panelInputSchema.parse(input),state=await current();
  const id=randomUUID(),view={id,input:parsed,owner:state.identity,endpoint:state.endpoint,navigations:new Set(),draftKey:'compact-draft:'+digest([state.endpoint,state.identity,parsed.object??null,parsed.helpSessionId??null,parsed.origin??null])};
  if(views.size>=64)views.delete(views.keys().next().value);views.set(id,view);return render(view);
 }
 async function refresh({viewId}){return render(await required(viewId));}
 async function open(input){const {viewId,entry}=panelOpenSchema.parse(input),view=await required(viewId),object=entry?{kind:entry}:view.input.object;
  if(!object)throw error('panel_object_required');const result=await guarded(view,()=>runtime.navigation.open({object,...(view.input.origin?{origin:view.input.origin}:{})}));
  if(result.navigationId)view.navigations.add(result.navigationId);return{...result,viewId,businessMutation:false};
 }
 async function resume(input){const {viewId,navigationId}=panelReturnSchema.parse(input),view=await required(viewId);
  if(!view.navigations.has(navigationId))throw error('panel_navigation_mismatch');
  // Navigation refresh already reads current source permissions. Do not expose
  // its full Task/Room data or local original prompt to a small UI accidentally.
  await guarded(view,()=>runtime.navigation.resume(navigationId));return{...await render(view),returned:true,navigationId};
 }
 async function save(input){const x=panelDraftSchema.parse(input),view=await required(x.viewId),previous=locks.get(view.draftKey)??Promise.resolve();
  const work=previous.catch(()=>{}).then(async()=>{await owner(view);const old=await runtime.store.get(view.draftKey);
   if((old?.revision??0)!==x.expectedRevision)throw error('panel_draft_conflict');
   const saved={draft:x.draft,revision:x.expectedRevision+1,updatedAt:now()};await runtime.store.put(view.draftKey,saved);await owner(view);
   return{viewId:x.viewId,draft:{text:saved.draft,revision:saved.revision,scope:'this-device-only'},businessMutation:false};});
  locks.set(view.draftKey,work);try{return await work;}finally{if(locks.get(view.draftKey)===work)locks.delete(view.draftKey);}
 }
 return{show,refresh,open,resume,save,close:()=>{closed=true;views.clear();}};
}
