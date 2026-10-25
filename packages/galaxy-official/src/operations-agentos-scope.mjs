import {ServiceError} from './shared/service-error.mjs';
import {automationEligibleActions} from './shared/operations-automation-scope.mjs';

const fail=(code,status=403)=>{throw new ServiceError(code,status);};

// Eligible is a continuing grant condition, not an execution-wide wildcard.
// The caller supplies the concrete task IDs; only server readers may qualify
// them. New objects can be selected by a later task, never added to this task.
export class OperationsAgentOsScope{
 constructor({authority}){this.authority=authority;}
 async publicContent(db,id){
  const content=this.authority.content;
  if(!content?.rawWithin||!content?.publicSourceWithin)fail('operations_agentos_scope_unavailable',503);
  for(const kind of ['post','reply']){
   let current;
   try{current=await content.rawWithin(db,kind,id);}
   catch(error){if(error instanceof ServiceError&&error.status===404)continue;throw error;}
   const source=await content.publicSourceWithin(db,kind,current.head,current.source);
   if(!source.available)fail('operations_agentos_object_ineligible');
   return {kind,id,version:kind==='post'?current.head.head_version:current.head.revision};
  }
  return null;
 }
 async ordinaryStrategy(db,id,actions){
  const strategies=this.authority.strategies;
  if(!strategies?.head||!strategies?.version)fail('operations_agentos_scope_unavailable',503);
  const head=await strategies.head(db),version=await strategies.version(db,head.active_id);
  const current=version?.configuration?.strategies?.find(strategy=>strategy.id===id);
  if(!current)return false;
  if(current.domain!=='governance'||current.template!=='selected-public-content-visibility')fail('operations_agentos_object_ineligible');
  if(actions.some(code=>code.startsWith('strategies.ordinary.'))&&(!current.ordinaryBounds||current.mode==='human-led'||head.paused))fail('operations_agentos_object_ineligible');
  // The existing ordinary draft/publish service freezes the exact current
  // revision, permitted fields and bounded version ancestry for each command.
  // Do not freeze the global head here: a successful bounded publish changes it.
  return true;
 }
 async qualify(db,{domain,actions,resourceIds}){
  if(domain!=='governance'||!actions.length||actions.some(code=>!automationEligibleActions.includes(code)))fail('operations_agentos_action_unavailable');
  if(!resourceIds.length)fail('operations_agentos_scope_required',400);
  const contentActions=actions.some(code=>code.startsWith('content.')),strategyActions=actions.some(code=>code.startsWith('strategies.'));
  const sourceRefs=[];
  for(const id of resourceIds){
   const content=contentActions?await this.publicContent(db,id):null;
   if(content){sourceRefs.push(content);continue;}
   if(strategyActions&&await this.ordinaryStrategy(db,id,actions))continue;
   fail('operations_agentos_object_ineligible');
  }
  return {sourceRefs};
 }
}
