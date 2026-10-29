import * as z from "zod/v4";
import {discoveryQueryV2Schema,discoveryDetailV2Schema,sameOpportunityRef} from "../../../../../galaxy-contracts/src/discovery-schema-v2.mjs";
import {getProjectContactClient} from "./operations.mjs";

const sessions=new WeakMap();
export const hasIndependentProject=opportunity=>['project','recruitment'].includes(opportunity?.opportunityRef?.sourceKind);
function localSubject(runtime){
 try{return runtime?.receiptStatus?.captureLease().subjectId??runtime?.api?.snapshot()?.subjectId??null;}catch{return null;}
}
export function projectViewScope(runtime,connected){
 const current=runtime?.api?.snapshot();
 return JSON.stringify([runtime?.api?.endpoint??null,!!connected,localSubject(runtime),current?.subjectId??null,current?.bindingId??null,current?.generation??null]);
}
export function projectQueryMemory(runtime,connected,key,value){
 if(!runtime)return null;let byScope=sessions.get(runtime);if(!byScope){byScope=new Map();sessions.set(runtime,byScope);}
 // Only user-authored inputs live here. Read results and permission decisions
 // stay in their binding-scoped views and must be fetched again on return.
 const id=JSON.stringify([runtime.api?.endpoint??null,localSubject(runtime)])+':'+key;
 if(arguments.length===4)byScope.set(id,structuredClone(value));
 return structuredClone(byScope.get(id)??null);
}
export const opportunityUnavailable=error=>[403,404].includes(error?.status)||error?.code==='project_opportunity_changed';
export const opportunityLocator=opportunity=>({id:opportunity.id,subjectId:opportunity.subjectId,projectId:opportunity.projectId,opportunityRef:opportunity.opportunityRef,sourceUnavailable:true});
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
 const recentContact=async opportunity=>{
  if(!writes)return null;current();
  const locators=await writes.acknowledgedContacts();current();
  const candidates=await Promise.all(locators.map(async locator=>{
   let contact;
   try{contact=await get('/v2/contacts/',locator.contactId);}
   catch(error){if([403,404].includes(error?.status))return null;throw error;}
   if(contact.initiatorId!==subjectId||contact.recipientId!==opportunity.subjectId)return null;
   // Match the chosen person and exact project/recruitment, using only the
   // currently readable source. A later source version does not erase an
   // existing invitation, and inaccessible old text is never restored locally.
   const send=contact.events?.find(event=>event.kind==='send'&&event.subjectId===subjectId&&
    event.opportunityRef?.subjectId===opportunity.subjectId&&event.opportunityRef?.projectId===opportunity.projectId&&
    event.opportunityRef?.recruitmentId===opportunity.opportunityRef.recruitmentId);
   return send?{contact,recordedAt:Date.parse(send.recordedAt)}:null;
  }));
  current();
  return candidates.filter(Boolean).sort((left,right)=>Number(right.contact.state==='sent')-Number(left.contact.state==='sent')||
   right.recordedAt-left.recordedAt)[0]?.contact??null;
 };
 return{
  scope,current,pendingContact,recentContact,
  project:id=>get('/v2/projects/',id),recruitment:id=>get('/v2/recruitment/',id),contact:id=>get('/v2/contacts/',id),
  async contactForProject(projectId){
   const project=await get('/v2/projects/',projectId);
   if(!project.document||project.state!=='active')throw new Error('当前项目资料不可用于新的联系。');
   const {title,functions,technologies}=project.document;
   // Selecting this exact source supplies a topic, not a claim that every
   // documented function is open to contact. The detail service and send both
   // enforce the current owner's effective preferences and source versions.
   const query=discoveryQueryV2Schema.parse({context:{kind:'ephemeral',title,functions,technologies},purposes:['conversation','reuse','collaboration','recruitment']});
   const opportunityRef={sourceKind:'project',subjectId:project.ownerId,projectId:project.projectId,
    documentEventId:project.source.documentEventId,policyEventId:project.source.policyEventId};
   const detail=await call('/v2/discovery/detail',discoveryDetailV2Schema.parse({context:query.context,purposes:query.purposes,opportunityRef}));
   return{project,query,detail};
  },
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
  /** @param {any} query @param {any} opportunity @param {{purpose:string,note:string,roomTitle?:string,operationId?:string}} input */
  async send(query,opportunity,{purpose,note,roomTitle,operationId}){
   if(!writes)throw new Error('请先连接自己的银河身份，再明确发送。');
   const selectedOperationId=operationId===undefined?undefined:z.uuid().parse(operationId);
   const pending=await pendingContact(opportunity);if(pending)throw Object.assign(new Error('这项机会有待对账的原联系，请先处理原操作。'),{resultUnknown:true,operationId:pending.operationId,objectId:pending.contactId});
   let currentDetail;
   try{currentDetail=await call('/v2/discovery/detail',discoveryDetailV2Schema.parse({context:query.context,purposes:[purpose],opportunityRef:opportunity.opportunityRef}));}
   catch(error){if(opportunityUnavailable(error))error.sourceUnavailable=true;throw error;}
   const target=currentDetail.opportunity;
   if(!sameOpportunityRef(target.opportunityRef,opportunity.opportunityRef)||target.subjectId!==opportunity.subjectId||target.contactState!=='welcome')
    throw Object.assign(new Error('机会或参与意愿已变化，请先刷新再选择。'),{code:'project_opportunity_changed',sourceUnavailable:true});
   current();let result;
   try{result=await writes.submit('contact',{kind:'send',contactId:crypto.randomUUID(),expectedRevision:0,recipientId:target.subjectId,
    purpose,context:query.context,opportunityRef:target.opportunityRef,note,roomTitle,...(selectedOperationId?{operationId:selectedOperationId}:{})},{viewers:[target.subjectId],confirmed:true});}
   catch(error){if(error.code==='contact_willingness_unavailable'&&error.outcome==='rejected')error.sourceUnavailable=true;throw error;}
   current();return result;
  },
  async respond(contact,kind,note=''){
   if(!writes)throw new Error('请先连接自己的银河身份。');
   current();const result=await writes.submit('contact',{kind,contactId:contact.contactId,expectedRevision:contact.revision,note},
    {viewers:[contact.initiatorId,contact.recipientId],confirmed:true});current();return result;
  },
  async reconcile(operationId,retry=false){if(!writes)throw new Error('请先连接原身份。');current();const value=await writes.reconcile(operationId,{retry,confirmed:retry});current();return value;},
  async resumePending(operationId){if(!writes)throw new Error('请先连接原身份。');current();const value=await writes.resumePending(operationId);current();return value;},
  async reviewPending(operationId){if(!writes)throw new Error('请先连接原身份。');current();const value=await writes.reviewPending(operationId);current();return value;},
 };
}
