import * as z from 'zod/v4';
import {discoveryQueryV2Schema,discoveryDetailV2Schema,sameOpportunityRef} from '../../galaxy-official/src/shared/discovery-schema-v2.mjs';
import {getProjectContactClient} from './project-contact-client.mjs';

const sessions=new WeakMap();
export const hasIndependentProject=opportunity=>['project','recruitment'].includes(opportunity?.opportunityRef?.sourceKind);
export function projectViewScope(runtime,connected){
 const current=connected?runtime?.api?.snapshot():null;
 return JSON.stringify([runtime?.api?.endpoint??null,!!connected,current?.subjectId??null,current?.bindingId??null]);
}
export function projectQueryMemory(runtime,connected,key,value){
 if(!runtime)return null;let byScope=sessions.get(runtime);if(!byScope){byScope=new Map();sessions.set(runtime,byScope);}
 const scope=projectViewScope(runtime,connected),id=scope+':'+key;
 if(arguments.length===4)byScope.set(id,structuredClone(value));
 return structuredClone(byScope.get(id)??null);
}
/** @param {any} runtime @param {{connected?:boolean,subjectId?:string|null}} options */
export function createProjectViewClient(runtime,{connected=false,subjectId=null}={}){
 const scope=projectViewScope(runtime,connected);
 const current=()=>{if(projectViewScope(runtime,connected)!==scope||connected&&runtime.api.snapshot()?.subjectId!==subjectId)
  throw Object.assign(new Error('身份或连接已改变，请重新读取当前页面。'),{code:'project_view_identity_changed'});};
 async function call(path,input,options={}){current();const result=await runtime.api.call(path,input,{authenticated:connected,...options});current();return result;}
 const get=(path,id)=>call(path+z.uuid().parse(id),undefined,{method:'GET'});
 const writes=connected&&subjectId?getProjectContactClient(runtime,subjectId):null;
 const pendingContact=async opportunity=>{
  if(!writes)return null;const records=await writes.pendingContacts();current();
  return records.find(row=>row.recipientId===opportunity.subjectId&&row.opportunityRef.projectId===opportunity.projectId&&
   row.opportunityRef.recruitmentId===opportunity.opportunityRef.recruitmentId)??null;
 };
 return{
  scope,current,pendingContact,
  project:id=>get('/v2/projects/',id),recruitment:id=>get('/v2/recruitment/',id),contact:id=>get('/v2/contacts/',id),
  /** @param {string} projectId @param {string[]} purposes @param {string|null} after */
  async related(projectId,purposes,after=null){
   const project=await get('/v2/projects/',projectId);
   if(!project.document||project.state!=='active')throw new Error('当前项目资料不可用于新的机会查询。');
   const {title,functions,technologies}=project.document;
   const query=discoveryQueryV2Schema.parse({context:{kind:'ephemeral',title,functions,technologies},purposes,limit:20,after});
   const result=await call('/v2/discovery/query',query);return{project,query,result};
  },
  /** @param {any} query @param {any} opportunityRef @param {string|null} experienceAfter */
  detail:(query,opportunityRef,experienceAfter=null)=>call('/v2/discovery/detail',discoveryDetailV2Schema.parse({context:query.context,purposes:query.purposes,opportunityRef,experienceAfter})),
  async send(query,opportunity,{purpose,note,roomTitle}){
   if(!writes)throw new Error('请先连接自己的银河身份，再明确发送。');
   const pending=await pendingContact(opportunity);if(pending)throw Object.assign(new Error('这项机会有待对账的原联系，请先处理原操作。'),{resultUnknown:true,operationId:pending.operationId,objectId:pending.contactId});
   const currentDetail=await call('/v2/discovery/detail',discoveryDetailV2Schema.parse({context:query.context,purposes:[purpose],opportunityRef:opportunity.opportunityRef}));
   const target=currentDetail.opportunity;
   if(!sameOpportunityRef(target.opportunityRef,opportunity.opportunityRef)||target.subjectId!==opportunity.subjectId||target.contactState!=='welcome')
    throw new Error('机会或参与意愿已变化，请先刷新再选择。');
   current();const result=await writes.submit('contact',{kind:'send',contactId:crypto.randomUUID(),expectedRevision:0,recipientId:target.subjectId,
    purpose,context:query.context,opportunityRef:target.opportunityRef,note,roomTitle},{viewers:[target.subjectId],confirmed:true});current();return result;
  },
  async respond(contact,kind,note=''){
   if(!writes)throw new Error('请先连接自己的银河身份。');
   current();const result=await writes.submit('contact',{kind,contactId:contact.contactId,expectedRevision:contact.revision,note},
    {viewers:[contact.initiatorId,contact.recipientId],confirmed:true});current();return result;
  },
  async reconcile(operationId,retry=false){if(!writes)throw new Error('请先连接原身份。');current();const value=await writes.reconcile(operationId,{retry,confirmed:retry});current();return value;},
 };
}
