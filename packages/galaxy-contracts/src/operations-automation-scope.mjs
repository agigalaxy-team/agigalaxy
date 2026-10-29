import {z} from 'zod';
import {ServiceError} from './service-error.mjs';
import {aiAutonomousPermissions} from './operations-ai-action-registry.mjs';

const ids=z.array(z.uuid()).max(100).refine(value=>new Set(value).size===value.length);
export const automationResourceIdsSchema=ids;
export const automationResourceScopeSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('selected'),resourceIds:ids.refine(value=>value.length>0)}),
 z.strictObject({kind:z.literal('eligible')}),
 z.strictObject({kind:z.literal('unresolved')}),
]);
export const automationEligibleActions=aiAutonomousPermissions;
const sameIds=(a,b)=>a.length===b.length&&a.every(id=>b.includes(id));
const fail=(code='operations_automation_scope_invalid')=>{throw new ServiceError(code,400);};

// A NULL discriminator is an old grant, never an implicit all-object grant.
// Old nonempty selections retain their original meaning; old empty rows need
// an explicit, authorized save before they can acquire an eligible scope.
export function automationResourceScope(row){
 const parsed=ids.safeParse(row?.resource_ids??row?.resourceIds??[]);
 if(!parsed.success)return {kind:'unresolved'};
 if(row?.resource_scope_kind==='eligible'&&parsed.data.length===0)return {kind:'eligible'};
 if((row?.resource_scope_kind==null||row?.resource_scope_kind==='selected')&&parsed.data.length)return {kind:'selected',resourceIds:[...parsed.data]};
 return {kind:'unresolved'};
}

// Takes the complete wire input. It does not add defaults to or mutate that
// input, so older operation receipts still compare the original intention.
export function automationScopeForSave(input,old=null){
 const legacy=ids.safeParse(input?.resourceIds);
 if(!legacy.success)fail();
 const before=old?automationResourceScope(old):null;
 let scope;
 if(input.resourceScope!==undefined){
  const parsed=automationResourceScopeSchema.safeParse(input.resourceScope);
  if(!parsed.success)fail();
  scope=parsed.data;
  if(scope.kind==='selected'?!sameIds(scope.resourceIds,legacy.data):legacy.data.length!==0)fail();
  if(scope.kind==='unresolved'&&before?.kind!=='unresolved')fail('operations_automation_scope_required');
 }else if(old){
  const oldIds=before.kind==='selected'?before.resourceIds:[];
  if(!sameIds(legacy.data,oldIds))fail('operations_automation_scope_required');
  scope=before;
 }else{
  if(!legacy.data.length)fail('operations_automation_scope_required');
  scope={kind:'selected',resourceIds:[...legacy.data]};
 }
 return {resourceScopeKind:scope.kind==='unresolved'?null:scope.kind,resourceIds:scope.kind==='selected'?[...scope.resourceIds]:[]};
}

export const automationScopeDelta=(before,after)=>({before:before?automationResourceScope(before):null,after:automationResourceScope(after)});

export function automationScopeCapability(row){
 const scope=automationResourceScope(row);
 const supportedActions=(row?.permissions??[]).filter(code=>automationEligibleActions.includes(code));
 const reason=scope.kind==='unresolved'?'operations_automation_scope_unresolved':supportedActions.length?'': 'operations_agentos_action_unavailable';
 return {state:scope.kind,canBindObjects:!reason,reason:reason||null,supportedActions};
}
